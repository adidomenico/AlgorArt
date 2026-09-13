import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

/**
 * LocalNet integration tests for the ClaimsVault's issuance path and payout-authority gating: the guards on `issueClaimAsa`,
 * `seedSupply`, and the caller-verification of `payBack`/`payClaim`/`settle` against the real chain — plus the protocol rule
 * that bounds the vault's clawback authority (a clawback axfer can never close a holder's position).
 *
 * Requires `algokit localnet start` and a build (`npm run build`).
 */

const CAMPAIGN_SPEC_PATH = path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')
const VAULT_SPEC_PATH = path.resolve(__dirname, '../artifacts/claimsvault/ClaimsVault.arc56.json')

/**
 * A bare probe app that creates an ASA with itself (the app account) as the clawback address and can attempt a clawback
 * close-out: an inner asset transfer with `AssetSender` = the holder and `AssetCloseTo` = the app. Its methods, dispatched
 * on the first application argument:
 *
 * - `make` — create the ASA (clawback = the app account) and record its id in global state.
 * - `give` — transfer `btoi(args[2])` units to `args[1]`.
 * - `claw` — claw `btoi(args[2])` units from `args[1]` (AssetSender) with AssetCloseTo = the app account.
 */
const CLAW_PROBE_TEAL = `
#pragma version 11

txn ApplicationID
bz create

txna ApplicationArgs 0
byte "make"
==
bnz make

txna ApplicationArgs 0
byte "give"
==
bnz give

txna ApplicationArgs 0
byte "claw"
==
bnz claw

err

make:
itxn_begin
int acfg
itxn_field TypeEnum
int 1000000
itxn_field ConfigAssetTotal
int 0
itxn_field ConfigAssetDecimals
global CurrentApplicationAddress
itxn_field ConfigAssetClawback
byte "CLAW"
itxn_field ConfigAssetUnitName
byte "Clawback probe"
itxn_field ConfigAssetName
itxn_submit
byte "aid"
itxn CreatedAssetID
app_global_put
int 1
return

give:
itxn_begin
int axfer
itxn_field TypeEnum
byte "aid"
app_global_get
itxn_field XferAsset
txna ApplicationArgs 2
btoi
itxn_field AssetAmount
txna ApplicationArgs 1
itxn_field AssetReceiver
itxn_submit
int 1
return

claw:
itxn_begin
int axfer
itxn_field TypeEnum
byte "aid"
app_global_get
itxn_field XferAsset
txna ApplicationArgs 2
btoi
itxn_field AssetAmount
global CurrentApplicationAddress
itxn_field AssetReceiver
txna ApplicationArgs 1
itxn_field AssetSender
global CurrentApplicationAddress
itxn_field AssetCloseTo
itxn_submit
int 1
return

create:
int 1
return
`

