const PINATA_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
const PINATA_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS'

/** Pinning failed at the Pinata API (upstream fault) - maps to a 502. */
export class PinningError extends Error {}

function pinataJwt(): string {
  const jwt = process.env.PINATA_JWT
  if (!jwt) {
    throw new Error('PINATA_JWT is not set (see .env.template)')
  }
  return jwt
}

function extractCid(json: unknown): string {
  const cid = typeof json === 'object' && json !== null && 'IpfsHash' in json ? json.IpfsHash : undefined
  if (typeof cid !== 'string' || cid === '') {
    throw new PinningError('pinning returned no CID')
  }
  return cid
}

/**
 * Pin raw image bytes to IPFS via Pinata.
 *
 * @param bytes Image bytes.
 * @param contentType Image MIME type (for example `image/png`).
 * @returns The IPFS CID of the pinned file.
 */
export async function pinImage(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<string> {
  const jwt = pinataJwt()
  try {
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: contentType }), 'upload')
    const response = await fetch(PINATA_FILE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    })
    if (!response.ok) {
      throw new PinningError(`pinning failed with status ${String(response.status)}`)
    }
    return extractCid(await response.json())
  } catch (error) {
    if (error instanceof PinningError) throw error
    throw new PinningError('pinning request failed', { cause: error })
  }
}

/**
 * Pin a metadata JSON blob to IPFS via Pinata.
 *
 * @param metadata String fields to pin (`name` and `image` required, the rest optional).
 * @returns The IPFS CID of the pinned blob.
 */
export async function pinJson(metadata: Record<string, string>): Promise<string> {
  const jwt = pinataJwt()
  try {
    const response = await fetch(PINATA_JSON_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pinataContent: metadata }),
    })
    if (!response.ok) {
      throw new PinningError(`pinning failed with status ${String(response.status)}`)
    }
    return extractCid(await response.json())
  } catch (error) {
    if (error instanceof PinningError) throw error
    throw new PinningError('pinning request failed', { cause: error })
  }
}
