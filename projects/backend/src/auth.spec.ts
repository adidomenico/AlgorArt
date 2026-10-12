import algosdk from 'algosdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createChallenge } from './auth.js'
import { pool } from './db.js'

function keypair(): { address: string; sk: Uint8Array } {
  const account = algosdk.generateAccount()
  return { address: account.addr.toString(), sk: account.sk }
}

function sign(message: string, sk: Uint8Array): string {
  const signature = algosdk.signBytes(new TextEncoder().encode(message), sk)
  return btoa(String.fromCharCode(...signature))
}

describe('wallet-signature auth', () => {
  afterEach(async () => {
    await pool().query('DELETE FROM auth_nonces')
  })

  it('issues a token for a correctly signed challenge', async () => {
    const app = buildApp()
    const { address, sk } = keypair()

    const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address } })
    expect(challenge.statusCode).toBe(200)
    const { message } = challenge.json<{ message: string }>()

    const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address, message, signature: sign(message, sk) } })
    expect(verified.statusCode).toBe(200)
    const { token } = verified.json<{ token: string }>()
    expect(typeof token).toBe('string')

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({ address })
  })

  it('rejects a challenge signed by another key', async () => {
    const app = buildApp()
    const victim = keypair()
    const attacker = keypair()

    const challenge = await createChallenge(victim.address)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: victim.address, message: challenge.message, signature: sign(challenge.message, attacker.sk) },
    })
    expect(verified.statusCode).toBe(400)
  })

  it('rejects challenges bound to another domain', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const forged = challenge.message.replace(/^Domain: .*$/m, 'Domain: evil.example')
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, message: forged, signature: sign(forged, sk) },
    })
    expect(verified.statusCode).toBe(400)
  })

  it('rejects replaying a consumed challenge', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const signature = sign(challenge.message, sk)

    const first = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address, message: challenge.message, signature } })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address, message: challenge.message, signature } })
    expect(second.statusCode).toBe(400)
  })

  it('rejects missing and invalid tokens on protected routes', async () => {
    const app = buildApp()

    const missing = await app.inject({ method: 'GET', url: '/me' })
    expect(missing.statusCode).toBe(401)
    const bogus = await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer bogus' } })
    expect(bogus.statusCode).toBe(401)
  })

  it('rejects malformed challenge requests', async () => {
    const app = buildApp()

    const noAddress = await app.inject({ method: 'POST', url: '/auth/challenge', payload: {} })
    expect(noAddress.statusCode).toBe(400)
    const badAddress = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: 'not-an-address' } })
    expect(badAddress.statusCode).toBe(400)
    const noFields = await app.inject({ method: 'POST', url: '/auth/verify', payload: {} })
    expect(noFields.statusCode).toBe(400)
    const garbage = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ', message: 'garbage', signature: 'e30=' },
    })
    expect(garbage.statusCode).toBe(400)
  })

  it('fails verification without SESSION_SECRET', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const signature = sign(challenge.message, sk)
    vi.stubEnv('SESSION_SECRET', '')
    try {
      const verified = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { address, message: challenge.message, signature },
      })
      expect(verified.statusCode).toBe(400)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('answers the health probe', async () => {
    const app = buildApp()
    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: 'ok' })
  })

  it('rejects tokens without an address', async () => {
    const app = buildApp()
    const { SignJWT } = await import('jose')
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('algorart')
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET ?? 'test-secret'))
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(401)
  })

  it('fails pool creation without DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', '')
    vi.resetModules()
    try {
      const { pool: freshPool } = await import('./db.js')
      expect(() => freshPool()).toThrow()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
