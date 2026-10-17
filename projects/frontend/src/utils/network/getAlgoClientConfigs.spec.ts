import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appIdFromEnv,
  getAlgodConfigFromViteEnvironment,
  getIndexerConfigFromViteEnvironment,
  getKmdConfigFromViteEnvironment,
} from './getAlgoClientConfigs'

describe('appIdFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads a positive app id from the environment', () => {
    expect(appIdFromEnv('VITE_FACTORY_APP_ID')).toBe(1001n)
  })

  it('reads zero when the variable is absent', () => {
    vi.stubEnv('VITE_FACTORY_APP_ID', undefined)
    expect(appIdFromEnv('VITE_FACTORY_APP_ID')).toBe(0n)
  })

  it('reads zero for non-positive values', () => {
    vi.stubEnv('VITE_FACTORY_APP_ID', '0')
    expect(appIdFromEnv('VITE_FACTORY_APP_ID')).toBe(0n)
  })
})

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
