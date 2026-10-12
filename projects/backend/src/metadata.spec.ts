import algosdk from 'algosdk'
import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { pool } from './db.js'

function keypair(): { address: string; sk: Uint8Array } {
  const account = algosdk.generateAccount()
  return { address: account.addr.toString(), sk: account.sk }
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

/**
 * ARC-60 test signature: ed25519 over sha256(data) || sha256(authenticatorData).
 *
 * @param data Exact SIWA JSON string that was signed.
 * @param sk Signing secret key.
 * @returns Base64 authenticator data and signature.
 */
function arc60Sign(data: string, sk: Uint8Array): { authenticatorData: string; signature: string } {
  const authenticatorData = createHash('sha256').update('localhost').digest()
  const toSign = new Uint8Array([...createHash('sha256').update(data).digest(), ...createHash('sha256').update(authenticatorData).digest()])
  return { authenticatorData: bytesToBase64(authenticatorData), signature: bytesToBase64(nacl.sign.detached(toSign, sk)) }
}

async function token(app: FastifyInstance): Promise<string> {
  const { address, sk } = keypair()
  const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address } })
  const { nonce } = challenge.json<{ nonce: string }>()
  const data = JSON.stringify({
    domain: 'localhost',
    account_address: address,
    type: 'ed25519',
    uri: 'http://localhost:5173',
    version: '1',
    nonce,
  })
  const { authenticatorData, signature } = arc60Sign(data, sk)
  const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address, data, authenticatorData, signature } })
  return verified.json<{ token: string }>().token
}

describe('POST /uploads/metadata', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await pool().query('DELETE FROM auth_nonces')
  })

  it('pins metadata and returns the CID', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    const seen: { url: unknown; init: { body?: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown, init: { body?: unknown }) => {
        seen.push({ url, init })
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ IpfsHash: 'QmMeta' }) })
      }),
    )
    const app = buildApp()
    const auth = await token(app)

    const response = await app.inject({
      method: 'POST',
      url: '/uploads/metadata',
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: 'Kyogre', description: 'A story', image: 'ipfs://QmCover', category: 'Games' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ cid: 'QmMeta' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.pinata.cloud/pinning/pinJSONToIPFS')
    const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>
    expect(body).toEqual({
      pinataContent: { name: 'Kyogre', description: 'A story', image: 'ipfs://QmCover', category: 'Games' },
      pinataMetadata: { name: 'Kyogre' },
    })
  })

  it('omits blank optional fields', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    const seen: { body?: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init: { body?: unknown }) => {
        seen.push({ body: init.body })
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ IpfsHash: 'QmMeta' }) })
      }),
    )
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads/metadata',
      headers: { authorization: `Bearer ${await token(app)}` },
      payload: { name: 'Kyogre', image: 'ipfs://QmCover' },
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(String(seen[0]?.body)) as Record<string, unknown>
    expect(body).toEqual({ pinataContent: { name: 'Kyogre', image: 'ipfs://QmCover' }, pinataMetadata: { name: 'Kyogre' } })
  })

  it('rejects unauthenticated uploads', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = buildApp()

    const response = await app.inject({ method: 'POST', url: '/uploads/metadata', payload: { name: 'Kyogre', image: 'ipfs://QmCover' } })

    expect(response.statusCode).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects missing names and images', async () => {
    const app = buildApp()
    const auth = await token(app)
    const headers = { authorization: `Bearer ${auth}` }

    const noName = await app.inject({ method: 'POST', url: '/uploads/metadata', headers, payload: { image: 'ipfs://QmCover' } })
    const noImage = await app.inject({ method: 'POST', url: '/uploads/metadata', headers, payload: { name: 'Kyogre' } })
    const blankImage = await app.inject({ method: 'POST', url: '/uploads/metadata', headers, payload: { name: 'Kyogre', image: '' } })
    const badCategory = await app.inject({
      method: 'POST',
      url: '/uploads/metadata',
      headers,
      payload: { name: 'Kyogre', image: 'ipfs://QmCover', category: 7 },
    })

    expect(noName.statusCode).toBe(400)
    expect(noImage.statusCode).toBe(400)
    expect(blankImage.statusCode).toBe(400)
    expect(badCategory.statusCode).toBe(400)
  })

  it('returns 502 when Pinata rejects the pin', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }))
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads/metadata',
      headers: { authorization: `Bearer ${await token(app)}` },
      payload: { name: 'Kyogre', image: 'ipfs://QmCover' },
    })

    expect(response.statusCode).toBe(502)
  })

  it('returns 502 when Pinata returns no CID', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }))
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads/metadata',
      headers: { authorization: `Bearer ${await token(app)}` },
      payload: { name: 'Kyogre', image: 'ipfs://QmCover' },
    })

    expect(response.statusCode).toBe(502)
  })

  it('returns 502 when the Pinata request fails', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads/metadata',
      headers: { authorization: `Bearer ${await token(app)}` },
      payload: { name: 'Kyogre', image: 'ipfs://QmCover' },
    })

    expect(response.statusCode).toBe(502)
  })

  it('returns 500 without PINATA_JWT', async () => {
    vi.stubEnv('PINATA_JWT', '')
    const pinOk = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ IpfsHash: 'QmMeta' }) })
    vi.stubGlobal('fetch', pinOk)
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads/metadata',
      headers: { authorization: `Bearer ${await token(app)}` },
      payload: { name: 'Kyogre', image: 'ipfs://QmCover' },
    })

    expect(response.statusCode).toBe(500)
  })
})
