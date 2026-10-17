import type algosdk from 'algosdk'
import { encodeAddress } from 'algosdk'
import { fetchChainTimestamp, getSdkConfig } from './chain.js'
import { fetchMyLeaves } from './claim-tree.js'

/**
 * Campaign read model: maps indexer responses into a `CampaignViewModel` a UI can render. The contract is the source
 * of truth - everything here is derived from the same public state the contract reads and writes.
 *
 * A backer's pledge is reconstructed from history, not read as a balance: their live leaves in the campaign's
 * frontier-Merkle tree (see `claim-tree.ts`), summed. Which campaigns are official is decided by the Factory
 * registry - the list view only shows campaigns registered with the configured Factory app (see `chain.ts`).
 *
 * See docs/campaign.md and docs/frontend.md for the on-chain model:
 *
 * - Global state: `creator` (bytes), `title` (bytes), `metadataUri` (bytes), `goal`/`deadline`/`raised`/`status` (uint),
 *   plus the tree state `root` (bytes) and `n` (uint, positions ever appended).
 * - Backer pledges: live leaves in the tree (no boxes, no assets, no per-backer storage).
 */

export type CampaignStatus = 'open' | 'funded' | 'failed' | 'claimed'

export interface CampaignViewModel {
  /** Application id - the campaign's unique identifier. */
  id: bigint
  /** Campaign creator address. */
  creator: string
  /** Short campaign title, stored on-chain. */
  title: string
  /** URI pointing to the off-chain campaign metadata (description, image, category). */
  metadataUri: string
  /** Funding target, in microAlgos. */
  goalMicroAlgos: bigint
  /** Total live pledge amount, in microAlgos. */
  raisedMicroAlgos: bigint
  /** Deadline as a UNIX timestamp (seconds). */
  deadlineSeconds: bigint
  /** Derived display status. `funded` is computed, never stored on-chain. */
  status: CampaignStatus
  /** The connected wallet's live pledge total (microAlgos), or undefined if it has no live leaves. */
  myPledgeMicroAlgos?: bigint | undefined
  /** True when the application was deleted on-chain (global state is gone; only history remains). */
  deleted?: boolean
}

const STATUS_UINT_TO_LABEL = {
  0: 'open',
  1: 'failed',
  2: 'claimed',
} as const

/**
 * Derive the display status. `funded` and `failed` are recomputed from deadline/raised/goal - exactly the rule the contract evaluates -
 * because neither is materialised into global state until someone acts. The stored `status` uint only ever holds `0` (Open), `1` (Failed,
 * after a refund) or `2` (Claimed), and is authoritative for `failed`/`claimed` once set.
 *
 * @param goal Funding target in microAlgos.
 * @param raised Total pledged so far in microAlgos.
 * @param deadlineSeconds Deadline as a UNIX timestamp (seconds).
 * @param statusUint Stored status uint (0 open, 1 failed, 2 claimed).
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @returns The derived display status.
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
const KNOWN_KEYS = ['creator', 'title', 'metadataUri', 'goal', 'deadline', 'raised', 'status', 'root', 'n'] as const

const utf8 = new TextDecoder()

function decodeKey(keyBytes: Uint8Array): string {
  return utf8.decode(keyBytes)
}

/**
 * Extract the contract's global state from an indexer `Application` into a plain object. Unknown keys are ignored so other apps are safely
 * filtered out.
 *
 * @param app Indexer application with the campaign's global state.
 * @returns Decoded global-state values.
 */
