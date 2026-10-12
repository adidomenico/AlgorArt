// Mint a throwaway session token for manual API testing (no wallet needed).
//
// Usage (from projects/backend):
//   export $(node scripts/mint-token.mjs)
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
// ARC-60 signing input: sha256(message) || sha256(authenticatorData).
const domain = challenge.message
  .split('\n')
  .find((line) => line.startsWith('Domain: '))
  .slice('Domain: '.length)
  .trim()
const authenticatorData = createHash('sha256').update(domain).digest()
const toSign = Buffer.concat([
  createHash('sha256').update(challenge.message).digest(),
  createHash('sha256').update(authenticatorData).digest(),
])
const verified = await post('/auth/verify', {
  address,
  message: challenge.message,
  authenticatorData: bytesToBase64(authenticatorData),
  signature: bytesToBase64(nacl.sign.detached(toSign, account.sk)),
})

// KEY=value so callers can `export $(node scripts/mint-token.mjs)`.
console.log(`TOKEN=${verified.token}`)
