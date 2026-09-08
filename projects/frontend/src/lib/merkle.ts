/**
 * Browser port of the `Campaign` contract's fanout-8 padded Merkle tree (see `docs/commitment-redesign.md` and
 * `projects/contracts/smart_contracts/merkle/tree.ts`). It produces the same leaf hashes, empty-subtree roots, and
 * sibling proofs the on-chain verifier expects, so a backer can prove their pledge client-side.
 *
 * The contract uses `sha256`; here it is Web Crypto's `SHA-256`, so every hashing function is async. The empty-subtree
 * roots match the constants hardcoded in the contract (see `EMPTY` in `contract.algo.ts`).
 */

export const FANOUT = 8
export const TREE_HEIGHT = 5

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * SHA-256 over a single byte array (matches the AVM `sha256` opcode).
 *
 * @param data Bytes to hash.
 * @returns The 32-byte digest.
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Copy into a plain ArrayBuffer-backed view: Web Crypto rejects SharedArrayBuffer-backed inputs.
  const bytes = new Uint8Array(data.length)
  bytes.set(data)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * SHA-256 over the concatenation of the given byte arrays (matches the AVM `sha256` over `concat`).
 *
 * @param parts Byte arrays to hash, in order.
 * @returns The 32-byte digest.
 */
export async function hash(...parts: Uint8Array[]): Promise<Uint8Array> {
  return sha256(concatBytes(parts))
}

/**
 * Encode a `uint64` as 8 bytes, big-endian.
 *
 * @param value The value to encode.
 * @returns The 8-byte big-endian encoding.
 */
export function bigEndian64(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let v = value
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

// Bounds-checked access that satisfies `noUncheckedIndexedAccess` without a non-null assertion.
function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error('index out of bounds')
  return value
}

/**
 * The hash of a pledge leaf: `sha256(address(32) || amount(8))`.
 *
 * @param address The backer's 32-byte public key.
 * @param amount Pledged microAlgos.
 * @returns The leaf hash.
 */
export async function leafHash(address: Uint8Array, amount: bigint): Promise<Uint8Array> {
  return hash(address, bigEndian64(amount))
}

// Empty-subtree roots, memoized: EMPTY[0] = sha256(b''), EMPTY[k] = sha256(FANOUT copies of EMPTY[k-1]).
const emptyCache: Promise<Uint8Array>[] = []

/**
 * The root of an empty fanout-8 subtree of height `k`. Distinct from any real leaf (which hashes a 40-byte input).
 *
 * @param k Subtree height (0 = a single empty leaf).
 * @returns The empty-subtree root.
 */
export function emptyNode(k: number): Promise<Uint8Array> {
  while (emptyCache.length <= k) {
    const height = emptyCache.length
    if (height === 0) {
      emptyCache.push(hash())
    } else {
      const child = at(emptyCache, height - 1)
      emptyCache.push(child.then((c) => hash(...new Array<Uint8Array>(FANOUT).fill(c))))
    }
  }
  return at(emptyCache, k)
}

// The full tree, bottom-up: `layers[k][j]` is the node at level `k`, index `j`. Slots beyond the leaf count are empty.
async function buildLayers(leaves: Uint8Array[], fanout: number, height: number): Promise<Uint8Array[][]> {
  const size = fanout ** height
  const layer = new Array<Uint8Array>(size).fill(await emptyNode(0))
  const leafCount = Math.min(leaves.length, size)
  for (let i = 0; i < leafCount; i++) layer[i] = at(leaves, i)
  const layers: Uint8Array[][] = [layer]
  for (let k = 1; k <= height; k++) {
    const prev = at(layers, k - 1)
    const next = new Array<Uint8Array>(prev.length / fanout)
    await Promise.all(
      Array.from({ length: next.length }, async (_, i) => {
        next[i] = await hash(...prev.slice(i * fanout, i * fanout + fanout))
      }),
    )
    layers.push(next)
  }
  return layers
}

/**
 * The root of `leaves` padded to a full `fanout^h`-leaf tree.
 *
 * @param leaves Leaf hashes, in slot order.
 * @returns The root hash.
 */
export async function rootOf(leaves: Uint8Array[]): Promise<Uint8Array> {
  return at(at(await buildLayers(leaves, FANOUT, TREE_HEIGHT), TREE_HEIGHT), 0)
}

/**
 * The `h × (fanout − 1)` sibling hashes proving the leaf at slot `index`, grouped by level.
 *
 * @param leaves Leaf hashes, in slot order.
 * @param index The leaf slot index.
 * @returns The sibling hashes, grouped by level.
 */
export async function siblingsFor(leaves: Uint8Array[], index: number): Promise<Uint8Array[]> {
  const layers = await buildLayers(leaves, FANOUT, TREE_HEIGHT)
  const siblings: Uint8Array[] = []
  let i = index
  for (let k = 0; k < TREE_HEIGHT; k++) {
    const layer = at(layers, k)
    const blockStart = i - (i % FANOUT)
    for (let j = 0; j < FANOUT; j++) {
      if (j !== i % FANOUT) siblings.push(at(layer, blockStart + j))
    }
    i = Math.floor(i / FANOUT)
  }
  return siblings
}

/**
 * The proof for a leaf at slot `index`, in the contract's wire format: the `h × (fanout − 1)` sibling hashes
 * concatenated, grouped by level.
 *
 * @param leaves Leaf hashes, in slot order.
 * @param index The leaf slot index.
 * @returns The concatenated proof bytes.
 */
export async function proofBytes(leaves: Uint8Array[], index: number): Promise<Uint8Array> {
  return concatBytes(await siblingsFor(leaves, index))
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Verify a Merkle proof against a root (the same chain the contract runs for `refund`/`cancelPledge`).
 *
 * @param root The committed root.
 * @param index The leaf slot index.
 * @param leaf The leaf hash.
 * @param siblings The `height × (fanout − 1)` sibling hashes, grouped by level.
 * @returns `true` when the leaf at `index` is consistent with `root`.
 */
export async function verify(root: Uint8Array, index: number, leaf: Uint8Array, siblings: Uint8Array[]): Promise<boolean> {
  let node = leaf
  let i = index
  for (let k = 0; k < TREE_HEIGHT; k++) {
    const digit = i % FANOUT
    const levelSiblings = siblings.slice(k * (FANOUT - 1), k * (FANOUT - 1) + FANOUT - 1)
    const children: Uint8Array[] = []
    for (let j = 0; j < FANOUT; j++) {
      if (j < digit) children.push(at(levelSiblings, j))
      else if (j === digit) children.push(node)
      else children.push(at(levelSiblings, j - 1))
    }
    node = await hash(...children)
    i = Math.floor(i / FANOUT)
  }
  return bytesEqual(node, root)
}
