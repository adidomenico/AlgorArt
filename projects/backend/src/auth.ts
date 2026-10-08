import algosdk from 'algosdk'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { SignJWT, jwtVerify } from 'jose'
import nacl from 'tweetnacl'
import { pool } from './db.js'

declare module 'fastify' {
  interface FastifyRequest {
    address?: string | undefined
  }
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const TOKEN_TTL = '7d'
const TOKEN_ISSUER = 'algorart'

/** A sign-in challenge for one address. */
export interface Challenge {
  message: string
  nonce: string
  expiresAt: string
}

/**
 * Concat two byte arrays (tweetnacl works on plain Uint8Arrays in every realm).
 *
 * @param first First bytes.
 * @param second Second bytes.
 * @returns Concatenated bytes.
 */
function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length)
  out.set(first)
  out.set(second, first.length)
  return out
}

// Domain-separation prefix that signing prepends ("MX"), mirroring algosdk.
const SIGN_BYTES_PREFIX = Uint8Array.from([77, 88])

/**
 * Decode base64 to bytes (atob/btoa work in every runtime, unlike Node's Buffer).
 *
 * @param base64 Base64 input.
 * @returns Decoded bytes.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function sessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET is not set (see .env.template)')
  }
  return new TextEncoder().encode(secret)
}

/**
 * Issue a single-use sign-in challenge for an address. The wallet signs `message`; `verifyChallenge` checks it.
 *
 * @param address Algorand address to challenge.
 * @returns The challenge message, nonce, and expiry.
 */
export async function createChallenge(address: string): Promise<Challenge> {
  const nonceBytes = new Uint8Array(16)
  crypto.getRandomValues(nonceBytes)
  const nonce = Buffer.from(nonceBytes).toString('hex')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
  const message = [
    'AlgorArt sign-in',
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date().toISOString()}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join('\n')
  await pool().query('INSERT INTO auth_nonces (nonce, address, expires_at) VALUES ($1, $2, $3)', [nonce, address, expiresAt.toISOString()])
  return { message, nonce, expiresAt: expiresAt.toISOString() }
}

/**
 * Verify a signed challenge and issue a session JWT. Nonces are single-use and expire after five minutes.
 *
 * @param address Claimed Algorand address.
 * @param message The exact challenge message that was signed.
 * @param signature Base64 signature over the message bytes.
 * @returns Session JWT (Bearer token, seven days).
 */
export async function verifyChallenge(address: string, message: string, signature: string): Promise<string> {
  const nonce = message
    .split('\n')
    .find((line) => line.startsWith('Nonce: '))
    ?.slice('Nonce: '.length)
    .trim()
  if (!nonce) {
    throw new Error('malformed challenge message')
  }
  const found = await pool().query<{ address: string }>(
    'SELECT address FROM auth_nonces WHERE nonce = $1 AND address = $2 AND used_at IS NULL AND expires_at > now()',
    [nonce, address],
  )
  if (found.rows[0] === undefined) {
    throw new Error('invalid or expired challenge')
  }
  const valid = nacl.sign.detached.verify(
    concatBytes(SIGN_BYTES_PREFIX, new TextEncoder().encode(message)),
    base64ToBytes(signature),
    algosdk.decodeAddress(address).publicKey,
  )
  if (!valid) {
    throw new Error('invalid signature')
  }
  await pool().query('UPDATE auth_nonces SET used_at = now() WHERE nonce = $1', [nonce])
  return new SignJWT({ address })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .setIssuer(TOKEN_ISSUER)
    .sign(sessionSecret())
}

/**
 * Fastify pre-handler: accepts a valid session JWT and sets `request.address`, else 401.
 *
 * @param request Incoming request.
 * @param reply Outgoing reply.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  const token = header !== undefined && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
  if (token === undefined) {
    await reply.code(401).send({ error: 'missing token' })
    return
  }
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), { issuer: TOKEN_ISSUER })
    if (typeof payload.address !== 'string' || payload.address === '') {
      throw new Error('token has no address')
    }
    request.address = payload.address
  } catch {
    await reply.code(401).send({ error: 'invalid token' })
  }
}
