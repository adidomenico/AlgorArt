import { Bytes } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import algosdk from 'algosdk'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import { Factory } from '../factory/contract.algo'
import { ClaimsVault } from './contract.algo'

/**
 * Behavioral tests for the ClaimsVault, run against the offline AVM emulation provided by `algorand-typescript-testing`.
 *
 * The vault's inner app calls (the Factory registration check inside `issueClaimAsa`) and the asset-balance-dependent paths (seed
 * transfer, payBack's ledger derivation, clawback sweep, destroy) can't be emulated offline — they're covered by the LocalNet
 * integration suites (`../campaign/contract.integration.test.ts` and `contract.integration.test.ts`). Everything else — the issuance
 * guards that fire before the inner call, the payout-authority gating, the settlement bookkeeping, and the refund guards — is covered
 * here, using direct box writes to emulate the issuance mappings.
 */

const CAMPAIGN_APP_ID = 42
const ISSUED_ASSET_ID = 777
const FAKE_PROGRAM = new Uint8Array([0x41, 0x6c, 0x67, 0x6f, 0x72, 0x41, 0x72, 0x74]) // "AlgorArt"
const FAKE_PROGRAM_HASH = createHash('sha256').update(FAKE_PROGRAM).digest()
const CAMPAIGN_APP_ADDRESS = algosdk.getApplicationAddress(CAMPAIGN_APP_ID).toString()

