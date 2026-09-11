import type algosdk from 'algosdk'
import { encodeAddress } from 'algosdk'
import { indexer } from './algorand'

/**
 * Read model: maps indexer responses into a `CampaignViewModel` the UI can render. The contract is the source of truth — everything here is
 * derived from the same public state the contract reads and writes.
 *
 * A backer's pledge is not reconstructed from history anymore: it is the backer's **Claim ASA balance**, read directly from the indexer
 * (1 claim unit = 1 microAlgo). Which campaigns are official is decided by the Factory registry — the list view only shows campaigns
 * registered with the configured Factory app.
 *
 * See docs/campaign.md and docs/frontend.md for the on-chain model:
 *
 * - Global state: `creator` (bytes), `title` (bytes), `metadataUri` (bytes), `goal`/`deadline`/`raised`/`status`/`claimAsa`/`deposit` (uint)
 * - Backer pledges: the backer's balance of the campaign's Claim ASA
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
  /** Total live pledge amount, in microAlgos. */
  raisedMicroAlgos: bigint
  /** Deadline as a UNIX timestamp (seconds). */
  deadlineSeconds: bigint
  /** Derived display status. `funded` is computed, never stored on-chain. */
  status: CampaignStatus
  /** The campaign's Claim ASA id, once `fund()` has issued it. */
  claimAsaId?: bigint
  /** The connected wallet's live claim balance (microAlgos), or undefined if it hasn't pledged. */
  myPledgeMicroAlgos?: bigint | undefined
}

/** The connected wallet's Claim ASA holding for a campaign. */
export interface ClaimHolding {
  /** Whether the wallet has opted in to the Claim ASA. */
  optedIn: boolean
  /** The wallet's claim-unit balance (1 unit = 1 microAlgo). */
  balance: bigint
}

/**
 * The Factory app id the frontend treats as canonical, from the environment.
 *
 * @returns The Factory app id, or 0 when not configured (registration filter disabled).
 */
export function factoryAppId(): bigint {
  return envAppId('VITE_FACTORY_APP_ID')
}

/**
 * The ClaimsVault app id the frontend pays pledges into and refunds from, from the environment.
 *
 * @returns The vault app id, or 0 when not configured.
 */
export function vaultAppId(): bigint {
  return envAppId('VITE_VAULT_APP_ID')
}

function envAppId(key: string): bigint {
  const raw = import.meta.env[key] as string | undefined
  if (raw === undefined || raw === '') return 0n
  const id = BigInt(raw)
  return id > 0n ? id : 0n
}

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
const KNOWN_KEYS = ['creator', 'title', 'metadataUri', 'goal', 'deadline', 'raised', 'status', 'claimAsa'] as const

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
  claimAsa?: bigint
} {
  const result: {
    creator?: string
    title?: string
    metadataUri?: string
    goal?: bigint
    deadline?: bigint
    raised?: bigint
    status?: bigint
    claimAsa?: bigint
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
    } else if (key === 'claimAsa') {
      result.claimAsa = kv.value.uint
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
  const claimAsaId = state.claimAsa !== undefined && state.claimAsa > 0n ? state.claimAsa : undefined

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
  if (claimAsaId !== undefined) {
    viewModel.claimAsaId = claimAsaId
  }
  if (myPledgeMicroAlgos !== undefined) {
    viewModel.myPledgeMicroAlgos = myPledgeMicroAlgos
  }
  return viewModel
}

/**
 * Fetch a campaign's Claim ASA id from its global state.
 *
 * @param appId Campaign application id.
 * @returns The Claim ASA id, or undefined when the campaign has not been funded yet.
 */
export async function fetchClaimAsaId(appId: bigint): Promise<bigint | undefined> {
  const response = await indexer.lookupApplications(appId).do()
  const app = response.application
  if (!app) return undefined
  const state = decodeGlobalState(app)
  return state.claimAsa !== undefined && state.claimAsa > 0n ? state.claimAsa : undefined
}

/**
 * Fetch an account's Claim ASA holding for a campaign: opt-in status and balance (1 unit = 1 microAlgo).
 *
 * @param appId Campaign application id.
 * @param address The account's address.
 * @returns The holding (not opted in → balance 0).
 */
export async function fetchClaimHolding(appId: bigint, address: string): Promise<ClaimHolding> {
  const claimAsa = await fetchClaimAsaId(appId)
  if (claimAsa === undefined) return { optedIn: false, balance: 0n }
  try {
    const response = await indexer.lookupAccountAssets(address).assetId(Number(claimAsa)).do()
    return { optedIn: true, balance: response.assets[0]?.amount ?? 0n }
  } catch {
    return { optedIn: false, balance: 0n }
  }
}

/**
 * Fetch the connected wallet's live pledge total for a campaign, or `undefined` if it holds no claim units.
 *
 * @param appId Campaign application id.
 * @param address Viewer's Algorand address.
 * @returns Pledge in microAlgos, or undefined if the backer has no claim.
 */
export async function fetchMyPledge(appId: bigint, address: string): Promise<bigint | undefined> {
  const { balance } = await fetchClaimHolding(appId, address)
  return balance > 0n ? balance : undefined
}

/**
 * Fetch every app id registered with the Factory (paginated box search), decoded from the registration box names.
 *
 * @param factoryId The Factory application id.
 * @returns The set of registered campaign app ids.
 */
export async function fetchRegisteredCampaignIds(factoryId: bigint): Promise<Set<bigint>> {
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
        id = (id << 8n) | BigInt(name[i] ?? 0)
      }
      registered.add(id)
    }
    nextToken = response.nextToken
  } while (nextToken !== undefined)
  return registered
}

/**
 * List all campaigns by scanning indexed applications for our global-state keys, filtered to Factory-registered campaigns when a Factory
 * is configured. There is no app-name filter on the indexer, so presence of the known keys is the discriminator (docs/frontend.md).
 *
 * @param nowSeconds Current UNIX timestamp (seconds).
 * @param viewerAddress Connected wallet address, if any.
 * @returns All official campaigns found in the indexer.
 */
export async function listCampaigns(nowSeconds: bigint, viewerAddress?: string): Promise<CampaignViewModel[]> {
  const factoryId = factoryAppId()
  const registered = factoryId > 0n ? await fetchRegisteredCampaignIds(factoryId) : undefined

  const response = await indexer.searchForApplications().limit(100).do()

  const campaigns: CampaignViewModel[] = []
  for (const app of response.applications) {
    if (!isCampaignApp(app)) continue
    if (registered !== undefined && !registered.has(app.id)) continue
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
