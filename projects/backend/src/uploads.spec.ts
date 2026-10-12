import algosdk from 'algosdk'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { pool } from './db.js'

function keypair(): { address: string; sk: Uint8Array } {
  const account = algosdk.generateAccount()
  return { address: account.addr.toString(), sk: account.sk }
}

function sign(message: string, sk: Uint8Array): string {
  const signature = algosdk.signBytes(new TextEncoder().encode(message), sk)
  return btoa(String.fromCharCode(...signature))
}

async function token(app: FastifyInstance): Promise<string> {
  const { address, sk } = keypair()
  const challenge = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address } })
  const { message } = challenge.json<{ message: string }>()
  const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address, message, signature: sign(message, sk) } })
  return verified.json<{ token: string }>().token
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pinOk(cid: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ IpfsHash: cid }) }))
}

describe('POST /uploads', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await pool().query('DELETE FROM auth_nonces')
  })

  it('pins an image and returns the CID', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    const seen: { url: unknown; init: { method?: unknown; headers?: unknown; body?: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown, init: { method?: unknown; headers?: unknown; body?: unknown }) => {
        seen.push({ url, init })
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ IpfsHash: 'QmTestCid' }) })
      }),
    )
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${await token(app)}`, 'content-type': 'image/png' },
      payload: PNG_BYTES,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ cid: 'QmTestCid' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.pinata.cloud/pinning/pinFileToIPFS')
    expect(seen[0]?.init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer test-jwt' } })
    expect(seen[0]?.init.body).toBeInstanceOf(FormData)
  })

  it('rejects unauthenticated uploads', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = buildApp()

    const response = await app.inject({ method: 'POST', url: '/uploads', headers: { 'content-type': 'image/png' }, payload: PNG_BYTES })

    expect(response.statusCode).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects non-image bodies', async () => {
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${await token(app)}` },
      payload: { not: 'an image' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 502 when Pinata rejects the pin', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }))
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${await token(app)}`, 'content-type': 'image/png' },
      payload: PNG_BYTES,
    })

    expect(response.statusCode).toBe(502)
  })

  it('returns 502 when Pinata returns no CID', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ IpfsHash: '' }) })
    vi.stubGlobal('fetch', fetchMock)
    const app = buildApp()
    const headers = { authorization: `Bearer ${await token(app)}`, 'content-type': 'image/png' }

    const missing = await app.inject({ method: 'POST', url: '/uploads', headers, payload: PNG_BYTES })
    const empty = await app.inject({ method: 'POST', url: '/uploads', headers, payload: PNG_BYTES })

    expect(missing.statusCode).toBe(502)
    expect(empty.statusCode).toBe(502)
  })

  it('returns 502 when the Pinata request fails', async () => {
    vi.stubEnv('PINATA_JWT', 'test-jwt')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${await token(app)}`, 'content-type': 'image/png' },
      payload: PNG_BYTES,
    })

    expect(response.statusCode).toBe(502)
  })

  it('returns 500 without PINATA_JWT', async () => {
    vi.stubEnv('PINATA_JWT', '')
    pinOk('QmTestCid')
    const app = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${await token(app)}`, 'content-type': 'image/png' },
      payload: PNG_BYTES,
    })

    expect(response.statusCode).toBe(500)
  })
})
