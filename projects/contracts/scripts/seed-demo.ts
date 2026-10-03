import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { ABIMethod } from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Seed the running LocalNet with demo `Campaign` applications so the frontend has data to render.
 *
 * Requires the Factory (`FACTORY_APP_ID`) and the ClaimsVault (`VAULT_APP_ID`) to be deployed. Creates one campaign per wallet below,
 * runs the setup chain (create → register), and pledges to a couple of them from a backer wallet so the list shows partial progress.
 * Pledge frontiers come from the claim-tree reference oracle (`../oracle.py`), one state file per campaign.
 *
 * Usage: `FACTORY_APP_ID=<id> VAULT_APP_ID=<id> npx ts-node --transpile-only scripts/seed-demo.ts`
 */

const SPEC_PATH = path.resolve(__dirname, '../smart_contracts/artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../smart_contracts/artifacts/factory/Factory.arc56.json')
const VAULT_SPEC_PATH = path.resolve(__dirname, '../smart_contracts/artifacts/claimsvault/ClaimsVault.arc56.json')

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

function appIdBytes(appId: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(appId)
  return buf
}

void (async () => {
  const algorand = AlgorandClient.defaultLocalNet()
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as Arc56Contract
  const factorySpec = JSON.parse(fs.readFileSync(FACTORY_SPEC_PATH, 'utf8')) as Arc56Contract
  const vaultSpec = JSON.parse(fs.readFileSync(VAULT_SPEC_PATH, 'utf8')) as Arc56Contract

  const factoryId = process.env.FACTORY_APP_ID !== undefined && process.env.FACTORY_APP_ID !== '' ? BigInt(process.env.FACTORY_APP_ID) : 0n
  const vaultId = process.env.VAULT_APP_ID !== undefined && process.env.VAULT_APP_ID !== '' ? BigInt(process.env.VAULT_APP_ID) : 0n
  if (factoryId === 0n || vaultId === 0n) {
    throw new Error('FACTORY_APP_ID and VAULT_APP_ID must both be set (deploy the Factory and the ClaimsVault first).')
  }
  const vaultClient = new AppFactory({ appSpec: vaultSpec, algorand, defaultSender: factoryId }).getAppClientById({ appId: vaultId })

  const backer = await algorand.account.fromEnvironment('backer', (100).algo())

  for (const c of CAMPAIGNS) {
    const creator = await algorand.account.fromEnvironment(c.creator, (100).algo())

    const campaignFactory = new AppFactory({ appSpec: spec, algorand, defaultSender: creator.addr })

    const goal = BigInt(c.goalAlgo) * 1_000_000n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + c.days * DAY)

    const { result } = await campaignFactory.send.create({
      method: 'create(uint64,byte[],byte[],uint64,uint64)void',
      args: [
        vaultId,
        new TextEncoder().encode(`${c.creator}'s campaign`),
        new TextEncoder().encode(`ipfs://seed/${c.creator}`),
        goal,
        deadline,
      ],
      sender: creator.addr,
      appReferences: [vaultId],
    })

    // Register with the Factory so the browse page lists the campaign (first-touch credit requires it on-chain).
    const factoryClient = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: creator.addr }).getAppClientById({
      appId: factoryId,
    })
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

    let pledged = '—'
    if (c.pledgeAlgo > 0) {
      // Pledge through the real group [pay, campaign.pledge, vault.credit]. Each campaign gets a single pledge, so
      // the frontier is always empty (N == 0 takes the empty-frontier branch).
      const amount = BigInt(c.pledgeAlgo) * 1_000_000n
      const pay = await algorand.createTransaction.payment({
        sender: backer.addr,
        receiver: vaultClient.appAddress,
        amount: microAlgos(amount),
      })
      const composer = algorand.send.newGroup()
      composer.addAppCallMethodCall({
        appId: result.appId,
        method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
        args: [pay, new Uint8Array()],
        sender: backer.addr,
      })
      const appIdBuf = appIdBytes(result.appId)
      composer.addAppCallMethodCall({
        appId: vaultId,
        method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
        args: [result.appId, amount],
        sender: backer.addr,
        appReferences: [factoryId],
        boxReferences: [
          { appId: vaultId, name: new Uint8Array(Buffer.concat([Buffer.from('c'), appIdBuf])) },
          { appId: factoryId, name: new Uint8Array(Buffer.concat([Buffer.from('r'), appIdBuf])) },
        ],
        extraFee: microAlgos(1_000n),
      })
      await composer.send()
      pledged = `${String(c.pledgeAlgo)} ALGO`
    }

    console.log(
      `#${result.appId.toString()} creator=${c.creator} (${creator.addr.toString()}) ` +
        `goal=${String(c.goalAlgo)} ALGO deadline=${new Date(Number(deadline) * 1000).toISOString()} pledged=${pledged}`,
    )
  }
})()
