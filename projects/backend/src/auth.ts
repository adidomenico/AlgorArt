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
const TOKEN_ISSUER = 'kasakame'

/** A sign-in challenge for one address: the client embeds the nonce in its SIWA request. */
export interface Challenge {
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
 * Narrow an unknown value to a string-keyed record.
 *
 * @param value Value to check.
 * @returns True for non-null objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
  const domain = process.env.APP_DOMAIN
  if (!domain) {
    throw new Error('APP_DOMAIN is not set (see .env.template)')
  }
  return domain
}

function appUri(): string {
  const uri = process.env.APP_URI
  if (!uri) {
    throw new Error('APP_URI is not set (see .env.template)')
  }
  return uri
}

function sessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET is not set (see .env.template)')
  }
  return new TextEncoder().encode(secret)
}

/**
 * Issue a single-use sign-in nonce for an address. The client embeds it in a SIWA request object that the wallet
 * signs; `verifyChallenge` checks the signature and the binding.
 *
 * @param address Algorand address to challenge.
 * @returns The nonce and expiry.
 */
export async function createChallenge(address: string): Promise<Challenge> {
  const nonceBytes = new Uint8Array(16)
  crypto.getRandomValues(nonceBytes)
  const nonce = Buffer.from(nonceBytes).toString('hex')
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
  await pool().query('INSERT INTO auth_nonces (nonce, address, expires_at) VALUES ($1, $2, $3)', [nonce, address, expiresAt.toISOString()])
  return { nonce, expiresAt: expiresAt.toISOString() }
}

/**
 * The exact note a login payment must carry: binds this deployment's domain to a live challenge nonce. The
 * frontend builds the identical string (see `loginNote` in the frontend's `lib/backend.ts`).
 *
 * @param domain Deployment domain (matches `APP_DOMAIN`).
 * @param nonce Live challenge nonce for the address.
 * @returns The note text.
 */
export function loginNote(domain: string, nonce: string): string {
  return `kasakame login ${domain} ${nonce}`
}

/**
 * Decode a signed login payment and check its shape: a single-key-signed zero self-payment with no close-out
 * and no rekey. Address, nonce, and signature checks live in `verifyTransactionChallenge`, so this stays pure
 * (no DB, no env) and unit-verifiable.
 *
 * @param signedTxn Base64 signed transaction bytes.
 * @returns The decoded payment and its signature.
 */
export function decodeLoginPayment(signedTxn: string): { txn: algosdk.Transaction; sig: Uint8Array } {
  let decoded: algosdk.SignedTransaction
  try {
    decoded = algosdk.decodeSignedTransaction(base64ToBytes(signedTxn))
  } catch {
    throw new Error('malformed signed transaction')
  }
  const { txn, sig, msig, lsig, sgnr } = decoded
  if (sig === undefined) {
    throw new Error('expected a single key signature')
  }
  if ([msig, lsig, sgnr].some((part) => part !== undefined)) {
    throw new Error('expected a single key signature')
  }
  const payment = txn.payment
  if (payment === undefined || payment.receiver.toString() !== txn.sender.toString()) {
    throw new Error('expected a self payment')
  }
  if (payment.amount !== BigInt(0)) {
    throw new Error('expected a zero payment')
  }
  if (payment.closeRemainderTo !== undefined || txn.rekeyTo !== undefined) {
    throw new Error('close-out and rekey are not allowed')
  }
  return { txn, sig }
}

/**
 * Issue a session JWT for an address. Single place minting tokens for both proof paths.
 *
 * @param address Verified Algorand address.
 * @returns Session JWT (Bearer token, seven days).
 */
function issueSessionToken(address: string): Promise<string> {
  return new SignJWT({ address })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .setIssuer(TOKEN_ISSUER)
    .sign(sessionSecret())
}

/**
 * Verify a wallet-signed SIWA request (ARC-60) and issue a session JWT. Nonces are single-use and expire after five
 * minutes. The wallet signs `sha256(data) || sha256(authenticatorData)` where the authenticator data starts with
 * the SHA-256 of this deployment's domain (see use-wallet's `createStdSignData`); rekeyed accounts are not
 * supported, the signature must come from the address key itself. `chain_id` is informational: the nonce anchors
 * replay protection.
 *
 * @param address Claimed Algorand address.
 * @param data The exact canonified SIWA JSON string that was signed.
 * @param authenticatorData Base64 ARC-60 authenticator data.
 * @param signature Base64 signature over the ARC-60 signing input.
 * @returns Session JWT (Bearer token, seven days).
 */
export async function verifyChallenge(address: string, data: string, authenticatorData: string, signature: string): Promise<string> {
  let siwa: unknown
  try {
    siwa = JSON.parse(data) as unknown
  } catch {
    throw new Error('malformed SIWA request')
  }
  if (!isRecord(siwa)) {
    throw new Error('malformed SIWA request')
  }
  const { domain, uri, account_address, type, version, nonce } = siwa
  if (typeof nonce !== 'string' || nonce === '') {
    throw new Error('malformed SIWA request')
  }
  if (domain !== appDomain() || uri !== appUri() || account_address !== address || type !== 'ed25519' || version !== '1') {
    throw new Error('SIWA request is not bound to this deployment')
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
    concatBytes(sha256(new TextEncoder().encode(data)), sha256(base64ToBytes(authenticatorData))),
    base64ToBytes(signature),
    algosdk.decodeAddress(address).publicKey,
  )
  if (!valid) {
    throw new Error('invalid signature')
  }
  await pool().query('UPDATE auth_nonces SET used_at = now() WHERE nonce = $1', [nonce])
  return issueSessionToken(address)
}

/**
 * Verify a wallet-signed zero self-payment login and issue a session JWT. The universal fallback for wallets
 * without message signing (Defly, Exodus): every wallet signs transactions. The payment is never broadcast -
 * it only carries the challenge nonce in its note - so no fee is paid and nothing lands on-chain. Nonces are
 * single-use and expire after five minutes; rekeyed accounts are not supported, like the ARC-60 path.
 *
 * @param address Claimed Algorand address.
 * @param signedTxn Base64 signed payment bytes (sender and receiver are the address, amount zero).
 * @returns Session JWT (Bearer token, seven days).
 */
export async function verifyTransactionChallenge(address: string, signedTxn: string): Promise<string> {
  const { txn, sig } = decodeLoginPayment(signedTxn)
  if (txn.sender.toString() !== address) {
    throw new Error('transaction is not from the claimed address')
  }
  const note = Buffer.from(txn.note).toString('utf8')
  const domain = appDomain()
  const live = (
    await pool().query<{ nonce: string }>('SELECT nonce FROM auth_nonces WHERE address = $1 AND used_at IS NULL AND expires_at > now()', [
      address,
    ])
  ).rows.map((row) => row.nonce)
  const nonce = live.find((candidate) => note === loginNote(domain, candidate))
  if (nonce === undefined) {
    throw new Error('invalid or expired challenge')
  }
  const valid = nacl.sign.detached.verify(txn.bytesToSign(), sig, algosdk.decodeAddress(address).publicKey)
  if (!valid) {
    throw new Error('invalid signature')
  }
  await pool().query('UPDATE auth_nonces SET used_at = now() WHERE nonce = $1', [nonce])
  return issueSessionToken(address)
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
