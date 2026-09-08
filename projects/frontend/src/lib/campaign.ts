import algosdk, { encodeAddress } from 'algosdk'
import { indexer } from './algorand'
import { bigEndian64 } from './merkle'

/**
 * Read model: maps indexer responses into a `CampaignViewModel` the UI can render. The contract is the source of truth — everything here is
 * derived from the same public state the contract reads and writes.
 *
 * See docs/frontend.md and docs/contracts/campaign.md for the on-chain model:
 *
 * - Global state: `creator` (bytes), `title` (bytes), `metadataUri` (bytes), `goal`/`deadline`/`raised`/`status`/`leafCount` (uint)
 * - Backer pledges: leaves of the on-chain Merkle tree, reconstructed from the pledge transactions in the indexer
 */

export type CampaignStatus = 'open' | 'funded' | 'failed' | 'claimed'

export interface CampaignViewModel {
  /** Application id — the campaign's unique identifier. */
  id: bigint
  /** Campaign creator address. */
  creator: string
  /** Short campaign title, stored on-chain. */
  title: string
  /** URI pointing to the off-chain campaign metadata (description, image, category). */
  metadataUri: string
  /** Funding target, in microAlgos. */
  goalMicroAlgos: bigint
  /** Total pledged so far, in microAlgos. */
  raisedMicroAlgos: bigint
  /** Deadline as a UNIX timestamp (seconds). */
  deadlineSeconds: bigint
  /** Derived display status. `funded` is computed, never stored on-chain. */
  status: CampaignStatus
  /** The connected wallet's live pledge (microAlgos), or undefined if it hasn't pledged. */
  myPledgeMicroAlgos?: bigint | undefined
}

/** One pledge leaf in slot order: the backer's address and the pledged amount. */
export interface PledgeLeaf {
  address: string
  amount: bigint
}

/** A live (not-yet-spent) leaf belonging to the connected backer. */
export interface LiveLeaf {
  /** The leaf's slot index in the tree. */
  index: number
  amount: bigint
}

/** The full ordered leaf list plus the backer's live leaves, reconstructed from the indexer. */
export interface PledgeReconstruction {
  leaves: PledgeLeaf[]
  live: LiveLeaf[]
}

// The spent bitmap is sharded into 1024-byte boxes (8192 leaves per shard), one bit per leaf.
const BITMAP_SHARD_BITS = 13
const BITMAP_SHARD_BYTES = 1024

const STATUS_UINT_TO_LABEL = {
  0: 'open',
  1: 'failed',
  2: 'claimed',
} as const

/**
 * Derive the display status. `funded` and `failed` are recomputed from deadline/raised/goal — exactly the rule the contract evaluates —
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
const KNOWN_KEYS = ['creator', 'title', 'metadataUri', 'goal', 'deadline', 'raised', 'status', 'leafCount'] as const

function decodeKey(keyBytes: Uint8Array): string {
  return Buffer.from(keyBytes).toString('utf8')
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
  leafCount?: bigint
} {
  const result: {
    creator?: string
    title?: string
    metadataUri?: string
    goal?: bigint
    deadline?: bigint
    raised?: bigint
    status?: bigint
    leafCount?: bigint
  } = {}

  for (const kv of app.params.globalState ?? []) {
    const key = decodeKey(kv.key)
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) continue

    if (key === 'creator') {
      result.creator = encodeAddress(kv.value.bytes)
    } else if (key === 'title') {
      result.title = Buffer.from(kv.value.bytes).toString('utf8')
    } else if (key === 'metadataUri') {
      result.metadataUri = Buffer.from(kv.value.bytes).toString('utf8')
    } else if (key === 'goal') {
      result.goal = kv.value.uint
    } else if (key === 'deadline') {
      result.deadline = kv.value.uint
    } else if (key === 'raised') {
      result.raised = kv.value.uint
    } else if (key === 'status') {
      result.status = kv.value.uint
    } else if (key === 'leafCount') {
      result.leafCount = kv.value.uint
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

  return {
    id: app.id,
    creator: state.creator ?? '',
    title: state.title ?? '',
    metadataUri: state.metadataUri ?? '',
    goalMicroAlgos: goal,
    raisedMicroAlgos: raised,
    deadlineSeconds: deadline,
    status: deriveStatus(goal, raised, deadline, state.status ?? 0n, nowSeconds),
    myPledgeMicroAlgos,
  }
}

function groupKey(group: Uint8Array): string {
  return Buffer.from(group).toString('base64')
}

/**
 * Fetch every app call to the campaign (paginated), in ascending round order.
 *
 * @param appId Campaign application id.
 */
