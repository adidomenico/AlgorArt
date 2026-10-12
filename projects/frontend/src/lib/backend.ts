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
  sign: (message: string) => Promise<Uint8Array>
  file: File
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

function challengeMessage(json: unknown): string {
  if (!isRecord(json) || typeof json.message !== 'string' || json.message === '') {
    throw new Error('Could not start the upload. Try again.')
  }
  return json.message
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
 * Pin a cover image through the backend: sign-in challenge, wallet signature, session verify, then upload.
 *
 * Signing support is probed by attempting it: wallets without message signing
 * reject, and the rejection propagates to the caller as the user-facing message.
 *
 * @param upload Upload inputs.
 * @param upload.baseUrl Backend base URL.
 * @param upload.address Signer address for the challenge.
 * @param upload.sign Wallet message signer, returning the raw signature bytes.
 * @param upload.file Image file to pin.
 * @returns The `ipfs://` URI to store as the campaign metadata URI.
 */
export async function uploadCover({ baseUrl, address, sign, file }: CoverUpload): Promise<string> {
  if (baseUrl === '') throw new Error('Image upload needs the backend configured (VITE_BACKEND_URL).')

  const challenge = await postJson(`${baseUrl}/auth/challenge`, { address })
  if (challenge.status !== 200) throw new Error('Could not start the upload. Is the backend reachable?')
  const message = challengeMessage(challenge.json)

  const signature = await sign(message)
  const verified = await postJson(`${baseUrl}/auth/verify`, {
    address,
    message,
    signature: btoa(String.fromCharCode(...signature)),
  })
  if (verified.status !== 200) throw new Error('Sign-in failed. Try again.')
  const token = sessionToken(verified.json)

  let upload: Response
  try {
    upload = await fetch(`${baseUrl}/uploads`, {
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
