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
 * LocalNet integration tests: deploy the compiled Campaign TEAL to a live algod and exercise the full lifecycle end-to-end, checking every
 * balance, minimum balance (MBR) and fee along the way.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifact exists.
 */

// --- protocol / contract constants (see docs/campaign.md "Boxes & minimum balance") ---
const ALGO = 1_000_000n // microAlgos in one ALGO
const BASE = 100_000n // network-wide account base minimum balance
const BOX_MBR = 2_500n + 400n * (33n + 8n) // 18,900 µA: one pledge box ('p' + 32-byte key, 8-byte value)
const CREATOR_FLOOR = 100_000n + 28_500n * 4n + 50_000n * 3n // 364,000 µA: app base + global-state schema carried on the creator
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

  /**
   * Log a labelled set of account snapshots (balance / minimum balance in µA).
   *
   * @param label Human-readable label for the log line.
   * @param accounts Map of account name → address to snapshot.
   */
  async function logAccounts(label: string, accounts: Record<string, string>) {
    const rows: string[] = []
    for (const [name, address] of Object.entries(accounts)) {
      const info = await accountInfo(address)
      rows.push(`${name}: ${info.balance.toString()} (min ${info.minBalance.toString()})`)
    }
    console.log(`  [${label}]`, rows.join('  |  '))
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

  async function pledgeAs(appClient: AppClient, backerAddr: string, amount: bigint) {
    const payment = await algorand.createTransaction.payment({
      sender: backerAddr,
      receiver: appClient.appAddress,
      amount: microAlgos(amount),
    })
    await appClient.send.call({ method: 'pledge(pay)void', args: [payment], sender: backerAddr, suppressLog: true })
  }

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
    const snapshot: Record<string, string> = {
      creator: creator.addr.toString(),
      escrow,
      b1: backer1.addr.toString(),
      b2: backer2.addr.toString(),
      b3: backer3.addr.toString(),
    }

    await logAccounts('after create', snapshot)

    // The creator's sponsorship floor is locked on their own account; the escrow starts empty.
    const creatorAfterCreate = await accountInfo(creator.addr.toString())
    const escrowAfterCreate = await accountInfo(escrow)
    expect(escrowAfterCreate.balance).toEqual(0n)
    expect(creatorAfterCreate.minBalance).toEqual(100_000n + CREATOR_FLOOR)

    // Three backers pledge 1 ALGO each.
    for (const backer of backers) {
      await pledgeAs(appClient, backer.addr.toString(), (1).algo().microAlgo)
    }

    const escrowAfterPledges = await accountInfo(escrow)
    expect(escrowAfterPledges.balance).toEqual(3n * ALGO)
    expect(escrowAfterPledges.minBalance).toEqual(BASE + 3n * BOX_MBR)

    // Each backer paid the pledge plus the payment + app-call fees.
    for (const backer of backers) {
      const info = await accountInfo(backer.addr.toString())
      expect(info.balance).toEqual(10n * ALGO - ALGO - 2n * TXN_FEE)
    }

    await logAccounts('after 3 pledges', snapshot)

    // Fast-forward and claim: creator receives balance - minBalance.
    await advanceTime(60)
    const creatorBeforeClaim = await accountInfo(creator.addr.toString())
    await appClient.send.call({ method: 'claim()void', args: [], sender: creator.addr, extraFee: (1000).microAlgo(), suppressLog: true })
    const creatorAfterClaim = await accountInfo(creator.addr.toString())

    const expectedClaim = 3n * ALGO - (BASE + 3n * BOX_MBR) // 2,843,300 µA
    expect(creatorAfterClaim.balance - creatorBeforeClaim.balance).toEqual(expectedClaim - 2n * TXN_FEE)

    const escrowAfterClaim = await accountInfo(escrow)
    expect(escrowAfterClaim.balance).toEqual(BASE + 3n * BOX_MBR) // residue: base + box MBR

    await logAccounts('after claim', snapshot)

    // Delete (claimed): boxes deleted, escrow closed to the creator, sponsorship floor freed.
    const creatorBeforeDelete = await accountInfo(creator.addr.toString())
    await appClient.send.delete({
      method: 'delete(address[])void',
      args: [backers.map((b) => b.addr.toString())],
      sender: creator.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    const creatorAfterDelete = await accountInfo(creator.addr.toString())

    // CloseRemainderTo returns the residue (base + box MBR) minus the delete fees.
    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(BASE + 3n * BOX_MBR - 2n * TXN_FEE)
    // The sponsorship floor is freed.
    expect(creatorAfterDelete.minBalance).toEqual(100_000n)

    await logAccounts('after delete', snapshot)

    // Net: the creator collected the full 3 ALGO pledged (claim + closeout), paying 5,000 µA in fees.
    const creatorFinal = await accountInfo(creator.addr.toString())
    expect(creatorFinal.balance).toEqual(10n * ALGO + 3n * ALGO - 5n * TXN_FEE)
  })

  test('failed flow: 3 backers pledge, all refund, creator deletes to free the floor', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backer1, backer2, backer3] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const backers = [backer1, backer2, backer3]
    const appClient = await createCampaign(creator.addr.toString(), 'Failed campaign', (10).algo().microAlgo)

    const escrow = appClient.appAddress.toString()
    const snapshot: Record<string, string> = {
      creator: creator.addr.toString(),
      escrow,
      b1: backer1.addr.toString(),
      b2: backer2.addr.toString(),
      b3: backer3.addr.toString(),
    }

    for (const backer of backers) {
      await pledgeAs(appClient, backer.addr.toString(), (1).algo().microAlgo)
    }

    const escrowAfterPledges = await accountInfo(escrow)
    expect(escrowAfterPledges.balance).toEqual(3n * ALGO)
    expect(escrowAfterPledges.minBalance).toEqual(BASE + 3n * BOX_MBR)

    await logAccounts('after 3 pledges (failed)', snapshot)

    // Fast-forward and let each backer refund.
    await advanceTime(60)
    for (const backer of backers) {
      const before = await accountInfo(backer.addr.toString())
      await appClient.send.call({ method: 'refund()void', args: [], sender: backer.addr, extraFee: (1000).microAlgo(), suppressLog: true })
      const after = await accountInfo(backer.addr.toString())
      // Full pledge back, minus the app-call + inner-payment fees.
      expect(after.balance - before.balance).toEqual(ALGO - 2n * TXN_FEE)
    }

    // Escrow drained: balance 0, min balance back to just the (sponsored) base.
    const escrowAfterRefunds = await accountInfo(escrow)
    expect(escrowAfterRefunds.balance).toEqual(0n)
    expect(escrowAfterRefunds.minBalance).toEqual(BASE)

    const boxes = await appClient.getBoxNames()
    expect(boxes).toHaveLength(0)

    await logAccounts('after 3 refunds', snapshot)

    // Delete the empty failed campaign: CloseRemainderTo moves nothing, but the app delete frees the creator's floor.
    const creatorBeforeDelete = await accountInfo(creator.addr.toString())
    await appClient.send.delete({
      method: 'delete(address[])void',
      args: [[]],
      sender: creator.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    const creatorAfterDelete = await accountInfo(creator.addr.toString())

    expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(-2n * TXN_FEE) // just the delete fees
    expect(creatorAfterDelete.minBalance).toEqual(100_000n) // floor freed

    await logAccounts('after delete (failed)', snapshot)
  })

  test('delete guards: open campaign, non-creator, and failed-with-outstanding-box all fail', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer2 = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const appClient = await createCampaign(creator.addr.toString(), 'Guard me', (10).algo().microAlgo)

    // 1. Open campaign cannot be deleted.
    await expect(
      appClient.send.delete({
        method: 'delete(address[])void',
        args: [[]],
        sender: creator.addr.toString(),
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/cannot delete an open campaign/)

    // 2. Non-creator cannot delete (the creator guard is checked first).
    await pledgeAs(appClient, backer.addr.toString(), (1).algo().microAlgo)
    await expect(
      appClient.send.delete({
        method: 'delete(address[])void',
        args: [[]],
        sender: backer.addr.toString(),
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the creator can delete/)

    // 3. A failed campaign with an outstanding pledge box cannot be deleted (CloseRemainderTo fails).
    //    backer refunds (materialising Failed and deleting their own box); backer2's box remains.
    await pledgeAs(appClient, backer2.addr.toString(), (1).algo().microAlgo)
    await advanceTime(60)
    await appClient.send.call({
      method: 'refund()void',
      args: [],
      sender: backer.addr.toString(),
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })

    await expect(
      appClient.send.delete({
        method: 'delete(address[])void',
        args: [[]],
        sender: creator.addr.toString(),
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/cannot close/)
  })
})
