// Mint a throwaway session token for manual API testing (no wallet needed).
//
// Usage (from projects/backend):
//   export $(node scripts/mint-token.mjs)
//   curl http://localhost:3001/me -H "Authorization: Bearer $TOKEN"
import algosdk from 'algosdk'

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

const account = algosdk.generateAccount()
const address = account.addr.toString()
const challenge = await post('/auth/challenge', { address })
const signature = Buffer.from(algosdk.signBytes(new TextEncoder().encode(challenge.message), account.sk)).toString('base64')
const verified = await post('/auth/verify', { address, message: challenge.message, signature })

// KEY=value so callers can `export $(node scripts/mint-token.mjs)`.
console.log(`TOKEN=${verified.token}`)
