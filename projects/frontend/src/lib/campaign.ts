import algosdk, { decodeAddress, encodeAddress } from 'algosdk'
import { indexer } from './algorand'

/**
 * Read model: maps indexer responses into a `CampaignViewModel` the UI can
 * render. The contract is the source of truth — everything here is derived
 * from the same public state the contract reads and writes.
 *
 * See docs/frontend.md and docs/contracts/campaign.md for the on-chain model:
 *   - global state: `creator` (bytes), `goal`/`deadline`/`raised`/`status` (uint)
 *   - backer pledges: boxes named by `p` prefix + address bytes
 */

export type CampaignStatus = 'open' | 'funded' | 'failed' | 'claimed'

export interface CampaignViewModel {
  /** Application id — the campaign's unique identifier. */
  id: bigint
  /** Campaign creator address. */
  creator: string
  /** Funding target, in microAlgos. */
  goalMicroAlgos: bigint
  /** Total pledged so far, in microAlgos. */
  raisedMicroAlgos: bigint
  /** Deadline as a UNIX timestamp (seconds). */
  deadlineSeconds: bigint
  /** Derived display status. `funded` is computed, never stored on-chain. */
  status: CampaignStatus
  /** The connected wallet's pledge (microAlgos), or undefined if it hasn't pledged. */
  myPledgeMicroAlgos?: bigint
}

const STATUS_UINT_TO_LABEL: Record<number, CampaignStatus> = {
  0: 'open',
  1: 'failed',
  2: 'claimed',
}

/**
 * Derive the display status. `funded` and `failed` are recomputed from
 * deadline/raised/goal — exactly the rule the contract evaluates — because
 * neither is materialised into global state until someone acts. The stored
 * `status` uint only ever holds `0` (Open), `1` (Failed, after a refund) or
 * `2` (Claimed), and is authoritative for `failed`/`claimed` once set.
 */
export function deriveStatus(
  goal: bigint,
  raised: bigint,
  deadlineSeconds: bigint,
  statusUint: bigint,
  nowSeconds: bigint,
): CampaignStatus {
  if (statusUint === 1n) return STATUS_UINT_TO_LABEL[1]
  if (statusUint === 2n) return STATUS_UINT_TO_LABEL[2]
  if (deadlineSeconds <= nowSeconds) {
    return raised >= goal ? 'funded' : 'failed'
  }
  return STATUS_UINT_TO_LABEL[0]
}

/** The global-state key names this contract materialises. */
const KNOWN_KEYS = ['creator', 'goal', 'deadline', 'raised', 'status'] as const

function decodeKey(keyBytes: Uint8Array): string {
  return Buffer.from(keyBytes).toString('utf8')
}

/**
 * Extract the contract's global state from an indexer `Application` into a
 * plain object. Unknown keys are ignored so other apps are safely filtered out.
 */
export function decodeGlobalState(app: algosdk.indexerModels.Application): {
  creator?: string
  goal?: bigint
  deadline?: bigint
  raised?: bigint
  status?: bigint
} {
  const result: {
    creator?: string
    goal?: bigint
    deadline?: bigint
    raised?: bigint
    status?: bigint
  } = {}

  for (const kv of app.params.globalState ?? []) {
    const key = decodeKey(kv.key)
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) continue

    if (key === 'creator') {
      result.creator = encodeAddress(kv.value.bytes)
    } else if (key === 'goal') {
      result.goal = kv.value.uint
    } else if (key === 'deadline') {
      result.deadline = kv.value.uint
    } else if (key === 'raised') {
      result.raised = kv.value.uint
    } else if (key === 'status') {
      result.status = kv.value.uint
    }
  }

  return result
}

/** True when an indexer `Application` looks like a `Campaign` (has our global-state keys). */
export function isCampaignApp(app: algosdk.indexerModels.Application): boolean {
  const keys = new Set((app.params.globalState ?? []).map((kv) => decodeKey(kv.key)))
  return (KNOWN_KEYS as readonly string[]).every((key) => keys.has(key))
}

/** Map an indexer `Application` to a `CampaignViewModel`. */
export function toCampaignViewModel(
  app: algosdk.indexerModels.Application,
  nowSeconds: bigint,
  myPledgeMicroAlgos?: bigint,
): CampaignViewModel {
  const state = decodeGlobalState(app)
  const goal = state.goal ?? 0n
  const raised = state.raised ?? 0n
  const deadline = state.deadline ?? 0n

  return {
    id: app.id,
    creator: state.creator ?? '',
    goalMicroAlgos: goal,
    raisedMicroAlgos: raised,
    deadlineSeconds: deadline,
    status: deriveStatus(goal, raised, deadline, state.status ?? 0n, nowSeconds),
    myPledgeMicroAlgos,
  }
}

/** Build the box name for a backer's pledge: `p` prefix + address bytes. */
export function pledgeBoxName(address: string): Uint8Array {
  const prefix = new TextEncoder().encode('p')
  const addressBytes = decodeAddress(address).publicKey
  const name = new Uint8Array(prefix.length + addressBytes.length)
  name.set(prefix, 0)
  name.set(addressBytes, prefix.length)
  return name
}

/** Decode a pledge box value (8-byte big-endian uint64) into microAlgos. */
export function decodePledgeBoxValue(value: Uint8Array): bigint {
  return algosdk.bytesToBigInt(value)
}

/**
 * Fetch the connected wallet's pledge for a campaign, or `undefined` if the
 * box is absent (never pledged, or already refunded).
 */
export async function fetchMyPledge(appId: bigint, address: string): Promise<bigint | undefined> {
  try {
    const box = await indexer.lookupApplicationBoxByIDandName(appId, pledgeBoxName(address)).do()
    return decodePledgeBoxValue(box.value)
  } catch {
    return undefined
  }
}

/**
 * List all campaigns by scanning indexed applications for our global-state keys.
 * There is no app-name filter on the indexer, so presence of the known keys is
 * the discriminator (docs/frontend.md).
 */
export async function listCampaigns(nowSeconds: bigint, viewerAddress?: string): Promise<CampaignViewModel[]> {
  const response = await indexer.searchForApplications().limit(100).do()

  const campaigns: CampaignViewModel[] = []
  for (const app of response.applications) {
    if (!isCampaignApp(app)) continue
    let myPledge: bigint | undefined
    if (viewerAddress) {
      myPledge = await fetchMyPledge(app.id, viewerAddress)
    }
    campaigns.push(toCampaignViewModel(app, nowSeconds, myPledge))
  }
  return campaigns
}

/** Fetch a single campaign by app id. */
export async function getCampaign(appId: bigint, nowSeconds: bigint, viewerAddress?: string): Promise<CampaignViewModel | undefined> {
  const response = await indexer.lookupApplications(appId).do()
  const app = response.application
  if (!app || !isCampaignApp(app)) return undefined

  let myPledge: bigint | undefined
  if (viewerAddress) {
    myPledge = await fetchMyPledge(app.id, viewerAddress)
  }
  return toCampaignViewModel(app, nowSeconds, myPledge)
}