async function fetchAppCalls(appId: bigint): Promise<algosdk.indexerModels.Transaction[]> {
  const out: algosdk.indexerModels.Transaction[] = []
  let nextToken: string | undefined
  do {
    let query = indexer.searchForTransactions().applicationID(appId).txType('appl').limit(1000)
    if (nextToken !== undefined) query = query.nextToken(nextToken)
    const response = await query.do()
    out.push(...response.transactions)
    nextToken = response.nextToken
  } while (nextToken !== undefined)
  return out
}

/**
 * Fetch every payment into the escrow (paginated), keyed by group id.
 *
 * @param escrow The escrow address.
 */
async function fetchEscrowPaymentsByGroup(escrow: string): Promise<Map<string, { sender: string; amount: bigint }>> {
  const map = new Map<string, { sender: string; amount: bigint }>()
  let nextToken: string | undefined
  do {
    let query = indexer.searchForTransactions().address(escrow).addressRole('receiver').txType('pay').limit(1000)
    if (nextToken !== undefined) query = query.nextToken(nextToken)
    const response = await query.do()
    for (const tx of response.transactions) {
      const group = tx.group
      const payment = tx.paymentTransaction
      if (group === undefined || payment === undefined) continue
      map.set(groupKey(group), { sender: tx.sender, amount: payment.amount })
    }
    nextToken = response.nextToken
  } while (nextToken !== undefined)
  return map
}

/**
 * Reconstruct the campaign's pledge leaves in slot order from the indexer.
 *
 * Each `pledge` app call is grouped with a payment from the backer to the escrow; the `fund` deposit is the only other grouped payment and
 * is filtered out by its sender (the creator). A stray payment to the escrow never matches an app call, so it is ignored.
 *
 * @param appId Campaign application id.
 * @param creator The campaign creator's address (filters out the `fund` deposit).
 * @returns The pledge leaves in slot order.
 */
export async function fetchPledgeLeaves(appId: bigint, creator: string): Promise<PledgeLeaf[]> {
  const escrow = algosdk.getApplicationAddress(appId).toString()
  const [appCalls, paymentsByGroup] = await Promise.all([fetchAppCalls(appId), fetchEscrowPaymentsByGroup(escrow)])

  const leaves: PledgeLeaf[] = []
  for (const call of appCalls) {
    const group = call.group
    if (group === undefined) continue
    const payment = paymentsByGroup.get(groupKey(group))
    if (payment === undefined) continue
    if (call.sender === creator) continue
    if (payment.sender !== call.sender) continue
    leaves.push({ address: call.sender, amount: payment.amount })
  }
  return leaves
}

/**
 * The box name of the spent-bitmap shard at `shardIndex`: `'s'` + the 8-byte big-endian index.
 *
 * @param shardIndex The shard index (leaf index >> 13).
 * @returns The box name bytes.
 */
function spentShardName(shardIndex: number): Uint8Array {
  const prefix = new TextEncoder().encode('s')
  const key = bigEndian64(BigInt(shardIndex))
  const name = new Uint8Array(prefix.length + key.length)
  name.set(prefix, 0)
  name.set(key, prefix.length)
  return name
}

