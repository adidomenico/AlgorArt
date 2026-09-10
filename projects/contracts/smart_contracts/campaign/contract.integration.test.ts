import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

/**
 * LocalNet integration tests: deploy the compiled Campaign TEAL to a live algod and exercise the full Claim-ASA lifecycle end-to-end,
 * checking every balance, minimum balance (MBR), ASA configuration and fee along the way.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifact exists.
 */

// --- protocol / contract constants (see docs/campaign.md "Minimum balances") ---
const ALGO = 1_000_000n // microAlgos in one ALGO
const BASE = 100_000n // network-wide account base minimum balance
const MIN_DEPOSIT = 200_000n // escrow MBR: base + created asset (the creator's supply holding is implicit, no opt-in cost)
const ESCROW_MIN_BALANCE = BASE + 100_000n
const TOTAL_CLAIM_UNITS = 2n ** 64n - 1n
const TXN_FEE = 1_000n

describe('Campaign (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let appSpec: Arc56Contract

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand
    appSpec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json'), 'utf8')) as Arc56Contract
  })

  afterAll(async () => {
    // Leave the localnet block timestamp offset reset.
    const algod = algorand.client.algod
    await algod
      .setBlockOffsetTimestamp(0)
      .do()
      .catch(() => undefined)
  })

  /**
   * Advance the dev-mode block timestamp by `seconds` and confirm a new block.
   *
   * @param seconds Offset to add to the current block timestamp.
   */
  async function advanceTime(seconds: number) {
    const algod = algorand.client.algod
    try {
      await algod.setBlockOffsetTimestamp(seconds).do()
      await algorand.send.payment({
        sender: fixture.context.testAccount.addr,
        receiver: fixture.context.testAccount.addr,
        amount: (0.001).algo(),
        suppressLog: true,
      })
    } finally {
      await algod.setBlockOffsetTimestamp(0).do()
    }
  }

  async function latestBlockTimestamp(): Promise<bigint> {
    const algod = algorand.client.algod
    const status = await algod.status().do()
    const block = await algod.block(status.lastRound).do()
    return block.block.header.timestamp
  }

  /**
   * Read an account's balance and minimum balance, in microAlgos.
   *
   * @param address The account address.
   */
  async function accountInfo(address: string) {
    const info = await algorand.account.getInformation(address)
    return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo }
  }

  async function createCampaign(creatorAddr: string, title: string, goal: bigint) {
    const deadline = (await latestBlockTimestamp()) + 30n
    const factory = new AppFactory({ appSpec, algorand, defaultSender: creatorAddr })
    const { appClient } = await factory.send.create({
      method: 'create(byte[],byte[],uint64,uint64)void',
      args: [new TextEncoder().encode(title), new TextEncoder().encode('ipfs://test'), goal, deadline],
      sender: creatorAddr,
      suppressLog: true,
    })
    return appClient
  }

  /**
   * The id of the campaign's Claim ASA, read from global state.
   *
   * @param appClient The deployed campaign client.
   */
  async function claimAsaOf(appClient: AppClient): Promise<bigint> {
    const value = await appClient.state.global.getValue('claimAsa')
    return value as bigint
  }

  /**
   * The creator funds the escrow's storage deposit via `fund()`, issuing the Claim ASA.
   *
   * @param appClient The deployed campaign client.
   * @param creatorAddr The creator's address.
   * @param amount Deposit amount in microAlgos.
   */
  async function fundAs(appClient: AppClient, creatorAddr: string, amount = MIN_DEPOSIT) {
    const payment = await algorand.createTransaction.payment({
      sender: creatorAddr,
      receiver: appClient.appAddress,
      amount: microAlgos(amount),
    })
    await appClient.send.call({
      method: 'fund(pay)void',
      args: [payment],
      sender: creatorAddr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  /**
   * Opt `backerAddr` into the Claim ASA (the mint on pledge requires the holding to exist).
   *
   * @param backerAddr The backer's address.
   * @param claimAsa The Claim ASA id.
   */
  async function optInAs(backerAddr: string, claimAsa: bigint) {
    await algorand.send.assetOptIn({ sender: backerAddr, assetId: claimAsa, suppressLog: true })
  }

  /**
   * Pledge `amount` as `backer`.
   *
   * @param appClient The deployed campaign client.
   * @param backerAddr The backer's address.
   * @param claimAsa The Claim ASA id.
   * @param amount Pledge amount in microAlgos.
   */
  async function pledgeAs(appClient: AppClient, backerAddr: string, claimAsa: bigint, amount: bigint) {
    const payment = await algorand.createTransaction.payment({
      sender: backerAddr,
      receiver: appClient.appAddress,
      amount: microAlgos(amount),
    })
    await appClient.send.call({
      method: 'pledge(pay)void',
      args: [payment],
      sender: backerAddr,
      assetReferences: [claimAsa],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  /**
   * The backer's Claim ASA balance, in units (0 when not opted in).
   *
   * @param backerAddr The backer's address.
   * @param claimAsa The Claim ASA id.
   */
  async function claimBalanceOf(backerAddr: string, claimAsa: bigint): Promise<bigint> {
    try {
      return (await algorand.asset.getAccountInformation(backerAddr, claimAsa)).balance
    } catch {
      return 0n
    }
  }

  /**
   * Surrender `amount` claim units to the escrow via `refund`, receiving the same microAlgo amount back.
   *
   * @param appClient The deployed campaign client.
   * @param backerAddr The backer's address.
   * @param claimAsa The Claim ASA id.
   * @param amount Claim units to surrender.
   */
  async function refundAs(appClient: AppClient, backerAddr: string, claimAsa: bigint, amount: bigint) {
    const axfer = await algorand.createTransaction.assetTransfer({
      sender: backerAddr,
      assetId: claimAsa,
      receiver: appClient.appAddress,
      amount: amount,
    })
    await appClient.send.call({
      method: 'refund(axfer)void',
      args: [axfer],
      sender: backerAddr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  async function cancelAs(appClient: AppClient, backerAddr: string, claimAsa: bigint, amount: bigint) {
    const axfer = await algorand.createTransaction.assetTransfer({
      sender: backerAddr,
      assetId: claimAsa,
      receiver: appClient.appAddress,
      amount: amount,
    })
    await appClient.send.call({
      method: 'cancelPledge(axfer)void',
      args: [axfer],
      sender: backerAddr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  /**
   * Close the backer's Claim ASA holding back to the escrow (post-success claim cleanup).
   *
   * @param appClient The deployed campaign client.
   * @param backerAddr The backer's address.
   * @param claimAsa The Claim ASA id.
   */
  async function closeOutAs(appClient: AppClient, backerAddr: string, claimAsa: bigint) {
    const axfer = await algorand.createTransaction.assetTransfer({
      sender: backerAddr,
      assetId: claimAsa,
      receiver: appClient.appAddress,
      amount: 0n,
      closeAssetTo: appClient.appAddress,
    })
    await appClient.send.call({ method: 'closeOut(axfer)void', args: [axfer], sender: backerAddr, suppressLog: true })
  }

  async function claimAs(appClient: AppClient, creatorAddr: string) {
    await appClient.send.call({
      method: 'claim()void',
      args: [],
      sender: creatorAddr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  async function deleteAs(appClient: AppClient, creatorAddr: string, claimAsa: bigint) {
    await appClient.send.delete({
      method: 'delete()void',
      args: [],
      sender: creatorAddr,
      assetReferences: [claimAsa],
      extraFee: (2000).microAlgo(),
      suppressLog: true,
    })
  }

  test('create + fund: the Claim ASA exists with the escrow as manager and a constant minimum balance', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'ASA campaign', (10).algo().microAlgo)
    const escrow = appClient.appAddress.toString()

    // Before fund: the escrow is empty; the creator carries the sponsorship floor on their own account.
    const escrowBefore = await accountInfo(escrow)
    expect(escrowBefore.balance).toEqual(0n)
    const creatorBefore = await accountInfo(creator.addr.toString())
    expect(creatorBefore.minBalance).toBeGreaterThan(BASE)

    await fundAs(appClient, creator.addr.toString())

    const claimAsa = await claimAsaOf(appClient)
    expect(claimAsa).toBeGreaterThan(0n)

    // The escrow minimum balance is exactly base + the created asset: 200,000 µA — constant regardless of the backer count.
    const escrowAfter = await accountInfo(escrow)
    expect(escrowAfter.balance).toEqual(MIN_DEPOSIT)
    expect(escrowAfter.minBalance).toEqual(ESCROW_MIN_BALANCE)

    // The Claim ASA: fixed total, 0 decimals, manager = the escrow, no reserve/freeze/clawback (bearer instrument).
    const asset = await algorand.asset.getById(claimAsa)
    expect(asset.total).toEqual(TOTAL_CLAIM_UNITS)
    expect(asset.decimals).toEqual(0)
    expect(asset.manager).toEqual(escrow)
    expect(asset.reserve).toBeUndefined()
    expect(asset.freeze).toBeUndefined()
    expect(asset.clawback).toBeUndefined()
  })

  test('pledge: mints the exact claim units, 1 unit per microAlgo, and multiple pledges accumulate', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Mint me', (100).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString())
    const claimAsa = await claimAsaOf(appClient)

    await optInAs(backer.addr.toString(), claimAsa)
    const escrow = appClient.appAddress.toString()

    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(ALGO)

    // The same backer pledges again: units accumulate on the backer's account.
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, 2n * ALGO)
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(3n * ALGO)

    // The escrow balance is the deposit + the live pledges; its minimum balance did not grow with the backers.
    const escrowInfo = await accountInfo(escrow)
    expect(escrowInfo.balance).toEqual(MIN_DEPOSIT + 3n * ALGO)
    expect(escrowInfo.minBalance).toEqual(ESCROW_MIN_BALANCE)
  })

  test('pledge guards: creator cannot self-pledge, pledging before fund() fails', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Guard me', (100).algo().microAlgo)

    // No fund() yet: the Claim ASA does not exist.
    await expect(pledgeAs(appClient, backer.addr.toString(), 999n, ALGO)).rejects.toThrow(/claim asset not issued yet/)

    await fundAs(appClient, creator.addr.toString())
    const claimAsa = await claimAsaOf(appClient)
    await optInAs(backer.addr.toString(), claimAsa)

    // The creator cannot pledge to their own campaign.
    const selfPayment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: appClient.appAddress,
      amount: microAlgos(ALGO),
    })
    await expect(
      appClient.send.call({
        method: 'pledge(pay)void',
        args: [selfPayment],
        sender: creator.addr.toString(),
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/creator cannot pledge to their own campaign/)
  })

  test('cancelPledge: a backer withdraws before the deadline and the units are surrendered', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Cancel me', (10).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString())
    const claimAsa = await claimAsaOf(appClient)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    const before = await accountInfo(backer.addr.toString())
    await cancelAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    const after = await accountInfo(backer.addr.toString())

    // The full pledge is returned, minus the surrender transfer, app-call, and inner-payment fees; the units are gone.
    expect(after.balance - before.balance).toEqual(ALGO - 3n * TXN_FEE)
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(0n)

    // A second cancel of the same units fails: the backer no longer holds them.
    await expect(cancelAs(appClient, backer.addr.toString(), claimAsa, ALGO)).rejects.toThrow()
  })

  test('failed flow: every backer refunds their own pledge, nobody else can, and the creator sweeps the deposit', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backer1, backer2, outsider] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const appClient = await createCampaign(creator.addr.toString(), 'Failed campaign', (10).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString())
    const claimAsa = await claimAsaOf(appClient)
    const escrow = appClient.appAddress.toString()

    for (const backer of [backer1, backer2]) {
      await optInAs(backer.addr.toString(), claimAsa)
      await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    }

    // Refund before the deadline fails.
    await expect(refundAs(appClient, backer1.addr.toString(), claimAsa, ALGO)).rejects.toThrow(/deadline has not passed/)

    await advanceTime(60)

    // An outsider with no claim units cannot redeem anything: the surrender transfer fails at apply time.
    await optInAs(outsider.addr.toString(), claimAsa)
    await expect(refundAs(appClient, outsider.addr.toString(), claimAsa, ALGO)).rejects.toThrow()

    // Each backer refunds their full pledge without any platform involvement.
    for (const backer of [backer1, backer2]) {
      const before = await accountInfo(backer.addr.toString())
      await refundAs(appClient, backer.addr.toString(), claimAsa, ALGO)
      const after = await accountInfo(backer.addr.toString())
      expect(after.balance - before.balance).toEqual(ALGO - 3n * TXN_FEE)
      expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(0n)
    }

    // The same claim cannot be redeemed twice: backer1 no longer holds units, so a second refund fails at the transfer.
    await expect(refundAs(appClient, backer1.addr.toString(), claimAsa, ALGO)).rejects.toThrow()

    // The escrow holds exactly the creator's deposit.
    const escrowAfter = await accountInfo(escrow)
    expect(escrowAfter.balance).toEqual(MIN_DEPOSIT)

    // The creator deletes: the ASA is destroyed and the deposit comes back.
    const creatorBefore = await accountInfo(creator.addr.toString())
    await deleteAs(appClient, creator.addr.toString(), claimAsa)
    const creatorAfter = await accountInfo(creator.addr.toString())

    expect(creatorAfter.balance - creatorBefore.balance).toEqual(MIN_DEPOSIT - 3n * TXN_FEE)
    expect(creatorAfter.minBalance).toEqual(BASE) // sponsorship floor freed
    await expect(algorand.asset.getById(claimAsa)).rejects.toThrow() // the Claim ASA is gone
  })

  test('failed flow with partial refunds: refunds are pull-based and repeatable', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Partial refund', (10).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString())
    const claimAsa = await claimAsaOf(appClient)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, 2n * ALGO)

    await advanceTime(60)

    // Refund half, then the other half.
    await refundAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(ALGO)
    await refundAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(0n)

    // Refunding more than the remaining claim fails.
    await expect(refundAs(appClient, backer.addr.toString(), claimAsa, ALGO)).rejects.toThrow()
  })

  test('funded flow: the creator claims after the deadline, backers close out, delete destroys the ASA and returns everything', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backer1, backer2] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const backers = [backer1, backer2]
    const appClient = await createCampaign(creator.addr.toString(), 'Funded campaign', (2).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString())
    const claimAsa = await claimAsaOf(appClient)
    const escrow = appClient.appAddress.toString()

    for (const backer of backers) {
      await optInAs(backer.addr.toString(), claimAsa)
      await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    }

    // Claim before the deadline fails.
    await expect(claimAs(appClient, creator.addr.toString())).rejects.toThrow(/deadline has not passed/)

    await advanceTime(60)

    // The creator claims: balance − minBalance = pledges + deposit surplus.
    const creatorBeforeClaim = await accountInfo(creator.addr.toString())
    await claimAs(appClient, creator.addr.toString())
    const creatorAfterClaim = await accountInfo(creator.addr.toString())

    const expectedClaim = MIN_DEPOSIT + 2n * ALGO - ESCROW_MIN_BALANCE
    expect(creatorAfterClaim.balance - creatorBeforeClaim.balance).toEqual(expectedClaim - 2n * TXN_FEE)

    const escrowAfterClaim = await accountInfo(escrow)
    expect(escrowAfterClaim.balance).toEqual(ESCROW_MIN_BALANCE)

    // A second claim fails.
    await expect(claimAs(appClient, creator.addr.toString())).rejects.toThrow(/already claimed/)

    // Backers cannot refund a successful campaign (the goal was reached).
    await expect(refundAs(appClient, backer1.addr.toString(), claimAsa, ALGO)).rejects.toThrow(/goal was reached, no refunds/)

    // Delete fails while claim units are still outstanding (the escrow does not hold the whole supply).
    await expect(deleteAs(appClient, creator.addr.toString(), claimAsa)).rejects.toThrow(/claim units outstanding/)

    // Each backer closes out their now-worthless claim: their units return to the escrow and their 0.1 ALGO opt-in MBR is freed.
    for (const backer of backers) {
      const before = await accountInfo(backer.addr.toString())
      await closeOutAs(appClient, backer.addr.toString(), claimAsa)
      const after = await accountInfo(backer.addr.toString())
      expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(0n)
      expect(after.minBalance).toEqual(before.minBalance - 100_000n)
    }

    // Now the delete succeeds: ASA destroyed, residual (base + asset MBR) closed to the creator, floor freed.
    const creatorBeforeDelete = await accountInfo(creator.addr.toString())
    await deleteAs(appClient, creator.addr.toString(), claimAsa)
    const creatorAfterDelete = await accountInfo(creator.addr.toString())

    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(ESCROW_MIN_BALANCE - 3n * TXN_FEE)
    expect(creatorAfterDelete.minBalance).toEqual(BASE)
    await expect(algorand.asset.getById(claimAsa)).rejects.toThrow()
  })

  test('claim guards: non-creator, below goal, and a never-funded campaign cannot be claimed', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Unfunded campaign', (10).algo().microAlgo)

    // Below goal (zero pledges): claim fails even after the deadline.
    await advanceTime(60)
    await expect(claimAs(appClient, creator.addr.toString())).rejects.toThrow(/goal not reached/)

    // A non-creator cannot claim.
    await expect(claimAs(appClient, backer.addr.toString())).rejects.toThrow(/only the creator can claim/)
  })

  test('delete guards: open campaigns, outstanding pledges, and non-creators are rejected', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backer1, backer2] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const appClient = await createCampaign(creator.addr.toString(), 'Delete guards', (10).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString())
    const claimAsa = await claimAsaOf(appClient)
    for (const backer of [backer1, backer2]) {
      await optInAs(backer.addr.toString(), claimAsa)
      await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    }

    // Open campaign with live pledges: nobody can delete.
    await expect(deleteAs(appClient, creator.addr.toString(), claimAsa)).rejects.toThrow(/cannot delete a campaign with live pledges/)

    // Non-creator cannot delete.
    await expect(deleteAs(appClient, backer1.addr.toString(), claimAsa)).rejects.toThrow(/only the creator can delete/)

    // Failed campaign with outstanding units: delete is blocked (backer2's ALGO is still in the escrow).
    await advanceTime(60)
    await refundAs(appClient, backer1.addr.toString(), claimAsa, ALGO) // materializes Failed
    await expect(deleteAs(appClient, creator.addr.toString(), claimAsa)).rejects.toThrow(/claim units outstanding/)

    // After the last backer refunds, the delete succeeds.
    await refundAs(appClient, backer2.addr.toString(), claimAsa, ALGO)
    await deleteAs(appClient, creator.addr.toString(), claimAsa)
  })

  test('refund rejects the wrong asset', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Wrong asset', (10).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString())
    const claimAsa = await claimAsaOf(appClient)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    // A second campaign's Claim ASA: the backer can hold it, but this escrow is not opted in, so the surrender transfer itself fails
    // before the app call (the transfer, not the contract, is the first line of defense against foreign claim assets).
    const other = await createCampaign(creator.addr.toString(), 'Other claim', (10).algo().microAlgo)
    await fundAs(other, creator.addr.toString())
    const otherClaimAsa = await claimAsaOf(other)
    await optInAs(backer.addr.toString(), otherClaimAsa)

    await advanceTime(60)
    const wrongAxfer = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: otherClaimAsa,
      receiver: appClient.appAddress,
      amount: 1n,
    })
    await expect(
      appClient.send.call({
        method: 'refund(axfer)void',
        args: [wrongAxfer],
        sender: backer.addr.toString(),
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow()
  })

  test('an abandoned campaign (created but never funded) can be deleted by its creator', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Abandoned', (10).algo().microAlgo)

    const creatorBefore = await accountInfo(creator.addr.toString())
    await appClient.send.delete({
      method: 'delete()void',
      args: [],
      sender: creator.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    const creatorAfter = await accountInfo(creator.addr.toString())
    expect(creatorAfter.minBalance).toEqual(BASE) // sponsorship floor freed with no residual
    expect(creatorAfter.balance - creatorBefore.balance).toEqual(-2n * TXN_FEE)
  })
})