describe('ClaimsVault', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
  })

  /** A real Factory contract whose approval hash is configured to match the synthetic campaign's program. */
  function createFactory(): Factory {
    const factory = ctx.contract.create(Factory)
    factory.create()
    factory.setApprovalHash(Bytes.fromBase64(Buffer.from(FAKE_PROGRAM_HASH).toString('base64')))
    return factory
  }

  function createVault(): ClaimsVault {
    const factory = createFactory()
    const vault = ctx.contract.create(ClaimsVault)
    vault.create(ctx.ledger.getApplicationForContract(factory))
    return vault
  }

  /**
   * The registered campaign app, whose program hashes to the official hash.
   *
   * @param creator The campaign app's creator.
   */
  function campaignApp(creator = ctx.defaultSender) {
    return ctx.any.application({ applicationId: CAMPAIGN_APP_ID, creator, approvalProgram: Bytes(FAKE_PROGRAM) })
  }

  /** An account whose address is the campaign app's account (to act as the inner-call sender). */
  function campaignAppAccount() {
    return ctx.ledger.getAccount(Bytes(algosdk.decodeAddress(CAMPAIGN_APP_ADDRESS).publicKey))
  }

  /**
   * Emulate the issuance mappings (the real `issueClaimAsa` needs the Factory inner call, covered on LocalNet).
   *
   * @param vault The vault contract.
   * @param app The campaign application.
   */
  function issueOffline(vault: ClaimsVault, app: ReturnType<typeof campaignApp>) {
    // Accessing the application's address forces the offline ledger to materialize the campaign app account data (the same side
    // effect the real `issueClaimAsa` has when it stores `app.address`).
    void app.address
    vault.asaOf(CAMPAIGN_APP_ID).value = ISSUED_ASSET_ID
    vault.addressOf(CAMPAIGN_APP_ID).value = campaignAppAccount()
    vault.creatorOf(CAMPAIGN_APP_ID).value = ctx.defaultSender
  }

  describe('create', () => {
    test('stores the factory app id', () => {
      const vault = createVault()
      expect(toExternalValue(vault.factory.value)).toBeGreaterThan(0)
    })
  })

  describe('issueClaimAsa', () => {
    test('rejects a second issue for the same campaign (the guard fires before any inner call)', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)

      expect(() => {
        vault.issueClaimAsa(app)
      }).toThrow('claim asset already issued')
    })

    test('rejects a campaign whose program hash does not match the official hash', () => {
      const vault = createVault()
      const app = ctx.any.application({
        applicationId: CAMPAIGN_APP_ID,
        creator: ctx.defaultSender,
        approvalProgram: Bytes(new Uint8Array([0x62, 0x61, 0x64])),
      })
      expect(() => {
        vault.issueClaimAsa(app)
      }).toThrow('not an official AlgorArt campaign')
    })

    test('rejects a non-creator caller', () => {
      const vault = createVault()
      const other = ctx.any.account()
      const app = campaignApp(other)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.issueClaimAsa(app)
        }).toThrow('only the campaign creator can issue')
      })
    })
  })

  describe('payBack', () => {
    // The payout derivation (raised − (T − U − H)) reads foreign global state and asset holdings the offline ledger can't emulate;
    // the full happy path is covered on LocalNet in ../campaign/contract.integration.test.ts.

    test('rejects a caller that is not the campaign app', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.payBack(app, stranger)
        }).toThrow('not the campaign app')
      })
    })

    test('rejects an unknown campaign', () => {
      const vault = createVault()
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.payBack(ctx.any.application({ applicationId: 999 }), stranger)
        }).toThrow('unknown campaign')
      })
    })
  })

  describe('payClaim', () => {
    test('records the claim settlement and pays the creator when called by the campaign app account', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.payClaim(app)
      })

      expect(toExternalValue(vault.settled(CAMPAIGN_APP_ID).value)).toEqual(2)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(ctx.defaultSender)
    })

    test('rejects a second claim (already settled)', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.payClaim(app)
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.payClaim(app)
        }).toThrow('already settled')
      })
    })

    test('rejects a caller that is not the campaign app', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.payClaim(app)
        }).toThrow('not the campaign app')
      })
    })
  })

  describe('notifyAttach', () => {
    test('records the attach marker when called by the campaign app account', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.notifyAttach(app)
      })

      expect(toExternalValue(vault.attached(CAMPAIGN_APP_ID).value)).toEqual(1)
    })

    test('rejects a second attach', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.notifyAttach(app)
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.notifyAttach(app)
        }).toThrow('already attached')
      })
    })

    test('rejects a caller that is not the campaign app', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.notifyAttach(app)
        }).toThrow('not the campaign app')
      })
    })
  })

  describe('settle', () => {
    test('records the failed settlement when called by the campaign app account', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.settle(app)
      })

      expect(toExternalValue(vault.settled(CAMPAIGN_APP_ID).value)).toEqual(1)
    })

    test('rejects a second settle', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.settle(app)
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.settle(app)
        }).toThrow('already settled')
      })
    })

    test('rejects a caller that is not the campaign app', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.settle(app)
        }).toThrow('not the campaign app')
      })
    })
  })

  describe('refund', () => {
    test('pays a failed-settled backer for surrendered units', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      const backer = ctx.any.account()

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.settle(app)
      })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: backer })]).execute(() => {
        vault.refund(
          app,
          ctx.any.txn.assetTransfer({
            sender: backer,
            xferAsset: ctx.any.asset({ assetId: ISSUED_ASSET_ID }),
            assetReceiver: ctx.ledger.getApplicationForContract(vault).address,
            assetAmount: 60_000,
          }),
        )
      })

      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(backer)
      expect(payout.amount).toEqual(60_000)
    })

    test('rejects a mismatched campaign id (the mapping is authoritative)', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      const backer = ctx.any.account()

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.settle(app)
      })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: backer })]).execute(() => {
        expect(() => {
          vault.refund(
            ctx.any.application({ applicationId: 999 }),
            ctx.any.txn.assetTransfer({
              sender: backer,
              xferAsset: ctx.any.asset({ assetId: ISSUED_ASSET_ID }),
              assetReceiver: ctx.ledger.getApplicationForContract(vault).address,
              assetAmount: 60_000,
            }),
          )
        }).toThrow('unknown claim asset')
      })
    })

    test('rejects refunding an unsettled campaign', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      const backer = ctx.any.account()

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: backer })]).execute(() => {
        expect(() => {
          vault.refund(
            app,
            ctx.any.txn.assetTransfer({
              sender: backer,
              xferAsset: ctx.any.asset({ assetId: ISSUED_ASSET_ID }),
              assetReceiver: ctx.ledger.getApplicationForContract(vault).address,
              assetAmount: 60_000,
            }),
          )
        }).toThrow('campaign is not refundable')
      })
    })

    test('rejects a zero-amount surrender', () => {
      const vault = createVault()
      const backer = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: backer })]).execute(() => {
        expect(() => {
          vault.refund(
            ctx.any.application({ applicationId: CAMPAIGN_APP_ID }),
            ctx.any.txn.assetTransfer({
              sender: backer,
              xferAsset: ctx.any.asset({ assetId: 999 }),
              assetReceiver: ctx.ledger.getApplicationForContract(vault).address,
              assetAmount: 0,
            }),
          )
        }).toThrow('claim amount must be greater than zero')
      })
    })

    test('rejects a surrender sent to the wrong receiver', () => {
      const vault = createVault()
      const backer = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: backer })]).execute(() => {
        expect(() => {
          vault.refund(
            ctx.any.application({ applicationId: CAMPAIGN_APP_ID }),
            ctx.any.txn.assetTransfer({
              sender: backer,
              xferAsset: ctx.any.asset({ assetId: 999 }),
              assetReceiver: backer,
              assetAmount: 1_000,
            }),
          )
        }).toThrow('claim units must go to the vault')
      })
    })
  })

  describe('sweepClaimAsa / destroyClaimAsa', () => {
    test('rejects sweeping an unsettled campaign', () => {
      const vault = createVault()
      const app = campaignApp()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.sweepClaimAsa(app, ctx.any.account())
        }).toThrow('campaign not claimed')
      })
    })

    test('rejects destroying an unsettled campaign (no issued asset)', () => {
      const vault = createVault()
      const app = campaignApp()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.destroyClaimAsa(app)
        }).toThrow('unknown campaign')
      })
    })

    test('rejects destroying with units outstanding', () => {
      const vault = createVault()
      const app = campaignApp()
      issueOffline(vault, app)
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.settle(app)
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.destroyClaimAsa(app)
        }).toThrow('claim units outstanding')
      })
    })

    test('seedSupply rejects an unknown campaign', () => {
      const vault = createVault()
      expect(() => {
        vault.seedSupply(ctx.any.application({ applicationId: 999 }))
      }).toThrow('unknown campaign')
    })
  })
})
