import algosdk from 'algosdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { algorand, indexer, waitForIndexerRound } from './algorand'

vi.mock('../utils/network/getAlgoClientConfigs', () => {
  const token = 'a'.repeat(64)
  return {
    getAlgodConfigFromViteEnvironment: () => ({ server: 'http://localhost', port: 4001, token, network: 'localnet' }),
    getIndexerConfigFromViteEnvironment: () => ({ server: 'http://localhost', port: 8980, token: { 'X-Indexer-API-Token': token } }),
  }
})

describe('algorand service', () => {
  it('builds an indexer client from the environment', () => {
    expect(indexer).toBeInstanceOf(algosdk.Indexer)
  })

  it('builds an AlgorandClient from the environment', () => {
    expect(algorand).toBeDefined()
  })
})

describe('waitForIndexerRound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resolves immediately when the indexer is already past the round', async () => {
    vi.spyOn(indexer, 'makeHealthCheck').mockReturnValue({ do: () => Promise.resolve({ round: 10n }) } as never)

    await expect(waitForIndexerRound(5n)).resolves.toBeUndefined()
  })

  it('polls until the indexer catches up to the round', async () => {
    const rounds = [3n, 6n, 9n]
    const healthCheckMock = vi.fn(() => Promise.resolve({ round: rounds.shift() ?? 9n }))
    vi.spyOn(indexer, 'makeHealthCheck').mockReturnValue({ do: healthCheckMock } as never)

    let resolved = false
    const promise = waitForIndexerRound(8n, 10_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await promise

    expect(resolved).toBe(true)
    expect(healthCheckMock).toHaveBeenCalledTimes(3)
  })

  it('gives up after the timeout', async () => {
    vi.spyOn(indexer, 'makeHealthCheck').mockReturnValue({ do: () => Promise.resolve({ round: 1n }) } as never)

    let resolved = false
    const promise = waitForIndexerRound(8n, 1_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await promise

    expect(resolved).toBe(true)
  })

  it('keeps polling when the health check is temporarily unreachable', async () => {
    const healthCheckMock = vi.fn().mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce({ round: 10n })
    vi.spyOn(indexer, 'makeHealthCheck').mockReturnValue({ do: healthCheckMock } as never)

    let resolved = false
    const promise = waitForIndexerRound(8n, 10_000, 250).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250)
    await promise

    expect(resolved).toBe(true)
    expect(healthCheckMock).toHaveBeenCalledTimes(2)
  })
})
