import * as sdk from '@kasakame/sdk'
import algosdk from 'algosdk'
import { describe, expect, it, vi } from 'vitest'
import { algorand, fetchChainTimestamp, indexer, waitForIndexerCatchUp, waitForIndexerRound } from './algorand'

vi.mock('../utils/network/getAlgoClientConfigs', () => {
  const token = 'a'.repeat(64)
  return {
    appIdFromEnv: () => 1001n,
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

  it('re-exports the SDK chain plumbing', () => {
    expect(fetchChainTimestamp).toBe(sdk.fetchChainTimestamp)
    expect(waitForIndexerRound).toBe(sdk.waitForIndexerRound)
    expect(waitForIndexerCatchUp).toBe(sdk.waitForIndexerCatchUp)
  })
})
