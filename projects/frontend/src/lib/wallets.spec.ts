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
})
