import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchClaimAsaId, fetchClaimHolding, fetchMyPledge, fetchRegisteredCampaignIds, getCampaign, listCampaigns } from './campaign'

const indexerMock = vi.hoisted(() => ({
  lookupApplications: vi.fn(),
  lookupAccountAssets: vi.fn(),
  searchForApplications: vi.fn(),
  searchForApplicationBoxes: vi.fn(),
}))

vi.mock('./algorand', () => ({
  indexer: indexerMock,
}))

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

function tealUint(value: bigint): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: new Uint8Array(), type: 2, uint: value })
}

function tealBytes(value: Uint8Array): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: value, type: 1, uint: 0n })
}

function kv(key: string, value: algosdk.indexerModels.TealValue): algosdk.indexerModels.TealKeyValue {
  return new algosdk.indexerModels.TealKeyValue({ key: new TextEncoder().encode(key), value })
}

function campaignApp(overrides: { claimAsa?: bigint; id?: bigint } = {}): algosdk.indexerModels.Application {
  const globalState = [
    kv('creator', tealBytes(algosdk.decodeAddress(ZERO_ADDRESS).publicKey)),
    kv('title', tealBytes(new TextEncoder().encode('My first novel'))),
    kv('metadataUri', tealBytes(new TextEncoder().encode('ipfs://QmExample'))),
    kv('goal', tealUint(10_000_000n)),
    kv('deadline', tealUint(2_000n)),
    kv('raised', tealUint(5_000_000n)),
    kv('status', tealUint(0n)),
    kv('claimAsa', tealUint(overrides.claimAsa ?? 777n)),
  ]
  return new algosdk.indexerModels.Application({
    id: overrides.id ?? 42n,
    params: new algosdk.indexerModels.ApplicationParams({
      approvalProgram: new Uint8Array(),
      clearStateProgram: new Uint8Array(),
      globalState,
    }),
  })
}

// A chainable indexer builder for lookup endpoints.
function lookupBuilder(response: unknown, throws = false): unknown {
  return {
    assetId: () => lookupBuilder(response, throws),
    do: () => (throws ? Promise.reject(new Error('not found')) : Promise.resolve(response)),
  }
}

function searchBuilder(getApplications: () => algosdk.indexerModels.Application[]): unknown {
  return {
    limit: () => searchBuilder(getApplications),
    do: () => ({ applications: getApplications() }),
  }
}

function boxSearchBuilder(getBoxes: () => { name: Uint8Array }[]): unknown {
  return {
    limit: () => boxSearchBuilder(getBoxes),
    nextToken: () => boxSearchBuilder(getBoxes),
    do: () => ({ boxes: getBoxes(), nextToken: undefined }),
  }
}

/**
 * A Factory registration box name: 'r' + the 8-byte big-endian app id.
 *
 * @param appId The campaign app id to encode.
 * @returns The 9-byte box name.
 */
function registrationBoxName(appId: bigint): Uint8Array {
  const name = new Uint8Array(9)
  name[0] = 0x72
  for (let i = 8; i >= 1; i--) {
    name[i] = Number(appId & 0xffn)
    appId >>= 8n
  }
  return name
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchClaimAsaId', () => {
  it('returns the Claim ASA id from global state', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp() }))
    expect(await fetchClaimAsaId(42n)).toBe(777n)
  })

  it('returns undefined when the campaign has not been funded', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp({ claimAsa: 0n }) }))
    expect(await fetchClaimAsaId(42n)).toBeUndefined()
  })

  it('returns undefined when the app is missing', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: undefined }))
    expect(await fetchClaimAsaId(42n)).toBeUndefined()
  })
})