export function decodeGlobalState(app: algosdk.indexerModels.Application): {
  creator?: string
  title?: string
  metadataUri?: string
  goal?: bigint
  deadline?: bigint
  raised?: bigint
  status?: bigint
} {
  const result: {
    creator?: string
    title?: string
    metadataUri?: string
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
    } else if (key === 'title') {
      result.title = utf8.decode(kv.value.bytes)
    } else if (key === 'metadataUri') {
      result.metadataUri = utf8.decode(kv.value.bytes)
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

/**
 * True when an indexer `Application` looks like a `Campaign` (has our global-state keys).
 *
 * @param app Indexer application to check.
 * @returns True when the app exposes all known campaign global-state keys.
 */
export function isCampaignApp(app: algosdk.indexerModels.Application): boolean {
  const keys = new Set((app.params.globalState ?? []).map((kv) => decodeKey(kv.key)))
  return (KNOWN_KEYS as readonly string[]).every((key) => keys.has(key))
}

/**
 * Map an indexer `Application` to a `CampaignViewModel`.
 *
 * @param app Indexer application to map.
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @param myPledgeMicroAlgos Viewer's pledge, if already fetched.
 * @returns The campaign view model.
 */
export function toCampaignViewModel(
  app: algosdk.indexerModels.Application,
  nowSeconds: bigint,
  myPledgeMicroAlgos?: bigint,
): CampaignViewModel {
  const state = decodeGlobalState(app)
  const goal = state.goal ?? 0n
  const raised = state.raised ?? 0n
  const deadline = state.deadline ?? 0n

  const viewModel: CampaignViewModel = {
    id: app.id,
    creator: state.creator ?? '',
    title: state.title ?? '',
    metadataUri: state.metadataUri ?? '',
    goalMicroAlgos: goal,
    raisedMicroAlgos: raised,
    deadlineSeconds: deadline,
    status: deriveStatus(goal, raised, deadline, state.status ?? 0n, nowSeconds),
  }
  if (myPledgeMicroAlgos !== undefined) {
    viewModel.myPledgeMicroAlgos = myPledgeMicroAlgos
  }
  return viewModel
}

/**
 * Fetch the connected wallet's live pledge total for a campaign: the sum of their unspent leaves. Rebuilt from
 * history (see `claim-tree.ts`) - there is no balance to read.
 *
 * @param appId Campaign application id.
 * @param address Viewer's Algorand address.
 * @returns Pledge in microAlgos, or undefined if the backer has no live leaves.
 */
export async function fetchMyPledge(appId: bigint, address: string): Promise<bigint | undefined> {
  const leaves = await fetchMyLeaves(appId, address)
  if (leaves.length === 0) return undefined
  return leaves.reduce((sum, leaf) => sum + leaf.amount, 0n)
}

/**
 * Fetch every app id registered with the Factory (paginated box search), decoded from the registration box names.
 *
 * @param factoryId The Factory application id.
 * @returns The set of registered campaign app ids.
 */
export async function fetchRegisteredCampaignIds(factoryId: bigint): Promise<Set<bigint>> {
  const indexer = getSdkConfig().algorand.client.indexer
  const registered = new Set<bigint>()
  let nextToken: string | undefined
  do {
    let query = indexer.searchForApplicationBoxes(factoryId).limit(1000)
    if (nextToken !== undefined) query = query.nextToken(nextToken)
    const response = await query.do()
    for (const box of response.boxes) {
      // Box name: 'r' (1 byte) + the campaign app id (8 bytes, big-endian).
      const name = box.name
      if (name.length !== 9 || name[0] !== 0x72) continue
      let id = 0n
      for (let i = 1; i <= 8; i++) {
        // The length check above guarantees all eight bytes exist; the fallback satisfies noUncheckedIndexedAccess.
        /* v8 ignore next */
        id = (id << 8n) | BigInt(name[i] ?? 0)
      }
      registered.add(id)
    }
    nextToken = response.nextToken
  } while (nextToken !== undefined)
  return registered
}

/** Last good base list (pledge-free view models), for instant paint across navigations. */
let cachedList: { campaigns: CampaignViewModel[]; nowSeconds: bigint } | undefined

/**
 * Read the cached base list, if a previous load stored one.
 *
 * @returns Cached campaigns and timestamp, or undefined on first load.
 */
export function getCachedCampaigns(): { campaigns: CampaignViewModel[]; nowSeconds: bigint } | undefined {
  return cachedList
}

/**
 * Store a fresh base list for instant paint on later mounts.
 *
 * @param result Fresh campaigns and timestamp.
 * @param result.campaigns Campaign view models.
 * @param result.nowSeconds Chain timestamp.
 */
export function setCachedCampaigns(result: { campaigns: CampaignViewModel[]; nowSeconds: bigint }): void {
  cachedList = result
}

/**
 * Drop the cached base list (tests and explicit refreshes).
 */
export function clearCachedCampaigns(): void {
  cachedList = undefined
}

/**
 * List all campaigns. With a Factory configured, look each registered id up directly - the unfiltered application
 * scan below works on sandbox-sized chains but never finishes on TestNet-scale chains (tens of thousands of apps,
 * each response carrying full approval programs).
 *
 * @param viewerAddress Connected wallet address, if any.
 * @returns The campaigns with the chain timestamp used to derive them.
 */
export async function listCampaigns(viewerAddress?: string): Promise<{ campaigns: CampaignViewModel[]; nowSeconds: bigint }> {
  const factoryId = getSdkConfig().factoryAppId
  if (factoryId <= 0n) {
    // No factory: fall back to scanning indexed applications for our global-state keys. There is no app-name filter
    // on the indexer, so presence of the known keys is the discriminator (docs/frontend.md). Only viable on small
    // chains.
    const indexer = getSdkConfig().algorand.client.indexer
    const now = await fetchChainTimestamp()
    const applications: algosdk.indexerModels.Application[] = []
    let nextToken: string | undefined
    do {
      let query = indexer.searchForApplications().limit(100)
      if (nextToken !== undefined) query = query.nextToken(nextToken)
      const response = await query.do()
      applications.push(...response.applications)
      nextToken = response.nextToken
    } while (nextToken !== undefined)

    const campaigns: CampaignViewModel[] = []
    for (const app of applications) {
      if (!isCampaignApp(app)) continue
      let myPledge: bigint | undefined
      if (viewerAddress) {
        myPledge = await fetchMyPledge(app.id, viewerAddress)
      }
      campaigns.push(toCampaignViewModel(app, now, myPledge))
    }
    const result = { campaigns, nowSeconds: now }
    setCachedCampaigns(result)
    return result
  }

  // Timestamp and registry are independent: fetch together so first paint waits on one round-trip, not two.
  const [now, registered] = await Promise.all([fetchChainTimestamp(), fetchRegisteredCampaignIds(factoryId)])
  const settled = await Promise.all([...registered].map((id) => getCampaign(id, now, viewerAddress)))
  const campaigns = settled.filter((campaign): campaign is CampaignViewModel => campaign !== undefined && campaign.deleted !== true)
  const result = { campaigns, nowSeconds: now }
  setCachedCampaigns(result)
  return result
}

/**
 * Fetch a single campaign by app id.
 *
 * @param appId Campaign application id.
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @param viewerAddress Connected wallet address, if any.
 * @returns The campaign, or undefined if not found or not a campaign app.
 */
export async function getCampaign(appId: bigint, nowSeconds: bigint, viewerAddress?: string): Promise<CampaignViewModel | undefined> {
  // Deleted apps are excluded by default - include them so the detail page can render the deleted state
  // (backers refund from the vault after deletion).
  const response = await getSdkConfig().algorand.client.indexer.lookupApplications(appId).includeAll(true).do()
  const app = response.application
  if (!app) return undefined
  if (app.deleted === true) {
    return {
      id: app.id,
      creator: '',
      title: '',
      metadataUri: '',
      goalMicroAlgos: 0n,
      raisedMicroAlgos: 0n,
      deadlineSeconds: 0n,
      status: 'failed',
      deleted: true,
    }
  }
  if (!isCampaignApp(app)) return undefined

  let myPledge: bigint | undefined
  if (viewerAddress) {
    myPledge = await fetchMyPledge(app.id, viewerAddress)
  }
  return toCampaignViewModel(app, nowSeconds, myPledge)
}
