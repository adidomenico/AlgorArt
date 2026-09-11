import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

/**
 * LocalNet integration tests for the Factory registry: deploy the Factory, hash a real Campaign's approval program, and exercise
 * register/unregister/isRegistered, including the authorization and impostor guards.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

const ALGO = 1_000_000n
const TXN_FEE = 1_000n
const REGISTER_MBR = 18_900n // the registration box's minimum balance (2500 + 400 × (9 + 32))

const CAMPAIGN_SPEC_PATH = path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')

describe('Factory (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let factorySpec: Arc56Contract
  let campaignSpec: Arc56Contract

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand
    factorySpec = JSON.parse(fs.readFileSync(FACTORY_SPEC_PATH, 'utf8')) as Arc56Contract
    campaignSpec = JSON.parse(fs.readFileSync(CAMPAIGN_SPEC_PATH, 'utf8')) as Arc56Contract
  })

  /**
   * Deploy the Factory, fund its application account, and return its client.
   *
   * @param ownerAddr The platform owner's address.
   */
  async function deployFactory(ownerAddr: string) {
    const factory = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: ownerAddr })
    const { appClient } = await factory.send.create({ method: 'create()void', args: [], sender: ownerAddr, suppressLog: true })

    // The platform funds the Factory account: the 0.1 ALGO base, so it can hold registration deposits and pay them back.
    await algorand.send.payment({ sender: ownerAddr, receiver: appClient.appAddress, amount: microAlgos(ALGO), suppressLog: true })
    return appClient
  }

  /**
   * Deploy + fund a real Campaign and return its client.
   *
   * @param creatorAddr The campaign creator's address.
   */
  async function deployCampaign(creatorAddr: string): Promise<AppClient> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const factory = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creatorAddr })
    const { appClient } = await factory.send.create({
      method: 'create(uint64,byte[],byte[],uint64,uint64)void',
      args: [1n, new TextEncoder().encode('Registrable'), new TextEncoder().encode('ipfs://test'), 1_000_000n, deadline],
      sender: creatorAddr,
      appReferences: [1n],
      suppressLog: true,
    })
    return appClient
  }

  /**
   * The SHA-256 of the deployed Campaign's approval program, exactly what the Factory verifies.
   *
   * @param appId The deployed Campaign's application id.
   */
  async function campaignApprovalHash(appId: bigint): Promise<Uint8Array> {
    const info = await algorand.app.getById(appId)
    return createHash('sha256').update(info.approvalProgram).digest()
  }

  /**
   * Call the Factory's readonly `isRegistered` and decode the boolean return.
   *
   * @param factoryClient The deployed Factory client.
   * @param appId The campaign application id.
   * @param callerAddr The address paying for the readonly call.
   */
  async function isRegistered(factoryClient: AppClient, appId: bigint, callerAddr: string): Promise<boolean> {
    const result = await factoryClient.send.call({
      method: 'isRegistered(uint64)bool',
      args: [appId],
      sender: callerAddr,
      appReferences: [appId],
      suppressLog: true,
    })
    return Boolean(result.return)
  }

  async function accountInfo(address: string) {
    const info = await algorand.account.getInformation(address)
    return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo }
  }

  test('register/isRegistered/unregister round trip with a real Campaign', { timeout: 120_000 }, async () => {
    const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const factoryClient = await deployFactory(owner.addr.toString())
    const factoryAddress = factoryClient.appAddress.toString()

    const campaignClient = await deployCampaign(creator.addr.toString())
    const campaignId = campaignClient.appId

    // Configure the official hash from the real deployed program.
    const hash = await campaignApprovalHash(campaignId)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [hash],
      sender: owner.addr,
      suppressLog: true,
    })

    // Register: the creator pays the refundable deposit.
    const factoryBefore = await accountInfo(factoryAddress)
    const creatorBefore = await accountInfo(creator.addr.toString())
    const payment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: factoryAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await factoryClient.send.call({
      method: 'register(uint64,pay)void',
      args: [campaignId, payment],
      sender: creator.addr,
      appReferences: [campaignId],
      suppressLog: true,
    })

    // The deposit landed on the Factory account; the registration box exists.
    const factoryAfterRegister = await accountInfo(factoryAddress)
    expect(factoryAfterRegister.balance - factoryBefore.balance).toEqual(REGISTER_MBR)
    expect(await isRegistered(factoryClient, campaignId, owner.addr.toString())).toBe(true)

    // Double registration fails.
    const secondPayment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: factoryAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await expect(
      factoryClient.send.call({
        method: 'register(uint64,pay)void',
        args: [campaignId, secondPayment],
        sender: creator.addr,
        appReferences: [campaignId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/campaign already registered/)

    // Unregister: the deposit is returned to the creator and the registration disappears.
    await factoryClient.send.call({
      method: 'unregister(uint64)void',
      args: [campaignId],
      sender: creator.addr,
      appReferences: [campaignId],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    expect(await isRegistered(factoryClient, campaignId, owner.addr.toString())).toBe(false)

    const creatorAfter = await accountInfo(creator.addr.toString())
    // Deposit returned; the creator only pays the register and unregister call fees (2,000 µA each, as measured on LocalNet).
    expect(creatorAfter.balance - creatorBefore.balance).toEqual(-4n * TXN_FEE)
    const factoryAfterUnregister = await accountInfo(factoryAddress)
    expect(factoryAfterUnregister.balance).toEqual(factoryAfterRegister.balance - REGISTER_MBR)
  })

  test('an impostor copy of the Campaign contract cannot register', { timeout: 120_000 }, async () => {
    const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const factoryClient = await deployFactory(owner.addr.toString())
    const campaignClient = await deployCampaign(creator.addr.toString())

    const hash = await campaignApprovalHash(campaignClient.appId)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [hash],
      sender: owner.addr,
      suppressLog: true,
    })

    // The Factory itself is an application, but not the official Campaign: its program hash does not match. The owner (the Factory's
    // creator) registers it, so the creator check passes and the program-hash check is what rejects.
    const payment = await algorand.createTransaction.payment({
      sender: owner.addr.toString(),
      receiver: factoryClient.appAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await expect(
      factoryClient.send.call({
        method: 'register(uint64,pay)void',
        args: [factoryClient.appId, payment],
        sender: owner.addr,
        appReferences: [factoryClient.appId],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not an official AlgorArt campaign/)
  })

  test(
    'a non-creator cannot register someone else’s campaign, and registration is refused before the hash is configured',
    { timeout: 120_000 },
    async () => {
      const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
      const factoryClient = await deployFactory(owner.addr.toString())
      const campaignClient = await deployCampaign(creator.addr.toString())

      // No hash configured yet: registration is refused outright.
      const payment = await algorand.createTransaction.payment({
        sender: creator.addr.toString(),
        receiver: factoryClient.appAddress,
        amount: microAlgos(REGISTER_MBR),
      })
      await expect(
        factoryClient.send.call({
          method: 'register(uint64,pay)void',
          args: [campaignClient.appId, payment],
          sender: creator.addr,
          appReferences: [campaignClient.appId],
          suppressLog: true,
        }),
      ).rejects.toThrow(/official approval hash not configured/)

      const hash = await campaignApprovalHash(campaignClient.appId)
      await factoryClient.send.call({
        method: 'setApprovalHash(byte[])void',
        args: [hash],
        sender: owner.addr,
        suppressLog: true,
      })

      // A stranger cannot register a campaign they did not create.
      const strangerPayment = await algorand.createTransaction.payment({
        sender: stranger.addr.toString(),
        receiver: factoryClient.appAddress,
        amount: microAlgos(REGISTER_MBR),
      })
      await expect(
        factoryClient.send.call({
          method: 'register(uint64,pay)void',
          args: [campaignClient.appId, strangerPayment],
          sender: stranger.addr,
          appReferences: [campaignClient.appId],
          suppressLog: true,
        }),
      ).rejects.toThrow(/only the campaign creator can register/)
    },
  )

  test('only the owner can set the official hash, and only the registered creator can unregister', { timeout: 120_000 }, async () => {
    const owner = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const creator = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const factoryClient = await deployFactory(owner.addr.toString())
    const campaignClient = await deployCampaign(creator.addr.toString())

    // Non-owner cannot set the hash.
    await expect(
      factoryClient.send.call({
        method: 'setApprovalHash(byte[])void',
        args: [new Uint8Array(32)],
        sender: stranger.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the owner can set the approval hash/)

    // Configure + register properly.
    const hash = await campaignApprovalHash(campaignClient.appId)
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [hash],
      sender: owner.addr,
      suppressLog: true,
    })
    const payment = await algorand.createTransaction.payment({
      sender: creator.addr.toString(),
      receiver: factoryClient.appAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await factoryClient.send.call({
      method: 'register(uint64,pay)void',
      args: [campaignClient.appId, payment],
      sender: creator.addr,
      appReferences: [campaignClient.appId],
      suppressLog: true,
    })

    // A stranger cannot unregister the campaign (the deposit stays protected).
    await expect(
      factoryClient.send.call({
        method: 'unregister(uint64)void',
        args: [campaignClient.appId],
        sender: stranger.addr,
        appReferences: [campaignClient.appId],
        extraFee: (1000).microAlgo(),
        suppressLog: true,
      }),
    ).rejects.toThrow(/only the campaign creator can unregister/)

    // The registered creator can.
    await factoryClient.send.call({
      method: 'unregister(uint64)void',
      args: [campaignClient.appId],
      sender: creator.addr,
      appReferences: [campaignClient.appId],
      extraFee: (1000).microAlgo(),
      suppressLog: true,
    })
    expect(await isRegistered(factoryClient, campaignClient.appId, owner.addr.toString())).toBe(false)
  })
})
