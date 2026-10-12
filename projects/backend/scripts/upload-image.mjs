// Upload a cover image through POST /uploads and print the resulting CID.
//
// Usage (from projects/backend):
//   export $(node scripts/mint-token.mjs)
//   node scripts/upload-image.mjs path/to/cover.png
// Prints the CID, the `ipfs://` URI for the create form, and a gateway URL.
import { readFile } from 'node:fs/promises'

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

const base = process.env.BASE_URL ?? 'http://localhost:3001'
const token = process.env.TOKEN
const [file] = process.argv.slice(2)

if (!token) {
  console.error('TOKEN is not set: run `export $(node scripts/mint-token.mjs)` first.')
  process.exit(1)
}
if (!file) {
  console.error('usage: node scripts/upload-image.mjs <image>')
  process.exit(1)
}
const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
const contentType = IMAGE_TYPES[extension]
if (!contentType) {
  console.error(`unknown image extension "${extension}" (supported: ${Object.keys(IMAGE_TYPES).join(', ')})`)
  process.exit(1)
}

const response = await fetch(`${base}/uploads`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
  body: await readFile(file),
})
const json = await response.json()
if (!response.ok) {
  console.error(`upload -> ${response.status}: ${JSON.stringify(json)}`)
  process.exit(1)
}
console.log(`CID=${json.cid}`)
console.log(`URI=ipfs://${json.cid}`)
console.log(`GATEWAY=https://green-cooperative-koi-991.mypinata.cloud/ipfs/${json.cid}`)
