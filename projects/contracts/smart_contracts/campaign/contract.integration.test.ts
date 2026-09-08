import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import algosdk from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { FANOUT, WideTree, leafHash, siblingsFor } from '../merkle/tree'

/**
 * LocalNet integration tests: deploy the compiled Campaign TEAL to a live algod and exercise the full lifecycle end-to-end, checking every
 * balance, minimum balance (MBR) and fee along the way.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifact exists.
 */

// --- protocol / contract constants (see docs/campaign.md "Boxes & minimum balance") ---
const ALGO = 1_000_000n // microAlgos in one ALGO
const BASE = 100_000n // network-wide account base minimum balance
const FRONTIER_MBR = 2_500n + 400n * (1n + 1344n) // 540,500 µA: the frontier box ('f' + 1344-byte value)
const SHARD_MBR = 2_500n + 400n * (9n + 1024n) // 415,700 µA: one spent shard ('s' + 8-byte key, 1024-byte value)
const MIN_DEPOSIT = 100_000n + FRONTIER_MBR + 4n * SHARD_MBR // base + frontier + 4 shards
// 571,000 µA: app base + global-state schema (6 ints + 4 bytes) + one extra program page, carried on the creator.
const CREATOR_FLOOR = 100_000n + 28_500n * 6n + 50_000n * 4n + 100_000n
const TXN_FEE = 1_000n
const TREE_HEIGHT = 5

