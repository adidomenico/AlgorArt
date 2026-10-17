import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureSdk, fetchChainTimestamp, getSdkConfig, waitForIndexerCatchUp, waitForIndexerRound } from './chain.js'

const algodStatus = vi.fn()
const algodBlock = vi.fn()
const healthCheck = vi.fn()

function fakeAlgorand(): AlgorandClient {
  return {
    client: {
      algod: {
        status: () => ({ do: algodStatus }),
        block: (round: bigint) => ({ do: () => algodBlock(round) }),
      },
      indexer: { makeHealthCheck: () => ({ do: healthCheck }) },
    },
  } as unknown as AlgorandClient
}

describe('configureSdk', () => {
  it('requires configuration before use', async () => {
    vi.resetModules()
    const fresh = await import('./chain.js')
    expect(() => fresh.getSdkConfig()).toThrow('SDK not configured')
  })

  it('stores the session for later calls', () => {
    const algorand = fakeAlgorand()
    configureSdk({ algorand, factoryAppId: 1001n, vaultAppId: 2002n })
    expect(getSdkConfig().algorand).toBe(algorand)
    expect(getSdkConfig().factoryAppId).toEqual(1001n)
    expect(getSdkConfig().vaultAppId).toEqual(2002n)
  })
})

describe('chain plumbing', () => {
  beforeEach(() => {
    configureSdk({ algorand: fakeAlgorand(), factoryAppId: 1001n, vaultAppId: 2002n })
    algodStatus.mockReset()
    algodBlock.mockReset()
    healthCheck.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads the latest block header timestamp', async () => {
    algodStatus.mockResolvedValue({ lastRound: 42n })
    algodBlock.mockResolvedValue({ block: { header: { timestamp: 123n } } })
    expect(await fetchChainTimestamp()).toEqual(123n)
    expect(algodBlock).toHaveBeenCalledWith(42n)
  })

  it('waits for the indexer to reach the chain tip', async () => {
    algodStatus.mockResolvedValue({ lastRound: 5n })
    healthCheck.mockResolvedValue({ round: 10n })
    await expect(waitForIndexerCatchUp(10_000, 250)).resolves.toBeUndefined()
  })
})

describe('waitForIndexerRound', () => {
  beforeEach(() => {
    configureSdk({ algorand: fakeAlgorand(), factoryAppId: 1001n, vaultAppId: 2002n })
    healthCheck.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resolves immediately when the indexer is already past the round', async () => {
    healthCheck.mockResolvedValue({ round: 10n })

    await expect(waitForIndexerRound(5n)).resolves.toBeUndefined()
  })

  it('polls until the indexer catches up to the round', async () => {
    const rounds = [3n, 6n, 9n]
    healthCheck.mockImplementation(() => Promise.resolve({ round: rounds.shift() ?? 9n }))

    let resolved = false
    const promise = waitForIndexerRound(8n, 10_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await promise

    expect(resolved).toBe(true)
    expect(healthCheck).toHaveBeenCalledTimes(3)
  })

  it('gives up after the timeout', async () => {
    healthCheck.mockResolvedValue({ round: 1n })

    let resolved = false
    const promise = waitForIndexerRound(8n, 1_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await promise

    expect(resolved).toBe(true)
  })

  it('keeps polling when the health check is temporarily unreachable', async () => {
    healthCheck.mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce({ round: 10n })

    let resolved = false
    const promise = waitForIndexerRound(8n, 10_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await promise

    expect(resolved).toBe(true)
    expect(healthCheck).toHaveBeenCalledTimes(2)
  })
})
