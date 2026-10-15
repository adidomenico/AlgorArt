import type { StdSignDataResponse, StdSignMetadata } from '@txnlab/use-wallet'
import { ScopeType } from '@txnlab/use-wallet'
import type { useWallet } from '@txnlab/use-wallet-react'
import algosdk from 'algosdk'
import { canonify } from 'canonify'
import { algorand } from './algorand'

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
  /** Transaction signer for wallets without message signing (universal sign-in fallback). */
  signTxn?: SignTxn | undefined
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
 * Adapt the wallet `signData` hook to the raw-bytes signer the upload flows take. Single place defining the ARC-60
 * call shape.
 *
 * @param signData Wallet `signData` hook.
 * @returns Signer taking the base64 SIWA payload.
 */
export function adaptSignData(
  signData: (data: string, metadata: StdSignMetadata) => Promise<StdSignDataResponse>,
): (payload: string) => Promise<{ signature: Uint8Array; authenticatorData: Uint8Array }> {
  return (payload) =>
    signData(payload, { encoding: 'base64', scope: ScopeType.AUTH }).then((result) => ({
      signature: result.signature,
      authenticatorData: result.authenticatorData,
    }))
}

/** Transaction signer for wallets without message signing (universal sign-in fallback). */
export type SignTxn = (unsignedTxn: Uint8Array) => Promise<Uint8Array>

/** Inputs for a wallet sign-in (see `signIn`). */
export interface SignIn {
  baseUrl: string
  address: string
  chainId: string | undefined
  sign: (payload: string) => Promise<{ signature: Uint8Array; authenticatorData: Uint8Array }>
  /** Transaction signer for wallets without message signing (universal fallback, see `signInWithTransaction`). */
  signTxn?: SignTxn | undefined
  statement: string
  action: string
  /** Suggested-params source for the transaction fallback (live algod values by default; injectable for tests). */
  getParams?: (() => Promise<algosdk.SuggestedParams>) | undefined
}

/** Wallet `signTransactions` hook shape, for `adaptSignTransaction` (type-only: erased at runtime). */
type WalletSignTransactions = ReturnType<typeof useWallet>['signTransactions']

/**
 * Adapt the wallet `signTransactions` hook to the signed-bytes signer the transaction proof takes. Single place
 * defining the call shape: one unsigned transaction in, its signed bytes out. Never broadcasts.
 *
 * @param signTransactions Wallet `signTransactions` hook.
 * @returns Signer returning the signed transaction bytes.
 */
export function adaptSignTransaction(signTransactions: WalletSignTransactions): (unsignedTxn: Uint8Array) => Promise<Uint8Array> {
  return async (unsignedTxn) => {
    const [signed] = await signTransactions([unsignedTxn], [0])
    if (!(signed instanceof Uint8Array) || signed.length === 0) {
      throw new Error('Sign-in failed. Try again.')
    }
    return signed
  }
}

let cachedSession: { address: string; token: string } | null = null

/** Clear the cached session token (wallet disconnect; tests). */
export function clearSession(): void {
  cachedSession = null
}

/**
 * Sign in with the wallet: challenge, ARC-60 signature over the SIWA request, verify.
 *
 * @param input Sign-in inputs.
 * @param input.baseUrl Backend base URL.
 * @param input.address Signer address for the challenge.
 * @param input.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param input.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param input.statement SIWA statement shown in the wallet.
 * @param input.action Action noun for user-facing messages.
 * @returns The session JWT.
 */
