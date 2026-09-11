import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

/**
 * LocalNet integration tests for the split-vault architecture: deploy the Factory + ClaimsVault + Campaign TEAL to a live algod and
 * exercise the full lifecycle end-to-end with **complete ledger accounting** — every test asserts each actor's balance and minimum
 * balance deltas (µA-exact), the fee totals of every operation, the vault pool movement, claim-unit ownership, and the parked/released
 * MBRs, plus the attack matrix (cross-campaign isolation, pooled solvency, settlement-after-deletion, counterfeit assets, double claims,
 * pledge→cancel→refund sequences, payout-authority hijacking, stray ALGO).
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

const ALGO = 1_000_000n
const BASE = 100_000n
const MIN_DEPOSIT = 200_000n
const ESCROW_MIN_BALANCE = BASE + 100_000n
const TOTAL_CLAIM_UNITS = 2n ** 64n - 1n
const FEE = 1_000n

// The campaign sponsorship floor on the creator's account while the app lives: app base + 7 uint64 keys + 3 bytes keys.
const CREATOR_FLOOR = BASE + 28_500n * 7n + 50_000n * 3n

// The vault's parked MBR per issued campaign: 100,000 (created asset) + 47,100 (mapping boxes: 9,300 + 18,900 + 18,900).
const VAULT_PARKED_AT_ISSUE = 147_100n
// The settled box (9,300) is written at settlement, so the GC destroy releases 156,400 in total.
const VAULT_PARKED_RELEASED_AT_DESTROY = 156_400n

// Measured fee totals per operation (µA), verified by the µA-exact assertions below.
const FEE_CREATE = FEE
const FEE_FUND = 3n * FEE // payment + app call + inner payment pool
const FEE_ISSUE = 2n * FEE // app call + inner asset-config pool
const FEE_ATTACH = 2n * FEE // app call + inner self-opt-in pool
const FEE_SEED = 2n * FEE // app call + inner supply-transfer pool
const FEE_PLEDGE = 3n * FEE // payment + app call + inner mint pool
const FEE_OPT_IN = FEE
const FEE_CANCEL_REFUND_CAMPAIGN = 4n * FEE // axfer + app call + inner app call + inner payment pools
const FEE_REFUND_VAULT = 3n * FEE // axfer + vault call + inner payment pool
const FEE_CLAIM = 3n * FEE // app call + inner app call + inner payment pools
const FEE_DELETE_FAILED = 4n * FEE // app call + settle + holding close + escrow close pools
const FEE_DELETE_CLAIMED = 3n * FEE // app call + holding close + escrow close pools
const FEE_DELETE_BARE = 2n * FEE // app call + escrow close pool
const FEE_CLOSE_OUT = 2n * FEE // axfer + app call
const FEE_DESTROY = 2n * FEE // app call + inner asset-config pool

const CAMPAIGN_SPEC_PATH = path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')
const VAULT_SPEC_PATH = path.resolve(__dirname, '../artifacts/claimsvault/ClaimsVault.arc56.json')

describe('Campaign + ClaimsVault (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let campaignSpec: Arc56Contract
  let factorySpec: Arc56Contract
  let vaultSpec: Arc56Contract
  let factoryId: bigint
  let vaultId: bigint
  let vaultAddress: string

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand
    campaignSpec = JSON.parse(fs.readFileSync(CAMPAIGN_SPEC_PATH, 'utf8')) as Arc56Contract
    factorySpec = JSON.parse(fs.readFileSync(FACTORY_SPEC_PATH, 'utf8')) as Arc56Contract
    vaultSpec = JSON.parse(fs.readFileSync(VAULT_SPEC_PATH, 'utf8')) as Arc56Contract

    // Deploy the Factory, configure the official Campaign approval hash.
    const owner = await fixture.context.generateAccount({ initialFunds: (50).algo(), suppressLog: true })
    const factoryFactory = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: owner.addr })
    const factoryClient = (await factoryFactory.send.create({ method: 'create()void', args: [], sender: owner.addr, suppressLog: true }))
      .appClient
    factoryId = factoryClient.appId

    const campaignTeal = fs.readFileSync(path.resolve(__dirname, '../artifacts/campaign/Campaign.approval.teal'), 'utf8')
    const compiled = await algorand.app.compileTeal(campaignTeal)
    const approvalHash = createHash('sha256').update(compiled.compiledBase64ToBytes).digest()
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [approvalHash],
      sender: owner.addr,
      suppressLog: true,
    })

    // Deploy the vault, fund its account (platform storage reserve: 1 ALGO).
    const vaultFactory = new AppFactory({ appSpec: vaultSpec, algorand, defaultSender: owner.addr })
    const vaultClient = (
      await vaultFactory.send.create({
        method: 'create(uint64)void',
        args: [factoryId],
        sender: owner.addr,
        appReferences: [factoryId],
        suppressLog: true,
      })
    ).appClient
    vaultId = vaultClient.appId
    vaultAddress = vaultClient.appAddress.toString()
    await algorand.send.payment({
      sender: owner.addr,
      receiver: vaultClient.appAddress,
      amount: microAlgos(ALGO),
      suppressLog: true,
    })
  })

  afterAll(async () => {
    await algorand.client.algod
      .setBlockOffsetTimestamp(0)
      .do()
      .catch(() => undefined)
  })

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

  type Ledger = Map<string, { balance: bigint; minBalance: bigint }>

  /**
   * Read an account's balance and minimum balance, in microAlgos.
   *
   * @param address The account address.
   */
  async function accountInfoOf(address: string) {
    const info = await algorand.account.getInformation(address)
    return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo }
  }

  /**
   * Snapshot the balance and minimum balance of every listed account.
   *
   * @param addresses The account addresses to snapshot.
   */
  async function snapshot(addresses: (string | undefined)[]): Promise<Ledger> {
    const ledger: Ledger = new Map()
    for (const address of addresses) {
      if (address === undefined) continue
      const info = await algorand.account.getInformation(address)
      ledger.set(address, { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo })
    }
    return ledger
  }

  /**
   * The balance and minimum-balance deltas of one account between two snapshots.
   *
   * @param before The earlier snapshot.
   * @param after The later snapshot.
   * @param address The account to diff.
   */
  function delta(before: Ledger, after: Ledger, address: string) {
    const from = before.get(address)
    const to = after.get(address)
    if (from === undefined || to === undefined) throw new Error(`missing snapshot for ${address}`)
    return { balance: to.balance - from.balance, minBalance: to.minBalance - from.minBalance }
  }

  /**
   * Deploy a full campaign: create → fund → issueClaimAsa (vault) → attachClaimAsa → seedSupply.
   *
   * @param creatorAddr The creator's address.
   * @param title The campaign title.
   * @param goal The funding goal in microAlgos.
   * @returns The campaign client and its Claim ASA id.
   */
  async function deployCampaign(creatorAddr: string, title: string, goal: bigint): Promise<{ appClient: AppClient; claimAsa: bigint }> {
    const deadline = (await latestBlockTimestamp()) + 30n
    const factory = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creatorAddr })
    const { appClient } = await factory.send.create({
      method: 'create(uint64,byte[],byte[],uint64,uint64)void',
      args: [vaultId, new TextEncoder().encode(title), new TextEncoder().encode('ipfs://test'), goal, deadline],
      sender: creatorAddr,
      appReferences: [vaultId],
      suppressLog: true,
    })

    const payment = await algorand.createTransaction.payment({
      sender: creatorAddr,
      receiver: appClient.appAddress,
      amount: microAlgos(MIN_DEPOSIT),
    })
    await appClient.send.call({
      method: 'fund(pay)void',
      args: [payment],
      sender: creatorAddr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })

    const vaultClient = vaultClientFor(creatorAddr)
    await vaultClient.send.call({
      method: 'issueClaimAsa(uint64)void',
      args: [appClient.appId],
      sender: creatorAddr,
      appReferences: [appClient.appId, factoryId],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })

    const claimAsa = (await vaultClient.state.box.getMapValue('asaOf', appClient.appId)) as bigint
    await appClient.send.call({
      method: 'attachClaimAsa(uint64)void',
      args: [claimAsa],
      sender: creatorAddr,
      appReferences: [vaultId],
      assetReferences: [claimAsa],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    await vaultClient.send.call({
      method: 'seedSupply(uint64)void',
      args: [appClient.appId],
      sender: creatorAddr,
      appReferences: [appClient.appId],
      assetReferences: [claimAsa],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })

    return { appClient, claimAsa }
  }

  /**
   * The vault's box names for a campaign (prefix + 8-byte app id) — inner app calls require them declared on the outer txn.
   *
   * @param appId The campaign app id.
   * @param prefixes The vault box key prefixes.
   */
  function vaultBoxes(appId: bigint, prefixes: string[]) {
    const appIdBytes = Buffer.alloc(8)
    appIdBytes.writeBigUInt64BE(appId)
    return prefixes.map((prefix) => ({ appId: vaultId, name: Buffer.concat([Buffer.from(prefix), appIdBytes]) }))
  }

  function vaultClientFor(sender: string): AppClient {
    return new AppClient({
      algorand,
      appSpec: vaultSpec,
      appId: vaultId,
      defaultSender: sender,
    })
  }

  async function optInAs(backerAddr: string, claimAsa: bigint) {
    await algorand.send.assetOptIn({ sender: backerAddr, assetId: claimAsa, suppressLog: true })
  }

  async function claimBalanceOf(backerAddr: string, claimAsa: bigint): Promise<bigint> {
    try {
      return (await algorand.asset.getAccountInformation(backerAddr, claimAsa)).balance
    } catch {
      return 0n
    }
  }

  async function pledgeAs(appClient: AppClient, backerAddr: string, claimAsa: bigint, amount: bigint) {
    const payment = await algorand.createTransaction.payment({
      sender: backerAddr,
      receiver: vaultAddress,
      amount: microAlgos(amount),
    })
    await appClient.send.call({
      method: 'pledge(pay)void',
      args: [payment],
      sender: backerAddr,
      appReferences: [vaultId],
      assetReferences: [claimAsa],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  /**
   * Cancel/refund through the campaign (works while the campaign is alive).
   *
   * @param appClient The campaign client.
   * @param backerAddr The backer's address.
   * @param claimAsa The Claim ASA id.
   * @param method The campaign method to invoke.
   */
  async function surrenderViaCampaign(appClient: AppClient, backerAddr: string, claimAsa: bigint, method: 'cancelPledge' | 'refund') {
    const axfer = await algorand.createTransaction.assetTransfer({
      sender: backerAddr,
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: await claimBalanceOf(backerAddr, claimAsa),
    })
    await appClient.send.call({
      method: `${method}(axfer)void`,
      args: [axfer],
      sender: backerAddr,
      appReferences: [vaultId],
      boxReferences: vaultBoxes(appClient.appId, ['a', 'd']),
      extraFee: (2000).microAlgo(),
      suppressLog: true,
    })
  }

  /**
   * Refund directly from the vault (works after the campaign is deleted).
   *
   * @param backerAddr The backer's address.
   * @param appId The campaign app id.
   * @param claimAsa The Claim ASA id.
   */
  async function refundViaVault(backerAddr: string, appId: bigint, claimAsa: bigint) {
    const vaultClient = vaultClientFor(backerAddr)
    const axfer = await algorand.createTransaction.assetTransfer({
      sender: backerAddr,
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: await claimBalanceOf(backerAddr, claimAsa),
    })
    await vaultClient.send.call({
      method: 'refund(uint64,axfer)void',
      args: [appId, axfer],
      sender: backerAddr,
      appReferences: [appId],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
  }

  async function claimAs(appClient: AppClient, creatorAddr: string) {
    await appClient.send.call({
      method: 'claim()void',
      args: [],
      sender: creatorAddr,
      appReferences: [vaultId],
      assetReferences: [await claimAsaOf(appClient)],
      boxReferences: vaultBoxes(appClient.appId, ['a', 'd', 'o', 's']),
      extraFee: (2000).microAlgo(),
      suppressLog: true,
    })
  }

  async function claimAsaOf(appClient: AppClient): Promise<bigint> {
    return (await appClient.state.global.getValue('claimAsa')) as bigint
  }

  async function deleteAs(appClient: AppClient, creatorAddr: string, claimAsa: bigint | undefined, extraFeeMicroAlgos: number) {
    await appClient.send.delete({
      method: 'delete()void',
      args: [],
      sender: creatorAddr,
      appReferences: [vaultId],
      assetReferences: claimAsa !== undefined ? [claimAsa] : [],
      boxReferences: claimAsa !== undefined ? vaultBoxes(appClient.appId, ['a', 'd', 's']) : [],
      extraFee: microAlgos(extraFeeMicroAlgos),
      suppressLog: true,
    })
  }

  test('setup: the vault issues the Claim ASA and seeds the escrow; creator capital is the escrow constant', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creatorBefore = await snapshot([creator.addr.toString(), vaultAddress])
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Setup', (10).algo().microAlgo)
    const creatorAfter = await snapshot([creator.addr.toString(), vaultAddress, appClient.appAddress.toString()])

    // The creator paid: create fee + fund (payment + fees) + issue + attach + seed fees + the 0.2 ALGO deposit; the floor appeared.
    const creatorDelta = delta(creatorBefore, creatorAfter, creator.addr.toString())
    expect(creatorDelta.balance).toEqual(-(FEE_CREATE + FEE_FUND + FEE_ISSUE + FEE_ATTACH + FEE_SEED) - MIN_DEPOSIT)
    expect(creatorDelta.minBalance).toEqual(CREATOR_FLOOR)

    // The vault parked exactly this campaign's created-asset MBR + mapping boxes; no pledge ALGO moved yet.
    const vaultDelta = delta(creatorBefore, creatorAfter, vaultAddress)
    expect(vaultDelta.balance).toEqual(0n)
    expect(vaultDelta.minBalance).toEqual(VAULT_PARKED_AT_ISSUE)

    // The escrow holds exactly the deposit and the whole seeded supply; its MBR is base + the asset opt-in.
    const escrowInfo = await accountInfoOf(appClient.appAddress.toString())
    expect(escrowInfo.balance).toEqual(MIN_DEPOSIT)
    expect(escrowInfo.minBalance).toEqual(ESCROW_MIN_BALANCE)
    const escrowHolding = await algorand.asset.getAccountInformation(appClient.appAddress.toString(), claimAsa)
    expect(escrowHolding.balance).toEqual(TOTAL_CLAIM_UNITS)

    // The asset's identity and authorities.
    const asset = await algorand.asset.getById(claimAsa)
    expect(asset.creator).toEqual(vaultAddress)
    expect(asset.manager).toEqual(vaultAddress)
    expect(asset.clawback).toEqual(vaultAddress)
    expect(asset.reserve).toEqual(vaultAddress)
    expect(asset.total).toEqual(TOTAL_CLAIM_UNITS)
    expect(asset.decimals).toEqual(0)
  })

  test('pledge: pays the vault (escrow untouched), mints claim units, accumulates', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Pledge', (100).algo().microAlgo)
    const escrowAddress = appClient.appAddress.toString()

    const before = await snapshot([backer.addr.toString(), vaultAddress, escrowAddress])
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, 2n * ALGO)
    const after = await snapshot([backer.addr.toString(), vaultAddress, escrowAddress])

    // The backer paid 3 ALGO plus the opt-in fee and two pledge fees; their opt-in MBR appeared.
    const backerDelta = delta(before, after, backer.addr.toString())
    expect(backerDelta.balance).toEqual(-3n * ALGO - FEE_OPT_IN - 2n * FEE_PLEDGE)
    expect(backerDelta.minBalance).toEqual(100_000n)

    // The vault gained exactly the pledged ALGO; no MBR change (no new campaign here).
    const vaultDelta = delta(before, after, vaultAddress)
    expect(vaultDelta.balance).toEqual(3n * ALGO)
    expect(vaultDelta.minBalance).toEqual(0n)

    // The escrow is untouched by pledges: same balance and MBR.
    const escrowDelta = delta(before, after, escrowAddress)
    expect(escrowDelta.balance).toEqual(0n)
    expect(escrowDelta.minBalance).toEqual(0n)

    // The claim units mirror the pledges exactly.
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(3n * ALGO)
  })

  test('pledge guards: wrong receiver, creator self-pledge — rejected atomically at zero cost', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Guards', (100).algo().microAlgo)

    const before = await snapshot([backer.addr.toString(), creator.addr.toString(), vaultAddress])

    // A payment to the escrow (not the vault) is rejected.
    const wrongPayment = await algorand.createTransaction.payment({
      sender: backer.addr.toString(),
      receiver: appClient.appAddress,
      amount: microAlgos(ALGO),
    })
    await expect(
      appClient.send.call({
        method: 'pledge(pay)void',
        args: [wrongPayment],
        sender: backer.addr,
        appReferences: [vaultId],
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/payment must be made to the vault/)

    // The creator cannot self-pledge.
    const selfPayment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: vaultAddress,
      amount: microAlgos(ALGO),
    })
    await expect(
      appClient.send.call({
        method: 'pledge(pay)void',
        args: [selfPayment],
        sender: creator.addr,
        appReferences: [vaultId],
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/creator cannot pledge to their own campaign/)

    // Failed atomic groups move nothing: no balance, MBR, or pool changes for any party.
    const after = await snapshot([backer.addr.toString(), creator.addr.toString(), vaultAddress])
    for (const address of [backer.addr.toString(), creator.addr.toString(), vaultAddress]) {
      const d = delta(before, after, address)
      expect(d.balance).toEqual(0n)
      expect(d.minBalance).toEqual(0n)
    }
  })

  test('attachClaimAsa rejects a counterfeit asset (wrong creator) — the campaign stays inert and untouched', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    // A bare campaign: created + funded + issued, but NOT attached yet.
    const deadline = (await latestBlockTimestamp()) + 30n
    const factory = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creator.addr })
    const { appClient } = await factory.send.create({
      method: 'create(uint64,byte[],byte[],uint64,uint64)void',
      args: [
        vaultId,
        new TextEncoder().encode('Counterfeit target'),
        new TextEncoder().encode('ipfs://test'),
        (10).algo().microAlgo,
        deadline,
      ],
      sender: creator.addr,
      appReferences: [vaultId],
      suppressLog: true,
    })
    const payment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: appClient.appAddress,
      amount: microAlgos(MIN_DEPOSIT),
    })
    await appClient.send.call({
      method: 'fund(pay)void',
      args: [payment],
      sender: creator.addr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })

    // A decoy ASA created by a random account (not the vault) is rejected outright — and costs nothing beyond the decoy creation.
    const before = await snapshot([creator.addr.toString()])
    const decoy = await algorand.send.assetCreate({
      sender: creator.addr.toString(),
      total: TOTAL_CLAIM_UNITS,
      decimals: 0,
      assetName: 'Decoy',
      unitName: 'DECOY',
      suppressLog: true,
    })
    await expect(
      appClient.send.call({
        method: 'attachClaimAsa(uint64)void',
        args: [decoy.assetId],
        sender: creator.addr,
        appReferences: [vaultId],
        assetReferences: [decoy.assetId],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/not issued by the vault/)
    const after = await snapshot([creator.addr.toString()])

    // The decoy creation cost one fee and parked the created-asset MBR on the creator; the rejected attach moved nothing.
    const creatorDelta = delta(before, after, creator.addr.toString())
    expect(creatorDelta.balance).toEqual(-FEE)
    expect(creatorDelta.minBalance).toEqual(100_000n)
    expect(await claimAsaOf(appClient)).toEqual(0n)
  })

  test('cancelPledge: the vault pays, raised decrements, units are consumed once', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Cancel', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    const before = await snapshot([backer.addr.toString(), vaultAddress, appClient.appAddress.toString()])
    await surrenderViaCampaign(appClient, backer.addr.toString(), claimAsa, 'cancelPledge')
    const after = await snapshot([backer.addr.toString(), vaultAddress, appClient.appAddress.toString()])

    // The full pledge returns, minus the axfer + app call + inner call + inner payment fees.
    expect(delta(before, after, backer.addr.toString()).balance).toEqual(ALGO - FEE_CANCEL_REFUND_CAMPAIGN)
    expect(delta(before, after, vaultAddress).balance).toEqual(-ALGO)
    expect(delta(before, after, appClient.appAddress.toString()).balance).toEqual(0n)
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(0n)

    // A second cancel of the same units fails at the transfer — no state changes.
    const beforeSecond = await snapshot([backer.addr.toString(), vaultAddress])
    await expect(surrenderViaCampaign(appClient, backer.addr.toString(), claimAsa, 'cancelPledge')).rejects.toThrow()
    const afterSecond = await snapshot([backer.addr.toString(), vaultAddress])
    for (const address of [backer.addr.toString(), vaultAddress]) {
      const d = delta(beforeSecond, afterSecond, address)
      expect(d.balance).toEqual(0n)
      expect(d.minBalance).toEqual(0n)
    }
  })

  test(
    'FLAGSHIP: failed campaign with a straggler — creator deletes in O(1), the straggler refunds from the vault afterwards',
    { timeout: 120_000 },
    async () => {
      const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const [backer1, backer2] = await Promise.all([
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      ])
      const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Failed with straggler', (10).algo().microAlgo)
      for (const backer of [backer1, backer2]) {
        await optInAs(backer.addr.toString(), claimAsa)
        await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
      }

      await advanceTime(60)

      // Backer1 refunds through the campaign (vault pays); fees = axfer + app call + inner call + inner payment.
      const beforeRefund = await snapshot([backer1.addr.toString(), vaultAddress])
      await surrenderViaCampaign(appClient, backer1.addr.toString(), claimAsa, 'refund')
      const afterRefund = await snapshot([backer1.addr.toString(), vaultAddress])
      expect(delta(beforeRefund, afterRefund, backer1.addr.toString()).balance).toEqual(ALGO - FEE_CANCEL_REFUND_CAMPAIGN)
      expect(delta(beforeRefund, afterRefund, vaultAddress).balance).toEqual(-ALGO)
      expect(await claimBalanceOf(backer1.addr.toString(), claimAsa)).toEqual(0n)

      // Backer2 (the straggler) never acts. The creator deletes in ONE call: settle → holding close → escrow close.
      const beforeDelete = await snapshot([creator.addr.toString(), vaultAddress])
      await deleteAs(appClient, creator.addr.toString(), claimAsa, 3000)
      const afterDelete = await snapshot([creator.addr.toString(), vaultAddress])

      // The deposit comes back minus the delete fees; the sponsorship floor is freed.
      expect(delta(beforeDelete, afterDelete, creator.addr.toString()).balance).toEqual(MIN_DEPOSIT - FEE_DELETE_FAILED)
      expect(delta(beforeDelete, afterDelete, creator.addr.toString()).minBalance).toEqual(-CREATOR_FLOOR)
      // The settle wrote a vault box: no ALGO moved, but the settlement box MBR is already counted in the parked total.
      expect(delta(beforeDelete, afterDelete, vaultAddress).balance).toEqual(0n)

      // The straggler still refunds — directly from the vault, after the campaign is gone.
      expect(await claimBalanceOf(backer2.addr.toString(), claimAsa)).toEqual(ALGO)
      const beforeStraggler = await snapshot([backer2.addr.toString(), vaultAddress])
      await refundViaVault(backer2.addr.toString(), appClient.appId, claimAsa)
      const afterStraggler = await snapshot([backer2.addr.toString(), vaultAddress])
      expect(delta(beforeStraggler, afterStraggler, backer2.addr.toString()).balance).toEqual(ALGO - FEE_REFUND_VAULT)
      expect(delta(beforeStraggler, afterStraggler, vaultAddress).balance).toEqual(-ALGO)
      expect(await claimBalanceOf(backer2.addr.toString(), claimAsa)).toEqual(0n)

      // Net ledger: the backers netted their pledges minus their own fees; the creator recovered the deposit minus fees; the vault's
      // pool is back to exactly the platform reserve, and GC releases the parked MBR.
      const beforeGc = await snapshot([vaultAddress, creator.addr.toString()])
      const vaultClient = vaultClientFor(creator.addr.toString())
      await vaultClient.send.call({
        method: 'destroyClaimAsa(uint64)void',
        args: [appClient.appId],
        sender: creator.addr,
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      })
      const afterGc = await snapshot([vaultAddress, creator.addr.toString()])
      // The creator (the caller) pays the destroy fees; the vault releases its parked MBR and moves no ALGO.
      expect(delta(beforeGc, afterGc, creator.addr.toString()).balance).toEqual(-FEE_DESTROY)
      expect(delta(beforeGc, afterGc, vaultAddress).balance).toEqual(0n)
      expect(delta(beforeGc, afterGc, vaultAddress).minBalance).toEqual(-VAULT_PARKED_RELEASED_AT_DESTROY)
      await expect(algorand.asset.getById(claimAsa)).rejects.toThrow()
    },
  )

  test('vault refund guards: unsettled campaign, wrong asset, zero amount — all rejected with no state changes', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Refund guards', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    // Unsettled (campaign alive): the vault refuses.
    await expect(refundViaVault(backer.addr.toString(), appClient.appId, claimAsa)).rejects.toThrow(/campaign is not refundable/)

    // A counterfeit asset fails at the transfer itself (the vault is not opted into it).
    const decoy = await algorand.send.assetCreate({
      sender: creator.addr.toString(),
      total: TOTAL_CLAIM_UNITS,
      decimals: 0,
      assetName: 'Decoy',
      unitName: 'DECOY',
      suppressLog: true,
    })
    await optInAs(backer.addr.toString(), decoy.assetId)
    await algorand.send.assetTransfer({
      sender: creator.addr.toString(),
      assetId: decoy.assetId,
      receiver: backer.addr.toString(),
      amount: 1n,
      suppressLog: true,
    })

    const before = await snapshot([backer.addr.toString(), vaultAddress])
    const decoyAxfer = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: decoy.assetId,
      receiver: vaultAddress,
      amount: 1n,
    })
    await expect(
      vaultClientFor(backer.addr.toString()).send.call({
        method: 'refund(uint64,axfer)void',
        args: [appClient.appId, decoyAxfer],
        sender: backer.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow()

    // Zero-amount surrender is rejected by the vault.
    const zeroAxfer = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: 0n,
    })
    await expect(
      vaultClientFor(backer.addr.toString()).send.call({
        method: 'refund(uint64,axfer)void',
        args: [appClient.appId, zeroAxfer],
        sender: backer.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/claim amount must be greater than zero/)

    // Nothing moved: the backer's claim is intact and the pool is untouched.
    const after = await snapshot([backer.addr.toString(), vaultAddress])
    for (const address of [backer.addr.toString(), vaultAddress]) {
      const d = delta(before, after, address)
      expect(d.balance).toEqual(0n)
      expect(d.minBalance).toEqual(0n)
    }
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(ALGO)
  })

  test('claim guards: below goal, non-creator — rejected at zero cost', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Claim guards', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    await advanceTime(60)

    const before = await snapshot([creator.addr.toString(), backer.addr.toString(), vaultAddress])
    await expect(claimAs(appClient, creator.addr.toString())).rejects.toThrow(/goal not reached/)
    await expect(claimAs(appClient, backer.addr.toString())).rejects.toThrow(/only the creator can claim/)
    const after = await snapshot([creator.addr.toString(), backer.addr.toString(), vaultAddress])

    for (const address of [creator.addr.toString(), backer.addr.toString(), vaultAddress]) {
      const d = delta(before, after, address)
      expect(d.balance).toEqual(0n)
      expect(d.minBalance).toEqual(0n)
    }
  })

  test('cross-campaign isolation: units of one campaign can never redeem on another', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const a = await deployCampaign(creator.addr.toString(), 'Campaign A', (1).algo().microAlgo)
    const b = await deployCampaign(creator.addr.toString(), 'Campaign B', (10).algo().microAlgo)

    const before = await snapshot([backer.addr.toString(), vaultAddress])

    await optInAs(backer.addr.toString(), a.claimAsa)
    await pledgeAs(a.appClient, backer.addr.toString(), a.claimAsa, ALGO)

    // B fails with a straggler; settle it.
    await optInAs(backer.addr.toString(), b.claimAsa)
    await pledgeAs(b.appClient, backer.addr.toString(), b.claimAsa, ALGO)
    await advanceTime(60)
    await deleteAs(b.appClient, creator.addr.toString(), b.claimAsa, 3000)

    // Presenting A's units (an open campaign) to the vault resolves to campaign A → not refundable.
    await expect(refundViaVault(backer.addr.toString(), a.appClient.appId, a.claimAsa)).rejects.toThrow(/campaign is not refundable/)

    // Presenting B's own units refunds B's own pledge — A's units are untouched.
    const aUnitsBefore = await claimBalanceOf(backer.addr.toString(), a.claimAsa)
    await refundViaVault(backer.addr.toString(), b.appClient.appId, b.claimAsa)
    const after = await snapshot([backer.addr.toString(), vaultAddress])

    // The backer: two opt-ins (2 × 0.1 MBR, 2 fees), two pledges (2 × 1 ALGO + fees), one vault refund (+1 ALGO − vault-refund fees).
    expect(delta(before, after, backer.addr.toString()).balance).toEqual(
      -2n * ALGO + ALGO - 2n * FEE_OPT_IN - 2n * FEE_PLEDGE - FEE_REFUND_VAULT,
    )
    expect(delta(before, after, backer.addr.toString()).minBalance).toEqual(2n * 100_000n)
    // The vault: two pledges in, one refund out — net one ALGO in the pool.
    expect(delta(before, after, vaultAddress).balance).toEqual(ALGO)
    expect(await claimBalanceOf(backer.addr.toString(), a.claimAsa)).toEqual(aUnitsBefore)
    expect(await claimBalanceOf(backer.addr.toString(), b.claimAsa)).toEqual(0n)
  })

  test('insolvency attack: payouts never exceed contributions across two campaigns', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backerA, backerB] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const a = await deployCampaign(creator.addr.toString(), 'Pool A', (10).algo().microAlgo)
    const b = await deployCampaign(creator.addr.toString(), 'Pool B', (10).algo().microAlgo)

    for (const [backer, camp] of [
      [backerA, a],
      [backerB, b],
    ] as const) {
      await optInAs(backer.addr.toString(), camp.claimAsa)
      await pledgeAs(camp.appClient, backer.addr.toString(), camp.claimAsa, ALGO)
    }

    const before = await snapshot([vaultAddress, backerA.addr.toString(), backerB.addr.toString()])

    // Both campaigns fail and settle with stragglers.
    await advanceTime(60)
    await deleteAs(a.appClient, creator.addr.toString(), a.claimAsa, 3000)
    await deleteAs(b.appClient, creator.addr.toString(), b.claimAsa, 3000)

    // Both stragglers refund everything. The vault pays exactly the pledged amounts and never goes below its reserve.
    for (const [backer, camp] of [
      [backerA, a],
      [backerB, b],
    ] as const) {
      const beforeRefund = await snapshot([backer.addr.toString()])
      await refundViaVault(backer.addr.toString(), camp.appClient.appId, camp.claimAsa)
      const afterRefund = await snapshot([backer.addr.toString()])
      expect(delta(beforeRefund, afterRefund, backer.addr.toString()).balance).toEqual(ALGO - FEE_REFUND_VAULT)
    }

    const after = await snapshot([vaultAddress])
    // The pool dropped by exactly the two refunds — no cross-campaign drain.
    expect(delta(before, after, vaultAddress).balance).toEqual(-2n * ALGO)
  })

  test(
    'funded flow: vault pays the claim from unit conservation; closeOut, sweep, destroy, full cleanup',
    { timeout: 120_000 },
    async () => {
      const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const [backer1, backer2] = await Promise.all([
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      ])
      const backers = [backer1, backer2]
      const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Funded', (2).algo().microAlgo)
      for (const backer of backers) {
        await optInAs(backer.addr.toString(), claimAsa)
        await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
      }

      // Claim before the deadline fails.
      await expect(claimAs(appClient, creator.addr.toString())).rejects.toThrow(/deadline has not passed/)

      await advanceTime(60)

      // The vault pays the derived amount (total − vault holding − campaign holding = 2 ALGO).
      const beforeClaim = await snapshot([creator.addr.toString(), vaultAddress])
      await claimAs(appClient, creator.addr.toString())
      const afterClaim = await snapshot([creator.addr.toString(), vaultAddress])
      expect(delta(beforeClaim, afterClaim, creator.addr.toString()).balance).toEqual(2n * ALGO - FEE_CLAIM)
      expect(delta(beforeClaim, afterClaim, vaultAddress).balance).toEqual(-2n * ALGO)

      // Double claim and refunds are rejected.
      await expect(claimAs(appClient, creator.addr.toString())).rejects.toThrow(/already claimed/)
      await expect(refundViaVault(backer1.addr.toString(), appClient.appId, claimAsa)).rejects.toThrow(/campaign is not refundable/)

      // The creator deletes in O(1): holding close + escrow close; deposit + floor recovered.
      const beforeDelete = await snapshot([creator.addr.toString()])
      await deleteAs(appClient, creator.addr.toString(), claimAsa, 2000)
      const afterDelete = await snapshot([creator.addr.toString()])
      expect(delta(beforeDelete, afterDelete, creator.addr.toString()).balance).toEqual(MIN_DEPOSIT - FEE_DELETE_CLAIMED)
      expect(delta(beforeDelete, afterDelete, creator.addr.toString()).minBalance).toEqual(-CREATOR_FLOOR)

      // GC: sweep the worthless units from both holders (the creator pays the sweep fees), then destroy the ASA.
      const vaultClient = vaultClientFor(creator.addr.toString())
      await vaultClient.send.call({
        method: 'sweepClaimAsa(uint64,address)void',
        args: [appClient.appId, backer1.addr.toString()],
        sender: creator.addr,
        appReferences: [appClient.appId],
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      })
      expect(await claimBalanceOf(backer1.addr.toString(), claimAsa)).toEqual(0n)

      // Destroy is refused while backer2 still holds units.
      await expect(
        vaultClient.send.call({
          method: 'destroyClaimAsa(uint64)void',
          args: [appClient.appId],
          sender: creator.addr,
          assetReferences: [claimAsa],
          extraFee: (1000).microAlgo(),
          suppressLog: true,
        }),
      ).rejects.toThrow(/claim units outstanding/)

      await vaultClient.send.call({
        method: 'sweepClaimAsa(uint64,address)void',
        args: [appClient.appId, backer2.addr.toString()],
        sender: creator.addr,
        appReferences: [appClient.appId],
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      })
      expect(await claimBalanceOf(backer2.addr.toString(), claimAsa)).toEqual(0n)

      const beforeGc = await snapshot([vaultAddress, creator.addr.toString()])
      await vaultClient.send.call({
        method: 'destroyClaimAsa(uint64)void',
        args: [appClient.appId],
        sender: creator.addr,
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      })
      const afterGc = await snapshot([vaultAddress, creator.addr.toString()])
      // destroyClaimAsa frees exactly this campaign's MBR (created asset + boxes + settled); the caller pays the destroy fees.
      expect(delta(beforeGc, afterGc, vaultAddress).minBalance).toEqual(-VAULT_PARKED_RELEASED_AT_DESTROY)
      expect(delta(beforeGc, afterGc, vaultAddress).balance).toEqual(0n)
      expect(delta(beforeGc, afterGc, creator.addr.toString()).balance).toEqual(-FEE_DESTROY)
      await expect(algorand.asset.getById(claimAsa)).rejects.toThrow()

      // The backers' own opt-ins are parked (clawback cannot close a holding) — their own 0.1 ALGO each, untouched by the sweeps.
      for (const backer of backers) {
        const info = await accountInfoOf(backer.addr.toString())
        expect(info.minBalance).toEqual(BASE + 100_000n)
      }
    },
  )

  test('vault payout methods reject non-campaign callers (no hijacking) — and nothing moves', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const attacker = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient } = await deployCampaign(creator.addr.toString(), 'Hijack target', (10).algo().microAlgo)
    const vaultClient = vaultClientFor(attacker.addr.toString())
    const before = await snapshot([attacker.addr.toString(), creator.addr.toString(), vaultAddress])

    await expect(
      vaultClient.send.call({
        method: 'payBack(uint64,address,uint64)void',
        args: [appClient.appId, attacker.addr.toString(), ALGO],
        sender: attacker.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      vaultClient.send.call({
        method: 'payClaim(uint64)void',
        args: [appClient.appId],
        sender: attacker.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      vaultClient.send.call({
        method: 'settle(uint64)void',
        args: [appClient.appId],
        sender: attacker.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)

    const after = await snapshot([attacker.addr.toString(), creator.addr.toString(), vaultAddress])
    for (const address of [attacker.addr.toString(), creator.addr.toString(), vaultAddress]) {
      const d = delta(before, after, address)
      expect(d.balance).toEqual(0n)
      expect(d.minBalance).toEqual(0n)
    }
  })

  test('stray ALGO sent to the vault cannot be extracted by anyone', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Stray', (10).algo().microAlgo)

    const before = await snapshot([stranger.addr.toString(), vaultAddress])
    await algorand.send.payment({ sender: stranger.addr, receiver: vaultAddress, amount: microAlgos(ALGO), suppressLog: true })

    // The stranger has no units; no payout path exists for them.
    await expect(refundViaVault(stranger.addr.toString(), appClient.appId, claimAsa)).rejects.toThrow()
    const after = await snapshot([stranger.addr.toString(), vaultAddress])

    // The stray ALGO sits in the vault (+1 ALGO); the stranger lost exactly the payment + fee.
    expect(delta(before, after, vaultAddress).balance).toEqual(ALGO)
    expect(delta(before, after, stranger.addr.toString()).balance).toEqual(-ALGO - FEE)
  })

  test('an abandoned campaign (created, funded, never issued) can be deleted by its creator', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const deadline = (await latestBlockTimestamp()) + 30n
    const factory = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creator.addr })
    const { appClient } = await factory.send.create({
      method: 'create(uint64,byte[],byte[],uint64,uint64)void',
      args: [vaultId, new TextEncoder().encode('Abandoned'), new TextEncoder().encode('ipfs://test'), (10).algo().microAlgo, deadline],
      sender: creator.addr,
      appReferences: [vaultId],
      suppressLog: true,
    })

    const before = await snapshot([creator.addr.toString()])
    await deleteAs(appClient, creator.addr.toString(), undefined, 1000)
    const after = await snapshot([creator.addr.toString()])

    expect(delta(before, after, creator.addr.toString()).balance).toEqual(-FEE_DELETE_BARE)
    expect(delta(before, after, creator.addr.toString()).minBalance).toEqual(-CREATOR_FLOOR)
  })

  test('the clawback authority is inert on open and failed campaigns — live claims are untouchable', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const attacker = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Sweep resistance', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    const vaultClient = vaultClientFor(attacker.addr.toString())
    const sweep = async () =>
      vaultClient.send.call({
        method: 'sweepClaimAsa(uint64,address)void',
        args: [appClient.appId, backer.addr.toString()],
        sender: attacker.addr,
        appReferences: [appClient.appId],
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      })

    // Open campaign: the sweep is refused outright (the claim is live).
    await expect(sweep()).rejects.toThrow(/campaign not claimed/)

    // Failed in fact but still open: still refused.
    await advanceTime(60)
    await expect(sweep()).rejects.toThrow(/campaign not claimed/)

    // Settled FAILED with the backer's live claim outstanding: still refused — the clawback cannot steal refundable claims.
    await deleteAs(appClient, creator.addr.toString(), claimAsa, 3000)
    await expect(sweep()).rejects.toThrow(/campaign not claimed/)

    // Nor can the ASA be destroyed while the claim is outstanding.
    await expect(
      vaultClient.send.call({
        method: 'destroyClaimAsa(uint64)void',
        args: [appClient.appId],
        sender: attacker.addr,
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/claim units outstanding/)

    // The attacker moved nothing across all attempts.
    const attackerInfo = await accountInfoOf(attacker.addr.toString())
    expect(attackerInfo.balance).toEqual((10).algo().microAlgo)

    // The backer's claim is fully intact: it refunds from the vault as usual.
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(ALGO)
    const before = await snapshot([backer.addr.toString(), vaultAddress])
    await refundViaVault(backer.addr.toString(), appClient.appId, claimAsa)
    const after = await snapshot([backer.addr.toString(), vaultAddress])
    expect(delta(before, after, backer.addr.toString()).balance).toEqual(ALGO - FEE_REFUND_VAULT)
    expect(delta(before, after, vaultAddress).balance).toEqual(-ALGO)
  })

  test('claim payout derives correctly with cancelled pledges mixed in', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Mixed history', (1).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)

    // Pledge 2 ALGO, then cancel 1 ALGO (a partial surrender), leaving raised = 1 ALGO — exactly the goal.
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, 2n * ALGO)
    const partialAxfer = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: ALGO,
    })
    await appClient.send.call({
      method: 'cancelPledge(axfer)void',
      args: [partialAxfer],
      sender: backer.addr,
      appReferences: [vaultId],
      boxReferences: vaultBoxes(appClient.appId, ['a', 'd']),
      extraFee: (2000).microAlgo(),
      suppressLog: true,
    })
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(ALGO)

    await advanceTime(60)

    // The vault pays exactly the remaining outstanding unit value (1 ALGO): total − vault holding − campaign holding.
    const before = await snapshot([creator.addr.toString(), vaultAddress])
    await claimAs(appClient, creator.addr.toString())
    const after = await snapshot([creator.addr.toString(), vaultAddress])
    expect(delta(before, after, creator.addr.toString()).balance).toEqual(ALGO - FEE_CLAIM)
    expect(delta(before, after, vaultAddress).balance).toEqual(-ALGO)
  })

  test('closeOut on-chain: a claimed campaign backer closes their holding and frees their opt-in MBR', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Cooperative closeOut', (1).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    await advanceTime(60)
    await claimAs(appClient, creator.addr.toString())

    // The cooperative path: the backer closes their worthless holding to the vault and frees their own 0.1 ALGO opt-in.
    const before = await snapshot([backer.addr.toString(), vaultAddress])
    const axfer = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: 0n,
      closeAssetTo: vaultAddress,
    })
    await appClient.send.call({
      method: 'closeOut(axfer)void',
      args: [axfer],
      sender: backer.addr,
      appReferences: [vaultId],
      suppressLog: true,
    })
    const after = await snapshot([backer.addr.toString(), vaultAddress])
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(0n)
    expect(delta(before, after, backer.addr.toString()).balance).toEqual(-FEE_CLOSE_OUT)
    expect(delta(before, after, backer.addr.toString()).minBalance).toEqual(-100_000n)
    expect(delta(before, after, vaultAddress).balance).toEqual(0n)

    // With the whole supply home again, the creator deletes and the vault's GC completes.
    await deleteAs(appClient, creator.addr.toString(), claimAsa, 2000)
    const vaultClient = vaultClientFor(creator.addr.toString())
    const beforeGc = await snapshot([vaultAddress, creator.addr.toString()])
    await vaultClient.send.call({
      method: 'destroyClaimAsa(uint64)void',
      args: [appClient.appId],
      sender: creator.addr,
      assetReferences: [claimAsa],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    const afterGc = await snapshot([vaultAddress, creator.addr.toString()])
    expect(delta(beforeGc, afterGc, vaultAddress).minBalance).toEqual(-VAULT_PARKED_RELEASED_AT_DESTROY)
    expect(delta(beforeGc, afterGc, creator.addr.toString()).balance).toEqual(-FEE_DESTROY)
  })

  test('delete on an open campaign with everything cancelled: no settlement needed', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'All cancelled', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    await surrenderViaCampaign(appClient, backer.addr.toString(), claimAsa, 'cancelPledge') // raised back to 0

    // Open, raised == 0, asset attached: deletable without settling the vault.
    const before = await snapshot([creator.addr.toString()])
    await deleteAs(appClient, creator.addr.toString(), claimAsa, 2000)
    const after = await snapshot([creator.addr.toString()])
    expect(delta(before, after, creator.addr.toString()).balance).toEqual(MIN_DEPOSIT - FEE_DELETE_CLAIMED)
    expect(delta(before, after, creator.addr.toString()).minBalance).toEqual(-CREATOR_FLOOR)

    // No settlement record was written (the getMapValue lookup 404s).
    const vaultClient = vaultClientFor(backer.addr.toString())
    await expect(vaultClient.state.box.getMapValue('settled', appClient.appId)).rejects.toThrow()
  })

  test('refund rejects a surrender with close-remainder, on both paths', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Close-remainder guards', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    // Campaign path: a surrender with closeAssetTo is rejected (the payout must be exact).
    await advanceTime(60)
    const axferWithClose = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: ALGO,
      closeAssetTo: vaultAddress,
    })
    await expect(
      appClient.send.call({
        method: 'refund(axfer)void',
        args: [axferWithClose],
        sender: backer.addr,
        appReferences: [vaultId],
        boxReferences: vaultBoxes(appClient.appId, ['a', 'd']),
        extraFee: (2000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/close-out is not allowed here/)

    // Vault path (post-settlement): the same guard.
    await deleteAs(appClient, creator.addr.toString(), claimAsa, 3000)
    const vaultClient = vaultClientFor(backer.addr.toString())
    const vaultAxferWithClose = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: ALGO,
      closeAssetTo: vaultAddress,
    })
    await expect(
      vaultClient.send.call({
        method: 'refund(uint64,axfer)void',
        args: [appClient.appId, vaultAxferWithClose],
        sender: backer.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/close-out is not allowed here/)

    // A mismatched campaign id is refused (the vault's mapping is authoritative).
    const cleanAxfer = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: ALGO,
    })
    await expect(
      vaultClient.send.call({
        method: 'refund(uint64,axfer)void',
        args: [999_999n, cleanAxfer],
        sender: backer.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/unknown claim asset/)

    // The backer's claim survived every rejected attempt.
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(ALGO)
  })

  test('fund guards on-chain: non-creator and double funding are rejected at zero cost', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient } = await deployCampaign(creator.addr.toString(), 'Fund guards', (10).algo().microAlgo)

    const before = await snapshot([stranger.addr.toString(), creator.addr.toString(), appClient.appAddress.toString()])

    const strangerPayment = await algorand.createTransaction.payment({
      sender: stranger.addr.toString(),
      receiver: appClient.appAddress,
      amount: microAlgos(MIN_DEPOSIT),
    })
    await expect(
      appClient.send.call({
        method: 'fund(pay)void',
        args: [strangerPayment],
        sender: stranger.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the creator can fund/)

    // Double funding is refused (the Claim ASA is already attached).
    const secondPayment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: appClient.appAddress,
      amount: microAlgos(MIN_DEPOSIT),
    })
    await expect(
      appClient.send.call({
        method: 'fund(pay)void',
        args: [secondPayment],
        sender: creator.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/claim asset already attached/)

    const after = await snapshot([stranger.addr.toString(), creator.addr.toString(), appClient.appAddress.toString()])
    for (const address of [stranger.addr.toString(), creator.addr.toString(), appClient.appAddress.toString()]) {
      const d = delta(before, after, address)
      expect(d.balance).toEqual(0n)
      expect(d.minBalance).toEqual(0n)
    }
  })

  test(
    'A: N backers — the creator deletes once, then every backer refunds independently from the vault',
    { timeout: 120_000 },
    async () => {
      const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const backers = await Promise.all([
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      ])
      const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'N backers', (10).algo().microAlgo)
      for (const backer of backers) {
        await optInAs(backer.addr.toString(), claimAsa)
        await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
      }

      await advanceTime(60)

      // The creator's single cancellation action: one O(1) delete that settles the vault and closes the escrow.
      const creatorBefore = await snapshot([creator.addr.toString()])
      await deleteAs(appClient, creator.addr.toString(), claimAsa, 3000)
      const creatorAfter = await snapshot([creator.addr.toString()])
      expect(delta(creatorBefore, creatorAfter, creator.addr.toString()).balance).toEqual(MIN_DEPOSIT - FEE_DELETE_FAILED)
      expect(delta(creatorBefore, creatorAfter, creator.addr.toString()).minBalance).toEqual(-CREATOR_FLOOR)

      // Every backer refunds their own pledge independently, straight from the vault — no order, no dependency on anyone else.
      const vaultBefore = await snapshot([vaultAddress])
      for (const backer of backers) {
        expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(ALGO)
        const before = await snapshot([backer.addr.toString()])
        await refundViaVault(backer.addr.toString(), appClient.appId, claimAsa)
        const after = await snapshot([backer.addr.toString()])
        expect(delta(before, after, backer.addr.toString()).balance).toEqual(ALGO - FEE_REFUND_VAULT)
        expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(0n)
      }
      const vaultAfter = await snapshot([vaultAddress])
      expect(delta(vaultBefore, vaultAfter, vaultAddress).balance).toEqual(-3n * ALGO)
    },
  )

  test(
    'B: two campaigns live simultaneously — one claimed and drained, the other still refunds in full',
    { timeout: 120_000 },
    async () => {
      const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const [backerA, backerB] = await Promise.all([
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
        fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      ])
      const funded = await deployCampaign(creator.addr.toString(), 'Funded twin', (1).algo().microAlgo)
      const failing = await deployCampaign(creator.addr.toString(), 'Failing twin', (10).algo().microAlgo)
      await optInAs(backerA.addr.toString(), funded.claimAsa)
      await pledgeAs(funded.appClient, backerA.addr.toString(), funded.claimAsa, ALGO)
      await optInAs(backerB.addr.toString(), failing.claimAsa)
      await pledgeAs(failing.appClient, backerB.addr.toString(), failing.claimAsa, ALGO)

      await advanceTime(60)

      // The pool before this scenario (earlier tests in the suite leave their own settled-but-unclaimed funds — only deltas matter).
      const poolBefore = await snapshot([vaultAddress])

      // The funded twin drains the pool via the claim...
      const claimBefore = await snapshot([creator.addr.toString(), vaultAddress])
      await claimAs(funded.appClient, creator.addr.toString())
      const claimAfter = await snapshot([creator.addr.toString(), vaultAddress])
      expect(delta(claimBefore, claimAfter, creator.addr.toString()).balance).toEqual(ALGO - FEE_CLAIM)
      expect(delta(claimBefore, claimAfter, vaultAddress).balance).toEqual(-ALGO)
      await deleteAs(funded.appClient, creator.addr.toString(), funded.claimAsa, 2000)

      // ...and the failing twin's backer still refunds in full afterwards.
      await deleteAs(failing.appClient, creator.addr.toString(), failing.claimAsa, 3000)
      const refundBefore = await snapshot([backerB.addr.toString(), vaultAddress])
      await refundViaVault(backerB.addr.toString(), failing.appClient.appId, failing.claimAsa)
      const refundAfter = await snapshot([backerB.addr.toString(), vaultAddress])
      expect(delta(refundBefore, refundAfter, backerB.addr.toString()).balance).toEqual(ALGO - FEE_REFUND_VAULT)
      expect(delta(refundBefore, refundAfter, vaultAddress).balance).toEqual(-ALGO)

      // The pool dropped by exactly the claim + the refund — neither campaign's settlement touched the other's funds.
      const poolAfter = await snapshot([vaultAddress])
      expect(delta(poolBefore, poolAfter, vaultAddress).balance).toEqual(-2n * ALGO)
    },
  )

  test('C: claim and refund interleaved in arbitrary order across the pool', { timeout: 120_000 }, async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backerA, backerB1, backerB2] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const claimed = await deployCampaign(creator.addr.toString(), 'Interleave A', (1).algo().microAlgo)
    const failed = await deployCampaign(creator.addr.toString(), 'Interleave B', (10).algo().microAlgo)
    for (const [backer, camp] of [
      [backerA, claimed],
      [backerB1, failed],
      [backerB2, failed],
    ] as const) {
      await optInAs(backer.addr.toString(), camp.claimAsa)
      await pledgeAs(camp.appClient, backer.addr.toString(), camp.claimAsa, ALGO)
    }

    await advanceTime(60)

    // The pool before this scenario (earlier tests in the suite leave their own settled-but-unclaimed funds — only deltas matter).
    const poolBefore = await snapshot([vaultAddress])

    // Interleaving: claim A → refund B1 (campaign path) → double-claim A rejected → double-refund B1 rejected → settle B →
    // refund B2 (vault path) → delete A.
    await claimAs(claimed.appClient, creator.addr.toString())
    await surrenderViaCampaign(failed.appClient, backerB1.addr.toString(), failed.claimAsa, 'refund')
    await expect(claimAs(claimed.appClient, creator.addr.toString())).rejects.toThrow(/already claimed/)
    await expect(surrenderViaCampaign(failed.appClient, backerB1.addr.toString(), failed.claimAsa, 'refund')).rejects.toThrow()
    await deleteAs(failed.appClient, creator.addr.toString(), failed.claimAsa, 3000)
    await refundViaVault(backerB2.addr.toString(), failed.appClient.appId, failed.claimAsa)
    await deleteAs(claimed.appClient, creator.addr.toString(), claimed.claimAsa, 2000)

    // The ledger: backerA's pledge went to the creator via the claim; backerB1 and backerB2 got their full pledges back — the pool
    // dropped by exactly those three payouts.
    const poolAfter = await snapshot([vaultAddress])
    expect(delta(poolBefore, poolAfter, vaultAddress).balance).toEqual(-3n * ALGO)
    expect(await claimBalanceOf(backerA.addr.toString(), claimed.claimAsa)).toEqual(ALGO) // worthless but untouched units
    expect(await claimBalanceOf(backerB1.addr.toString(), failed.claimAsa)).toEqual(0n)
    expect(await claimBalanceOf(backerB2.addr.toString(), failed.claimAsa)).toEqual(0n)
  })

  test('D: the derived claim amount (T − U_i − H_i) always equals raised', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const [backer1, backer2, backer3] = await Promise.all([
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
      fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true }),
    ])
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Formula', (2).algo().microAlgo)
    for (const backer of [backer1, backer2, backer3]) {
      await optInAs(backer.addr.toString(), claimAsa)
      await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    }

    // One cancellation returns 1 ALGO of units to the vault: raised = 2 ALGO (the goal).
    const cancelAxfer = await algorand.createTransaction.assetTransfer({
      sender: backer3.addr.toString(),
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: ALGO,
    })
    await appClient.send.call({
      method: 'cancelPledge(axfer)void',
      args: [cancelAxfer],
      sender: backer3.addr,
      appReferences: [vaultId],
      boxReferences: vaultBoxes(appClient.appId, ['a', 'd']),
      extraFee: (2000).microAlgo(),
      suppressLog: true,
    })

    await advanceTime(60)

    // Evaluate the formula from live on-chain holdings, immediately before the claim.
    const vaultHolding = await algorand.asset.getAccountInformation(vaultAddress, claimAsa)
    const escrowHolding = await algorand.asset.getAccountInformation(appClient.appAddress.toString(), claimAsa)
    const outstanding = TOTAL_CLAIM_UNITS - vaultHolding.balance - escrowHolding.balance
    const raised = (await appClient.state.global.getValue('raised')) as bigint

    // T − U_i − H_i equals raised, exactly — the claim pays precisely that.
    expect(outstanding).toEqual(raised)
    expect(raised).toEqual(2n * ALGO)

    const before = await snapshot([creator.addr.toString(), vaultAddress])
    await claimAs(appClient, creator.addr.toString())
    const after = await snapshot([creator.addr.toString(), vaultAddress])
    expect(delta(before, after, creator.addr.toString()).balance).toEqual(outstanding - FEE_CLAIM)
    expect(delta(before, after, vaultAddress).balance).toEqual(-outstanding)
  })
})
