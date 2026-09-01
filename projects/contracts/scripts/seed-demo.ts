import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Seed the running LocalNet with demo `Campaign` applications so the frontend has data to render.
 *
 * Creates one campaign per wallet below (each wallet is idempotently created and funded from the LocalNet dispenser), then pledges to a
 * couple of them from a backer wallet so the list shows partial progress.
 *
 * Usage: `algokit localnet start && npm run build && npx ts-node --transpile-only scripts/seed-demo.ts`
 */

const SPEC_PATH = path.resolve(__dirname, '../smart_contracts/artifacts/campaign/Campaign.arc56.json')

const DAY = 86_400

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

  const backer = await algorand.account.fromEnvironment('backer', (100).algo())

  for (const c of CAMPAIGNS) {
    const creator = await algorand.account.fromEnvironment(c.creator, (100).algo())

    const factory = new AppFactory({ appSpec: spec, algorand, defaultSender: creator.addr })

    const goal = BigInt(c.goalAlgo) * 1_000_000n
    const deadline = BigInt(Math.floor(Date.now() / 1000) + c.days * DAY)

    const { result } = await factory.send.create({
      method: 'create(uint64,uint64)void',
      args: [goal, deadline],
      sender: creator.addr,
    })

    let pledged = '—'
    if (c.pledgeAlgo > 0) {
      const client = factory.getAppClientById({ appId: result.appId })
      const amount = BigInt(c.pledgeAlgo) * 1_000_000n
      const payment = await algorand.createTransaction.payment({
        sender: backer.addr,
        receiver: client.appAddress,
        amount: (c.pledgeAlgo).algo(),
      })
      await client.send.call({
        method: 'pledge(pay)void',
        args: [payment],
        sender: backer.addr,
      })
      pledged = `${c.pledgeAlgo} ALGO`
    }

    console.log(
      `#${result.appId.toString()} creator=${c.creator} (${creator.addr}) goal=${c.goalAlgo} ALGO deadline=${new Date(Number(deadline) * 1000).toISOString()} pledged=${pledged}`,
    )
  }
})()