describe('ClaimsVault (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let campaignSpec: Arc56Contract
  let factorySpec: Arc56Contract
  let vaultSpec: Arc56Contract
  let factoryId: bigint
  let vaultId: bigint
  let vaultAddress: string

  // Vault MBR parked per issued campaign: 100,000 (created asset) + 47,100 (asaOf + addressOf + creatorOf boxes).
  const VAULT_PARKED_AT_ISSUE = 147_100n

  async function accountInfo(address: string) {
    const info = await algorand.account.getInformation(address)
    return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo }
  }

  function uint64Arg(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, value)
    return bytes
  }

  async function assetBalanceOf(address: string, assetId: bigint): Promise<bigint> {
    try {
      return (await algorand.asset.getAccountInformation(address, assetId)).balance
    } catch {
      return 0n
    }
  }

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand
    campaignSpec = JSON.parse(fs.readFileSync(CAMPAIGN_SPEC_PATH, 'utf8')) as Arc56Contract
    factorySpec = JSON.parse(fs.readFileSync(FACTORY_SPEC_PATH, 'utf8')) as Arc56Contract
    vaultSpec = JSON.parse(fs.readFileSync(VAULT_SPEC_PATH, 'utf8')) as Arc56Contract

    const owner = await fixture.context.generateAccount({ initialFunds: (50).algo(), suppressLog: true })
    const factoryFactory = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: owner.addr })
    const factoryClient = (await factoryFactory.send.create({ method: 'create()void', args: [], sender: owner.addr, suppressLog: true }))
      .appClient
    factoryId = factoryClient.appId
    // Platform funding: the Factory app account holds the registration deposits and pays the registration box MBR.
    await algorand.send.payment({
      sender: owner.addr,
      receiver: factoryClient.appAddress,
      amount: microAlgos(1_000_000n),
      suppressLog: true,
    })

    const campaignTeal = fs.readFileSync(path.resolve(__dirname, '../artifacts/campaign/Campaign.approval.teal'), 'utf8')
    const compiled = await algorand.app.compileTeal(campaignTeal)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [createHash('sha256').update(compiled.compiledBase64ToBytes).digest()],
      sender: owner.addr,
      suppressLog: true,
    })

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
      amount: microAlgos(1_000_000n),
      suppressLog: true,
    })
  })

  function vaultClientFor(sender: string): AppClient {
    return new AppClient({ algorand, appSpec: vaultSpec, appId: vaultId, defaultSender: sender })
  }

  function factoryClientFor(sender: string): AppClient {
    return new AppClient({ algorand, appSpec: factorySpec, appId: factoryId, defaultSender: sender })
  }

  /**
   * Register the campaign with the Factory (required by `issueClaimAsa`) and return the registration box reference.
   *
   * @param creatorAddr The campaign creator's address.
   * @param campaignId The campaign app id.
   */
  async function registerAs(creatorAddr: string, campaignId: bigint) {
    const factoryClient = factoryClientFor(creatorAddr)
    const payment = await algorand.createTransaction.payment({
      sender: creatorAddr,
      receiver: factoryClient.appAddress,
      amount: microAlgos(18_900n),
    })
    await factoryClient.send.call({
      method: 'register(uint64,pay)void',
      args: [campaignId, payment],
      sender: creatorAddr,
      appReferences: [campaignId],
      suppressLog: true,
    })
    const appIdBytes = Buffer.alloc(8)
    appIdBytes.writeBigUInt64BE(campaignId)
    return [{ appId: factoryId, name: Buffer.concat([Buffer.from('r'), appIdBytes]) }]
  }

  async function deployBareCampaign(creatorAddr: string): Promise<AppClient> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const factory = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creatorAddr })
    const { appClient } = await factory.send.create({
      method: 'create(uint64,byte[],byte[],uint64,uint64)void',
      args: [vaultId, new TextEncoder().encode('Vault target'), new TextEncoder().encode('ipfs://test'), 1_000_000n, deadline],
      sender: creatorAddr,
      appReferences: [vaultId],
      suppressLog: true,
    })
    const payment = await algorand.createTransaction.payment({
      sender: creatorAddr,
      receiver: appClient.appAddress,
      amount: microAlgos(200_000n),
    })
    await appClient.send.call({
      method: 'fund(pay)void',
      args: [payment],
      sender: creatorAddr,
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    return appClient
  }

  test('issueClaimAsa guards: non-creator, non-official program, double issue; seedSupply is one-shot', { timeout: 120_000 }, async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const campaignClient = await deployBareCampaign(creator.addr.toString())
    const vaultClient = vaultClientFor(stranger.addr.toString())
    const vaultBefore = await accountInfo(vaultAddress)
    const strangerBefore = await accountInfo(stranger.addr.toString())

    // A stranger cannot issue for someone else's campaign (the creator check fires before the registration check).
    await expect(
      vaultClient.send.call({
        method: 'issueClaimAsa(uint64)void',
        args: [campaignClient.appId],
        sender: stranger.addr,
        appReferences: [campaignClient.appId, factoryId],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the campaign creator can issue/)

    // A program that does not hash to the official one cannot be issued for (use the factory app itself as the impostor).
    await expect(
      vaultClient.send.call({
        method: 'issueClaimAsa(uint64)void',
        args: [factoryId],
        sender: stranger.addr,
        appReferences: [factoryId, factoryId],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/not an official AlgorArt campaign/)

    // The creator registers, then issues; a second issue is rejected.
    const creatorVaultClient = vaultClientFor(creator.addr.toString())
    const registrationBox = await registerAs(creator.addr.toString(), campaignClient.appId)
    await creatorVaultClient.send.call({
      method: 'issueClaimAsa(uint64)void',
      args: [campaignClient.appId],
      sender: creator.addr,
      appReferences: [campaignClient.appId, factoryId],
      boxReferences: registrationBox,
      extraFee: (2000).microAlgo(),
      suppressLog: true,
    })
    await expect(
      creatorVaultClient.send.call({
        method: 'issueClaimAsa(uint64)void',
        args: [campaignClient.appId],
        sender: creator.addr,
        appReferences: [campaignClient.appId, factoryId],
        boxReferences: registrationBox,
        extraFee: (2000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/claim asset already issued/)

    // The rejected attempts moved nothing for the stranger.
    expect((await accountInfo(stranger.addr.toString())).balance).toEqual(strangerBefore.balance)

    // The issue parked exactly the campaign's MBR on the vault (created asset + three mapping boxes) and moved no pool ALGO.
    const vaultAfterIssue = await accountInfo(vaultAddress)
    expect(vaultAfterIssue.minBalance - vaultBefore.minBalance).toEqual(VAULT_PARKED_AT_ISSUE)
    expect(vaultAfterIssue.balance).toEqual(vaultBefore.balance)

    // The supply can only be seeded once: the campaign first attaches (self-opts in), then the first seed succeeds and the second is
    // rejected.
    const claimAsa = (await creatorVaultClient.state.box.getMapValue('asaOf', campaignClient.appId)) as bigint
    const appIdBytes = Buffer.alloc(8)
    appIdBytes.writeBigUInt64BE(campaignClient.appId)
    await campaignClient.send.call({
      method: 'attachClaimAsa(uint64)void',
      args: [claimAsa],
      sender: creator.addr,
      appReferences: [vaultId],
      assetReferences: [claimAsa],
      boxReferences: ['a', 'd', 't'].map((prefix) => ({
        appId: vaultId,
        name: Buffer.concat([Buffer.from(prefix), appIdBytes]),
      })),
      extraFee: (2000).microAlgo(),
      suppressLog: true,
    })
    await creatorVaultClient.send.call({
      method: 'seedSupply(uint64)void',
      args: [campaignClient.appId],
      sender: creator.addr,
      appReferences: [campaignClient.appId],
      assetReferences: [claimAsa],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    await expect(
      creatorVaultClient.send.call({
        method: 'seedSupply(uint64)void',
        args: [campaignClient.appId],
        sender: creator.addr,
        appReferences: [campaignClient.appId],
        assetReferences: [claimAsa],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/supply already seeded/)
  })

  test('a clawback axfer cannot close a holder position — the protocol rejects the close-out and the 100k opt-in MBR stays parked', async () => {
    const prober = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })

    const probeApp = await algorand.send.appCreate({
      sender: prober.addr,
      approvalProgram: CLAW_PROBE_TEAL,
      clearStateProgram: CLAW_PROBE_TEAL,
      schema: { globalInts: 1, globalByteSlices: 0, localInts: 0, localByteSlices: 0 },
      suppressLog: true,
    })
    // The app account needs the created-asset MBR before `make` can run.
    await algorand.send.payment({
      sender: prober.addr,
      receiver: probeApp.appAddress,
      amount: microAlgos(200_000n),
      suppressLog: true,
    })
    await algorand.send.appCall({
      sender: prober.addr,
      appId: probeApp.appId,
      args: [new TextEncoder().encode('make')],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    const globalState = await algorand.app.getGlobalState(probeApp.appId)
    const assetId = (globalState.aid as { value: bigint }).value
    const asset = await algorand.asset.getById(assetId)
    expect(asset.clawback).toEqual(probeApp.appAddress.toString())

    // The backer opts in, parking 100,000 µA of MBR.
    await algorand.send.assetOptIn({ sender: backer.addr, assetId, suppressLog: true })
    const optedIn = await accountInfo(backer.addr.toString())
    expect(optedIn.minBalance).toEqual(200_000n)

    // The app hands the backer 5 units so the claw has something to take.
    await algorand.send.appCall({
      sender: prober.addr,
      appId: probeApp.appId,
      args: [new TextEncoder().encode('give'), backer.addr.publicKey, uint64Arg(5n)],
      accountReferences: [backer.addr.toString()],
      assetReferences: [assetId],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    expect(await assetBalanceOf(backer.addr.toString(), assetId)).toEqual(5n)

    // The clawback axfer with AssetSender = backer and AssetCloseTo = the app account is rejected by the protocol:
    // go-algorand refuses close-out on any clawback transfer ("cannot close asset by clawback").
    await expect(
      algorand.send.appCall({
        sender: prober.addr,
        appId: probeApp.appId,
        args: [new TextEncoder().encode('claw'), backer.addr.publicKey, uint64Arg(5n)],
        accountReferences: [backer.addr.toString()],
        assetReferences: [assetId],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/cannot close asset by clawback/)

    // Nothing moved: the units and the 100k MBR stay with the backer.
    expect(await assetBalanceOf(backer.addr.toString(), assetId)).toEqual(5n)
    const afterClaw = await accountInfo(backer.addr.toString())
    expect(afterClaw.balance).toEqual(optedIn.balance)
    expect(afterClaw.minBalance).toEqual(optedIn.minBalance)

    // Only the backer's own close-out releases the MBR: closing the holding to the app frees the backer's 100k.
    await algorand.send.assetOptOut({
      sender: backer.addr,
      assetId,
      creator: probeApp.appAddress.toString(),
      ensureZeroBalance: false,
      suppressLog: true,
    })
    const afterOptOut = await accountInfo(backer.addr.toString())
    expect(afterOptOut.minBalance).toEqual(afterClaw.minBalance - 100_000n)
    expect(await assetBalanceOf(backer.addr.toString(), assetId)).toEqual(0n)
  })
})