describe('fetchClaimHolding', () => {
  it('returns the opted-in balance', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp() }))
    indexerMock.lookupAccountAssets.mockImplementation(() => lookupBuilder({ assets: [{ amount: 250_000n }] }))
    expect(await fetchClaimHolding(42n, 'ADDRESS')).toEqual({ optedIn: true, balance: 250_000n })
  })

  it('returns opted out when the asset lookup 404s', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp() }))
    indexerMock.lookupAccountAssets.mockImplementation(() => lookupBuilder({}, true))
    expect(await fetchClaimHolding(42n, 'ADDRESS')).toEqual({ optedIn: false, balance: 0n })
  })

  it('returns opted out when the campaign has no Claim ASA', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp({ claimAsa: 0n }) }))
    expect(await fetchClaimHolding(42n, 'ADDRESS')).toEqual({ optedIn: false, balance: 0n })
  })
})

describe('fetchMyPledge', () => {
  it('returns the claim balance when positive', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp() }))
    indexerMock.lookupAccountAssets.mockImplementation(() => lookupBuilder({ assets: [{ amount: 1_000_000n }] }))
    expect(await fetchMyPledge(42n, 'ADDRESS')).toBe(1_000_000n)
  })

  it('returns undefined when the backer holds no units', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp() }))
    indexerMock.lookupAccountAssets.mockImplementation(() => lookupBuilder({}, true))
    expect(await fetchMyPledge(42n, 'ADDRESS')).toBeUndefined()
  })
})

describe('fetchRegisteredCampaignIds', () => {
  it('decodes registration box names into app ids', async () => {
    indexerMock.searchForApplicationBoxes.mockImplementation(() =>
      boxSearchBuilder(() => [
        { name: registrationBoxName(7n) },
        { name: registrationBoxName(1_234_567_890n) },
        { name: new Uint8Array([0x72, 1, 2, 3]) }, // malformed: too short
        { name: new Uint8Array([0x71, 1, 2, 3, 4, 5, 6, 7, 8]) }, // wrong prefix
      ]),
    )
    const ids = await fetchRegisteredCampaignIds(1001n)
    expect([...ids]).toEqual([7n, 1_234_567_890n])
  })
})

describe('listCampaigns', () => {
  it('lists campaigns filtered to the Factory registrations', async () => {
    const official = campaignApp({ id: 42n })
    const unregistered = campaignApp({ id: 43n })
    const unrelated = new algosdk.indexerModels.Application({
      id: 44n,
      params: new algosdk.indexerModels.ApplicationParams({
        approvalProgram: new Uint8Array(),
        clearStateProgram: new Uint8Array(),
        globalState: [kv('nope', tealUint(1n))],
      }),
    })

    indexerMock.searchForApplicationBoxes.mockImplementation(() => boxSearchBuilder(() => [{ name: registrationBoxName(42n) }]))
    indexerMock.searchForApplications.mockImplementation(() => searchBuilder(() => [official, unregistered, unrelated]))

    const campaigns = await listCampaigns(1_000n)
    expect(campaigns.map((c) => c.id)).toEqual([42n])
  })
})

describe('getCampaign', () => {
  it('returns the campaign with the viewer pledge', async () => {
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: campaignApp() }))
    indexerMock.lookupAccountAssets.mockImplementation(() => lookupBuilder({ assets: [{ amount: 250_000n }] }))
    const vm = await getCampaign(42n, 3_000n, 'ADDRESS')
    expect(vm?.id).toBe(42n)
    expect(vm?.myPledgeMicroAlgos).toBe(250_000n)
  })

  it('returns undefined for a non-campaign app', async () => {
    const unrelated = new algosdk.indexerModels.Application({
      id: 44n,
      params: new algosdk.indexerModels.ApplicationParams({
        approvalProgram: new Uint8Array(),
        clearStateProgram: new Uint8Array(),
        globalState: [kv('nope', tealUint(1n))],
      }),
    })
    indexerMock.lookupApplications.mockImplementation(() => lookupBuilder({ application: unrelated }))
    expect(await getCampaign(44n, 3_000n)).toBeUndefined()
  })
})
