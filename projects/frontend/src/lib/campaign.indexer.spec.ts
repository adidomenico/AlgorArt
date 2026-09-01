import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMyPledge, getCampaign, listCampaigns } from './campaign'

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

const lookupBoxMock = { do: vi.fn() }
const searchAppsDoMock = vi.fn()
const lookupAppsMock = { do: vi.fn() }

vi.mock('./algorand', () => ({
  indexer: {
    lookupApplicationBoxByIDandName: vi.fn(() => lookupBoxMock),
    searchForApplications: vi.fn(() => ({ limit: () => ({ do: searchAppsDoMock }) })),
    lookupApplications: vi.fn(() => lookupAppsMock),
  },
}))

function tealUint(value: bigint): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: new Uint8Array(), type: 2, uint: value })
}

function tealBytes(value: Uint8Array): algosdk.indexerModels.TealValue {
  return new algosdk.indexerModels.TealValue({ bytes: value, type: 1, uint: 0n })
}

function kv(key: string, value: algosdk.indexerModels.TealValue): algosdk.indexerModels.TealKeyValue {
  return new algosdk.indexerModels.TealKeyValue({ key: new TextEncoder().encode(key), value })
}

function appParams(globalState: algosdk.indexerModels.TealKeyValue[]): algosdk.indexerModels.ApplicationParams {
  return new algosdk.indexerModels.ApplicationParams({
    approvalProgram: new Uint8Array(),
    clearStateProgram: new Uint8Array(),
    globalState,
  })
}

function campaignApp(id: bigint): algosdk.indexerModels.Application {
  const globalState = [
    kv('creator', tealBytes(algosdk.decodeAddress(ZERO_ADDRESS).publicKey)),
    kv('goal', tealUint(10_000_000n)),
    kv('deadline', tealUint(2_000n)),
    kv('raised', tealUint(5_000_000n)),
    kv('status', tealUint(0n)),
  ]
  return new algosdk.indexerModels.Application({ id, params: appParams(globalState) })
}

describe('indexer-backed helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetchMyPledge decodes the pledge box value', async () => {
    lookupBoxMock.do.mockResolvedValue({ value: new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0]) })
    const result = await fetchMyPledge(42n, ZERO_ADDRESS)
    expect(result).toBe(256n)
  })

  it('fetchMyPledge returns undefined when the box is missing', async () => {
    lookupBoxMock.do.mockRejectedValue(new Error('not found'))
    const result = await fetchMyPledge(42n, ZERO_ADDRESS)
    expect(result).toBeUndefined()
  })

  it('listCampaigns maps campaigns and skips non-campaign apps', async () => {
    searchAppsDoMock.mockResolvedValue({
      applications: [
        campaignApp(1n),
        new algosdk.indexerModels.Application({
          id: 99n,
          params: appParams([kv('other', tealUint(1n))]),
        }),
      ],
    })

    const result = await listCampaigns(1_000n)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe(1n)
  })

  it('listCampaigns fetches the viewer pledge when an address is provided', async () => {
    lookupBoxMock.do.mockResolvedValue({ value: new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0]) })
    searchAppsDoMock.mockResolvedValue({ applications: [campaignApp(1n)] })

    const result = await listCampaigns(1_000n, ZERO_ADDRESS)
    expect(result[0]?.myPledgeMicroAlgos).toBe(256n)
  })

  it('getCampaign returns a campaign by id', async () => {
    lookupAppsMock.do.mockResolvedValue({ application: campaignApp(7n) })
    const result = await getCampaign(7n, 1_000n)
    expect(result?.id).toBe(7n)
  })

  it('getCampaign returns undefined for non-campaign apps', async () => {
    lookupAppsMock.do.mockResolvedValue({
      application: new algosdk.indexerModels.Application({
        id: 8n,
        params: appParams([]),
      }),
    })
    const result = await getCampaign(8n, 1_000n)
    expect(result).toBeUndefined()
  })

  it('getCampaign returns undefined when the app is absent', async () => {
    lookupAppsMock.do.mockResolvedValue({ application: undefined })
    const result = await getCampaign(8n, 1_000n)
    expect(result).toBeUndefined()
  })

  it('getCampaign fetches the viewer pledge when an address is provided', async () => {
    lookupBoxMock.do.mockResolvedValue({ value: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 7]) })
    lookupAppsMock.do.mockResolvedValue({ application: campaignApp(7n) })
    const result = await getCampaign(7n, 1_000n, ZERO_ADDRESS)
    expect(result?.myPledgeMicroAlgos).toBe(7n)
  })
})
