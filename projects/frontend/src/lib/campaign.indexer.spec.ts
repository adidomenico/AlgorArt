import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMyPledge, fetchPledgeLeaves, fetchSpentShards, getCampaign, isLeafSpent, listCampaigns } from './campaign'

const indexerMock = vi.hoisted(() => ({
  lookupApplications: vi.fn(),
  searchForApplications: vi.fn(),
  searchForTransactions: vi.fn(),
  lookupApplicationBoxByIDandName: vi.fn(),
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

function campaignApp(leafCount: bigint): algosdk.indexerModels.Application {
  const globalState = [
    kv('creator', tealBytes(algosdk.decodeAddress(ZERO_ADDRESS).publicKey)),
    kv('title', tealBytes(new TextEncoder().encode('My first novel'))),
    kv('metadataUri', tealBytes(new TextEncoder().encode('ipfs://QmExample'))),
    kv('goal', tealUint(10_000_000n)),
    kv('deadline', tealUint(2_000n)),
    kv('raised', tealUint(5_000_000n)),
    kv('status', tealUint(0n)),
    kv('leafCount', tealUint(leafCount)),
  ]
  return new algosdk.indexerModels.Application({
    id: 42n,
    params: new algosdk.indexerModels.ApplicationParams({
      approvalProgram: new Uint8Array(),
      clearStateProgram: new Uint8Array(),
      globalState,
    }),
  })
}

// A fake indexer transaction with just the fields the read model touches.
interface FakeTx {
  group: Uint8Array | undefined
  sender: string
  paymentTransaction?: { amount: bigint }
}

function appCall(sender: string, group?: Uint8Array): FakeTx {
  return { sender, group }
}

function payment(sender: string, amount: bigint, group: Uint8Array): FakeTx {
  return { sender, group, paymentTransaction: { amount } }
}

// A chainable `searchForTransactions` builder whose `.do()` routes to app-calls or payments based on which filter ran first.
function searchTxBuilder(getAppCalls: () => FakeTx[], getPayments: () => FakeTx[]): unknown {
  let mode: 'app' | 'pay' | null = null
  const query = {
    applicationID: () => {
      mode = 'app'
      return query
    },
    address: () => {
      mode = 'pay'
      return query
    },
    addressRole: () => query,
    txType: () => query,
    limit: () => query,
    nextToken: () => query,
    do: () => ({ transactions: mode === 'pay' ? getPayments() : getAppCalls(), nextToken: undefined }),
  }
  return query
}

function mockTransactions(appCalls: FakeTx[], payments: FakeTx[]) {
  indexerMock.searchForTransactions.mockImplementation(() =>
    searchTxBuilder(
      () => appCalls,
      () => payments,
    ),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchPledgeLeaves', () => {
  const GROUP_A = new Uint8Array([1, 2, 3, 4])
  const GROUP_B = new Uint8Array([5, 6, 7, 8])
  const GROUP_FUND = new Uint8Array([9, 9, 9, 9])

  it('reconstructs leaves in app-call order, filtering out fund and ungrouped calls', async () => {
    mockTransactions(
      [appCall('BACKER_A', GROUP_A), appCall('CREATOR', GROUP_FUND), appCall('CREATOR'), appCall('BACKER_B', GROUP_B)],
      [payment('BACKER_A', 100n, GROUP_A), payment('CREATOR', 2_303_300n, GROUP_FUND), payment('BACKER_B', 200n, GROUP_B)],
    )

    const leaves = await fetchPledgeLeaves(42n, 'CREATOR')

    expect(leaves).toEqual([
      { address: 'BACKER_A', amount: 100n },
      { address: 'BACKER_B', amount: 200n },
    ])
  })

  it('ignores a stray payment with no matching app call', async () => {
    mockTransactions([appCall('BACKER_A', GROUP_A)], [payment('BACKER_A', 100n, GROUP_A), payment('STRANGER', 999n, GROUP_B)])

    const leaves = await fetchPledgeLeaves(42n, 'CREATOR')

    expect(leaves).toEqual([{ address: 'BACKER_A', amount: 100n }])
  })

  it('skips a group whose payment sender does not match the app caller', async () => {
    mockTransactions([appCall('BACKER_A', GROUP_A)], [payment('SOMEONE_ELSE', 100n, GROUP_A)])

    const leaves = await fetchPledgeLeaves(42n, 'CREATOR')

    expect(leaves).toEqual([])
  })
})

describe('isLeafSpent', () => {
  it('reads set bits from the most significant bit of the first byte', () => {
    const shard = new Uint8Array(1024)
    shard[0] = 0xc0 // bits 0 and 1
    expect(isLeafSpent([shard], 0)).toBe(true)
    expect(isLeafSpent([shard], 1)).toBe(true)
    expect(isLeafSpent([shard], 2)).toBe(false)
  })

  it('returns false for an absent shard', () => {
    expect(isLeafSpent([], 8192)).toBe(false)
  })

  it('returns false when the shard is too short to hold the bit', () => {
    expect(isLeafSpent([new Uint8Array(1)], 8)).toBe(false)
  })
})

describe('fetchSpentShards', () => {
  it('reads shards by name and defaults missing shards to zero bytes', async () => {
    const shard0 = new Uint8Array(1024)
    shard0[0] = 0xff
    indexerMock.lookupApplicationBoxByIDandName.mockImplementation((_appId: unknown, name: Uint8Array) => {
      const nameHex = Buffer.from(name).toString('hex')
      if (nameHex === '73' + '00'.repeat(8)) {
        return { do: () => ({ value: shard0 }) }
      }
      return { do: () => Promise.reject(new Error('missing')) }
    })

    const shards = await fetchSpentShards(42n, 20_000n) // 3 shards

    expect(shards).toHaveLength(3)
    expect(shards[0]?.[0]).toBe(0xff)
    expect(shards[1]).toEqual(new Uint8Array(1024))
  })

  it('reads no shards when the leaf count is zero', async () => {
    const shards = await fetchSpentShards(42n, 0n)
    expect(shards).toEqual([])
    expect(indexerMock.lookupApplicationBoxByIDandName).not.toHaveBeenCalled()
  })
})

describe('fetchMyPledge', () => {
  const GROUP_A = new Uint8Array([1, 2, 3, 4])
  const GROUP_B = new Uint8Array([5, 6, 7, 8])

  function mockCampaignAndLeaves(leafCount: bigint, appCalls: FakeTx[], payments: FakeTx[]) {
    indexerMock.lookupApplications.mockReturnValue({ do: () => ({ application: campaignApp(leafCount) }) })
    mockTransactions(appCalls, payments)
    indexerMock.lookupApplicationBoxByIDandName.mockReturnValue({ do: () => Promise.reject(new Error('missing')) })
  }

  it('sums the backer live leaves', async () => {
    mockCampaignAndLeaves(
      2n,
      [appCall('BACKER_A', GROUP_A), appCall('BACKER_B', GROUP_B)],
      [payment('BACKER_A', 100n, GROUP_A), payment('BACKER_B', 200n, GROUP_B)],
    )

    const result = await fetchMyPledge(42n, 'BACKER_A')

    expect(result).toBe(100n)
  })

  it('returns undefined when the backer has no live leaves', async () => {
    mockCampaignAndLeaves(1n, [appCall('BACKER_A', GROUP_A)], [payment('BACKER_A', 100n, GROUP_A)])

    const result = await fetchMyPledge(42n, 'BACKER_B')

    expect(result).toBeUndefined()
  })

  it('excludes spent leaves', async () => {
    mockCampaignAndLeaves(
      2n,
      [appCall('BACKER_A', GROUP_A), appCall('BACKER_A', GROUP_B)],
      [payment('BACKER_A', 100n, GROUP_A), payment('BACKER_A', 200n, GROUP_B)],
    )

    // Mark leaf 0 spent: shard 0, bit 0 (0x80).
    const shard = new Uint8Array(1024)
    shard[0] = 0x80
    indexerMock.lookupApplicationBoxByIDandName.mockReturnValue({ do: () => ({ value: shard }) })

    const result = await fetchMyPledge(42n, 'BACKER_A')

    expect(result).toBe(200n)
  })
})

describe('listCampaigns', () => {
  it('maps campaigns, skips non-campaign apps, and fetches the viewer pledge', async () => {
    indexerMock.searchForApplications.mockReturnValue({
      limit: () => ({
        do: () => ({
          applications: [
            campaignApp(0n),
            new algosdk.indexerModels.Application({
              id: 99n,
              params: new algosdk.indexerModels.ApplicationParams({
                approvalProgram: new Uint8Array(),
                clearStateProgram: new Uint8Array(),
                globalState: [kv('other', tealUint(1n))],
              }),
            }),
          ],
        }),
      }),
    })
    mockTransactions([], [])
    indexerMock.lookupApplications.mockReturnValue({ do: () => ({ application: campaignApp(0n) }) })

    const result = await listCampaigns(1_000n, ZERO_ADDRESS)

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe(42n)
  })

  it('does not fetch the pledge when no viewer is connected', async () => {
    indexerMock.searchForApplications.mockReturnValue({
      limit: () => ({ do: () => ({ applications: [campaignApp(0n)] }) }),
    })

    const result = await listCampaigns(1_000n)

    expect(result).toHaveLength(1)
    expect(indexerMock.lookupApplications).not.toHaveBeenCalled()
  })
})

describe('getCampaign', () => {
  it('returns a campaign by id', async () => {
    indexerMock.lookupApplications.mockReturnValue({ do: () => ({ application: campaignApp(0n) }) })
    const result = await getCampaign(7n, 1_000n)
    expect(result?.id).toBe(42n)
  })

  it('returns undefined for non-campaign apps', async () => {
    indexerMock.lookupApplications.mockReturnValue({
      do: () => ({
        application: new algosdk.indexerModels.Application({
          id: 8n,
          params: new algosdk.indexerModels.ApplicationParams({
            approvalProgram: new Uint8Array(),
            clearStateProgram: new Uint8Array(),
            globalState: [],
          }),
        }),
      }),
    })
    const result = await getCampaign(8n, 1_000n)
    expect(result).toBeUndefined()
  })

  it('returns undefined when the app is absent', async () => {
    indexerMock.lookupApplications.mockReturnValue({ do: () => ({ application: undefined }) })
    const result = await getCampaign(8n, 1_000n)
    expect(result).toBeUndefined()
  })

  it('fetches the viewer pledge when an address is provided', async () => {
    const GROUP_A = new Uint8Array([1, 2, 3, 4])
    indexerMock.lookupApplications.mockReturnValue({ do: () => ({ application: campaignApp(1n) }) })
    mockTransactions([appCall('BACKER_A', GROUP_A)], [payment('BACKER_A', 7n, GROUP_A)])
    indexerMock.lookupApplicationBoxByIDandName.mockReturnValue({ do: () => Promise.reject(new Error('missing')) })

    const result = await getCampaign(7n, 1_000n, 'BACKER_A')
    expect(result?.myPledgeMicroAlgos).toBe(7n)
  })
})
