// Mint a throwaway session token for manual API testing (no wallet needed).
//
// Usage (from projects/backend):
//   export $(node --env-file=.env scripts/mint-token.mjs)
//   curl http://localhost:3001/me -H "Authorization: Bearer $TOKEN"
import algosdk from 'algosdk'
import { createHash } from 'node:crypto'
import nacl from 'tweetnacl'

const base = process.env.BASE_URL ?? 'http://localhost:3001'

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${JSON.stringify(json)}`)
  return json
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

const account = algosdk.generateAccount()
const address = account.addr.toString()
const challenge = await post('/auth/challenge', { address })
// SIWA request carrying the challenge nonce; the wallet would canonify it, but the backend hashes the exact bytes
// it receives, so plain JSON is enough here.
const domain = process.env.APP_DOMAIN ?? 'localhost'
const uri = process.env.APP_URI ?? 'http://localhost:5173'
const data = JSON.stringify({
  domain,
  account_address: address,
  type: 'ed25519',
  uri,
  version: '1',
  statement: 'manual API testing',
  nonce: challenge.nonce,
  'issued-at': new Date().toISOString(),
})
// ARC-60 signing input: sha256(data) || sha256(authenticatorData).
const authenticatorData = createHash('sha256').update(domain).digest()
const toSign = Buffer.concat([createHash('sha256').update(data).digest(), createHash('sha256').update(authenticatorData).digest()])
const verified = await post('/auth/verify', {
  address,
  data,
  authenticatorData: bytesToBase64(authenticatorData),
  signature: bytesToBase64(nacl.sign.detached(toSign, account.sk)),
})

// KEY=value so callers can `export $(node scripts/mint-token.mjs)`.
console.log(`TOKEN=${verified.token}`)
