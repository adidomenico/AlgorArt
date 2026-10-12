import algosdk from 'algosdk'
import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'
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

async function token(app: FastifyInstance, address: string, sk: Uint8Array): Promise<string> {
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

describe('profiles', () => {
  afterEach(async () => {
    await pool().query('DELETE FROM profiles')
    await pool().query('DELETE FROM settings')
    await pool().query('DELETE FROM auth_nonces')
  })

  it('returns null fields for a fresh address with 404', async () => {
    const app = buildApp()

    const missing = await app.inject({ method: 'GET', url: '/profiles?address=SOMEADDRESS' })
    const noAddress = await app.inject({ method: 'GET', url: '/profiles' })

    expect(missing.statusCode).toBe(404)
    expect(noAddress.statusCode).toBe(400)
  })

  it('creates and reads a profile', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const auth = await token(app, address, sk)

    const put = await app.inject({
      method: 'PUT',
      url: '/profiles',
      headers: { authorization: `Bearer ${auth}` },
      payload: { display_name: 'Kyogre Fan', bio: 'Collector', avatar_cid: 'QmAvatar', email: 'kyogre@example.com' },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ address, display_name: 'Kyogre Fan', bio: 'Collector' })

    const get = await app.inject({ method: 'GET', url: `/profiles?address=${address}` })
    expect(get.statusCode).toBe(200)
    expect(get.json()).toMatchObject({ address, display_name: 'Kyogre Fan' })
  })

  it('partially updates and clears fields', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const headers = { authorization: `Bearer ${await token(app, address, sk)}` }

    await app.inject({ method: 'PUT', url: '/profiles', headers, payload: { display_name: 'Old', bio: 'Old bio' } })
    const updated = await app.inject({ method: 'PUT', url: '/profiles', headers, payload: { display_name: 'New', bio: null } })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ display_name: 'New', bio: null })
  })

  it('rejects empty and malformed profiles', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const headers = { authorization: `Bearer ${await token(app, address, sk)}` }

    const empty = await app.inject({ method: 'PUT', url: '/profiles', headers, payload: {} })
    const badType = await app.inject({ method: 'PUT', url: '/profiles', headers, payload: { display_name: 7 } })
    const tooLong = await app.inject({ method: 'PUT', url: '/profiles', headers, payload: { display_name: 'x'.repeat(65) } })
    const notObject = await app.inject({
      method: 'PUT',
      url: '/profiles',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '"nope"',
    })

    expect(empty.statusCode).toBe(400)
    expect(badType.statusCode).toBe(400)
    expect(tooLong.statusCode).toBe(400)
    expect(notObject.statusCode).toBe(400)
  })

  it('rejects unauthenticated writes', async () => {
    const app = buildApp()

    const put = await app.inject({ method: 'PUT', url: '/profiles', payload: { display_name: 'Ghost' } })
    const settings = await app.inject({ method: 'PUT', url: '/settings', payload: { theme: 'dark' } })

    expect(put.statusCode).toBe(401)
    expect(settings.statusCode).toBe(401)
  })
})

describe('settings', () => {
  afterEach(async () => {
    await pool().query('DELETE FROM profiles')
    await pool().query('DELETE FROM settings')
    await pool().query('DELETE FROM auth_nonces')
  })

  it('serves defaults before anything is saved', async () => {
    const app = buildApp()
    const { address, sk } = keypair()

    const response = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${await token(app, address, sk)}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ address, notify_funded: true, notify_failed: true, theme: 'system' })
  })

  it('saves and reads settings', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const headers = { authorization: `Bearer ${await token(app, address, sk)}` }

    const put = await app.inject({ method: 'PUT', url: '/settings', headers, payload: { notify_funded: false, theme: 'dark' } })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ notify_funded: false, notify_failed: true, theme: 'dark' })

    const get = await app.inject({ method: 'GET', url: '/settings', headers })
    expect(get.json()).toMatchObject({ notify_funded: false, theme: 'dark' })
  })

  it('rejects empty and malformed settings', async () => {
    const app = buildApp()
    const { address, sk } = keypair()
    const headers = { authorization: `Bearer ${await token(app, address, sk)}` }

    const empty = await app.inject({ method: 'PUT', url: '/settings', headers, payload: {} })
    const badBool = await app.inject({ method: 'PUT', url: '/settings', headers, payload: { notify_funded: 'yes' } })
    const badBool2 = await app.inject({ method: 'PUT', url: '/settings', headers, payload: { notify_failed: 0 } })
    const badTheme = await app.inject({ method: 'PUT', url: '/settings', headers, payload: { theme: 'neon' } })
    const notObject = await app.inject({
      method: 'PUT',
      url: '/settings',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '"nope"',
    })

    expect(empty.statusCode).toBe(400)
    expect(badBool.statusCode).toBe(400)
    expect(badBool2.statusCode).toBe(400)
    expect(badTheme.statusCode).toBe(400)
    expect(notObject.statusCode).toBe(400)
  })
})
