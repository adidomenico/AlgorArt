import { Bytes, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, expect, test } from 'vitest'
import { Campaign } from './contract.algo'

/**
 * Behavioral tests for the Campaign escrow contract, run against the offline AVM emulation provided by
 * `algorand-typescript-testing`. Claim-ASA balance effects (the mint on `pledge`, the surrender on `refund`/`cancelPledge`, and the
 * supply check in `delete`) are exercised end-to-end on LocalNet in `contract.integration.test.ts`; here every method × branch guard is
 * covered offline.
 */

const GOAL = 1_000_000 // microAlgos
const CREATION_TIME = 1_000 // patched latestTimestamp at campaign creation
const DEADLINE = 2_000 // must be strictly after CREATION_TIME
const MIN_BALANCE = 100_000
const MIN_DEPOSIT = 200_000 // µA the creator funds for the escrow's fixed minimum balance
const TITLE = Bytes('My first novel')
const METADATA_URI = Bytes('ipfs://QmExample')

describe('Campaign', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
    ctx.ledger.patchGlobalData({ latestTimestamp: CREATION_TIME })
  })

  function createCampaign(goal = GOAL, deadline = DEADLINE) {
    const contract = ctx.contract.create(Campaign)
    contract.create(TITLE, METADATA_URI, goal, deadline)
    return contract
  }

  /**
   * The creator funds the escrow's storage deposit via `fund()`, which also issues the Claim ASA.
   *
   * @param contract The campaign to fund.
   * @param amount Deposit amount in microAlgos.
   * @returns The issued Claim ASA.
   */
  function fundAs(contract: Campaign, amount = MIN_DEPOSIT) {
    const appAddress = ctx.ledger.getApplicationForContract(contract).address
    contract.fund(ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: appAddress, amount }))
    return ctx.txn.lastGroup.lastItxnGroup().getAssetConfigInnerTxn().createdAsset
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
    const appAddress = ctx.ledger.getApplicationForContract(contract).address
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
      contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: appAddress, amount }))
    })
  }

  describe('create', () => {
    test('sets global state and leaves the Claim ASA unissued', () => {
      const contract = createCampaign()

      expect(contract.creator.value).toEqual(ctx.defaultSender)
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
        contract.create(Bytes(''), METADATA_URI, GOAL, DEADLINE)
      }).toThrow('title must not be empty')
    })

    test('rejects a goal of zero', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(TITLE, METADATA_URI, 0, DEADLINE)
      }).toThrow('goal must be greater than zero')
    })

    test('rejects a deadline in the past', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => {
        contract.create(TITLE, METADATA_URI, GOAL, CREATION_TIME)
      }).toThrow('deadline must be in the future')
    })
  })

  describe('fund', () => {
    test('issues the Claim ASA and records the deposit', () => {
      const contract = createCampaign()
      fundAs(contract)

      expect(contract.claimAsa.value).not.toEqual(0)
      expect(contract.deposit.value).toEqual(MIN_DEPOSIT)
    })

    test('rejects a second fund (the Claim ASA is issued once)', () => {
      const contract = createCampaign()
      fundAs(contract)
      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      expect(() => {
        contract.fund(ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: appAddress, amount: MIN_DEPOSIT }))
      }).toThrow('claim asset already issued')
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

    test('rejects funding after the campaign is settled', () => {
      const contract = createCampaign()
      contract.status.value = 2
      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      expect(() => {
        contract.fund(ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: appAddress, amount: MIN_DEPOSIT }))
      }).toThrow('campaign is not open')
    })
  })

  describe('pledge', () => {
    test('mints claim units and bumps raised', () => {
      const contract = createCampaign()
      fundAs(contract)
      const a = backerAccount()
      const b = backerAccount()

      pledgeAs(contract, a, 100_000)
      pledgeAs(contract, b, 50_000)
      expect(contract.raised.value).toEqual(150_000)
    })

    test('allows the same backer to pledge repeatedly', () => {
      const contract = createCampaign()
      fundAs(contract)
      const a = backerAccount()

      pledgeAs(contract, a, 40_000)
      pledgeAs(contract, a, 60_000)
      expect(contract.raised.value).toEqual(100_000)
    })

    test('rejects pledging before the Claim ASA is issued', () => {
      const contract = createCampaign()
      const backer = backerAccount()
      const payment = ctx.any.txn.payment({
        sender: backer,
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 100_000,
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
        expect(() => {
          contract.pledge(payment)
        }).toThrow('claim asset not issued yet')
      })
    })

    test('rejects the creator pledging to their own campaign', () => {
      const contract = createCampaign()
      fundAs(contract)
      const payment = ctx.any.txn.payment({
        sender: ctx.defaultSender,
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 100_000,
      })
      expect(() => {
        contract.pledge(payment)
      }).toThrow('creator cannot pledge to their own campaign')
    })

    test('rejects a zero pledge', () => {
      const contract = createCampaign()
      fundAs(contract)
      const backer = backerAccount()
      const payment = ctx.any.txn.payment({
        sender: backer,
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 0,
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
        expect(() => {
          contract.pledge(payment)
        }).toThrow('pledge must be greater than zero')
      })
    })

    test('rejects pledging after the deadline', () => {
      const contract = createCampaign()
      fundAs(contract)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      const backer = backerAccount()
      const payment = ctx.any.txn.payment({
        sender: backer,
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 100_000,
      })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: backer })]).execute(() => {
        expect(() => {
          contract.pledge(payment)
        }).toThrow('pledging is closed')
      })
    })
  })

  describe('refund', () => {
    test('returns a backer their pledge in exchange for claim units', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.ledger.patchAccountData(appAddress, { account: { balance: MIN_DEPOSIT + 60_000 } })
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        contract.refund(
          ctx.any.txn.assetTransfer({
            sender: a,
            xferAsset: claimAsset,
            assetReceiver: appAddress,
            assetAmount: 60_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      })

      expect(contract.status.value).toEqual(1)
      expect(contract.raised.value).toEqual(0)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(a)
      expect(payout.amount).toEqual(60_000)
    })

    test('allows a partial refund, leaving the rest claimable', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.ledger.patchAccountData(appAddress, { account: { balance: MIN_DEPOSIT + 60_000 } })
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        contract.refund(
          ctx.any.txn.assetTransfer({
            sender: a,
            xferAsset: claimAsset,
            assetReceiver: appAddress,
            assetAmount: 10_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      })
      expect(contract.raised.value).toEqual(50_000)
    })

    test('rejects a surrender with closeRemainderTo set', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.ledger.patchAccountData(appAddress, { account: { balance: MIN_DEPOSIT + 60_000 } })
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: appAddress,
              assetAmount: 60_000,
              assetCloseTo: appAddress,
            }),
          )
        }).toThrow('close-out is not allowed here')
      })
    })

    test('rejects surrendering a different asset', () => {
      const contract = createCampaign()
      fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: ctx.any.asset(),
              assetReceiver: appAddress,
              assetAmount: 60_000,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('wrong claim asset')
      })
    })

    test('rejects a zero-amount surrender', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: appAddress,
              assetAmount: 0,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('claim amount must be greater than zero')
      })
    })

    test('rejects a surrender sent to the wrong receiver', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: a,
              assetAmount: 60_000,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('claim units must go to the campaign escrow')
      })
    })

    test('rejects refunding before the deadline', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      expect(() => {
        contract.refund(
          ctx.any.txn.assetTransfer({
            sender: ctx.defaultSender,
            xferAsset: claimAsset,
            assetReceiver: ctx.ledger.getApplicationForContract(contract).address,
            assetAmount: 100_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      }).toThrow('deadline has not passed')
    })

    test('rejects refunding when the goal was reached', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, GOAL)

      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: ctx.ledger.getApplicationForContract(contract).address,
              assetAmount: GOAL,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('goal was reached, no refunds')
      })
    })

    test('rejects refunding a claimed campaign', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, GOAL - 1)

      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.status.value = 2 // claimed (manually, to exercise the branch past the goal check)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.refund(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: ctx.ledger.getApplicationForContract(contract).address,
              assetAmount: 1,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('campaign is not refundable')
      })
    })
  })

  describe('cancelPledge', () => {
    test('returns a backer their pledge and decrements raised', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.ledger.patchAccountData(appAddress, { account: { balance: MIN_DEPOSIT + 60_000 } })

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        contract.cancelPledge(
          ctx.any.txn.assetTransfer({
            sender: a,
            xferAsset: claimAsset,
            assetReceiver: appAddress,
            assetAmount: 60_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      })

      expect(contract.raised.value).toEqual(0)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.amount).toEqual(60_000)
    })

    test('rejects canceling after the deadline', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.cancelPledge(
          ctx.any.txn.assetTransfer({
            sender: ctx.defaultSender,
            xferAsset: claimAsset,
            assetReceiver: ctx.ledger.getApplicationForContract(contract).address,
            assetAmount: 100_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      }).toThrow('pledging is closed')
    })

    test('rejects canceling a settled campaign', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      contract.status.value = 2
      expect(() => {
        contract.cancelPledge(
          ctx.any.txn.assetTransfer({
            sender: ctx.defaultSender,
            xferAsset: claimAsset,
            assetReceiver: ctx.ledger.getApplicationForContract(contract).address,
            assetAmount: 100_000,
            assetCloseTo: zeroAccount(),
          }),
        )
      }).toThrow('campaign is not open')
    })

    test('rejects a surrender with closeRemainderTo set', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 60_000)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.cancelPledge(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: appAddress,
              assetAmount: 60_000,
              assetCloseTo: appAddress,
            }),
          )
        }).toThrow('close-out is not allowed here')
      })
    })
  })

  describe('claim', () => {
    test('pays the spendable escrow balance to the creator once the goal is met', () => {
      const contract = createCampaign()
      fundAs(contract)
      const backer = backerAccount()
      const appAddress = ctx.ledger.getApplicationForContract(contract).address

      pledgeAs(contract, backer, GOAL)
      ctx.ledger.patchAccountData(appAddress, { account: { balance: MIN_DEPOSIT + GOAL } })
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()

      expect(contract.status.value).toEqual(2)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(ctx.defaultSender)
      expect(payout.amount).toEqual(MIN_DEPOSIT + GOAL - MIN_BALANCE)
    })

    test('rejects a second claim', () => {
      const contract = createCampaign()
      fundAs(contract)
      const backer = backerAccount()
      const appAddress = ctx.ledger.getApplicationForContract(contract).address

      pledgeAs(contract, backer, GOAL)
      ctx.ledger.patchAccountData(appAddress, { account: { balance: MIN_DEPOSIT + GOAL } })
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
      fundAs(contract)
      const backer = backerAccount()
      pledgeAs(contract, backer, GOAL - 1)

      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => {
        contract.claim()
      }).toThrow('goal not reached')
    })
  })

  describe('closeOut', () => {
    function claimAs(contract: Campaign, backer: ReturnType<typeof backerAccount>) {
      pledgeAs(contract, backer, GOAL)
      ctx.ledger.patchAccountData(ctx.ledger.getApplicationForContract(contract).address, {
        account: { balance: MIN_DEPOSIT + GOAL },
      })
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()
    }

    test('accepts a close-out to the escrow after a successful claim', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      claimAs(contract, a)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      expect(() => {
        ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
          contract.closeOut(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: appAddress,
              assetAmount: 0,
              assetCloseTo: appAddress,
            }),
          )
        })
      }).not.toThrow()
    })

    test('rejects a close-out without closeRemainderTo', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      claimAs(contract, a)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.closeOut(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: appAddress,
              assetAmount: GOAL,
              assetCloseTo: zeroAccount(),
            }),
          )
        }).toThrow('must close the claim holding to the escrow')
      })
    })

    test('rejects a close-out while the campaign is not claimed', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      pledgeAs(contract, a, 10_000)

      const appAddress = ctx.ledger.getApplicationForContract(contract).address
      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.closeOut(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: appAddress,
              assetAmount: 0,
              assetCloseTo: appAddress,
            }),
          )
        }).toThrow('campaign is not claimed')
      })
    })

    test('rejects a close-out to the wrong receiver', () => {
      const contract = createCampaign()
      const claimAsset = fundAs(contract)
      const a = backerAccount()
      claimAs(contract, a)

      ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: a })]).execute(() => {
        expect(() => {
          contract.closeOut(
            ctx.any.txn.assetTransfer({
              sender: a,
              xferAsset: claimAsset,
              assetReceiver: a,
              assetAmount: 0,
              assetCloseTo: a,
            }),
          )
        }).toThrow('claim units must go to the campaign escrow')
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

    test('rejects an open campaign with live pledges', () => {
      const contract = createCampaign()
      fundAs(contract)
      pledgeAs(contract, backerAccount(), 10_000)
      expect(() => {
        contract.delete()
      }).toThrow('cannot delete a campaign with live pledges')
    })

    test('closes the escrow to the creator for a never-funded open campaign', () => {
      const contract = createCampaign()
      expect(() => {
        contract.delete()
      }).not.toThrow()

      const close = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(close.receiver).toEqual(ctx.defaultSender)
      expect(close.amount).toEqual(0)
    })

    test('closes the escrow to the creator for a settled unfunded campaign', () => {
      const contract = createCampaign()
      contract.status.value = 1 // failed
      expect(() => {
        contract.delete()
      }).not.toThrow()

      const close = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(close.receiver).toEqual(ctx.defaultSender)
    })
  })
})