describe('Campaign (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let appSpec: Arc56Contract

  // The reference tree mirrors the contract's on-chain tree; proofs for refund/cancel are generated from it.
  let tree: WideTree
  let leaves: Uint8Array[]

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand
    appSpec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json'), 'utf8')) as Arc56Contract
  })

  beforeEach(() => {
    tree = new WideTree(FANOUT, TREE_HEIGHT)
    leaves = []
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
   * The creator funds the escrow's storage deposit via `fund()`.
   *
   * @param appClient The deployed campaign client.
   * @param creatorAddr The creator's address.
   * @param amount Deposit amount in microAlgos.
   */
  async function fundAs(appClient: AppClient, creatorAddr: string, amount: bigint) {
    const payment = await algorand.createTransaction.payment({
      sender: creatorAddr,
      receiver: appClient.appAddress,
      amount: microAlgos(amount),
    })
    await appClient.send.call({ method: 'fund(pay)void', args: [payment], sender: creatorAddr, suppressLog: true })
  }

  /**
   * Pledge `amount` as `backer`, mirroring the leaf in the reference tree.
   *
   * @param appClient The deployed campaign client.
   * @param backerAddr The backer's address.
   * @param amount Pledge amount in microAlgos.
   * @returns The slot index the pledge occupied.
   */
  async function pledgeAs(appClient: AppClient, backerAddr: string, amount: bigint): Promise<number> {
    const payment = await algorand.createTransaction.payment({
      sender: backerAddr,
      receiver: appClient.appAddress,
      amount: microAlgos(amount),
    })
    await appClient.send.call({ method: 'pledge(pay)void', args: [payment], sender: backerAddr, suppressLog: true })
    const leaf = leafHash(algosdk.decodeAddress(backerAddr).publicKey, amount)
    leaves.push(leaf)
    return tree.append(leaf)
  }

  function proofFor(index: number): Uint8Array {
    return Buffer.concat(siblingsFor(leaves, FANOUT, TREE_HEIGHT, index))
  }

  async function refundAs(appClient: AppClient, backerAddr: string, index: number, amount: bigint) {
    await appClient.send.call({
      method: 'refund(byte[],uint64,uint64)void',
      args: [proofFor(index), index, amount],
      sender: backerAddr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  async function cancelAs(appClient: AppClient, backerAddr: string, index: number, amount: bigint) {
    await appClient.send.call({
      method: 'cancelPledge(byte[],uint64,uint64)void',
      args: [proofFor(index), index, amount],
      sender: backerAddr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  test('cancelPledge happy path: a backer withdraws their pledge before the deadline', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Cancel me', (10).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString(), MIN_DEPOSIT)

    const index = await pledgeAs(appClient, backer.addr.toString(), ALGO)

    const before = await accountInfo(backer.addr.toString())
    await cancelAs(appClient, backer.addr.toString(), index, ALGO)
    const after = await accountInfo(backer.addr.toString())

    // The full pledge is returned, minus the app-call + inner-payment fees.
    expect(after.balance - before.balance).toEqual(ALGO - 2n * TXN_FEE)

    // A second cancel of the same leaf fails (already spent).
    await expect(cancelAs(appClient, backer.addr.toString(), index, ALGO)).rejects.toThrow(/already spent/)
  })

  test('large campaign: 10 backers pledge and refund within the opcode budget', { timeout: 60_000 }, async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Big campaign', (1_000).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString(), MIN_DEPOSIT)

    // 10 backers cross the first carry point (the 8th backer fills a level and merges it into the next).
    const backers = await Promise.all(
      Array.from({ length: 10 }, () => fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })),
    )

    const indices: { backer: (typeof backers)[number]; index: number }[] = []
    for (const backer of backers) {
      const index = await pledgeAs(appClient, backer.addr.toString(), ALGO)
      indices.push({ backer, index })
    }

    // Fast-forward and refund everyone — each refund exercises the full proof-verification chain.
    await advanceTime(60)
    for (const { backer, index } of indices) {
      await refundAs(appClient, backer.addr.toString(), index, ALGO)
    }
  })

  test('funded flow: 3 backers pledge, creator claims, creator deletes and recovers everything', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backer1, backer2, backer3] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const backers = [backer1, backer2, backer3]
    const appClient = await createCampaign(creator.addr.toString(), 'Funded campaign', (3).algo().microAlgo)

    const escrow = appClient.appAddress.toString()

    // After create: the escrow is empty; the creator carries the sponsorship floor on their own account.
    const creatorAfterCreate = await accountInfo(creator.addr.toString())
    const escrowAfterCreate = await accountInfo(escrow)
    expect(escrowAfterCreate.balance).toEqual(0n)
    expect(creatorAfterCreate.minBalance).toEqual(100_000n + CREATOR_FLOOR)

    // The creator funds the storage deposit.
    await fundAs(appClient, creator.addr.toString(), MIN_DEPOSIT)

    // Three backers pledge 1 ALGO each.
    for (const backer of backers) {
      await pledgeAs(appClient, backer.addr.toString(), ALGO)
    }

    const escrowAfterPledges = await accountInfo(escrow)
    expect(escrowAfterPledges.balance).toEqual(MIN_DEPOSIT + 3n * ALGO)
    // Only the frontier box has been created (no cancels/refunds yet).
    expect(escrowAfterPledges.minBalance).toEqual(BASE + FRONTIER_MBR)

    // Fast-forward and claim: creator receives balance - minBalance.
    await advanceTime(60)
    const creatorBeforeClaim = await accountInfo(creator.addr.toString())
    await appClient.send.call({ method: 'claim()void', args: [], sender: creator.addr, extraFee: (1000).microAlgo(), suppressLog: true })
    const creatorAfterClaim = await accountInfo(creator.addr.toString())

    // Claim pays pledges + deposit excess over min balance: (deposit + 3 ALGO) - (base + frontier).
    const expectedClaim = MIN_DEPOSIT + 3n * ALGO - (BASE + FRONTIER_MBR)
    expect(creatorAfterClaim.balance - creatorBeforeClaim.balance).toEqual(expectedClaim - 2n * TXN_FEE)

    const escrowAfterClaim = await accountInfo(escrow)
    expect(escrowAfterClaim.balance).toEqual(BASE + FRONTIER_MBR)

    // Delete (claimed): frontier deleted, escrow closed to the creator, sponsorship floor freed.
    const creatorBeforeDelete = await accountInfo(creator.addr.toString())
    await appClient.send.delete({
      method: 'delete()void',
      args: [],
      sender: creator.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    const creatorAfterDelete = await accountInfo(creator.addr.toString())

    // CloseRemainderTo returns the residual (base + frontier MBR) minus the delete fees.
    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(BASE + FRONTIER_MBR - 2n * TXN_FEE)
    expect(creatorAfterDelete.minBalance).toEqual(100_000n) // floor freed

    // Net: the creator recovered the deposit plus all 3 ALGO pledged, paying only fees (create + fund + claim + delete).
    const creatorFinal = await accountInfo(creator.addr.toString())
    expect(creatorFinal.balance).toEqual(10n * ALGO + 3n * ALGO - 7n * TXN_FEE)
  })

  test('failed flow: 3 backers pledge, all refund in full, creator deletes to recover the deposit', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backer1, backer2, backer3] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const backers = [backer1, backer2, backer3]
    const appClient = await createCampaign(creator.addr.toString(), 'Failed campaign', (10).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString(), MIN_DEPOSIT)

    const escrow = appClient.appAddress.toString()

    const pledges: { backer: (typeof backers)[number]; index: number }[] = []
    for (const backer of backers) {
      const index = await pledgeAs(appClient, backer.addr.toString(), ALGO)
      pledges.push({ backer, index })
    }

    // Fast-forward and let each backer refund their full pledge (the deposit covers the storage MBR).
    await advanceTime(60)
    for (const { backer, index } of pledges) {
      const before = await accountInfo(backer.addr.toString())
      await refundAs(appClient, backer.addr.toString(), index, ALGO)
      const after = await accountInfo(backer.addr.toString())
      expect(after.balance - before.balance).toEqual(ALGO - 2n * TXN_FEE)
    }

    // Escrow now holds exactly the deposit.
    const escrowAfterRefunds = await accountInfo(escrow)
    expect(escrowAfterRefunds.balance).toEqual(MIN_DEPOSIT)

    // Delete: deposit recovered, floor freed.
    const creatorBeforeDelete = await accountInfo(creator.addr.toString())
    await appClient.send.delete({
      method: 'delete()void',
      args: [],
      sender: creator.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    const creatorAfterDelete = await accountInfo(creator.addr.toString())

    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(MIN_DEPOSIT - 2n * TXN_FEE)
    expect(creatorAfterDelete.minBalance).toEqual(100_000n)
  })

  test('delete guards: open campaign, non-creator, and failed-with-outstanding-pledge all fail', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer2 = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Guard me', (10).algo().microAlgo)
    await fundAs(appClient, creator.addr.toString(), MIN_DEPOSIT)

    // 1. Open campaign cannot be deleted.
    await expect(
      appClient.send.delete({ method: 'delete()void', args: [], sender: creator.addr, extraFee: (1000).microAlgo(), suppressLog: true }),
    ).rejects.toThrow(/cannot delete an open campaign/)

    // 2. Non-creator cannot delete (the creator guard is checked first).
    const index = await pledgeAs(appClient, backer.addr.toString(), ALGO)
    await expect(
      appClient.send.delete({ method: 'delete()void', args: [], sender: backer.addr, extraFee: (1000).microAlgo(), suppressLog: true }),
    ).rejects.toThrow(/only the creator can delete/)

    // 3. A failed campaign with an outstanding pledge cannot be deleted (backer's ALGO still in the escrow).
    await pledgeAs(appClient, backer2.addr.toString(), ALGO)
    await advanceTime(60)
    await refundAs(appClient, backer.addr.toString(), index, ALGO) // backer refunds; backer2's pledge remains

    await expect(
      appClient.send.delete({ method: 'delete()void', args: [], sender: creator.addr, extraFee: (1000).microAlgo(), suppressLog: true }),
    ).rejects.toThrow(/cannot delete with funds remaining/)
  })
})
