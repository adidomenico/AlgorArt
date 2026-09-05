import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

/**
 * LocalNet integration tests: deploy the compiled Campaign TEAL to a live algod and exercise the full lifecycle (create → pledge → claim,
 * and create → pledge → refund). These are the M4 milestone — proof that the compiled bytecode behaves as the offline AVM tests expect.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifact exists.
 */
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
      // Producing any transaction materialises the new timestamp into a block.
      // A self-payment keeps the bump valid (the sender is already funded).
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

  test('deploys and completes the funded flow (create → pledge → claim)', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    const goal = (1).algo().microAlgo
    const deadline = (await latestBlockTimestamp()) + 30n

    const factory = new AppFactory({ appSpec, algorand, defaultSender: creator.addr })
    const { appClient } = await factory.send.create({
      method: 'create(byte[],byte[],uint64,uint64)void',
      args: [new TextEncoder().encode('Funded campaign'), new TextEncoder().encode('ipfs://funded'), goal, deadline],
      sender: creator.addr,
      suppressLog: true,
    })

    // Global state reflects the campaign parameters.
    const created = await appClient.getGlobalState()
    expect(created.goal?.value).toEqual(goal)
    expect(created.deadline?.value).toEqual(deadline)

    // Pledge 1 ALGO (meets the goal).
    const pledge = await algorand.createTransaction.payment({
      sender: backer.addr,
      receiver: appClient.appAddress,
      amount: (1).algo(),
    })
    await appClient.send.call({
      method: 'pledge(pay)void',
      args: [pledge],
      sender: backer.addr,
      suppressLog: true,
    })

    const pledged = await appClient.getGlobalState()
    expect(pledged.raised?.value).toEqual(goal)

    // Fast-forward past the deadline and claim.
    await advanceTime(60)
    await appClient.send.call({
      method: 'claim()void',
      args: [],
      sender: creator.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })

    const claimed = await appClient.getGlobalState()
    expect(claimed.status?.value).toEqual(2n)
  })

  test('deploys and refunds the failed flow (create → pledge → refund)', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    const goal = (10).algo().microAlgo
    const deadline = (await latestBlockTimestamp()) + 30n

    const factory = new AppFactory({ appSpec, algorand, defaultSender: creator.addr })
    const { appClient } = await factory.send.create({
      method: 'create(byte[],byte[],uint64,uint64)void',
      args: [new TextEncoder().encode('Failed campaign'), new TextEncoder().encode('ipfs://failed'), goal, deadline],
      sender: creator.addr,
      suppressLog: true,
    })

    // Pledge only 1 ALGO (below the 10 ALGO goal).
    const pledge = await algorand.createTransaction.payment({
      sender: backer.addr,
      receiver: appClient.appAddress,
      amount: (1).algo(),
    })
    await appClient.send.call({
      method: 'pledge(pay)void',
      args: [pledge],
      sender: backer.addr,
      suppressLog: true,
    })

    // Fast-forward past the deadline and refund.
    await advanceTime(60)
    await appClient.send.call({
      method: 'refund()void',
      args: [],
      sender: backer.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })

    const state = await appClient.getGlobalState()
    expect(state.status?.value).toEqual(1n)
    // The backer's pledge box is gone after refund.
    const boxes = await appClient.getBoxNames()
    expect(boxes).toHaveLength(0)
  })

  test('delete with no boxes leaves the escrow balance stranded in the app account', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    const factory = new AppFactory({ appSpec, algorand, defaultSender: creator.addr })
    const { appClient } = await factory.send.create({
      method: 'create(byte[],byte[],uint64,uint64)void',
      args: [
        new TextEncoder().encode('Delete me'),
        new TextEncoder().encode('ipfs://delete'),
        (1).algo().microAlgo,
        (await latestBlockTimestamp()) + 30n,
      ],
      sender: creator.addr,
      suppressLog: true,
    })

    // Fund the app account with a surplus above the seeded minimum balance.
    await algorand.send.payment({
      sender: creator.addr,
      receiver: appClient.appAddress,
      amount: (1).algo(),
      suppressLog: true,
    })

    const appBefore = await accountInfo(appClient.appAddress.toString())
    const creatorBefore = await accountInfo(creator.addr.toString())

    await appClient.send.delete({ method: 'delete()void', args: [], sender: creator.addr, suppressLog: true })

    const appAfter = await accountInfo(appClient.appAddress.toString())
    const creatorAfter = await accountInfo(creator.addr.toString())

    // A bare delete returns nothing: the whole balance stays stranded in the now-deleteless app account.
    expect(appAfter.balance).toEqual(appBefore.balance)
    // The creator only pays the 1,000 µA delete fee.
    expect(creatorAfter.balance - creatorBefore.balance).toEqual(-1_000n)
  })

  test('delete with an outstanding pledge box leaves the box and its MBR locked', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    const factory = new AppFactory({ appSpec, algorand, defaultSender: creator.addr })
    const { appClient } = await factory.send.create({
      method: 'create(byte[],byte[],uint64,uint64)void',
      args: [
        new TextEncoder().encode('Delete me'),
        new TextEncoder().encode('ipfs://delete'),
        (10).algo().microAlgo,
        (await latestBlockTimestamp()) + 30n,
      ],
      sender: creator.addr,
      suppressLog: true,
    })

    // One backer pledges 1 ALGO, creating a pledge box.
    const pledge = await algorand.createTransaction.payment({
      sender: backer.addr,
      receiver: appClient.appAddress,
      amount: (1).algo(),
    })
    await appClient.send.call({
      method: 'pledge(pay)void',
      args: [pledge],
      sender: backer.addr,
      suppressLog: true,
    })

    const appBefore = await accountInfo(appClient.appAddress.toString())
    const creatorBefore = await accountInfo(creator.addr.toString())

    await appClient.send.delete({ method: 'delete()void', args: [], sender: creator.addr, suppressLog: true })

    const appAfter = await accountInfo(appClient.appAddress.toString())
    const creatorAfter = await accountInfo(creator.addr.toString())

    // The pledge box survives the app delete, so its MBR stays locked.
    const boxes = await algorand.client.algod.getApplicationBoxes(appClient.appId).do()
    expect(boxes.boxes.length).toBeGreaterThan(0)
    expect(appAfter.minBalance).toEqual(appBefore.minBalance)
    expect(appAfter.balance).toEqual(appBefore.balance)
    expect(creatorAfter.balance - creatorBefore.balance).toEqual(-1_000n)
  })

  test('refund frees the pledge box MBR and pays the backer back', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    const factory = new AppFactory({ appSpec, algorand, defaultSender: creator.addr })
    const { appClient } = await factory.send.create({
      method: 'create(byte[],byte[],uint64,uint64)void',
      args: [
        new TextEncoder().encode('Refund me'),
        new TextEncoder().encode('ipfs://refund'),
        (10).algo().microAlgo,
        (await latestBlockTimestamp()) + 30n,
      ],
      sender: creator.addr,
      suppressLog: true,
    })

    const pledge = await algorand.createTransaction.payment({
      sender: backer.addr,
      receiver: appClient.appAddress,
      amount: (1).algo(),
    })
    await appClient.send.call({
      method: 'pledge(pay)void',
      args: [pledge],
      sender: backer.addr,
      suppressLog: true,
    })

    const appWithBox = await accountInfo(appClient.appAddress.toString())
    const backerBefore = await accountInfo(backer.addr.toString())

    await advanceTime(60)
    await appClient.send.call({
      method: 'refund()void',
      args: [],
      sender: backer.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })

    const appAfter = await accountInfo(appClient.appAddress.toString())
    const backerAfter = await accountInfo(backer.addr.toString())

    // Box name: 'p' prefix (1 byte) + 32-byte address = 33 bytes; value 8 bytes → MBR = 2500 + 400*41 = 18,900 µA.
    const boxMbr = 2_500n + 400n * (33n + 8n)

    expect(appAfter.minBalance).toEqual(appWithBox.minBalance - boxMbr)
    // The backer receives their 1 ALGO back, minus the 2,000 µA of fees (app call + inner payment).
    expect(backerAfter.balance - backerBefore.balance).toEqual(1_000_000n - 2_000n)
  })
})
