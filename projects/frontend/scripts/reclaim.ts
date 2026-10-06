import type { TransactionSigner } from 'algosdk'
import algosdk, { getApplicationAddress } from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'
import { fetchChainTimestamp } from '../src/lib/algorand'
import { getCampaign, vaultAppId } from '../src/lib/campaign'
import { fetchPledges, fetchSpends } from '../src/lib/claimtree'
import { formatAlgo } from '../src/lib/format'
import type { BackerLeaf, WalletSession } from '../src/lib/transaction'
import { cancelPledge, claim, deleteCampaign, refund } from '../src/lib/transaction'

/**
 * Reclaim demo/test campaign funds and remove the campaigns from the browse list.
 *
 * For each campaign: route by on-chain state (claim when funded, refund/cancel known backers' leaves when
 * failed/open), then creator-`delete()` + factory-`unregister()`. Leaves from accounts without keys (e.g. manual
 * pledges from your own wallet) cannot be touched — they are reported with amounts so you can see them and refund
 * through the UI. Action failures are reported, never fatal (a rejection is also how the bad paths show up).
 *
 * Known accounts come from `<NAME>_MNEMONIC` env vars (any name works — the address is derived). Reuses the exact
 * transaction flows as the UI (`lib/transaction.ts`), so this also exercises them.
 *
 * Usage (from projects/frontend):
 *   npm run reclaim -- [appId...]
 * TestNet mnemonics live in ../../contracts/.env.testnet — export them first:
 *   set -a; source ../contracts/.env.testnet; set +a
 * With no app ids, falls back to the seed state file (`npm run seed` output).
 */

// Frontend config (VITE_*) lives in .env next to package.json — load it (tsx leaves import.meta.env empty).
process.loadEnvFile()

const SEED_STATE_PATH = path.resolve(process.cwd(), '../contracts/scripts/.seed-state.json')

interface LiveLeaf extends BackerLeaf {
  backer: string
}

function knownSessions(): Map<string, WalletSession> {
  const sessions = new Map<string, WalletSession>()
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.endsWith('_MNEMONIC') || value === undefined || value === '') continue
    const { addr, sk } = algosdk.mnemonicToSecretKey(value)
    const address = addr.toString()
    const signer: TransactionSigner = algosdk.makeBasicAccountTransactionSigner({ addr, sk })
    sessions.set(address, { address, signer })
  }
  return sessions
}

function targetAppIds(): bigint[] {
  const fromArgs = process.argv.slice(2).map((arg) => BigInt(arg))
  if (fromArgs.length > 0) return fromArgs
  if (!fs.existsSync(SEED_STATE_PATH)) {
    throw new Error('Pass app ids or seed first (no .seed-state.json found).')
  }
  const state = JSON.parse(fs.readFileSync(SEED_STATE_PATH, 'utf8')) as { campaigns: { appId: string }[] }
  return state.campaigns.map((entry) => BigInt(entry.appId))
}

void (async () => {
  const sessions = knownSessions()
  if (sessions.size === 0) {
    throw new Error('No *_MNEMONIC env vars found (source ../contracts/.env.testnet first).')
  }
  const vaultId = vaultAppId()
  const vaultAddress = getApplicationAddress(vaultId).toString()
  const now = await fetchChainTimestamp()
  let leftovers = 0

  const report = (message: string): void => {
    console.log(message)
  }
  const leftover = (message: string): void => {
    leftovers += 1
    console.log(`LEFTOVER: ${message}`)
  }

  for (const appId of targetAppIds()) {
    const id = appId.toString()
    const campaign = await getCampaign(appId, now)
    if (campaign === undefined) {
      leftover(`#${id}: not found or not a campaign app`)
      continue
    }
    if (campaign.deleted === true) {
      leftover(`#${id}: already deleted on-chain (unregister manually if still listed)`)
      continue
    }

    const pledges = await fetchPledges(appId, vaultAddress)
    const spent = new Set((await fetchSpends(appId, vaultId)).map((spend) => spend.position))
    const leaves: LiveLeaf[] = pledges
      .map((pledge, index) => ({ ...pledge, position: index }))
      .filter((pledge) => !spent.has(pledge.position))
    const known = leaves.filter((leaf) => sessions.has(leaf.backer))
    const unknown = leaves.filter((leaf) => !sessions.has(leaf.backer))
    for (const leaf of unknown) {
      leftover(`#${id}: live pledge ${formatAlgo(leaf.amount)} ALGO by ${leaf.backer} (no keys — refund via UI)`)
    }

    const creatorSession = sessions.get(campaign.creator)
    const run = async (label: string, action: () => Promise<void>): Promise<boolean> => {
      try {
        await action()
        report(`#${id}: ${label}`)
        return true
      } catch (error) {
        leftover(`#${id}: ${label} failed (${(error as Error).message})`)
        return false
      }
    }

    if (campaign.status === 'open' && now < campaign.deadlineSeconds) {
      for (const leaf of known) {
        const session = sessions.get(leaf.backer)
        if (session !== undefined) {
          await run(`cancelled ${formatAlgo(leaf.amount)} ALGO pledge`, () => cancelPledge(appId, session, leaf))
        }
      }
    } else if (campaign.status === 'funded' || (campaign.status === 'open' && campaign.raisedMicroAlgos >= campaign.goalMicroAlgos)) {
      if (creatorSession !== undefined) {
        await run('claimed to creator', () => claim(appId, creatorSession))
      } else {
        leftover(`#${id}: funded but creator ${campaign.creator} has no keys`)
      }
    } else {
      for (const leaf of known) {
        const session = sessions.get(leaf.backer)
        if (session !== undefined) {
          await run(`refunded ${formatAlgo(leaf.amount)} ALGO pledge`, () => refund(appId, session, leaf))
        }
      }
    }

    if (creatorSession !== undefined) {
      await run('deleted and unregistered', () => deleteCampaign(appId, creatorSession))
    } else {
      leftover(`#${id}: creator ${campaign.creator} has no keys (cannot delete/unregister)`)
    }
  }

  if (leftovers > 0) {
    console.log(`${leftovers.toString()} leftover item(s) need manual action (see above).`)
    process.exit(1)
  }
  console.log('reclaimed: nothing left')
})()
