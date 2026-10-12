import algosdk from 'algosdk'
import { createHash } from 'node:crypto'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { createChallenge } from './auth.js'
import { pool } from './db.js'

function keypair(): { address: string; sk: Uint8Array } {
  const account = algosdk.generateAccount()
  return { address: account.addr.toString(), sk: account.sk }
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Minimal SIWA request carrying the challenge nonce (plain stringify: the backend hashes the exact bytes it
 * receives, so canonical form only matters for real wallets).
 *
 * @param nonce Challenge nonce from `createChallenge`.
 * @param address Signer address.
 * @param domain Deployment domain.
 * @returns SIWA JSON string.
 */
function siwaData(nonce: string, address: string, domain = 'localhost'): string {
  return JSON.stringify({
    domain,
    chain_id: 'algorand:testnet',
    account_address: address,
    type: 'ed25519',
    uri: 'http://localhost:5173',
    version: '1',
    statement: 'test sign-in',
    nonce,
    'issued-at': new Date().toISOString(),
  })
}

/**
 * ARC-60 test signature: ed25519 over sha256(data) || sha256(authenticatorData).
 *
 * @param data Exact SIWA JSON string that was signed.
 * @param sk Signing secret key.
 * @param domain Domain hashed into the authenticator data.
 * @returns Base64 authenticator data and signature.
 */
function arc60Sign(data: string, sk: Uint8Array, domain = 'localhost'): { authenticatorData: string; signature: string } {
  const authenticatorData = createHash('sha256').update(domain).digest()
  const toSign = new Uint8Array([...createHash('sha256').update(data).digest(), ...createHash('sha256').update(authenticatorData).digest()])
  return { authenticatorData: bytesToBase64(authenticatorData), signature: bytesToBase64(nacl.sign.detached(toSign, sk)) }
}

describe('wallet-signature auth', () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    await pool().query('DELETE FROM auth_nonces')
  })

  it('issues a token for a correctly signed challenge', async () => {
    const app = buildApp()
    const { address, sk } = keypair()

    const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address } })
    expect(challenge.statusCode).toBe(200)
    const { nonce } = challenge.json<{ nonce: string }>()
    const data = siwaData(nonce, address)
    const { authenticatorData, signature } = arc60Sign(data, sk)

    const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address, data, authenticatorData, signature } })
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
    const data = siwaData(challenge.nonce, victim.address)
    const { authenticatorData, signature } = arc60Sign(data, attacker.sk)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address: victim.address, data, authenticatorData, signature },
    })
    expect(verified.statusCode).toBe(400)
  })

  it('rejects signatures bound to another domain', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const data = siwaData(challenge.nonce, address)
    const { authenticatorData, signature } = arc60Sign(data, sk, 'evil.example')
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, data, authenticatorData, signature },
    })
    expect(verified.statusCode).toBe(400)
  })

  it('rejects short authenticator data', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const data = siwaData(challenge.nonce, address)
    const { signature } = arc60Sign(data, sk)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, data, authenticatorData: 'e30=', signature },
    })
    expect(verified.statusCode).toBe(400)
  })

  it('rejects tampered SIWA data', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const data = siwaData(challenge.nonce, address).replace('test sign-in', 'test sign-ix')
    const { authenticatorData, signature } = arc60Sign(siwaData(challenge.nonce, address), sk)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, data, authenticatorData, signature },
    })
    expect(verified.statusCode).toBe(400)
  })

  it('rejects SIWA requests bound to another domain', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const data = siwaData(challenge.nonce, address, 'evil.example')
    const { authenticatorData, signature } = arc60Sign(data, sk, 'evil.example')
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, data, authenticatorData, signature },
    })
    expect(verified.statusCode).toBe(400)
  })

  it('rejects replaying a consumed challenge', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const data = siwaData(challenge.nonce, address)
    const { authenticatorData, signature } = arc60Sign(data, sk)

    const first = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, data, authenticatorData, signature },
    })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, data, authenticatorData, signature },
    })
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
      payload: {
        address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
        data: 'garbage',
        authenticatorData: 'e30=',
        signature: 'e30=',
      },
    })
    expect(garbage.statusCode).toBe(400)
    const noNonce = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
        data: '{}',
        authenticatorData: 'e30=',
        signature: 'e30=',
      },
    })
    expect(noNonce.statusCode).toBe(400)
    const primitive = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
        data: '"oops"',
        authenticatorData: 'e30=',
        signature: 'e30=',
      },
    })
    expect(primitive.statusCode).toBe(400)
  })

  it('fails verification without SESSION_SECRET', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const data = siwaData(challenge.nonce, address)
    const { authenticatorData, signature } = arc60Sign(data, sk)
    vi.stubEnv('SESSION_SECRET', '')
    try {
      const verified = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { address, data, authenticatorData, signature },
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

  it('fails without domain config', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const data = siwaData(challenge.nonce, address)
    const { authenticatorData, signature } = arc60Sign(data, sk)
    vi.stubEnv('APP_DOMAIN', undefined)
    vi.stubEnv('APP_URI', undefined)

    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, data, authenticatorData, signature },
    })

    expect(verified.statusCode).toBe(400)
  })

  it('fails without the URI config', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const challenge = await createChallenge(address)
    const data = siwaData(challenge.nonce, address)
    const { authenticatorData, signature } = arc60Sign(data, sk)
    vi.stubEnv('APP_URI', undefined)

    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { address, data, authenticatorData, signature },
    })

    expect(verified.statusCode).toBe(400)
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