/**
 * Read the campaign's spent-bitmap shards (one 1024-byte box per 8192 leaves). A missing shard means no leaf in it is spent.
 *
 * @param appId Campaign application id.
 * @param leafCount Number of leaves appended so far.
 * @returns The shard bytes, indexed by shard index.
 */
export async function fetchSpentShards(appId: bigint, leafCount: bigint): Promise<Uint8Array[]> {
  const shardCount = Number((leafCount + BigInt(BITMAP_SHARD_BYTES * 8 - 1)) >> BigInt(BITMAP_SHARD_BITS))
  const shards: Uint8Array[] = []
  for (let i = 0; i < shardCount; i++) {
    try {
      const box = await indexer.lookupApplicationBoxByIDandName(appId, spentShardName(i)).do()
      shards.push(box.value)
    } catch {
      shards.push(new Uint8Array(BITMAP_SHARD_BYTES))
    }
  }
  return shards
}

/**
 * True when the leaf at `index` is marked spent. AVM bits are numbered from the most significant bit of the first byte.
 *
 * @param shards The spent-bitmap shards, indexed by shard index.
 * @param index The leaf slot index.
 * @returns Whether the leaf is spent.
 */
export function isLeafSpent(shards: Uint8Array[], index: number): boolean {
  const bitIndex = index & (BITMAP_SHARD_BYTES * 8 - 1)
  const shard = shards[index >> BITMAP_SHARD_BITS]
  if (shard === undefined) return false
  const byte = shard[bitIndex >> 3]
  if (byte === undefined) return false
  return (byte & (1 << (7 - (bitIndex & 7)))) !== 0
}

/**
 * Reconstruct a campaign's full leaf list plus the connected backer's live leaves, from the indexer.
 *
 * @param appId Campaign application id.
 * @param address The connected backer's address.
 * @returns The full leaves and the backer's live leaves.
 */
export async function fetchPledgesForBacker(appId: bigint, address: string): Promise<PledgeReconstruction> {
  const app = (await indexer.lookupApplications(appId).do()).application
  const state = app ? decodeGlobalState(app) : {}
  const creator = state.creator ?? ''
  const leafCount = state.leafCount ?? 0n

  const leaves = await fetchPledgeLeaves(appId, creator)
  const shards = await fetchSpentShards(appId, leafCount)
  const live: LiveLeaf[] = []
  leaves.forEach((leaf, index) => {
    if (leaf.address === address && !isLeafSpent(shards, index)) {
      live.push({ index, amount: leaf.amount })
    }
  })
  return { leaves, live }
}

/**
 * Fetch the connected wallet's live leaves for a campaign.
 *
 * @param appId Campaign application id.
 * @param address Viewer's Algorand address.
 * @returns The backer's live leaves.
 */
export async function fetchBackerLiveLeaves(appId: bigint, address: string): Promise<LiveLeaf[]> {
  return (await fetchPledgesForBacker(appId, address)).live
}

/**
 * Fetch the connected wallet's live pledge total for a campaign, or `undefined` if it has no live leaves.
 *
 * @param appId Campaign application id.
 * @param address Viewer's Algorand address.
 * @returns Pledge in microAlgos, or undefined if the backer has no live pledge.
 */
export async function fetchMyPledge(appId: bigint, address: string): Promise<bigint | undefined> {
  const leaves = await fetchBackerLiveLeaves(appId, address)
  const total = leaves.reduce((sum, leaf) => sum + leaf.amount, 0n)
  return total > 0n ? total : undefined
}

/**
 * List all campaigns by scanning indexed applications for our global-state keys. There is no app-name filter on the indexer, so presence of
 * the known keys is the discriminator (docs/frontend.md).
 *
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @param viewerAddress Connected wallet address, if any.
 * @returns All campaigns found in the indexer.
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

/**
 * Fetch a single campaign by app id.
 *
 * @param appId Campaign application id.
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @param viewerAddress Connected wallet address, if any.
 * @returns The campaign, or undefined if not found or not a campaign app.
 */
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
