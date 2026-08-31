import { describe, expect, it, vi } from 'vitest'
import algosdk from 'algosdk'
import { getAlgorand, getIndexer } from './algorand'

vi.mock('../utils/network/getAlgoClientConfigs', () => {
  const token = 'a'.repeat(64)
  return {
    getAlgodConfigFromViteEnvironment: () => ({ server: 'http://localhost', port: 4001, token, network: 'localnet' }),
    getIndexerConfigFromViteEnvironment: () => ({ server: 'http://localhost', port: 8980, token: { 'X-Indexer-API-Token': token } }),
  }
})

describe('algorand service', () => {
  it('returns a memoised indexer client', () => {
    const indexer = getIndexer()
    expect(indexer).toBeInstanceOf(algosdk.Indexer)
    expect(getIndexer()).toBe(indexer)
  })

  it('returns a memoised AlgorandClient', () => {
    const algorand = getAlgorand()
    expect(algorand).toBeDefined()
    expect(getAlgorand()).toBe(algorand)
  })
})
