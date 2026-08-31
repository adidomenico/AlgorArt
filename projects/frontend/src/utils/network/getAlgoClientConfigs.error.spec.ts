import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  getAlgodConfigFromViteEnvironment,
  getIndexerConfigFromViteEnvironment,
  getKmdConfigFromViteEnvironment,
} from './getAlgoClientConfigs'

describe('getAlgoClientConfigs error branches', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws when VITE_ALGOD_SERVER is missing', () => {
    vi.stubEnv('VITE_ALGOD_SERVER', '')
    expect(() => getAlgodConfigFromViteEnvironment()).toThrow()
  })

  it('throws when VITE_INDEXER_SERVER is missing', () => {
    vi.stubEnv('VITE_INDEXER_SERVER', '')
    expect(() => getIndexerConfigFromViteEnvironment()).toThrow()
  })

  it('throws when VITE_KMD_SERVER is missing', () => {
    vi.stubEnv('VITE_KMD_SERVER', '')
    expect(() => getKmdConfigFromViteEnvironment()).toThrow()
  })
})