export async function signIn({ baseUrl, address, chainId, sign, statement, action }: SignIn): Promise<string> {
  const challenge = await postJson(`${baseUrl}/auth/challenge`, { address })
  if (challenge.status !== 200) throw new Error(`Could not start the ${action}. Is the backend reachable?`)
  const nonce = challengeNonce(challenge.json, action)

  // The wallet requires canonical SIWA JSON; canonify of this plain object cannot fail.
  const data = canonify({
    domain: location.host,
    chain_id: chainId ?? 'algorand:localnet',
    account_address: address,
    type: 'ed25519',
    uri: location.origin,
    version: '1',
    statement,
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
  return sessionToken(verified.json)
}

/**
 * The cached session token, signing in on first use per address. One popup per address per session, shared by
 * every upload. Keyed by address so switching wallets never reuses the previous account's token. Tries ARC-60
 * first (the proven path); wallets without message signing fail that call fast without opening a popup and fall
 * back to the universal transaction proof. Dismissals and real errors rethrow untouched - no second popup.
 *
 * @param input Sign-in inputs.
 * @returns The session JWT.
 */
export async function ensureSession(input: SignIn): Promise<string> {
  if (cachedSession !== null && cachedSession.address === input.address) return cachedSession.token
  const token = await signInWithFallback(input)
  cachedSession = { address: input.address, token }
  return token
}

const CAPABILITY_PATTERN = /method not supported/i

async function signInWithFallback(input: SignIn): Promise<string> {
  try {
    return await signIn(input)
  } catch (error) {
    if (input.signTxn === undefined || !isCapabilityError(error)) throw error
    return await signInWithTransaction({
      baseUrl: input.baseUrl,
      address: input.address,
      signTxn: input.signTxn,
      action: input.action,
      getParams: input.getParams,
    })
  }
}

function isCapabilityError(error: unknown): boolean {
  return error instanceof Error && CAPABILITY_PATTERN.test(error.message)
}

/**
 * UTF-8 bytes owned by this realm (globals like `TextEncoder` can come from another realm, whose instances fail
 * the SDK's `instanceof Uint8Array` checks).
 *
 * @param text Text to encode.
 * @returns The bytes.
 */
function utf8Bytes(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text)
  const bytes = new Uint8Array(encoded.length)
  bytes.set(encoded)
  return bytes
}

/** Inputs for a transaction-signature sign-in (see `signInWithTransaction`). */
export interface TxnSignIn {
  baseUrl: string
  address: string
  signTxn: SignTxn
  action: string
  /** Suggested-params source (live algod values by default; injectable for tests). */
  getParams?: (() => Promise<algosdk.SuggestedParams>) | undefined
}

/**
 * Sign in with a zero self-payment: the wallet signs (never broadcasts) a payment carrying the challenge nonce
 * in its note, and the backend verifies the signature against the challenge. Works on every wallet - the
 * fallback for missing `signData`.
 *
 * @param input Sign-in inputs.
 * @param input.baseUrl Backend base URL.
 * @param input.address Signer address for the challenge.
 * @param input.signTxn Transaction signer (receives the unsigned payment bytes), returning signed bytes.
 * @param input.action Action noun for user-facing messages.
 * @param input.getParams Suggested-params source (live algod values by default; injectable for tests).
 * @returns The session JWT.
 */
export async function signInWithTransaction({ baseUrl, address, signTxn, action, getParams }: TxnSignIn): Promise<string> {
  const challenge = await postJson(`${baseUrl}/auth/challenge`, { address })
  if (challenge.status !== 200) throw new Error(`Could not start the ${action}. Is the backend reachable?`)
  const nonce = challengeNonce(challenge.json, action)
  const params = getParams === undefined ? await algorand.client.algod.getTransactionParams().do() : await getParams()
  const unsigned = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    // Mirrors `loginNote` on the backend (`AlgorArt login <domain> <nonce>`).
    note: utf8Bytes(`AlgorArt login ${location.host} ${nonce}`),
    suggestedParams: params,
  })
  const signed = await signTxn(algosdk.encodeUnsignedTransaction(unsigned))
  const verified = await postJson(`${baseUrl}/auth/verify-txn`, {
    address,
    signedTxn: bytesToBase64(signed),
  })
  if (verified.status !== 200) throw new Error('Sign-in failed. Try again.')
  return sessionToken(verified.json)
}

/**
 * Pin a cover image through the backend, reusing the cached session (one wallet popup per session).
 *
 * @param upload Upload inputs.
 * @param upload.baseUrl Backend base URL.
 * @param upload.address Signer address for the challenge.
 * @param upload.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param upload.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param upload.signTxn Transaction signer for wallets without message signing (universal sign-in fallback).
 * @param upload.file Image file to pin.
 * @returns The `ipfs://` URI to store as the campaign metadata URI.
 */
export async function uploadCover({ baseUrl, address, chainId, sign, signTxn, file }: CoverUpload): Promise<string> {
  if (baseUrl === '') throw new Error('Image upload needs the backend configured (VITE_BACKEND_URL).')

  const token = await ensureSession({
    baseUrl,
    address,
    chainId,
    sign,
    signTxn,
    statement: 'Sign in to AlgorArt to upload a cover image.',
    action: 'upload',
  })

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
  if (upload.status === 401) {
    clearSession()
    throw new Error('Session expired. Try again.')
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
  /** Transaction signer for wallets without message signing (universal sign-in fallback). */
  signTxn?: SignTxn | undefined
  name: string
  description: string
  image: string
  category: string
}

/**
 * Pin a campaign metadata blob through the backend, reusing the cached session. Blank optional fields are omitted
 * from the pinned blob.
 *
 * @param upload Upload inputs.
 * @param upload.baseUrl Backend base URL.
 * @param upload.address Signer address for the challenge.
 * @param upload.chainId CAIP-2 chain id for the SIWA request, if the network config provides one.
 * @param upload.sign Wallet message signer (receives the base64 SIWA payload), returning raw signature bytes.
 * @param upload.signTxn Transaction signer for wallets without message signing (universal sign-in fallback).
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
  signTxn,
  name,
  description,
  image,
  category,
}: MetadataUpload): Promise<string> {
  if (baseUrl === '') throw new Error('Metadata upload needs the backend configured (VITE_BACKEND_URL).')

  const token = await ensureSession({
    baseUrl,
    address,
    chainId,
    sign,
    signTxn,
    statement: 'Sign in to AlgorArt to upload campaign metadata.',
    action: 'metadata upload',
  })

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
  if (upload.status === 401) {
    clearSession()
    throw new Error('Session expired. Try again.')
  }
  if (upload.status !== 200) throw new Error('Metadata pinning failed. Try again.')
  return `ipfs://${pinnedCid(await readJson(upload))}`
}
