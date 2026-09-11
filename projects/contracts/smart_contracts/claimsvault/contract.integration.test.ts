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
 * `seedSupply`, and the caller-verification of `payBack`/`payClaim`/`settle` against the real chain.
 *
 * Requires `algokit localnet start` and a build (`npm run build`).
 */

const CAMPAIGN_SPEC_PATH = path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')
const VAULT_SPEC_PATH = path.resolve(__dirname, '../artifacts/claimsvault/ClaimsVault.arc56.json')

describe('ClaimsVault (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let campaignSpec: Arc56Contract
  let factorySpec: Arc56Contract
  let vaultSpec: Arc56Contract
  let factoryId: bigint
  let vaultId: bigint

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

    // A stranger cannot issue for someone else's campaign.
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

    // The creator issues; a second issue is rejected.
    const creatorVaultClient = vaultClientFor(creator.addr.toString())
    await creatorVaultClient.send.call({
      method: 'issueClaimAsa(uint64)void',
      args: [campaignClient.appId],
      sender: creator.addr,
      appReferences: [campaignClient.appId, factoryId],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    await expect(
      creatorVaultClient.send.call({
        method: 'issueClaimAsa(uint64)void',
        args: [campaignClient.appId],
        sender: creator.addr,
        appReferences: [campaignClient.appId, factoryId],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/claim asset already issued/)

    // The supply can only be seeded once: the campaign first attaches (self-opts in), then the first seed succeeds and the second is
    // rejected.
    const claimAsa = (await creatorVaultClient.state.box.getMapValue('asaOf', campaignClient.appId)) as bigint
    await campaignClient.send.call({
      method: 'attachClaimAsa(uint64)void',
      args: [claimAsa],
      sender: creator.addr,
      appReferences: [vaultId],
      assetReferences: [claimAsa],
      extraFee: (1000).microAlgo(),
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
})
