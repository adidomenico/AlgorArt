import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAlgodConfigFromViteEnvironment,
  getIndexerConfigFromViteEnvironment,
  getKmdConfigFromViteEnvironment,
} from './getAlgoClientConfigs'

describe('client configs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads full configs from the environment', () => {
    vi.stubEnv('VITE_ALGOD_SERVER', 'http://algod')
    vi.stubEnv('VITE_ALGOD_PORT', '4001')
    vi.stubEnv('VITE_ALGOD_TOKEN', 'token')
    vi.stubEnv('VITE_ALGOD_NETWORK', 'localnet')
    expect(getAlgodConfigFromViteEnvironment()).toEqual({ server: 'http://algod', port: '4001', token: 'token', network: 'localnet' })
  })

  it('defaults missing algod optionals to empty strings', () => {
    vi.stubEnv('VITE_ALGOD_PORT', undefined)
    vi.stubEnv('VITE_ALGOD_TOKEN', undefined)
    vi.stubEnv('VITE_ALGOD_NETWORK', undefined)
    expect(getAlgodConfigFromViteEnvironment()).toEqual({ server: 'http://localhost', port: '', token: '', network: '' })
  })

  it('defaults missing indexer optionals to empty strings', () => {
    vi.stubEnv('VITE_INDEXER_PORT', undefined)
    vi.stubEnv('VITE_INDEXER_TOKEN', undefined)
    vi.stubEnv('VITE_ALGOD_NETWORK', undefined)
    expect(getIndexerConfigFromViteEnvironment()).toEqual({ server: 'http://localhost', port: '', token: '', network: '' })
  })

  it('defaults missing kmd optionals to empty strings', () => {
    vi.stubEnv('VITE_KMD_PORT', undefined)
    vi.stubEnv('VITE_KMD_TOKEN', undefined)
    vi.stubEnv('VITE_KMD_WALLET', undefined)
    vi.stubEnv('VITE_KMD_PASSWORD', undefined)
    expect(getKmdConfigFromViteEnvironment()).toEqual({ server: 'http://localhost', port: '', token: '', wallet: '', password: '' })
  })
})
