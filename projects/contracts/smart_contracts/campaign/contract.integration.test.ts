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
 * exercise the full lifecycle end-to-end, checking every balance, minimum balance (MBR), ASA configuration, fee, and the attack matrix
 * (cross-campaign isolation, pooled solvency, settlement-after-deletion, counterfeit assets, double claims, pledge→cancel→refund
 * sequences, direct vault-call hijacking).
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

const ALGO = 1_000_000n
const BASE = 100_000n
const MIN_DEPOSIT = 200_000n
const ESCROW_MIN_BALANCE = BASE + 100_000n
const TOTAL_CLAIM_UNITS = 2n ** 64n - 1n
const TXN_FEE = 1_000n

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

  async function accountInfo(address: string) {
    const info = await algorand.account.getInformation(address)
    return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo }
  }

  /**
   * Deploy a full campaign: create → fund → issueClaimAsa (vault) → attachClaimAsa.
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
      extraFee: (3000).microAlgo(),
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

  function vaultClientFor(sender: string): AppClient {
    return new AppClient({
      algorand,
      appSpec: vaultSpec,
      appId: vaultId,
      defaultSender: sender,
    })
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
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Setup', (10).algo().microAlgo)

    const asset = await algorand.asset.getById(claimAsa)
    expect(asset.creator).toEqual(vaultAddress)
    expect(asset.manager).toEqual(vaultAddress)
    expect(asset.clawback).toEqual(vaultAddress)
    expect(asset.reserve).toEqual(vaultAddress)
    expect(asset.total).toEqual(TOTAL_CLAIM_UNITS)
    expect(asset.decimals).toEqual(0)

    // The escrow holds the whole supply and exactly the deposit.
    const escrow = await accountInfo(appClient.appAddress.toString())
    expect(escrow.balance).toEqual(MIN_DEPOSIT)
    expect(escrow.minBalance).toEqual(ESCROW_MIN_BALANCE)
    const escrowHolding = await algorand.asset.getAccountInformation(appClient.appAddress.toString(), claimAsa)
    expect(escrowHolding.balance).toEqual(TOTAL_CLAIM_UNITS)

    // The vault parks its created-asset MBR (accepted platform cost).
    const vault = await accountInfo(vaultAddress)
    expect(vault.minBalance).toBeGreaterThan(BASE)
  })

  test('pledge: pays the vault (escrow untouched), mints claim units, accumulates', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Pledge', (100).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)

    const vaultBefore = await accountInfo(vaultAddress)
    const escrowBefore = await accountInfo(appClient.appAddress.toString())

    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, 2n * ALGO)

    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(3n * ALGO)
    const vaultAfter = await accountInfo(vaultAddress)
    expect(vaultAfter.balance - vaultBefore.balance).toEqual(3n * ALGO)
    const escrowAfter = await accountInfo(appClient.appAddress.toString())
    expect(escrowAfter.balance).toEqual(escrowBefore.balance) // escrow untouched by pledges
  })

  test('pledge guards: no claim asset, wrong receiver, creator self-pledge', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Guards', (100).algo().microAlgo)

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
  })

  test('attachClaimAsa rejects a counterfeit asset (wrong creator)', async () => {
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

    // A decoy ASA created by a random account (not the vault) is rejected outright.
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
  })

  test('cancelPledge: the vault pays, raised decrements, units are consumed once', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Cancel', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    const before = await accountInfo(backer.addr.toString())
    await surrenderViaCampaign(appClient, backer.addr.toString(), claimAsa, 'cancelPledge')
    const after = await accountInfo(backer.addr.toString())

    // Refund paid by the vault: pledge back minus the axfer, the app call, and the inner call + inner payment fees.
    expect(after.balance - before.balance).toEqual(ALGO - 4n * TXN_FEE)
    expect(await claimBalanceOf(backer.addr.toString(), claimAsa)).toEqual(0n)

    await expect(surrenderViaCampaign(appClient, backer.addr.toString(), claimAsa, 'cancelPledge')).rejects.toThrow()
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

      // Backer1 refunds through the campaign (vault pays).
      await surrenderViaCampaign(appClient, backer1.addr.toString(), claimAsa, 'refund')
      expect(await claimBalanceOf(backer1.addr.toString(), claimAsa)).toEqual(0n)

      // Backer2 (the straggler) never acts. The creator deletes in ONE call: settle → holding close → escrow close.
      const creatorBefore = await accountInfo(creator.addr.toString())
      await deleteAs(appClient, creator.addr.toString(), claimAsa, 3000)
      const creatorAfter = await accountInfo(creator.addr.toString())

      // The deposit comes back (minus the delete call's own + inner fees); the floor is freed; the escrow is empty.
      expect(creatorAfter.balance - creatorBefore.balance).toEqual(MIN_DEPOSIT - 4n * TXN_FEE)
      expect(creatorAfter.minBalance).toEqual(BASE)

      // The straggler still refunds — directly from the vault, after the campaign is gone.
      expect(await claimBalanceOf(backer2.addr.toString(), claimAsa)).toEqual(ALGO)
      const stragglerBefore = await accountInfo(backer2.addr.toString())
      await refundViaVault(backer2.addr.toString(), appClient.appId, claimAsa)
      const stragglerAfter = await accountInfo(backer2.addr.toString())
      expect(stragglerAfter.balance - stragglerBefore.balance).toEqual(ALGO - 3n * TXN_FEE)
      expect(await claimBalanceOf(backer2.addr.toString(), claimAsa)).toEqual(0n)

      // All units are home again: the vault can garbage-collect the ASA and free its parked MBR.
      const vaultBefore = await accountInfo(vaultAddress)
      const vaultClient = vaultClientFor(creator.addr.toString())
      await vaultClient.send.call({
        method: 'destroyClaimAsa(uint64)void',
        args: [appClient.appId],
        sender: creator.addr,
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      })
      const vaultAfter = await accountInfo(vaultAddress)
      // destroyClaimAsa frees exactly this campaign's created-asset MBR + mapping boxes (100,000 + 56,400 µA).
      expect(vaultBefore.minBalance - vaultAfter.minBalance).toEqual(156_400n)
      await expect(algorand.asset.getById(claimAsa)).rejects.toThrow()
    },
  )

  test('vault refund guards: unsettled campaign, wrong asset, zero amount, close-out forbidden', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Refund guards', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    // Unsettled (campaign alive): the vault refuses.
    await expect(refundViaVault(backer.addr.toString(), appClient.appId, claimAsa)).rejects.toThrow(/campaign is not refundable/)

    // A counterfeit asset resolves to no campaign.
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
    const vaultClient = vaultClientFor(backer.addr.toString())
    const decoyAxfer = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: decoy.assetId,
      receiver: vaultAddress,
      amount: 1n,
    })
    // The vault is not opted into the decoy, so the surrender transfer itself fails at apply (receiver must opt in) — the first line of
    // defense. The vault's own `unknown claim asset` branch is covered offline and via the cross-campaign test's real-asset path.
    await expect(
      vaultClient.send.call({
        method: 'refund(uint64,axfer)void',
        args: [appClient.appId, decoyAxfer],
        sender: backer.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow()

    // Zero-amount surrender is rejected.
    const zeroAxfer = await algorand.createTransaction.assetTransfer({
      sender: backer.addr.toString(),
      assetId: claimAsa,
      receiver: vaultAddress,
      amount: 0n,
    })
    await expect(
      vaultClient.send.call({
        method: 'refund(uint64,axfer)void',
        args: [appClient.appId, zeroAxfer],
        sender: backer.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/claim amount must be greater than zero/)
  })

  test('claim guards: below goal, non-creator', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Claim guards', (10).algo().microAlgo)
    await optInAs(backer.addr.toString(), claimAsa)
    await pledgeAs(appClient, backer.addr.toString(), claimAsa, ALGO)

    await advanceTime(60)

    await expect(claimAs(appClient, creator.addr.toString())).rejects.toThrow(/goal not reached/)
    await expect(claimAs(appClient, backer.addr.toString())).rejects.toThrow(/only the creator can claim/)
  })

  test('cross-campaign isolation: units of one campaign can never redeem on another', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const a = await deployCampaign(creator.addr.toString(), 'Campaign A', (1).algo().microAlgo)
    const b = await deployCampaign(creator.addr.toString(), 'Campaign B', (10).algo().microAlgo)

    await optInAs(backer.addr.toString(), a.claimAsa)
    await pledgeAs(a.appClient, backer.addr.toString(), a.claimAsa, ALGO)

    // B fails with a straggler; settle it.
    await optInAs(backer.addr.toString(), b.claimAsa)
    await pledgeAs(b.appClient, backer.addr.toString(), b.claimAsa, ALGO)
    await advanceTime(60)
    await deleteAs(b.appClient, creator.addr.toString(), b.claimAsa, 3000)

    // Presenting A's units (an open campaign) to the vault resolves to campaign A → not refundable.
    await expect(refundViaVault(backer.addr.toString(), a.appClient.appId, a.claimAsa)).rejects.toThrow(/campaign is not refundable/)

    // Presenting B's own units refunds B's own pledge — A's balance is untouched.
    const aUnitsBefore = await claimBalanceOf(backer.addr.toString(), a.claimAsa)
    await refundViaVault(backer.addr.toString(), b.appClient.appId, b.claimAsa)
    expect(await claimBalanceOf(backer.addr.toString(), a.claimAsa)).toEqual(aUnitsBefore)
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

    const vaultBefore = await accountInfo(vaultAddress)

    // A fails and is settled with straggler A; B fails too.
    await advanceTime(60)
    await deleteAs(a.appClient, creator.addr.toString(), a.claimAsa, 3000)
    await deleteAs(b.appClient, creator.addr.toString(), b.claimAsa, 3000)

    // Both stragglers refund everything. The vault pays exactly the pledged amounts (minus nothing) and never goes below its reserve.
    for (const [backer, camp] of [
      [backerA, a],
      [backerB, b],
    ] as const) {
      const before = await accountInfo(backer.addr.toString())
      await refundViaVault(backer.addr.toString(), camp.appClient.appId, camp.claimAsa)
      const after = await accountInfo(backer.addr.toString())
      expect(after.balance - before.balance).toEqual(ALGO - 3n * TXN_FEE)
    }

    const vaultAfter = await accountInfo(vaultAddress)
    expect(vaultAfter.balance).toEqual(vaultBefore.balance - 2n * ALGO)
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
      const creatorBefore = await accountInfo(creator.addr.toString())
      const vaultBefore = await accountInfo(vaultAddress)
      await claimAs(appClient, creator.addr.toString())
      const creatorAfter = await accountInfo(creator.addr.toString())
      expect(creatorAfter.balance - creatorBefore.balance).toEqual(2n * ALGO - 3n * TXN_FEE)
      const vaultAfter = await accountInfo(vaultAddress)
      expect(vaultAfter.balance).toEqual(vaultBefore.balance - 2n * ALGO)

      // Double claim and refunds are rejected.
      await expect(claimAs(appClient, creator.addr.toString())).rejects.toThrow(/already claimed/)
      await expect(refundViaVault(backer1.addr.toString(), appClient.appId, claimAsa)).rejects.toThrow(/campaign is not refundable/)

      // The creator deletes in O(1): holding close + escrow close; deposit + floor recovered.
      const creatorBeforeDelete = await accountInfo(creator.addr.toString())
      await deleteAs(appClient, creator.addr.toString(), claimAsa, 2000)
      const creatorAfterDelete = await accountInfo(creator.addr.toString())
      expect(creatorAfterDelete.balance - creatorBeforeDelete.balance).toEqual(MIN_DEPOSIT - 3n * TXN_FEE)
      expect(creatorAfterDelete.minBalance).toEqual(BASE)

      // GC: sweep the worthless units from both holders, then destroy the ASA and free the vault's parked MBR.
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

      // Sweeping a settled-claimed campaign is permissionless; after the last holder, the destroy succeeds.
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

      const vaultBeforeGc = await accountInfo(vaultAddress)
      await vaultClient.send.call({
        method: 'destroyClaimAsa(uint64)void',
        args: [appClient.appId],
        sender: creator.addr,
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      })
      const vaultAfterGc = await accountInfo(vaultAddress)
      // destroyClaimAsa frees exactly this campaign's created-asset MBR + mapping boxes (100,000 + 56,400 µA).
      expect(vaultBeforeGc.minBalance - vaultAfterGc.minBalance).toEqual(156_400n)
      await expect(algorand.asset.getById(claimAsa)).rejects.toThrow()
    },
  )

  test('vault payout methods reject non-campaign callers (no hijacking)', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const attacker = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Hijack target', (10).algo().microAlgo)
    const vaultClient = vaultClientFor(attacker.addr.toString())

    // A random account cannot trigger payBack (which would pay itself).
    await expect(
      vaultClient.send.call({
        method: 'payBack(uint64,address,uint64)void',
        args: [appClient.appId, attacker.addr.toString(), ALGO],
        sender: attacker.addr,
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)

    // Nor payClaim (stealing the pool), nor settle (forcing refunds on a live campaign).
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
    void claimAsa
  })

  test('stray ALGO sent to the vault cannot be extracted by anyone', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const { appClient, claimAsa } = await deployCampaign(creator.addr.toString(), 'Stray', (10).algo().microAlgo)

    await algorand.send.payment({ sender: stranger.addr, receiver: vaultAddress, amount: microAlgos(ALGO), suppressLog: true })
    const vaultBefore = await accountInfo(vaultAddress)

    // The stranger has no units; no payout path exists for them.
    await expect(refundViaVault(stranger.addr.toString(), appClient.appId, claimAsa)).rejects.toThrow()

    // The stray ALGO stays in the vault: no payout path references it.
    const vaultAfter = await accountInfo(vaultAddress)
    expect(vaultAfter.balance).toEqual(vaultBefore.balance)
    void appClient
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

    const creatorBefore = await accountInfo(creator.addr.toString())
    await deleteAs(appClient, creator.addr.toString(), undefined, 1000)
    const creatorAfter = await accountInfo(creator.addr.toString())
    expect(creatorAfter.minBalance).toEqual(BASE)
    expect(creatorAfter.balance - creatorBefore.balance).toEqual(-2n * TXN_FEE)
  })
})
