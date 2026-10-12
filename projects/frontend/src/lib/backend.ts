import { canonify } from 'canonify'

/**
 * Backend (catalog) API client: wallet sign-in plus cover-image upload.
 *
 * The backend is optional - the dApp runs without it. Every function here takes its inputs explicitly and throws an
 * `Error` carrying a user-facing message on any failure, so callers only need one catch.
 */

/**
 * The backend base URL, or empty when not configured (uploads stay unavailable).
 *
 * @returns The `VITE_BACKEND_URL` value, or an empty string.
 */
export function backendUrl(): string {
  const env: Record<string, string | undefined> = {
    // Browser-only builds have no process object; vitest always runs under node.
    /* v8 ignore next */
    ...(typeof process === 'undefined' ? {} : process.env),
    ...import.meta.env,
  }
  return env.VITE_BACKEND_URL ?? ''
}

/** Inputs for a cover-image upload (see `uploadCover`). */
export interface CoverUpload {
  baseUrl: string
  address: string
  chainId: string | undefined
  sign: (payload: string) => Promise<{ signature: Uint8Array; authenticatorData: Uint8Array }>
  file: File
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    return { status: 0, json: null }
  }
  return { status: response.status, json: await readJson(response) }
}

function challengeNonce(json: unknown, action: string): string {
  if (!isRecord(json) || typeof json.nonce !== 'string' || json.nonce === '') {
    throw new Error(`Could not start the ${action}. Try again.`)
  }
  return json.nonce
}

function sessionToken(json: unknown): string {
  if (!isRecord(json) || typeof json.token !== 'string' || json.token === '') {
    throw new Error('Sign-in failed. Try again.')
  }
  return json.token
}

function pinnedCid(json: unknown): string {
  if (!isRecord(json) || typeof json.cid !== 'string' || json.cid === '') {
    throw new Error('Pinning failed. Try again.')
  }
  return json.cid
}

/**
 * Pin a cover image through the backend: sign-in challenge, ARC-60 wallet signature over a SIWA request carrying
 * the nonce, session verify, then upload.
 *
 * Signing support is probed by attempting it: wallets without message signing
 * reject, and the rejection propagates to the caller as the user-facing message.
 *
 * @param upload Upload inputs.
 * @param upload.baseUrl Backend base URL.
 * @param upload.address Signer address for the challenge.
 * @param upload.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param upload.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param upload.file Image file to pin.
 * @returns The `ipfs://` URI to store as the campaign metadata URI.
 */
export async function uploadCover({ baseUrl, address, chainId, sign, file }: CoverUpload): Promise<string> {
  if (baseUrl === '') throw new Error('Image upload needs the backend configured (VITE_BACKEND_URL).')

  const challenge = await postJson(`${baseUrl}/auth/challenge`, { address })
  if (challenge.status !== 200) throw new Error('Could not start the upload. Is the backend reachable?')
  const nonce = challengeNonce(challenge.json, 'upload')

  // The wallet requires canonical SIWA JSON; canonify of this plain object cannot fail.
  const data = canonify({
    domain: location.host,
    chain_id: chainId ?? 'algorand:localnet',
    account_address: address,
    type: 'ed25519',
    uri: location.origin,
    version: '1',
    statement: 'Sign in to AlgorArt to upload a cover image.',
    nonce,
    'issued-at': new Date().toISOString(),
  }) as string
  const { signature, authenticatorData } = await sign(btoa(data))
  const verified = await postJson(`${baseUrl}/auth/verify`, {
    address,
    data,
    authenticatorData: bytesToBase64(authenticatorData),
    signature: bytesToBase64(signature),
  })
  if (verified.status !== 200) throw new Error('Sign-in failed. Try again.')
  const token = sessionToken(verified.json)

  let upload: Response
  try {
    upload = await fetch(`${baseUrl}/uploads?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': file.type },
      body: file,
    })
  } catch {
    throw new Error('Pinning failed. Is the backend reachable?')
  }
  if (upload.status !== 200) throw new Error('Pinning failed. Try again.')
  return `ipfs://${pinnedCid(await readJson(upload))}`
}

/** Inputs for a metadata-blob upload (see `uploadMetadata`). */
export interface MetadataUpload {
  baseUrl: string
  address: string
  chainId: string | undefined
  sign: (payload: string) => Promise<{ signature: Uint8Array; authenticatorData: Uint8Array }>
  name: string
  description: string
  image: string
  category: string
}

/**
 * Pin a campaign metadata blob through the backend: sign-in challenge, ARC-60 wallet signature, session verify,
 * then upload. Blank optional fields are omitted from the pinned blob.
 *
 * @param upload Upload inputs.
 * @param upload.baseUrl Backend base URL.
 * @param upload.address Signer address for the challenge.
 * @param upload.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param upload.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param upload.name Campaign title.
 * @param upload.description Campaign description, omitted when blank.
 * @param upload.image Cover image URI.
 * @param upload.category Campaign category, omitted when blank.
 * @returns The `ipfs://` URI to store as the campaign metadata URI.
 */
export async function uploadMetadata({
  baseUrl,
  address,
  chainId,
  sign,
  name,
  description,
  image,
  category,
}: MetadataUpload): Promise<string> {
  if (baseUrl === '') throw new Error('Metadata upload needs the backend configured (VITE_BACKEND_URL).')

  const challenge = await postJson(`${baseUrl}/auth/challenge`, { address })
  if (challenge.status !== 200) throw new Error('Could not start the metadata upload. Is the backend reachable?')
  const nonce = challengeNonce(challenge.json, 'metadata upload')

  // The wallet requires canonical SIWA JSON; canonify of this plain object cannot fail.
  const data = canonify({
    domain: location.host,
    chain_id: chainId ?? 'algorand:localnet',
    account_address: address,
    type: 'ed25519',
    uri: location.origin,
    version: '1',
    statement: 'Sign in to AlgorArt to upload campaign metadata.',
    nonce,
    'issued-at': new Date().toISOString(),
  }) as string
  const { signature, authenticatorData } = await sign(btoa(data))
  const verified = await postJson(`${baseUrl}/auth/verify`, {
    address,
    data,
    authenticatorData: bytesToBase64(authenticatorData),
    signature: bytesToBase64(signature),
  })
  if (verified.status !== 200) throw new Error('Sign-in failed. Try again.')
  const token = sessionToken(verified.json)

  const metadata: Record<string, string> = { name, image }
  if (description !== '') metadata.description = description
  if (category !== '') metadata.category = category
  let upload: Response
  try {
    upload = await fetch(`${baseUrl}/uploads/metadata`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(metadata),
    })
  } catch {
    throw new Error('Metadata pinning failed. Is the backend reachable?')
  }
  if (upload.status !== 200) throw new Error('Metadata pinning failed. Try again.')
  return `ipfs://${pinnedCid(await readJson(upload))}`
}
