import type { Account, bytes } from '@algorandfoundation/algorand-typescript'
import { Bytes } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import algosdk from 'algosdk'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { Campaign } from '../campaign/contract.algo'
import { ClaimsVault } from './contract.algo'

/**
 * Behavioral tests for the ClaimsVault (claim-tree design), run against the offline AVM emulation.
 *
 * The Factory registration inner call inside first-touch `credit` can't be emulated offline (no inner-call logs) — it
 * is covered on LocalNet in `contract.integration.test.ts`. Everything else runs here, including full differential
 * pledge/refund flows: expected roots come from the Python reference oracle (`../oracle.py`), driven with the mock
 * payments' real `txnId`s.
 */

const CAMPAIGN_APP_ID = 42
const FACTORY_APP_ID = 7
const WINDOW = 1_000_000
const Z_HEX = '00'.repeat(32)
const ORACLE = path.resolve(__dirname, '../oracle.py')

// Packed box statuses: 1 = Open, 2 = Failed, 3 = Claimed.
const OPEN = 1
const FAILED = 2
const CLAIMED = 3

describe('ClaimsVault', () => {
  const ctx = new TestExecutionContext()
  let stateFile: string

  beforeEach(() => {
    ctx.reset()
    stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claimvault-spec-')), 'state.json')
    oracle('init')
  })

  function oracle(cmd: string, ...args: string[]): unknown {
    const out = execFileSync('python3', [ORACLE, stateFile, cmd, ...args], { encoding: 'utf8' })
    return JSON.parse(out) as unknown
  }

  function createVault(sweep = ctx.defaultSender, window = WINDOW): ClaimsVault {
    const vault = ctx.contract.create(ClaimsVault)
    vault.create(ctx.any.application({ applicationId: FACTORY_APP_ID }), sweep, window)
    return vault
  }

  /**
   * The campaign app stub.
   *
   * @param creator The campaign app's creator.
   */
  function campaignApp(creator = ctx.defaultSender) {
    return ctx.any.application({ applicationId: CAMPAIGN_APP_ID, creator })
  }

  /** An account whose address is the campaign app's account (to act as the inner-call sender). */
  function campaignAppAccount() {
    return ctx.ledger.getAccount(Bytes(algosdk.decodeAddress(algosdk.getApplicationAddress(CAMPAIGN_APP_ID).toString()).publicKey))
  }

  /**
   * The vault's own app account (pledge payments go here).
   *
   * @param vault The vault contract.
   * @returns Its app account.
   */
  function vaultAccount(vault: ClaimsVault) {
    const address = ctx.ledger.getApplicationForContract(vault).address
    return ctx.ledger.getAccount(address)
  }

  function toU64(value: number): Buffer {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64BE(BigInt(value))
    return buf
  }

  /**
   * Write a packed campaign box directly (emulates prior `credit`/`settle` calls).
   *
   * @param vault The vault contract.
   * @param appId The campaign application id (the box key).
   * @param fields The box fields.
   * @param fields.paidIn Verified inflows, in microAlgos.
   * @param fields.paidOut Outflows paid, in microAlgos.
   * @param fields.root Tree root (hex).
   * @param fields.n Position count.
   * @param fields.status Box status byte.
   * @param fields.settledAt Settlement timestamp.
   */
  function writeBox(
    vault: ClaimsVault,
    appId: number,
    fields: { paidIn: number; paidOut: number; root: string; n: number; status: number; settledAt: number },
  ): void {
    vault.campaignBox(appId).value = Bytes(
      Buffer.concat([
        toU64(fields.paidIn),
        toU64(fields.paidOut),
        Buffer.from(fields.root, 'hex'),
        toU64(fields.n),
        Buffer.from([fields.status]),
        toU64(fields.settledAt),
      ]),
    )
  }

  /**
   * Read a packed campaign box back into fields.
   *
   * @param vault The vault contract.
   * @param appId The campaign application id (the box key).
   * @returns The unpacked fields.
   */
  function readBox(
    vault: ClaimsVault,
    appId: number,
  ): { paidIn: bigint; paidOut: bigint; root: string; n: bigint; status: number; settledAt: bigint } {
    const raw = Buffer.from(toExternalValue(vault.campaignBox(appId).value))
    return {
      paidIn: raw.subarray(0, 8).readBigUInt64BE(),
      paidOut: raw.subarray(8, 16).readBigUInt64BE(),
      root: raw.subarray(16, 48).toString('hex'),
      n: raw.subarray(48, 56).readBigUInt64BE(),
      status: raw[56] === undefined ? 0 : raw[56],
      settledAt: raw.subarray(57, 65).readBigUInt64BE(),
    }
  }

  /**
   * A real Campaign contract standing in as the foreign app for `settleOpen` (its globals are readable on-chain).
   *
   * @param fields The campaign globals.
   * @param fields.status Campaign status.
   * @param fields.raised Live pledge total.
   * @param fields.goal Funding target.
   * @param fields.deadline Deadline timestamp.
   * @param fields.root Tree root (hex).
   * @param fields.n Position count.
   * @returns The application reference and its id (vault boxes are keyed by it).
   */
  function foreignCampaign(fields: { status: number; raised: number; goal: number; deadline: number; root: string; n: number }) {
    const campaign = ctx.contract.create(Campaign)
    campaign.status.value = fields.status
    campaign.raised.value = fields.raised
    campaign.goal.value = fields.goal
    campaign.deadline.value = fields.deadline
    campaign.root.value = Bytes(Buffer.from(fields.root, 'hex'))
    campaign.n.value = fields.n
    const app = ctx.ledger.getApplicationForContract(campaign)
    return { app, id: Number(toExternalValue(app.id)) }
  }

  describe('create', () => {
    test('stores the factory, sweep target, and window', () => {
      const vault = createVault()
      expect(toExternalValue(vault.factory.value.id)).toEqual(FACTORY_APP_ID)
      expect(toExternalValue(vault.refundWindow.value)).toEqual(WINDOW)
    })

    test('rejects a zero window', () => {
      const vault = ctx.contract.create(ClaimsVault)
      expect(() => {
        vault.create(ctx.any.application({ applicationId: FACTORY_APP_ID }), ctx.defaultSender, 0)
      }).toThrow('refund window must be positive')
    })
  })

  describe('credit', () => {
    test('rejects a zero amount', () => {
      const vault = createVault()
      expect(() => {
        vault.credit(campaignApp(), 0)
      }).toThrow('pledge must be greater than zero')
    })

    test('rejects a first touch the offline ledger cannot register (covered on LocalNet)', () => {
      // No box exists and the group payment verifies, so `credit` reaches the Factory inner call whose log the
      // offline ledger cannot emulate: the call resolves but returns no log, failing the gate. The real gate runs
      // on LocalNet.
      const vault = createVault()
      const caller = ctx.defaultSender
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: caller, receiver: vaultAccount(vault), amount: 1000 }),
          ctx.any.txn.applicationCall({ appId: vault, sender: caller }),
        ])
        .execute(() => {
          expect(() => {
            vault.credit(campaignApp(), 1000)
          }).toThrow('campaign not registered')
        })
    })

    test('rejects a box that is not open', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: FAILED, settledAt: 500 })
      expect(() => {
        vault.credit(campaignApp(), 1000)
      }).toThrow('campaign is not open')
    })

    test('rejects a group without a matching payment', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      const caller = ctx.any.account()
      const other = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.applicationCall({ appId: vault, sender: other }),
          ctx.any.txn.payment({ sender: other, receiver: vaultAccount(vault), amount: 500 }),
          ctx.any.txn.applicationCall({ appId: vault, sender: caller }),
        ])
        .execute(() => {
          expect(() => {
            vault.credit(campaignApp(), 500)
          }).toThrow('matching payment not found in group')
        })
    })

    test('records the inflow on an existing box', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      const caller = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: caller, receiver: vaultAccount(vault), amount: 500 }),
          ctx.any.txn.applicationCall({ appId: vault, sender: caller }),
        ])
        .execute(() => {
          vault.credit(campaignApp(), 500)
        })

      const box = readBox(vault, CAMPAIGN_APP_ID)
      expect(box.paidIn).toEqual(1500n)
      expect(box.paidOut).toEqual(200n)
      expect(box.status).toEqual(OPEN)
    })
  })

  describe('payBack', () => {
    test('rejects a caller that is not the campaign app', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.payBack(campaignApp(), stranger, 100)
        }).toThrow('not the campaign app')
      })
    })

    test('rejects an unknown campaign', () => {
      const vault = createVault()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.payBack(ctx.any.application({ applicationId: 999 }), ctx.defaultSender, 100)
        }).toThrow('unknown campaign')
      })
    })

    test('rejects a box that is not open', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: FAILED, settledAt: 500 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.payBack(campaignApp(), ctx.defaultSender, 100)
        }).toThrow('campaign is not open')
      })
    })

    test('rejects a zero amount', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.payBack(campaignApp(), ctx.defaultSender, 0)
        }).toThrow('nothing to pay back')
      })
    })

    test('rejects a payout above verified inflows', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 900, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.payBack(campaignApp(), ctx.defaultSender, 200)
        }).toThrow('insufficient campaign balance')
      })
    })

    test('pays the backer and records the outflow when called by the campaign app', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      const backer = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.payBack(campaignApp(), backer, 300)
      })

      const box = readBox(vault, CAMPAIGN_APP_ID)
      expect(box.paidOut).toEqual(500n)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(backer)
      expect(toExternalValue(payout.amount)).toEqual(300)
    })
  })

  describe('payClaim', () => {
    test('rejects a caller that is not the campaign app', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.payClaim(campaignApp())
        }).toThrow('not the campaign app')
      })
    })

    test('rejects an unknown campaign', () => {
      const vault = createVault()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.payClaim(ctx.any.application({ applicationId: 999 }))
        }).toThrow('unknown campaign')
      })
    })

    test('rejects an already settled box', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 1000, root: Z_HEX, n: 1, status: CLAIMED, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.payClaim(campaignApp())
        }).toThrow('campaign is not open')
      })
    })

    test('rejects an empty payout', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 1000, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.payClaim(campaignApp())
        }).toThrow('nothing to claim')
      })
    })

    test('pays the derived payout to the creator and flips to claimed', () => {
      const vault = createVault()
      const creator = ctx.any.account()
      const app = ctx.any.application({ applicationId: CAMPAIGN_APP_ID, creator })
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.payClaim(app)
      })

      const box = readBox(vault, CAMPAIGN_APP_ID)
      expect(box.status).toEqual(CLAIMED)
      expect(box.paidOut).toEqual(1000n)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(creator)
      expect(toExternalValue(payout.amount)).toEqual(800)
    })
  })

  describe('settle', () => {
    const ROOT = '11'.repeat(32)

    test('rejects a caller that is not the campaign app', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.settle(campaignApp(), Bytes(Buffer.from(ROOT, 'hex')), 1)
        }).toThrow('not the campaign app')
      })
    })

    test('ignores an unknown campaign (no-op)', () => {
      const vault = createVault()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.settle(ctx.any.application({ applicationId: 999 }), Bytes(Buffer.from(ROOT, 'hex')), 1)
      })

      expect(vault.campaignBox(999).exists).toEqual(false)
    })

    test('rejects a malformed root', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.settle(campaignApp(), Bytes(Buffer.from('11', 'hex')), 1)
        }).toThrow('bad root length')
      })
    })

    test('writes root, n, and settledAt while flipping an open box to failed', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 0, status: OPEN, settledAt: 0 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 5_000 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.settle(campaignApp(), Bytes(Buffer.from(ROOT, 'hex')), 3)
      })

      const box = readBox(vault, CAMPAIGN_APP_ID)
      expect(box.root).toEqual(ROOT)
      expect(box.n).toEqual(3n)
      expect(box.status).toEqual(FAILED)
      expect(box.settledAt).toEqual(5_000n)
      expect(box.paidIn).toEqual(1000n)
      expect(box.paidOut).toEqual(200n)
    })

    test('is a no-op on an already failed box', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: ROOT, n: 3, status: FAILED, settledAt: 500 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.settle(campaignApp(), Bytes(Buffer.from(Z_HEX, 'hex')), 9)
      })

      const box = readBox(vault, CAMPAIGN_APP_ID)
      expect(box.root).toEqual(ROOT)
      expect(box.n).toEqual(3n)
      expect(box.settledAt).toEqual(500n)
    })

    test('rejects a claimed box', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 1000, root: ROOT, n: 1, status: CLAIMED, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.settle(campaignApp(), Bytes(Buffer.from(ROOT, 'hex')), 1)
        }).toThrow('already claimed')
      })
    })
  })

  describe('settleOpen', () => {
    test('rejects an unknown campaign', () => {
      const vault = createVault()
      expect(() => {
        vault.settleOpen(ctx.any.application({ applicationId: 999 }))
      }).toThrow('unknown campaign')
    })

    test('rejects a box that is not open', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: FAILED, settledAt: 500 })
      expect(() => {
        vault.settleOpen(campaignApp())
      }).toThrow('campaign is not open')
    })

    test('rejects an already claimed campaign', () => {
      const vault = createVault()
      const { app, id } = foreignCampaign({ status: 2, raised: 1000, goal: 1000, deadline: 100, root: Z_HEX, n: 1 })
      writeBox(vault, id, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 500 })
      expect(() => {
        vault.settleOpen(app)
      }).toThrow('campaign already claimed')
    })

    test('rejects a campaign before its deadline', () => {
      const vault = createVault()
      const { app, id } = foreignCampaign({ status: 0, raised: 500, goal: 1000, deadline: 5_000, root: Z_HEX, n: 1 })
      writeBox(vault, id, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 500 })
      expect(() => {
        vault.settleOpen(app)
      }).toThrow('deadline has not passed')
    })

    test('rejects a campaign that reached its goal', () => {
      const vault = createVault()
      const { app, id } = foreignCampaign({ status: 0, raised: 1000, goal: 1000, deadline: 100, root: Z_HEX, n: 1 })
      writeBox(vault, id, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 500 })
      expect(() => {
        vault.settleOpen(app)
      }).toThrow('goal was reached')
    })

    test('settles a failed campaign from its live global state', () => {
      const vault = createVault()
      const root = '22'.repeat(32)
      const { app, id } = foreignCampaign({ status: 1, raised: 800, goal: 1000, deadline: 100, root, n: 4 })
      writeBox(vault, id, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 0, status: OPEN, settledAt: 0 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 500 })
      vault.settleOpen(app)

      const box = readBox(vault, id)
      expect(box.root).toEqual(root)
      expect(box.n).toEqual(4n)
      expect(box.status).toEqual(FAILED)
      expect(box.settledAt).toEqual(500n)
    })
  })

  describe('refund', () => {
    const AMOUNT = 1_000_000

    /**
     * Hex of an account's 32-byte address.
     *
     * @param account The account.
     * @returns Lowercase hex.
     */
    function accountHex(account: Account): string {
      return Buffer.from(toExternalValue(account.bytes as unknown as bytes)).toString('hex')
    }

    /**
     * The oracle path blob for position k (siblings ‖ top ‖ lower).
     *
     * @param k Leaf position.
     * @returns The concatenated blob.
     */
    function pathBlob(k: number): Buffer {
      const path = oracle('path', k.toString()) as { siblings: string[]; top: string | null; lower: string[] }
      return Buffer.concat([
        ...path.siblings.map((s) => Buffer.from(s, 'hex')),
        ...(path.top === null ? [] : [Buffer.from(path.top, 'hex')]),
        ...path.lower.map((s) => Buffer.from(s, 'hex')),
      ])
    }

    /**
     * Build a pledge tree in the oracle and mirror it into a failed box (paid in full, nothing paid out).
     *
     * @param vault The vault contract.
     * @param settledAt Settlement timestamp for the mirrored box.
     * @param pledgeCount Number of equal pledges (fresh backer per position).
     * @returns The backer accounts (positions built in order) and their pledge TxIDs.
     */
    function failedBoxWithTree(vault: ClaimsVault, settledAt: number, pledgeCount = 3): { backers: Account[]; txids: string[] } {
      const backers: Account[] = []
      const txids: string[] = []
      for (let i = 0; i < pledgeCount; i = i + 1) {
        const backer = ctx.any.account()
        backers.push(backer)
        const pay = ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(vault), amount: AMOUNT })
        const txid = Buffer.from(toExternalValue(pay.txnId)).toString('hex')
        txids.push(txid)
        oracle('append', accountHex(backer), AMOUNT.toString(), txid)
      }
      const state = oracle('state') as { n: number; root: string; raised: number }
      writeBox(vault, CAMPAIGN_APP_ID, {
        paidIn: state.raised,
        paidOut: 0,
        root: state.root,
        n: state.n,
        status: FAILED,
        settledAt,
      })
      return { backers, txids }
    }

    test('rejects an unknown campaign', () => {
      const vault = createVault()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.refund(ctx.any.application({ applicationId: 999 }), 0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
        }).toThrow('unknown campaign')
      })
    })

    test('rejects a box that is not failed', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.refund(campaignApp(), 0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
        }).toThrow('campaign is not refundable')
      })
    })

    test('rejects a refund after the window closes', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: FAILED, settledAt: 100 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 100 + WINDOW + 1 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.refund(campaignApp(), 0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
        }).toThrow('refund window closed')
      })
    })

    test('rejects an unknown position', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: FAILED, settledAt: 100 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 200 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.refund(campaignApp(), 7, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
        }).toThrow('unknown position')
      })
    })

    test('rejects a malformed txid', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 0, root: Z_HEX, n: 1, status: FAILED, settledAt: 100 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 200 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: ctx.defaultSender })]).execute(() => {
        expect(() => {
          vault.refund(campaignApp(), 0, 100, Bytes(Buffer.alloc(16)), Bytes(new Uint8Array()))
        }).toThrow('bad txid length')
      })
    })

    test('rejects a malformed path', () => {
      const vault = createVault()
      failedBoxWithTree(vault, 100)
      ctx.ledger.patchGlobalData({ latestTimestamp: 200 })
      const caller = ctx.defaultSender
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: caller })]).execute(() => {
        expect(() => {
          vault.refund(campaignApp(), 0, AMOUNT, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
        }).toThrow('bad path length')
      })
    })

    test('rejects a proof that does not match the stored root', () => {
      const vault = createVault()
      failedBoxWithTree(vault, 100)
      ctx.ledger.patchGlobalData({ latestTimestamp: 200 })
      const caller = ctx.any.account()
      const blob = pathBlob(0)
      // Corrupt one path byte: the recombined root no longer matches.
      blob[0] = blob[0] === 0 ? 1 : 0
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: caller })]).execute(() => {
        expect(() => {
          vault.refund(campaignApp(), 0, AMOUNT, Bytes(Buffer.alloc(32)), Bytes(blob))
        }).toThrow('proof does not match root')
      })
    })

    test('rejects a payout above verified inflows', () => {
      const vault = createVault()
      const { backers, txids } = failedBoxWithTree(vault, 100)
      const txid = txids[0] === undefined ? '' : txids[0]
      const backer = backers[0] === undefined ? ctx.defaultSender : backers[0]
      // Shrink the box's paidIn below the leaf amount: the proof verifies, the guard must not.
      const box = readBox(vault, CAMPAIGN_APP_ID)
      writeBox(vault, CAMPAIGN_APP_ID, {
        paidIn: AMOUNT - 1,
        paidOut: 0,
        root: box.root,
        n: Number(box.n),
        status: FAILED,
        settledAt: 100,
      })
      ctx.ledger.patchGlobalData({ latestTimestamp: 200 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: backer })]).execute(() => {
        expect(() => {
          vault.refund(campaignApp(), 0, AMOUNT, Bytes(Buffer.from(txid, 'hex')), Bytes(pathBlob(0)))
        }).toThrow('insufficient campaign balance')
      })
    })

    test('pays each caller and nulls each leaf in turn (differential, all path shapes)', () => {
      const vault = createVault()
      const { backers, txids } = failedBoxWithTree(vault, 100)
      const app = campaignApp()
      ctx.ledger.patchGlobalData({ latestTimestamp: 200 })

      // k=2: r=0 with a higher peak (exercises hasTop); k=1: r=1, c=1; k=0: r=1, c=1. Paths are rebuilt from the
      // oracle after every null, exactly as a client would after on-chain state advances.
      for (const k of [2, 1, 0]) {
        const txid = txids[k] === undefined ? '' : txids[k]
        const backer = backers[k] === undefined ? ctx.defaultSender : backers[k]
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: backer })]).execute(() => {
          vault.refund(app, k, AMOUNT, Bytes(Buffer.from(txid, 'hex')), Bytes(pathBlob(k)))
        })

        const expected = oracle('null', k.toString(), AMOUNT.toString()) as { root: string; raised: number }
        const box = readBox(vault, CAMPAIGN_APP_ID)
        expect(box.root).toEqual(expected.root)
      }

      const box = readBox(vault, CAMPAIGN_APP_ID)
      expect(box.paidOut).toEqual(BigInt(3 * AMOUNT))
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(toExternalValue(payout.amount)).toEqual(AMOUNT)
    })

    test('refunds at N=6 k=0 (even popcount input, r=2, no top)', () => {
      const vault = createVault()
      const { backers, txids } = failedBoxWithTree(vault, 100, 6)
      const txid = txids[0] === undefined ? '' : txids[0]
      const backer = backers[0] === undefined ? ctx.defaultSender : backers[0]
      ctx.ledger.patchGlobalData({ latestTimestamp: 200 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: backer })]).execute(() => {
        vault.refund(campaignApp(), 0, AMOUNT, Bytes(Buffer.from(txid, 'hex')), Bytes(pathBlob(0)))
      })

      const expected = oracle('null', '0', AMOUNT.toString()) as { root: string }
      const box = readBox(vault, CAMPAIGN_APP_ID)
      expect(box.root).toEqual(expected.root)
      expect(box.paidOut).toEqual(BigInt(AMOUNT))
    })
  })

  describe('notifyDelete', () => {
    test('rejects a caller that is not the campaign app', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 1000, root: Z_HEX, n: 1, status: CLAIMED, settledAt: 0 })
      const stranger = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: stranger })]).execute(() => {
        expect(() => {
          vault.notifyDelete(campaignApp())
        }).toThrow('not the campaign app')
      })
    })

    test('rejects an unknown campaign', () => {
      const vault = createVault()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.notifyDelete(ctx.any.application({ applicationId: 999 }))
        }).toThrow('unknown campaign')
      })
    })

    test('rejects a box that is not claimed', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.notifyDelete(campaignApp())
        }).toThrow('campaign not claimed')
      })
    })

    test('rejects a box with an outstanding balance', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: CLAIMED, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        expect(() => {
          vault.notifyDelete(campaignApp())
        }).toThrow('campaign balance outstanding')
      })
    })

    test('deletes a balanced claimed box when called by the campaign app', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 1000, root: Z_HEX, n: 1, status: CLAIMED, settledAt: 0 })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: vault, sender: campaignAppAccount() })]).execute(() => {
        vault.notifyDelete(campaignApp())
      })

      expect(vault.campaignBox(CAMPAIGN_APP_ID).exists).toEqual(false)
    })
  })

  describe('finalize', () => {
    test('rejects an unknown campaign', () => {
      const vault = createVault()
      expect(() => {
        vault.finalize(ctx.any.application({ applicationId: 999 }))
      }).toThrow('unknown campaign')
    })

    test('rejects a box that is not failed', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: OPEN, settledAt: 0 })
      expect(() => {
        vault.finalize(campaignApp())
      }).toThrow('campaign is not failed')
    })

    test('rejects finalization while the window is still open', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: FAILED, settledAt: 100 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 100 + WINDOW - 1 })
      expect(() => {
        vault.finalize(campaignApp())
      }).toThrow('refund window still open')
    })

    test('sweeps the residual and deletes the box once the window closes', () => {
      const sweep = ctx.any.account()
      const vault = createVault(sweep)
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 200, root: Z_HEX, n: 1, status: FAILED, settledAt: 100 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 100 + WINDOW })
      vault.finalize(campaignApp())

      expect(vault.campaignBox(CAMPAIGN_APP_ID).exists).toEqual(false)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(sweep)
      expect(toExternalValue(payout.amount)).toEqual(800)
    })

    test('deletes the box without paying when nothing is left', () => {
      const vault = createVault()
      writeBox(vault, CAMPAIGN_APP_ID, { paidIn: 1000, paidOut: 1000, root: Z_HEX, n: 1, status: FAILED, settledAt: 100 })
      ctx.ledger.patchGlobalData({ latestTimestamp: 100 + WINDOW })
      vault.finalize(campaignApp())

      expect(vault.campaignBox(CAMPAIGN_APP_ID).exists).toEqual(false)
    })
  })
})
