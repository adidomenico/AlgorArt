import { afterEach, describe, expect, it, vi } from 'vitest'

describe('getWalletManager', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('returns the KMD wallet on localnet', async () => {
    const { getWalletManager } = await import('./wallets')
    const manager = getWalletManager()

    expect(manager.wallets.map((wallet) => wallet.id)).toEqual(['kmd'])
    expect(getWalletManager()).toBe(manager)
  })

  it('returns Defly, Pera, and Exodus elsewhere', async () => {
    vi.stubEnv('VITE_ALGOD_NETWORK', 'testnet')
    const { getWalletManager } = await import('./wallets')
    const manager = getWalletManager()

    expect(manager.wallets.map((wallet) => wallet.id).sort()).toEqual(['defly', 'exodus', 'pera'])
    expect(getWalletManager()).toBe(manager)
  })

  it('serializes object tokens for header auth', async () => {
    vi.stubEnv('VITE_ALGOD_NETWORK', 'testnet')
    vi.doMock('../utils/network/getAlgoClientConfigs', () => ({
      getAlgodConfigFromViteEnvironment: () => ({
        server: 'http://localhost',
        port: '4001',
        token: { 'X-Api-Key': 'secret' },
        network: 'testnet',
      }),
      getKmdConfigFromViteEnvironment: () => ({
        server: 'http://localhost',
        port: '4002',
        token: { 'X-Api-Key': 'secret' },
        wallet: 'w',
        password: '',
      }),
    }))
    const { getWalletManager } = await import('./wallets')
    const manager = getWalletManager()

    expect(manager.networkConfig['testnet']?.algod.token).toBe('{"X-Api-Key":"secret"}')
  })

  it('serializes an object KMD token on localnet', async () => {
    vi.doMock('../utils/network/getAlgoClientConfigs', () => ({
      getAlgodConfigFromViteEnvironment: () => ({
        server: 'http://localhost',
        port: '4001',
        token: 'a'.repeat(64),
        network: 'localnet',
      }),
      getKmdConfigFromViteEnvironment: () => ({
        server: 'http://localhost',
        port: '4002',
        token: { 'X-Api-Key': 'secret' },
        wallet: 'w',
        password: '',
      }),
    }))
    const { getWalletManager } = await import('./wallets')
    const manager = getWalletManager()

    expect(manager.wallets.map((wallet) => wallet.id)).toEqual(['kmd'])
  })
})
