import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { ABIMethod, OnApplicationComplete } from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Remove campaigns created by `seed-demo.ts`: creator-signed `delete()` (skipped when live pledges forbid it) followed
 * by `unregister()`, which drops the campaign from the browse list either way. Reads `.seed-state.json` and clears
 * entries that fully unregister; anything left is reported for a later retry (e.g. after its deadline passes).
 *
 * Same environment rules as the seed script: LocalNet by default, `DOTENV_CONFIG_PATH=.env.testnet` elsewhere.
 *
 * Usage: `FACTORY_APP_ID=<id> VAULT_APP_ID=<id> npm run unseed`
 */

const STATE_PATH = path.resolve(__dirname, '.seed-state.json')

interface SeedEntry {
  appId: string
  creator: string
}

interface SeedState {
  factoryId: string
  vaultId: string
  campaigns: SeedEntry[]
}

function vaultBoxName(appId: bigint): Uint8Array {
  let remaining = appId
  const idBytes = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    idBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return new Uint8Array([0x63, ...idBytes])
}

void (async () => {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error('No .seed-state.json found (run the seed script first).')
  }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as SeedState
  const isLocalNet = process.env.ALGOD_SERVER === undefined || process.env.ALGOD_SERVER.includes('localhost')
  const algorand = isLocalNet ? AlgorandClient.defaultLocalNet() : AlgorandClient.fromEnvironment()

  const factoryId = BigInt(state.factoryId)
  const vaultId = BigInt(state.vaultId)
  const remaining: SeedEntry[] = []
  for (const entry of state.campaigns) {
    const appId = BigInt(entry.appId)
    const creator = await algorand.account.fromEnvironment(entry.creator)
    try {
      const composer = algorand.send.newGroup()
      composer.addAppCallMethodCall({
        appId,
        method: ABIMethod.fromSignature('delete()void'),
        args: [],
        sender: creator.addr,
        onComplete: OnApplicationComplete.DeleteApplicationOC,
        appReferences: [vaultId],
        boxReferences: [{ appId: vaultId, name: vaultBoxName(appId) }],
        extraFee: microAlgos(2_000n),
      })
      await composer.send()
      console.log(`deleted campaign ${entry.appId}`)
    } catch (error) {
      console.log(`delete skipped for ${entry.appId} (live pledges?): ${(error as Error).message}`)
    }

    try {
      const composer = algorand.send.newGroup()
      composer.addAppCallMethodCall({
        appId: factoryId,
        method: ABIMethod.fromSignature('unregister(uint64)void'),
        args: [appId],
        sender: creator.addr,
        appReferences: [appId],
        extraFee: microAlgos(1_000n),
      })
      await composer.send()
      console.log(`unregistered campaign ${entry.appId}`)
    } catch (error) {
      console.log(`unregister failed for ${entry.appId}: ${(error as Error).message}`)
      remaining.push(entry)
    }
  }

  if (remaining.length === 0) {
    fs.rmSync(STATE_PATH)
    console.log('unseeded: state cleared')
  } else {
    // Pretty-printed: `prettier --check .` also covers this gitignored file.
    fs.writeFileSync(STATE_PATH, `${JSON.stringify({ ...state, campaigns: remaining }, null, 2)}\n`)
  }
})()
