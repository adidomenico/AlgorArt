import { Bytes, OnCompleteAction, Uint64 } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, test } from 'vitest'
import { Campaign } from './contract.algo'

/**
 * Behavioral tests for the Campaign escrow contract, run against the offline AVM emulation provided by
 * `algorand-typescript-testing`. The split-vault mechanics (Claim ASA issuance, vault payments, pooled-solvency, settlement-after-
 * deletion, clawback GC) are exercised end-to-end on LocalNet in `contract.integration.test.ts` and
 * `../claimsvault/contract.integration.test.ts`; here every method × branch guard is covered offline.
 */

const GOAL = 1_000_000 // microAlgos
const CREATION_TIME = 1_000 // patched latestTimestamp at campaign creation
const DEADLINE = 2_000 // must be strictly after CREATION_TIME
const MIN_DEPOSIT = 200_000 // µA the creator funds for the escrow's fixed minimum balance
const TITLE = Bytes('My first novel')
const METADATA_URI = Bytes('ipfs://QmExample')
const VAULT_APP_ID = 777
const VAULT_ADDRESS = algosdk.getApplicationAddress(VAULT_APP_ID).toString()

describe('Campaign', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
    ctx.ledger.patchGlobalData({ latestTimestamp: CREATION_TIME })
  })

  /** The vault app — a synthetic application standing in for the ClaimsVault. */
  function vaultApp() {
    return ctx.any.application({ applicationId: VAULT_APP_ID })
  }

  function createCampaign(goal = GOAL, deadline = DEADLINE) {
    const contract = ctx.contract.create(Campaign)
    contract.create(vaultApp(), TITLE, METADATA_URI, goal, deadline)
    return contract
  }

  /** The vault's app account as an `Account` value for test transactions. */
  function vaultAccount() {
    return ctx.ledger.getAccount(Bytes(algosdk.decodeAddress(VAULT_ADDRESS).publicKey))
  }

  /**
   * The creator funds the escrow's storage deposit via `fund()`.
   *
   * @param contract The campaign to fund.
   * @param amount Deposit amount in microAlgos.
   */
  function fundAs(contract: Campaign, amount = MIN_DEPOSIT) {
    const appAddress = ctx.ledger.getApplicationForContract(contract).address
    contract.fund(ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: appAddress, amount }))
  }

  /**
   * The Claim ASA issued by the vault, as an `Asset` value usable in test transactions.
   *
   * @param contract The campaign whose asset is requested.
   */
  function claimAssetOf(contract: Campaign) {
    return ctx.any.asset({ assetId: toExternalValue(contract.claimAsa.value) })
  }

  function backerAccount() {
    return ctx.any.account()
  }

  /** The zero address, used for the "no close-out" assertion on surrender transfers. */
  function zeroAccount() {
    return ctx.any.account({ address: Bytes.fromHex('0'.repeat(64)) })
  }

  /**
   * Pledge `amount` as `backer`.
   *
   * @param contract The campaign to pledge to.
   * @param backer The non-creator backer.
   * @param amount Pledge amount in microAlgos.
   */
  function pledgeAs(contract: Campaign, backer: ReturnType<typeof backerAccount>, amount: number) {
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
      contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount }))
    })
  }

  describe('create', () => {
    test('sets global state and leaves the Claim ASA unissued', () => {
      const contract = createCampaign()

      expect(contract.creator.value).toEqual(ctx.defaultSender)
      expect(contract.vault.value.id).toEqual(VAULT_APP_ID)
      expect(contract.title.value).toEqual(TITLE)
      expect(contract.metadataUri.value).toEqual(METADATA_URI)
      expect(contract.goal.value).toEqual(GOAL)
      expect(contract.deadline.value).toEqual(DEADLINE)
      expect(contract.raised.value).toEqual(0)
      expect(contract.status.value).toEqual(0)
      expect(contract.claimAsa.value).toEqual(0)
      expect(contract.deposit.value).toEqual(0)
    })

    test('rejects an empty title', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), Bytes(''), METADATA_URI, GOAL, DEADLINE)
      }).toThrow('title must not be empty')
    })

    test('rejects a goal of zero', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), TITLE, METADATA_URI, 0, DEADLINE)
      }).toThrow('goal must be greater than zero')
    })

    test('rejects a deadline in the past', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), TITLE, METADATA_URI, GOAL, CREATION_TIME)
      }).toThrow('deadline must be in the future')
    })
  })

  describe('fund', () => {
    test('records the deposit without issuing an asset', () => {
      const contract = createCampaign()
      fundAs(contract)

      expect(contract.deposit.value).toEqual(MIN_DEPOSIT)
      expect(contract.claimAsa.value).toEqual(0)
    })

    test('rejects a non-creator caller', () => {
      const contract = createCampaign()
      const other = ctx.any.account()
      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other })]).execute(() => {
        expect(() => {
          contract.fund(ctx.any.txn.payment({ sender: other, receiver: appAddress, amount: MIN_DEPOSIT }))
        }).toThrow('only the creator can fund')
      })
    })

    test('rejects a deposit below the escrow minimum balance', () => {
      const contract = createCampaign()
      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      expect(() => {
        contract.fund(ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: appAddress, amount: MIN_DEPOSIT - 1 }))
      }).toThrow('fund must cover the escrow minimum balance')
    })

    test('rejects funding after the claim asset is attached', () => {
      const contract = createCampaign()
      fundAs(contract)
      contract.claimAsa.value = 5 // simulate attach
      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      expect(() => {
        contract.fund(ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: appAddress, amount: MIN_DEPOSIT }))
      }).toThrow('claim asset already attached')
    })
  })

  describe('attachClaimAsa', () => {
    test('records a vault-issued asset', () => {
      const contract = createCampaign()
      // An asset whose params match the stored vault (creator/manager/clawback = vault address, full supply, 0 decimals).
      const asset = ctx.any.asset({
        assetId: 4242,
        creator: vaultAccount(),
        manager: vaultAccount(),
        clawback: vaultAccount(),
        total: Uint64(0xffff_ffff_ffff_ffffn),
        decimals: Uint64(0),
      })
      contract.attachClaimAsa(asset)
      expect(contract.claimAsa.value).toEqual(4242)
    })

    test('rejects an asset not created by the vault', () => {
      const contract = createCampaign()
      const asset = ctx.any.asset({
        assetId: 4242,
        creator: ctx.any.account(),
        manager: vaultAccount(),
        clawback: vaultAccount(),
        total: Uint64(0xffff_ffff_ffff_ffffn),
        decimals: Uint64(0),
      })
      expect(() => {
        contract.attachClaimAsa(asset)
      }).toThrow('not issued by the vault')
    })

    test('rejects an asset not managed by the vault', () => {
      const contract = createCampaign()
      const asset = ctx.any.asset({
        assetId: 4242,
        creator: vaultAccount(),
        manager: ctx.any.account(),
        clawback: vaultAccount(),
        total: Uint64(0xffff_ffff_ffff_ffffn),
        decimals: Uint64(0),
      })
      expect(() => {
        contract.attachClaimAsa(asset)
      }).toThrow('not managed by the vault')
    })

    test('rejects an asset whose clawback authority is not the vault', () => {
      const contract = createCampaign()
      const asset = ctx.any.asset({
        assetId: 4242,
        creator: vaultAccount(),
        manager: vaultAccount(),
        clawback: ctx.any.account(),
        total: Uint64(0xffff_ffff_ffff_ffffn),
        decimals: Uint64(0),
      })
      expect(() => {
        contract.attachClaimAsa(asset)
      }).toThrow('vault must hold the clawback authority')
    })

    test('rejects a wrong total supply', () => {
      const contract = createCampaign()
      const asset = ctx.any.asset({
        assetId: 4242,
        creator: vaultAccount(),
        manager: vaultAccount(),
        clawback: vaultAccount(),
        total: Uint64(1_000),
        decimals: Uint64(0),
      })
      expect(() => {
        contract.attachClaimAsa(asset)
      }).toThrow('wrong claim asset supply')
    })

    test('rejects a second attach', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 9
      expect(() => {
        contract.attachClaimAsa(ctx.any.asset())
      }).toThrow('claim asset already attached')
    })
  })

  describe('pledge', () => {
    function attachedCampaign() {
      const contract = createCampaign()
      contract.claimAsa.value = 4242 // simulate attach
      return contract
    }

    test('mints claim units and bumps raised, paying the vault', () => {
      const contract = attachedCampaign()
      const a = backerAccount()
      const b = backerAccount()

      pledgeAs(contract, a, 100_000)
      pledgeAs(contract, b, 50_000)
      expect(contract.raised.value).toEqual(150_000)
    })

    test('allows the same backer to pledge repeatedly', () => {
      const contract = attachedCampaign()
      const a = backerAccount()

      pledgeAs(contract, a, 40_000)
      pledgeAs(contract, a, 60_000)
      expect(contract.raised.value).toEqual(100_000)
    })

    test('rejects pledging before the Claim ASA is attached', () => {
      const contract = createCampaign()
      const backer = backerAccount()
      const payment = ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100_000 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
        expect(() => {
          contract.pledge(payment)
        }).toThrow('claim asset not issued yet')
      })
    })

    test('rejects a payment that does not go to the vault', () => {
      const contract = attachedCampaign()
      const backer = backerAccount()
      const payment = ctx.any.txn.payment({
        sender: backer,
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 100_000,
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
        expect(() => {
          contract.pledge(payment)
        }).toThrow('payment must be made to the vault')
      })
    })

    test('rejects the creator pledging to their own campaign', () => {
      const contract = attachedCampaign()
      const payment = ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: vaultAccount(), amount: 100_000 })
      expect(() => {
        contract.pledge(payment)
      }).toThrow('creator cannot pledge to their own campaign')
    })

    test('rejects a zero pledge', () => {
      const contract = attachedCampaign()
      const backer = backerAccount()
      const payment = ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
        expect(() => {
          contract.pledge(payment)
        }).toThrow('pledge must be greater than zero')
      })
    })

    test('rejects pledging after the deadline', () => {
      const contract = attachedCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      const backer = backerAccount()
      const payment = ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100_000 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
        expect(() => {
          contract.pledge(payment)
        }).toThrow('pledging is closed')
      })
    })
  })

  describe('refund', () => {
    function failedCampaign(pledged: number) {
      const contract = createCampaign()
      contract.claimAsa.value = 4242 // simulate attach
      const a = backerAccount()
      pledgeAs(contract, a, pledged)
      return { contract, a }
    }

    test('returns a backer their pledge via the vault and decrements raised', () => {
      const { contract, a } = failedCampaign(60_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        contract.refund(
          ctx.any.txn.assetTransfer({
            sender: a,
            xferAsset: claimAssetOf(contract),
            assetReceiver: vaultAccount(),
            assetAmount: 60_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      })

      expect(contract.status.value).toEqual(1)
      expect(contract.raised.value).toEqual(0)

      // The payout is an inner app call to the vault (payBack), not a direct payment.
      const inner = ctx.txn.lastGroup.lastItxnGroup().getApplicationCallInnerTxn()
      expect(inner).toBeDefined()
    })

    test('allows a partial refund, leaving the rest claimable', () => {
      const { contract, a } = failedCampaign(60_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        contract.refund(
          ctx.any.txn.assetTransfer({
            sender: a,
            xferAsset: claimAssetOf(contract),
            assetReceiver: vaultAccount(),
            assetAmount: 10_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      })
      expect(contract.raised.value).toEqual(50_000)
    })

    test('rejects a surrender sent to the campaign escrow instead of the vault', () => {
      const { contract, a } = failedCampaign(60_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAssetOf(contract),
              assetReceiver: ctx.ledger.getApplicationForContract(contract).address,
              assetAmount: 60_000,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('claim units must go to the vault')
      })
    })

    test('rejects a surrender with closeRemainderTo set', () => {
      const { contract, a } = failedCampaign(60_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAssetOf(contract),
              assetReceiver: vaultAccount(),
              assetAmount: 60_000,
              assetCloseTo: vaultAccount(),
            }),
          )
        }).toThrow('close-out is not allowed here')
      })
    })

    test('rejects refunding before the deadline', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      expect(() => {
        contract.refund(
          ctx.any.txn.assetTransfer({
            sender: ctx.defaultSender,
            xferAsset: claimAssetOf(contract),
            assetReceiver: vaultAccount(),
            assetAmount: 100_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      }).toThrow('deadline has not passed')
    })

    test('rejects refunding when the goal was reached', () => {
      const { contract, a } = failedCampaign(GOAL)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAssetOf(contract),
              assetReceiver: vaultAccount(),
              assetAmount: GOAL,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('goal was reached, no refunds')
      })
    })

    test('rejects refunding a claimed campaign', () => {
      const { contract, a } = failedCampaign(GOAL - 1)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.status.value = 2 // claimed (manually, to exercise the branch past the goal check)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAssetOf(contract),
              assetReceiver: vaultAccount(),
              assetAmount: 1,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('campaign is not refundable')
      })
    })
  })

  describe('cancelPledge', () => {
    test('returns a backer their pledge via the vault and decrements raised', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        contract.cancelPledge(
          ctx.any.txn.assetTransfer({
            sender: a,
            xferAsset: claimAssetOf(contract),
            assetReceiver: vaultAccount(),
            assetAmount: 60_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      })

      expect(contract.raised.value).toEqual(0)
      const inner = ctx.txn.lastGroup.lastItxnGroup().getApplicationCallInnerTxn()
      expect(inner).toBeDefined()
    })

    test('rejects canceling after the deadline', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.cancelPledge(
          ctx.any.txn.assetTransfer({
            sender: ctx.defaultSender,
            xferAsset: claimAssetOf(contract),
            assetReceiver: vaultAccount(),
            assetAmount: 100_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      }).toThrow('pledging is closed')
    })

    test('rejects canceling a settled campaign', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      contract.status.value = 2
      expect(() => {
        contract.cancelPledge(
          ctx.any.txn.assetTransfer({
            sender: ctx.defaultSender,
            xferAsset: claimAssetOf(contract),
            assetReceiver: vaultAccount(),
            assetAmount: 100_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      }).toThrow('campaign is not open')
    })
  })

  describe('claim', () => {
    test('sets claimed and asks the vault to pay (no direct escrow payment)', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      const backer = backerAccount()
      pledgeAs(contract, backer, GOAL)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()

      expect(contract.status.value).toEqual(2)
      const inner = ctx.txn.lastGroup.lastItxnGroup().getApplicationCallInnerTxn()
      expect(inner).toBeDefined()
    })

    test('rejects a second claim', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      const backer = backerAccount()
      pledgeAs(contract, backer, GOAL)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()

      expect(() => {
        contract.claim()
      }).toThrow('already claimed')
    })

    test('rejects a non-creator caller', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      const other = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other })]).execute(() => {
        expect(() => {
          contract.claim()
        }).toThrow('only the creator can claim')
      })
    })

    test('rejects claiming before the deadline', () => {
      const contract = createCampaign()
      expect(() => {
        contract.claim()
      }).toThrow('deadline has not passed')
    })

    test('rejects claiming when the goal was not reached', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      const backer = backerAccount()
      pledgeAs(contract, backer, GOAL - 1)

      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.claim()
      }).toThrow('goal not reached')
    })
  })

  describe('closeOut', () => {
    function claimedCampaign() {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      const backer = backerAccount()
      pledgeAs(contract, backer, GOAL)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()
      return contract
    }

    test('accepts a close-out to the vault after a successful claim', () => {
      const contract = claimedCampaign()
      const a = backerAccount()
      expect(() => {
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
          contract.closeOut(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAssetOf(contract),
              assetReceiver: vaultAccount(),
              assetAmount: 0,
              assetCloseTo: vaultAccount(),
            }),
          )
        })
      }).not.toThrow()
    })

    test('rejects a close-out without closeRemainderTo', () => {
      const contract = claimedCampaign()
      const a = backerAccount()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.closeOut(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAssetOf(contract),
              assetReceiver: vaultAccount(),
              assetAmount: GOAL,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('must close the claim holding to the vault')
      })
    })

    test('rejects a close-out while the campaign is not claimed', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      const a = backerAccount()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.closeOut(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAssetOf(contract),
              assetReceiver: vaultAccount(),
              assetAmount: 0,
              assetCloseTo: vaultAccount(),
            }),
          )
        }).toThrow('campaign is not claimed')
      })
    })
  })

  describe('delete', () => {
    test('rejects a non-creator caller', () => {
      const contract = createCampaign()
      const other = ctx.any.account()
      ctx.txn
        .createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other, onCompletion: OnCompleteAction.DeleteApplication })])
        .execute(() => {
          expect(() => {
            contract.delete()
          }).toThrow('only the creator can delete')
        })
    })

    test('rejects an open campaign with live pledges before the deadline', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      pledgeAs(contract, backerAccount(), 10_000)
      expect(() => {
        contract.delete()
      }).toThrow('cannot delete a campaign with live pledges')
    })

    test('materializes a failed campaign and settles the vault', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      pledgeAs(contract, backerAccount(), 10_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      contract.delete()

      expect(contract.status.value).toEqual(1)
    })

    test('closes the escrow to the creator for a never-funded open campaign', () => {
      const contract = createCampaign()
      expect(() => {
        contract.delete()
      }).not.toThrow()

      const close = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(close.receiver).toEqual(ctx.defaultSender)
    })

    test('closes the escrow for a claimed campaign without further settlement', () => {
      const contract = createCampaign()
      contract.claimAsa.value = 4242
      pledgeAs(contract, backerAccount(), GOAL)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()

      expect(() => {
        contract.delete()
      }).not.toThrow()
      const close = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(close.receiver).toEqual(ctx.defaultSender)
    })
  })
})
