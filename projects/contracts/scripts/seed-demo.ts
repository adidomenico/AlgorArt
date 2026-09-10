import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Seed the running LocalNet with demo `Campaign` applications so the frontend has data to render.
 *
 * Creates one campaign per wallet below (each wallet is idempotently created and funded from the LocalNet dispenser), funds the storage
 * deposit (issuing each campaign's Claim ASA), registers it with the Factory when `FACTORY_APP_ID` is set, and pledges to a couple of
 * them from a backer wallet so the list shows partial progress.
 *
 * Usage: `algokit localnet start && npm run build && FACTORY_APP_ID=<id> npx ts-node --transpile-only scripts/seed-demo.ts`
 */

const SPEC_PATH = path.resolve(__dirname, '../smart_contracts/artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../smart_contracts/artifacts/factory/Factory.arc56.json')

const DAY = 86_400

// The Factory registration deposit: the registration box's minimum balance, returned on unregister.
const REGISTER_MBR = 18_900n

/** Campaigns to create: [creator wallet, goal (ALGO), days until deadline, pledge (ALGO) or 0]. */
const CAMPAIGNS: ReadonlyArray<{ creator: string; goalAlgo: number; days: number; pledgeAlgo: number }> = [
  { creator: 'alice', goalAlgo: 10, days: 14, pledgeAlgo: 4 },
  { creator: 'bob', goalAlgo: 25, days: 21, pledgeAlgo: 0 },
  { creator: 'carol', goalAlgo: 50, days: 30, pledgeAlgo: 18 },
  { creator: 'dave', goalAlgo: 5, days: 7, pledgeAlgo: 0 },
]

void (async () => {
  const algorand = AlgorandClient.defaultLocalNet()
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as Arc56Contract
  const factoryId = process.env.FACTORY_APP_ID !== undefined && process.env.FACTORY_APP_ID !== '' ? BigInt(process.env.FACTORY_APP_ID) : 0n
  const factorySpec = factoryId > 0n ? (JSON.parse(fs.readFileSync(FACTORY_SPEC_PATH, 'utf8')) as Arc56Contract) : undefined

  const backer = await algorand.account.fromEnvironment('backer', (100).algo())

  for (const c of CAMPAIGNS) {
    const creator = await algorand.account.fromEnvironment(c.creator, (100).algo())

    const factory = new AppFactory({ appSpec: spec, algorand, defaultSender: creator.addr })

    const goal = BigInt(c.goalAlgo) * 1_000_000n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + c.days * DAY)

    const { result } = await factory.send.create({
      method: 'create(byte[],byte[],uint64,uint64)void',
      args: [new TextEncoder().encode(`${c.creator}'s campaign`), new TextEncoder().encode(`ipfs://seed/${c.creator}`), goal, deadline],
      sender: creator.addr,
    })

    const client = factory.getAppClientById({ appId: result.appId })

    // Fund the storage deposit: 0.2 ALGO covers the escrow's fixed minimum balance and issues the Claim ASA.
    const fundPayment = await algorand.createTransaction.payment({
      sender: creator.addr,
      receiver: result.appAddress,
      amount: microAlgos(200_000n),
    })
    await client.send.call({
      method: 'fund(pay)void',
      args: [fundPayment],
      sender: creator.addr,
      extraFee: microAlgos(1000),
    })

    const claimAsa = (await client.state.global.getValue('claimAsa')) as bigint

    let registered = 'no'
    if (factoryId > 0n && factorySpec !== undefined) {
      const factoryClientFactory = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: creator.addr })
      const factoryClient = factoryClientFactory.getAppClientById({ appId: factoryId })
      const registerPayment = await algorand.createTransaction.payment({
        sender: creator.addr,
        receiver: factoryClient.appAddress,
        amount: microAlgos(REGISTER_MBR),
      })
      await factoryClient.send.call({
        method: 'register(uint64,pay)void',
        args: [result.appId, registerPayment],
        sender: creator.addr,
        appReferences: [result.appId],
      })
      registered = 'yes'
    }

    let pledged = '—'
    if (c.pledgeAlgo > 0) {
      // The backer opts into the Claim ASA, then pledges: the contract mints the same number of claim units.
      await algorand.send.assetOptIn({ sender: backer.addr, assetId: claimAsa })
      const pledgePayment = await algorand.createTransaction.payment({
        sender: backer.addr,
        receiver: result.appAddress,
        amount: microAlgos(BigInt(c.pledgeAlgo) * 1_000_000n),
      })
      await client.send.call({
        method: 'pledge(pay)void',
        args: [pledgePayment],
        sender: backer.addr,
        assetReferences: [claimAsa],
        extraFee: microAlgos(1000),
      })
      pledged = `${String(c.pledgeAlgo)} ALGO`
    }

    console.log(
      `#${result.appId.toString()} creator=${c.creator} (${creator.addr.toString()}) claimAsa=${claimAsa.toString()} ` +
        `goal=${String(c.goalAlgo)} ALGO deadline=${new Date(Number(deadline) * 1000).toISOString()} ` +
        `registered=${registered} pledged=${pledged}`,
    )
  }
})()
