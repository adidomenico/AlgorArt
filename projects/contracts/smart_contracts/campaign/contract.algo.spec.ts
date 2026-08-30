import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { beforeEach, describe, expect, test } from 'vitest'
import { Campaign } from './contract.algo'

/**
 * Behavioral tests for the Campaign escrow contract, run against the offline
 * AVM emulation provided by `algorand-typescript-testing`.
 *
 * Coverage target (README + docs/contracts/testing.md): every method × every
 * branch. This file grows incrementally — see the roadmap in
 * docs/contracts/testing.md.
 */

const GOAL = 1_000_000 // microAlgos
const CREATION_TIME = 1_000 // patched latestTimestamp at campaign creation
const DEADLINE = 2_000 // must be strictly after CREATION_TIME
const MIN_BALANCE = 100_000 // default app account min balance in the test runtime

describe('Campaign', () => {
  // A single context is reused; `reset()` in `beforeEach` gives per-test isolation.
  // Creating a second `TestExecutionContext` throws ("context already set").
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
    // `Global.latestTimestamp` defaults to Date.now() (ms) in the offline runtime,
    // so pin it for deterministic deadline checks.
    ctx.ledger.patchGlobalData({ latestTimestamp: CREATION_TIME })
  })

  /** Create a campaign as the default sender (the creator). */
  function createCampaign(goal = GOAL, deadline = DEADLINE) {
    const contract = ctx.contract.create(Campaign)
    contract.create(goal, deadline)
    return contract
  }

  describe('create', () => {
    test('sets creator, goal, deadline, raised and status', () => {
      const contract = createCampaign()

      expect(contract.creator.value).toEqual(ctx.defaultSender)
      expect(contract.goal.value).toEqual(GOAL)
      expect(contract.deadline.value).toEqual(DEADLINE)
      expect(contract.raised.value).toEqual(0)
      expect(contract.status.value).toEqual(0)
    })

    test('rejects a goal of zero', () => {
      const contract = ctx.contract.create(Campaign)
      expect(() => contract.create(0, DEADLINE)).toThrowError('goal must be greater than zero')
    })

    test('rejects a deadline in the past', () => {
      const contract = ctx.contract.create(Campaign)
      // latestTimestamp is pinned to CREATION_TIME, so a deadline equal to it is not in the future.
      expect(() => contract.create(GOAL, CREATION_TIME)).toThrowError('deadline must be in the future')
    })
  })

  describe('pledge', () => {
    test('records the pledge and bumps raised', () => {
      const contract = createCampaign()
      const backer = ctx.defaultSender
      const payment = ctx.any.txn.payment({
        sender: backer,
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 100_000,
      })

      contract.pledge(payment)

      expect(contract.pledges(backer).value).toEqual(100_000)
      expect(contract.raised.value).toEqual(100_000)
    })

    test('re-pledging accumulates into the same box', () => {
      const contract = createCampaign()
      const backer = ctx.defaultSender
      const appAddress = ctx.ledger.getApplicationForContract(contract).address

      contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: appAddress, amount: 100_000 }))
      contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: appAddress, amount: 50_000 }))

      expect(contract.pledges(backer).value).toEqual(150_000)
      expect(contract.raised.value).toEqual(150_000)
    })

    test('rejects a zero pledge', () => {
      const contract = createCampaign()
      const payment = ctx.any.txn.payment({
        sender: ctx.defaultSender,
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 0,
      })

      expect(() => contract.pledge(payment)).toThrowError('pledge must be greater than zero')
    })

    test('rejects a payment to the wrong receiver', () => {
      const contract = createCampaign()
      const payment = ctx.any.txn.payment({
        sender: ctx.defaultSender,
        receiver: ctx.any.account(),
        amount: 100_000,
      })

      expect(() => contract.pledge(payment)).toThrowError('payment must be made to the campaign escrow')
    })

    test('rejects a payment from someone other than the caller', () => {
      const contract = createCampaign()
      const payment = ctx.any.txn.payment({
        sender: ctx.any.account(),
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 100_000,
      })

      expect(() => contract.pledge(payment)).toThrowError('payment must come from the caller')
    })

    test('rejects pledging after the deadline', () => {
      const contract = createCampaign()
      const backer = ctx.defaultSender
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      const payment = ctx.any.txn.payment({
        sender: backer,
        receiver: ctx.ledger.getApplicationForContract(contract).address,
        amount: 100_000,
      })

      expect(() => contract.pledge(payment)).toThrowError('pledging is closed')
    })
  })

  describe('claim', () => {
    test('pays the escrow balance to the creator once the goal is met', () => {
      const contract = createCampaign()
      const appAddress = ctx.ledger.getApplicationForContract(contract).address

      contract.pledge(ctx.any.txn.payment({ sender: ctx.defaultSender, receiver: appAddress, amount: GOAL }))
      // Simulate the pledged funds having arrived at the escrow.
      ctx.ledger.patchAccountData(appAddress, { account: { balance: GOAL + MIN_BALANCE } })

      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.claim()

      expect(contract.status.value).toEqual(2)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(ctx.defaultSender)
      expect(payout.amount).toEqual(GOAL)
    })

    test('rejects a non-creator caller', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })

      const other = ctx.any.account()
      ctx.txn
        .createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other })])
        .execute(() => expect(() => contract.claim()).toThrowError('only the creator can claim'))
    })

    test('rejects claiming before the deadline', () => {
      const contract = createCampaign()
      expect(() => contract.claim()).toThrowError('deadline has not passed')
    })

    test('rejects claiming when the goal was not reached', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => contract.claim()).toThrowError('goal not reached')
    })
  })

  describe('refund', () => {
    test('returns a backer their pledge when the goal was not reached', () => {
      const contract = createCampaign()
      const backer = ctx.defaultSender
      const appAddress = ctx.ledger.getApplicationForContract(contract).address

      contract.pledge(ctx.any.txn.payment({ sender: backer, receiver: appAddress, amount: 100_000 }))
      ctx.ledger.patchAccountData(appAddress, { account: { balance: 100_000 + MIN_BALANCE } })

      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      contract.refund()

      expect(contract.status.value).toEqual(1)
      expect(contract.pledges(backer).exists).toEqual(false)
      const payout = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
      expect(payout.receiver).toEqual(backer)
      expect(payout.amount).toEqual(100_000)
    })

    test('rejects refunding before the deadline', () => {
      const contract = createCampaign()
      expect(() => contract.refund()).toThrowError('deadline has not passed')
    })

    test('rejects refunding when the goal was reached', () => {
      const contract = createCampaign()
      const backer = ctx.defaultSender
      contract.pledge(
        ctx.any.txn.payment({ sender: backer, receiver: ctx.ledger.getApplicationForContract(contract).address, amount: GOAL }),
      )

      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => contract.refund()).toThrowError('goal was reached, no refunds')
    })

    test('rejects a caller with nothing to refund', () => {
      const contract = createCampaign()
      ctx.ledger.patchGlobalData({ latestTimestamp: DEADLINE })
      expect(() => contract.refund()).toThrowError('nothing to refund')
    })
  })
})
