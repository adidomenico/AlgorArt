import type { Account, bytes } from '@algorandfoundation/algorand-typescript'
import { Bytes, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import algosdk from 'algosdk'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { Campaign } from './contract.algo'

/**
 * Behavioral tests for the Campaign contract (claim-tree design), run against the offline AVM emulation.
 *
 * Every tree operation runs differentially: expected roots come from the Python reference oracle (`../oracle.py`),
 * driven with the mock payments' real `txnId`s. The vault inner calls (`payBack`/`payClaim`/`settle`/`notifyDelete`)
 * target the stub vault app and succeed as no-ops offline - their real routing and effects run on LocalNet in
 * `contract.integration.test.ts`.
 */

const GOAL = 10_000_000
const CREATION_TIME = 1_000
const DEADLINE = 2_000
const TITLE = Bytes('My first novel')
const METADATA_URI = Bytes('ipfs://QmExample')
const VAULT_APP_ID = 777
const ORACLE = path.resolve(__dirname, '../oracle.py')

describe('Campaign', () => {
  const ctx = new TestExecutionContext()
  let stateFile: string

  beforeEach(() => {
    ctx.reset()
    ctx.ledger.patchGlobalData({ latestTimestamp: CREATION_TIME })
    stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-spec-')), 'state.json')
    oracle('init')
  })

  function oracle(cmd: string, ...args: string[]): unknown {
    const out = execFileSync('python3', [ORACLE, stateFile, cmd, ...args], { encoding: 'utf8' })
    return JSON.parse(out) as unknown
  }

  /**
   * Hex of an account's 32-byte address.
   *
   * @param account The account.
   * @returns Lowercase hex.
   */
  function accountHex(account: Account): string {
    // Puya `bytes` is string-branded statically but Uint8Array at runtime (per the testing lib docs) - hence the bridge.
    return Buffer.from(toExternalValue(account.bytes as unknown as bytes)).toString('hex')
  }

  /** The vault app stub (inner calls to it succeed as no-ops offline; real routing runs on LocalNet). */
  function vaultApp() {
    return ctx.any.application({ applicationId: VAULT_APP_ID })
  }

  /** The vault's app account as an `Account` value for test transactions. */
  function vaultAccount() {
    return ctx.ledger.getAccount(Bytes(algosdk.decodeAddress(algosdk.getApplicationAddress(VAULT_APP_ID).toString()).publicKey))
  }

  function createCampaign(goal = GOAL, deadline = DEADLINE) {
    const contract = ctx.contract.create(Campaign)
    contract.create(vaultApp(), TITLE, METADATA_URI, goal, deadline)
    return contract
  }

  function rootHex(contract: Campaign): string {
    return Buffer.from(toExternalValue(contract.root.value)).toString('hex')
  }

  /** Hex of the first inner app call's method selector (keeps the embedded vault selectors in sync). */
  function firstInnerSelector(): string {
    const call = ctx.txn.lastGroup.getItxnGroup(0).getApplicationCallInnerTxn()
    return Buffer.from(toExternalValue(call.appArgs(0))).toString('hex')
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
   * Pledge `amount` as `backer`, asserting root/n/raised against the oracle at every step.
   *
   * @param contract The campaign to pledge to.
   * @param backer The non-creator backer.
   * @param amount Pledge amount in microAlgos.
   * @returns The pledge payment's TxID (hex), for later spend proofs.
   */
  function pledgeAs(contract: Campaign, backer: Account, amount: number): string {
    const front = oracle('frontier') as { peaks: string[] }
    const frontier = Buffer.concat(front.peaks.map((p) => Buffer.from(p, 'hex')))
    let txid = ''
    ctx.txn
      .createScope([
        ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount }),
        ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
      ])
      .execute(() => {
        // Rebuild the payment handle inside the scope so the mock carries the scope's transaction.
        const pay = ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount })
        txid = Buffer.from(toExternalValue(pay.txnId)).toString('hex')
        contract.pledge(pay, Bytes(frontier))
      })
    const expected = oracle('append', accountHex(backer), amount.toString(), txid) as {
      n: number
      root: string
      raised: number
    }
    expect(contract.n.value).toEqual(expected.n)
    expect(rootHex(contract)).toEqual(expected.root)
    expect(contract.raised.value).toEqual(expected.raised)
    return txid
  }

  describe('create', () => {
    test('sets global state with an empty tree', () => {
      const contract = createCampaign()

      expect(contract.creator.value).toEqual(ctx.defaultSender)
      expect(contract.vault.value.id).toEqual(VAULT_APP_ID)
      expect(contract.title.value).toEqual(TITLE)
      expect(contract.metadataUri.value).toEqual(METADATA_URI)
      expect(contract.goal.value).toEqual(GOAL)
      expect(contract.deadline.value).toEqual(DEADLINE)
      expect(contract.raised.value).toEqual(0)
      expect(contract.status.value).toEqual(0)
      expect(rootHex(contract)).toEqual('00'.repeat(32))
      expect(contract.n.value).toEqual(0)
    })

    test('rejects an empty title', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), Bytes(''), METADATA_URI, GOAL, DEADLINE)
      }).toThrow('title must not be empty')
    })

    test('rejects an overlong title', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), Bytes(Buffer.alloc(129)), METADATA_URI, GOAL, DEADLINE)
      }).toThrow('title too long')
    })

    test('rejects an overlong metadata uri', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(vaultApp(), TITLE, Bytes(Buffer.alloc(129)), GOAL, DEADLINE)
      }).toThrow('metadata uri too long')
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

  describe('pledge', () => {
    test('appends four pledges, root/n/raised matching the oracle at every step', () => {
      const contract = createCampaign()
      const backers = [ctx.any.account(), ctx.any.account(), ctx.any.account()]

      const backerA = backers[0] === undefined ? ctx.defaultSender : backers[0]
      const backerB = backers[1] === undefined ? ctx.defaultSender : backers[1]
      const backerC = backers[2] === undefined ? ctx.defaultSender : backers[2]
      pledgeAs(contract, backerA, 3_000_000)
      pledgeAs(contract, backerB, 1_000_000)
      pledgeAs(contract, backerA, 2_000_000)
      pledgeAs(contract, backerC, 1_000_000)

      expect(contract.n.value).toEqual(4)
      expect(contract.raised.value).toEqual(7_000_000)
    })

    test('rejects pledging after the deadline', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      const backer = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('pledging is closed')
        })
    })

    test('rejects a failed campaign', () => {
      const contract = createCampaign()
      contract.status.value = 1
      const backer = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('campaign is not open')
        })
    })

    test('rejects a payment to the wrong receiver', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const other = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: other, amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: other, amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('payment must be made to the vault')
        })
    })

    test('rejects a payment from someone other than the caller', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const other = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: other, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: other, receiver: vaultAccount(), amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('payment must come from the caller')
        })
    })

    test('rejects a zero pledge', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 0 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 0 }), Bytes(new Uint8Array()))
          }).toThrow('pledge must be greater than zero')
        })
    })

    test('rejects a creator self-pledge', () => {
      const contract = createCampaign()
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: ctx.defaultSender }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(
              ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: vaultAccount(), amount: 100 }),
              Bytes(new Uint8Array()),
            )
          }).toThrow('creator cannot pledge to their own campaign')
        })
    })

    test('rejects a frontier of the wrong length', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 100)
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }), Bytes(new Uint8Array()))
          }).toThrow('bad frontier length')
        })
    })

    test('rejects a forged frontier', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 100)
      const front = oracle('frontier') as { peaks: string[] }
      const forged = Buffer.concat(front.peaks.map((p) => Buffer.from(p, 'hex')))
      forged[0] = forged[0] === 0 ? 1 : 0
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backer }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: vaultAccount(), amount: 100 }), Bytes(forged))
          }).toThrow('stale or forged frontier')
        })
      // State untouched by the failed append.
      const state = oracle('state') as { n: number; root: string; raised: number }
      expect(contract.n.value).toEqual(state.n)
      expect(rootHex(contract)).toEqual(state.root)
    })

    test('rejects a stale frontier after another pledge lands', () => {
      const contract = createCampaign()
      const backerA = ctx.any.account()
      const backerB = ctx.any.account()
      pledgeAs(contract, backerA, 100)
      const front = oracle('frontier') as { peaks: string[] }
      const stale = Buffer.concat(front.peaks.map((p) => Buffer.from(p, 'hex')))
      pledgeAs(contract, backerB, 100)
      ctx.txn
        .createScope([
          ctx.any.txn.payment({ sender: backerA, receiver: vaultAccount(), amount: 100 }),
          ctx.any.txn.applicationCall({ appId: contract, sender: backerA }),
        ])
        .execute(() => {
          expect(() => {
            contract.pledge(ctx.any.txn.payment({ sender: backerA, receiver: vaultAccount(), amount: 100 }), Bytes(stale))
          }).toThrow('stale or forged frontier')
        })
    })
  })

  describe('cancelPledge', () => {
    test('rejects cancellation after the deadline', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.cancelPledge(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('pledging is closed')
    })

    test('rejects cancellation on a non-open campaign', () => {
      const contract = createCampaign()
      contract.status.value = 1
      expect(() => {
        contract.cancelPledge(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('campaign is not open')
    })

    test('cancels a pledge differentially and rejects its double-spend', () => {
      const contract = createCampaign()
      const backerA = ctx.any.account()
      const backerB = ctx.any.account()
      const txidA = pledgeAs(contract, backerA, 1_000_000)
      pledgeAs(contract, backerB, 2_000_000)

      spendAs(contract, backerA, 0, 1_000_000, txidA, 'cancelPledge')
      expect(contract.raised.value).toEqual(2_000_000)
      expect(firstInnerSelector()).toEqual('b0e0eedf')

      // The same proof no longer verifies: the leaf holds Z now.
      const blob = pathBlob(0)
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backerA })]).execute(() => {
        expect(() => {
          contract.cancelPledge(0, 1_000_000, Bytes(Buffer.from(txidA, 'hex')), Bytes(blob))
        }).toThrow('proof does not match root')
      })
      expect(contract.raised.value).toEqual(2_000_000)
    })

    test('rejects spends with malformed inputs', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const txid = pledgeAs(contract, backer, 1_000_000)
      const blob = pathBlob(0)
      const scope = () => ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })])

      scope().execute(() => {
        expect(() => {
          contract.cancelPledge(0, 0, Bytes(Buffer.from(txid, 'hex')), Bytes(blob))
        }).toThrow('amount must be greater than zero')
      })
      scope().execute(() => {
        expect(() => {
          contract.cancelPledge(0, 1_000_000, Bytes(Buffer.alloc(16)), Bytes(blob))
        }).toThrow('bad txid length')
      })
      scope().execute(() => {
        expect(() => {
          contract.cancelPledge(7, 1_000_000, Bytes(Buffer.from(txid, 'hex')), Bytes(blob))
        }).toThrow('unknown position')
      })
      scope().execute(() => {
        expect(() => {
          contract.cancelPledge(0, 1_000_000, Bytes(Buffer.from(txid, 'hex')), Bytes(Buffer.alloc(31)))
        }).toThrow('bad path length')
      })
    })
  })

  describe('refund', () => {
    test('rejects a refund before the deadline', () => {
      const contract = createCampaign()
      expect(() => {
        contract.refund(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('deadline has not passed')
    })

    test('rejects a refund when the goal was reached', () => {
      const contract = createCampaign(100, DEADLINE)
      contract.raised.value = 100
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.refund(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('goal was reached, no refunds')
    })

    test('rejects a refund on a claimed campaign', () => {
      const contract = createCampaign()
      contract.status.value = 2
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.refund(0, 100, Bytes(Buffer.alloc(32)), Bytes(new Uint8Array()))
      }).toThrow('campaign is not refundable')
    })

    test('refunds non-sequentially after the deadline, flipping to failed once', () => {
      const contract = createCampaign()
      const backerA = ctx.any.account()
      const backerB = ctx.any.account()
      const txidA1 = pledgeAs(contract, backerA, 1_000_000)
      const txidB = pledgeAs(contract, backerB, 2_000_000)
      const txidA2 = pledgeAs(contract, backerA, 1_000_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      // k=2: r=0 with a higher peak (exercises hasTop); k=1,0: r=1, c=1. The oracle advances after every null.
      spendAs(contract, backerA, 2, 1_000_000, txidA2, 'refund')
      expect(contract.status.value).toEqual(1)
      spendAs(contract, backerB, 1, 2_000_000, txidB, 'refund')
      spendAs(contract, backerA, 0, 1_000_000, txidA1, 'refund')
      expect(contract.raised.value).toEqual(0)
      expect(contract.n.value).toEqual(3)
    })
  })

  describe('claim', () => {
    test('rejects a non-creator caller', () => {
      const contract = createCampaign()
      const other = ctx.any.account()
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other })]).execute(() => {
        expect(() => {
          contract.claim()
        }).toThrow('only the creator can claim')
      })
    })

    test('rejects a claim before the deadline', () => {
      const contract = createCampaign()
      expect(() => {
        contract.claim()
      }).toThrow('deadline has not passed')
    })

    test('rejects a claim below the goal', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.claim()
      }).toThrow('goal not reached')
    })

    test('rejects a second claim', () => {
      const contract = createCampaign(100, DEADLINE)
      contract.raised.value = 100
      contract.status.value = 2
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.claim()
      }).toThrow('already claimed')
    })

    test('claims a funded campaign end to end', () => {
      const contract = createCampaign(2_000_000, DEADLINE)
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 1_000_000)
      pledgeAs(contract, backer, 1_000_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()

      expect(contract.status.value).toEqual(2)
      expect(firstInnerSelector()).toEqual('f8c4e0cb')
    })
  })

  describe('delete', () => {
    function deleteScope(contract: Campaign, sender: Account) {
      return ctx.txn.createScope([
        ctx.any.txn.applicationCall({ appId: contract, sender, onCompletion: OnCompleteAction.DeleteApplication }),
      ])
    }

    test('rejects a non-creator caller', () => {
      const contract = createCampaign()
      const other = ctx.any.account()
      deleteScope(contract, other).execute(() => {
        expect(() => {
          contract.delete()
        }).toThrow('only the creator can delete')
      })
    })

    test('rejects deleting a campaign with live pledges', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 1_000_000)
      deleteScope(contract, ctx.defaultSender).execute(() => {
        expect(() => {
          contract.delete()
        }).toThrow('cannot delete a campaign with live pledges')
      })
    })

    test('deletes a pristine campaign, settling (a no-op with no box)', () => {
      const contract = createCampaign()
      deleteScope(contract, ctx.defaultSender).execute(() => {
        contract.delete()
      })

      // Settle runs unconditionally for non-claimed campaigns (a no-op here); then the escrow closes.
      expect(firstInnerSelector()).toEqual('09200848')
      const inner = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(inner.receiver).toEqual(ctx.defaultSender)
    })

    test('notifies the vault on a claimed campaign', () => {
      const contract = createCampaign(100, DEADLINE)
      contract.raised.value = 100
      contract.status.value = 2
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      deleteScope(contract, ctx.defaultSender).execute(() => {
        contract.delete()
      })

      expect(firstInnerSelector()).toEqual('87060e1d')
    })

    test('settles the vault on a failed campaign', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      pledgeAs(contract, backer, 1_000_000)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      deleteScope(contract, ctx.defaultSender).execute(() => {
        contract.delete()
      })

      expect(contract.status.value).toEqual(1)
      expect(firstInnerSelector()).toEqual('09200848')
    })

    test('settles the vault on an open campaign with everything cancelled', () => {
      const contract = createCampaign()
      const backer = ctx.any.account()
      const txid = pledgeAs(contract, backer, 1_000_000)
      spendAs(contract, backer, 0, 1_000_000, txid, 'cancelPledge')
      deleteScope(contract, ctx.defaultSender).execute(() => {
        contract.delete()
      })

      expect(firstInnerSelector()).toEqual('09200848')
    })
  })

  /**
   * Spend a leaf via `cancelPledge`/`refund`, asserting root/n/raised against the oracle at every step.
   *
   * @param contract The campaign to spend from.
   * @param backer The leaf owner (rebuilt leaf binds the caller).
   * @param k Leaf position.
   * @param amount Pledged amount committed by the leaf.
   * @param txid Pledge payment TxID (hex).
   * @param method Which spend entry point to exercise.
   */
  function spendAs(contract: Campaign, backer: Account, k: number, amount: number, txid: string, method: 'cancelPledge' | 'refund'): void {
    const blob = pathBlob(k)
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
      if (method === 'cancelPledge') {
        contract.cancelPledge(k, amount, Bytes(Buffer.from(txid, 'hex')), Bytes(blob))
      } else {
        contract.refund(k, amount, Bytes(Buffer.from(txid, 'hex')), Bytes(blob))
      }
    })
    const expected = oracle('null', k.toString(), amount.toString()) as { n: number; root: string; raised: number }
    expect(contract.n.value).toEqual(expected.n)
    expect(rootHex(contract)).toEqual(expected.root)
    expect(contract.raised.value).toEqual(expected.raised)
  }
})
