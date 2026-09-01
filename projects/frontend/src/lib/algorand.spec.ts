import algosdk from 'algosdk'
import { describe, expect, it, vi } from 'vitest'
import { algorand, indexer } from './algorand'

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
