const PINATA_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS'

/** Pinning failed at the Pinata API (upstream fault) - maps to a 502. */
export class PinningError extends Error {}

function pinataJwt(): string {
  const jwt = process.env.PINATA_JWT
  if (!jwt) {
    throw new Error('PINATA_JWT is not set (see .env.template)')
  }
  return jwt
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
    const response = await fetch(PINATA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    })
    if (!response.ok) {
      throw new PinningError(`pinning failed with status ${String(response.status)}`)
    }
    const json: unknown = await response.json()
    const cid = typeof json === 'object' && json !== null && 'IpfsHash' in json ? json.IpfsHash : undefined
    if (typeof cid !== 'string' || cid === '') {
      throw new PinningError('pinning returned no CID')
    }
    return cid
  } catch (error) {
    if (error instanceof PinningError) throw error
    throw new PinningError('pinning request failed', { cause: error })
  }
}
