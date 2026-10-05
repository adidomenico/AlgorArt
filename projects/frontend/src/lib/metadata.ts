/**
 * Off-chain campaign metadata (ARC-3-style JSON).
 *
 * The on-chain `metadataUri` is capped at 128 bytes, so it is always a short
 * pointer (an `ipfs://` URI or an `https://` URL) to a JSON blob shaped like
 * this — never the JSON itself:
 *
 * ```json
 * { "name": "My first novel", "description": "…", "image": "ipfs://…", "category": "books" }
 * ```
 *
 * All fields are optional; a blob with none of them is treated as absent. The
 * `image` may itself be an `ipfs://` URI (resolved through the gateway below)
 * or a plain `https://` URL. As a convenience, `metadataUri` may also point
 * straight at an image file instead of a JSON blob (see `resolveImageSrc`).
 */

// Public gateway for `ipfs://` URIs. No key needed; a dedicated gateway or
// backend-pinned URLs belong here once the catalog backend exists.
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

export interface CampaignMetadata {
  name?: string | undefined
  description?: string | undefined
  image?: string | undefined
  category?: string | undefined
}

/**
 * Map an `ipfs://` URI onto the gateway; anything else passes through.
 *
 * @param uri The URI to resolve.
 * @returns Gateway URL for `ipfs://` URIs, the trimmed input otherwise.
 */
export function resolveIpfsUri(uri: string): string {
  const trimmed = uri.trim()
  if (trimmed.startsWith('ipfs://')) {
    return `${IPFS_GATEWAY}${trimmed.slice('ipfs://'.length)}`
  }
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Pick the known string fields out of a parsed JSON blob; null when empty.
 *
 * @param json The parsed JSON value.
 * @returns The metadata, or null for non-objects and empty blobs.
 */
export function parseCampaignMetadata(json: unknown): CampaignMetadata | null {
  if (!isRecord(json)) return null
  const metadata: CampaignMetadata = {
    name: asOptionalString(json.name),
    description: asOptionalString(json.description),
    image: asOptionalString(json.image),
    category: asOptionalString(json.category),
  }
  return (metadata.name ?? metadata.description ?? metadata.image ?? metadata.category) ? metadata : null
}

/**
 * Fetch and parse the metadata blob; null on blank URIs and any failure.
 *
 * @param uri The `metadataUri` pointer.
 * @returns The parsed metadata, or null when unavailable.
 */
export async function fetchCampaignMetadata(uri: string): Promise<CampaignMetadata | null> {
  if (uri.trim() === '') return null
  try {
    const response = await fetch(resolveIpfsUri(uri))
    if (!response.ok) return null
    return parseCampaignMetadata((await response.json()) as unknown)
  } catch {
    return null
  }
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i

/**
 * Best-effort image URL for a `metadataUri`: the blob's `image` field, or the URI itself when it points straight at an
 * image file. Null when unknown.
 *
 * @param metadataUri The `metadataUri` pointer.
 * @param metadata The fetched blob, if any.
 * @returns Resolved image URL, or null.
 */
export function resolveImageSrc(metadataUri: string, metadata: CampaignMetadata | null): string | null {
  if (metadata?.image) return resolveIpfsUri(metadata.image)
  if (IMAGE_EXTENSIONS.test(metadataUri.trim())) return resolveIpfsUri(metadataUri)
  return null
}
