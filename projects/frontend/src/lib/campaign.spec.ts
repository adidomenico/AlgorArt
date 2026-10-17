import { describe, expect, it, vi } from 'vitest'
import { factoryAppId, vaultAppId } from './campaign'

describe('factoryAppId', () => {
  it('reads the Factory app id from the environment', () => {
    expect(factoryAppId()).toBe(1001n)
  })

  it('reads zero when the variable is absent', () => {
    vi.stubEnv('VITE_FACTORY_APP_ID', undefined)
    try {
      expect(factoryAppId()).toBe(0n)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reads zero for non-positive values', () => {
    vi.stubEnv('VITE_FACTORY_APP_ID', '0')
    try {
      expect(factoryAppId()).toBe(0n)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('vaultAppId', () => {
  it('reads the vault app id from the environment', () => {
    expect(vaultAppId()).toBe(2002n)
  })

  it('reads zero when the variable is absent', () => {
    vi.stubEnv('VITE_VAULT_APP_ID', undefined)
    try {
      expect(vaultAppId()).toBe(0n)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
