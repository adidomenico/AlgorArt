import algosdk from 'algosdk'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { SignJWT, jwtVerify } from 'jose'
import { createHash } from 'node:crypto'
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

/**
 * SHA-256 digest (ARC-60 signing input hashing).
 *
 * @param bytes Input bytes.
 * @returns The 32-byte digest.
 */
function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest()
}

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

function appDomain(): string {
  return process.env.APP_DOMAIN ?? 'localhost'
}

function appUri(): string {
  return process.env.APP_URI ?? 'http://localhost:5173'
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
 * The message carries the SIWE-style `Domain` and `URI` lines so the wallet shows the user which site they sign
 * into; verification rejects anything not bound to this deployment.
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
    `Domain: ${appDomain()}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date().toISOString()}`,
    `Expires: ${expiresAt.toISOString()}`,
    `URI: ${appUri()}`,
  ].join('\n')
  await pool().query('INSERT INTO auth_nonces (nonce, address, expires_at) VALUES ($1, $2, $3)', [nonce, address, expiresAt.toISOString()])
  return { message, nonce, expiresAt: expiresAt.toISOString() }
}

/**
 * Verify a wallet-signed challenge (ARC-60) and issue a session JWT. Nonces are single-use and expire after five
 * minutes. The wallet signs `sha256(message) || sha256(authenticatorData)` where the authenticator data is the
 * SHA-256 of this deployment's domain (see use-wallet's `createStdSignData`); rekeyed accounts are not supported,
 * the signature must come from the address key itself.
 *
 * @param address Claimed Algorand address.
 * @param message The exact challenge message that was signed.
 * @param authenticatorData Base64 ARC-60 authenticator data (SHA-256 of the domain).
 * @param signature Base64 signature over the ARC-60 signing input.
 * @returns Session JWT (Bearer token, seven days).
 */
export async function verifyChallenge(address: string, message: string, authenticatorData: string, signature: string): Promise<string> {
  const lines = message.split('\n')
  const field = (prefix: string): string | undefined => {
    const line = lines.find((candidate) => candidate.startsWith(prefix))
    return line?.slice(prefix.length).trim() || undefined
  }
  const nonce = field('Nonce: ')
  if (nonce === undefined) {
    throw new Error('malformed challenge message')
  }
  if (field('Domain: ') !== appDomain() || field('URI: ') !== appUri() || field('Address: ') !== address) {
    throw new Error('challenge is not bound to this deployment')
  }
  const found = await pool().query<{ address: string }>(
    'SELECT address FROM auth_nonces WHERE nonce = $1 AND address = $2 AND used_at IS NULL AND expires_at > now()',
    [nonce, address],
  )
  if (found.rows[0] === undefined) {
    throw new Error('invalid or expired challenge')
  }
  // ARC-60 binds the signature to the domain through the authenticator data's leading domain hash (extra trailing
  // fields are allowed by the standard, so only the prefix is compared).
  const authenticatorBytes = base64ToBytes(authenticatorData)
  const domainHash = sha256(new TextEncoder().encode(appDomain()))
  if (
    authenticatorBytes.length < domainHash.length ||
    !Buffer.from(authenticatorBytes.subarray(0, domainHash.length)).equals(Buffer.from(domainHash))
  ) {
    throw new Error('signature is not bound to this deployment')
  }
  const valid = nacl.sign.detached.verify(
    concatBytes(sha256(new TextEncoder().encode(message)), sha256(base64ToBytes(authenticatorData))),
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
