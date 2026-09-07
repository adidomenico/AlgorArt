import { createHash } from 'node:crypto'

/**
 * Reference implementation of the fixed-height padded Merkle tree that the `Campaign` contract's redesign will use
 * (see `docs/commitment-redesign.md`).
 *
 * This file is plain TypeScript, not a contract: it exists to (a) define the exact hash scheme the AVM port must
 * reproduce, and (b) provide a naive reference against which the on-chain incremental tree can be property-tested.
 * The contract itself will verify proofs with the `h`-hash chain in `verify`; it never builds the full tree.
 */

/**
 * SHA-512/256 over the concatenation of the given byte arrays (matches the AVM `sha512_256` opcode).
 *
 * @param parts Byte arrays to hash, in order.
 * @returns The 32-byte digest.
 */
export function sha512256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('sha512-256')
  for (const part of parts) hash.update(part)
  return new Uint8Array(hash.digest())
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

/**
 * The hash of a pledge leaf: `sha512_256(address(32) || amount(8))`.
 *
 * @param address The backer's 32-byte public key.
 * @param amount Pledged microAlgos.
 * @returns The leaf hash.
 */
export function leafHash(address: Uint8Array, amount: bigint): Uint8Array {
  return sha512256(address, bigEndian64(amount))
}

// Empty-subtree roots, memoized: EMPTY[0] = sha512_256(b''), EMPTY[k] = sha512_256(EMPTY[k-1] || EMPTY[k-1]).
const emptyCache: Uint8Array[] = []

function cachedEmpty(k: number): Uint8Array {
  while (emptyCache.length <= k) {
    const height = emptyCache.length
    emptyCache.push(height === 0 ? sha512256() : sha512256(at(emptyCache, height - 1), at(emptyCache, height - 1)))
  }
  return at(emptyCache, k)
}

// Bounds-checked access that satisfies `noUncheckedIndexedAccess` without a non-null assertion.
function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error('index out of bounds')
  return value
}

/**
 * The root of an empty subtree of height `k`. Distinct from any real leaf, which hashes a 40-byte input.
 *
 * @param k Subtree height (0 = a single empty leaf).
 * @returns The empty-subtree root.
 */
export function emptyNode(k: number): Uint8Array {
  return cachedEmpty(k)
}

/**
 * Incremental fixed-height padded Merkle tree, mirroring what the on-chain contract will maintain.
 *
 * Leaves occupy slots `0..count-1`; slots beyond `count` are empty. The root is the balanced hash over all `2^h` slots.
 * Appending is O(log N): the `peaks` array holds the roots of the completed subtrees that make up `count` in binary.
 */
export class PaddedTree {
  readonly h: number
  private readonly peaks: (Uint8Array | null)[]
  private count_ = 0
  private root_: Uint8Array

  constructor(h: number) {
    this.h = h
    this.peaks = new Array<Uint8Array | null>(h + 1).fill(null)
    this.root_ = emptyNode(h)
  }

  get count(): number {
    return this.count_
  }

  get root(): Uint8Array {
    return this.root_
  }

  /**
   * Append a leaf hash.
   *
   * @param leaf The 32-byte leaf hash to append.
   * @returns The slot index the leaf was placed at.
   */
  append(leaf: Uint8Array): number {
    let node = leaf
    let k = 0
    let left = this.peaks[k] ?? null
    while (left !== null) {
      node = sha512256(left, node)
      this.peaks[k] = null
      k++
      left = this.peaks[k] ?? null
    }
    this.peaks[k] = node
    this.count_++
    this.root_ = this.fold()
    return this.count_ - 1
  }

  /** Fold the completed-subtree peaks (smallest first) into the empty-padded root. */
  private fold(): Uint8Array {
    let acc: Uint8Array | null = null
    let accHeight = 0
    for (let k = 0; k <= this.h; k++) {
      const peak = this.peaks[k] ?? null
      if (peak === null) continue
      if (acc === null) {
        acc = peak
        accHeight = k
      } else {
        while (accHeight < k) {
          acc = sha512256(acc, emptyNode(accHeight))
          accHeight++
        }
        acc = sha512256(peak, acc)
        accHeight = k + 1
      }
    }
    if (acc === null) return emptyNode(this.h)
    while (accHeight < this.h) {
      acc = sha512256(acc, emptyNode(accHeight))
      accHeight++
    }
    return acc
  }
}

/**
 * The full tree, bottom-up: `layers[k][j]` is the node at height `k`, index `j`. Reference only (O(2^h)).
 *
 * @param leaves Leaf hashes, in slot order.
 * @param h Tree height.
 * @returns The layers, from leaves (`layers[0]`) to root (`layers[h]`).
 */
export function buildLayers(leaves: Uint8Array[], h: number): Uint8Array[][] {
  const size = 1 << h
  const layer = new Array<Uint8Array>(size).fill(emptyNode(0))
  const leafCount = Math.min(leaves.length, size)
  for (let i = 0; i < leafCount; i++) layer[i] = at(leaves, i)
  const layers: Uint8Array[][] = [layer]
  for (let k = 1; k <= h; k++) {
    const prev = at(layers, k - 1)
    const next = new Array<Uint8Array>(prev.length / 2)
    for (let i = 0; i < next.length; i++) next[i] = sha512256(at(prev, 2 * i), at(prev, 2 * i + 1))
    layers.push(next)
  }
  return layers
}

/**
 * The root of `leaves` padded to a full `2^h`-leaf tree. Reference only.
 *
 * @param leaves Leaf hashes, in slot order.
 * @param h Tree height.
 * @returns The root hash.
 */
export function rootOf(leaves: Uint8Array[], h: number): Uint8Array {
  return at(at(buildLayers(leaves, h), h), 0)
}

/**
 * The `h` sibling hashes proving the leaf at slot `index`. Reference only.
 *
 * @param leaves Leaf hashes, in slot order.
 * @param h Tree height.
 * @param index The leaf slot index.
 * @returns The `h` siblings, from height 0 up.
 */
export function siblingsFor(leaves: Uint8Array[], h: number, index: number): Uint8Array[] {
  const layers = buildLayers(leaves, h)
  const siblings: Uint8Array[] = []
  let i = index
  for (let k = 0; k < h; k++) {
    const layer = at(layers, k)
    siblings.push(i % 2 === 0 ? at(layer, i + 1) : at(layer, i - 1))
    i >>= 1
  }
  return siblings
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Verify a Merkle proof against a root. This is the exact `h`-hash chain the contract will run for
 * `refund`/`cancelPledge`: direction at level `k` is bit `k` of `index`.
 *
 * @param root The committed root.
 * @param h Tree height.
 * @param index The leaf slot index.
 * @param leaf The leaf hash.
 * @param siblings The `h` sibling hashes.
 * @returns `true` when the leaf at `index` is consistent with `root`.
 */
export function verify(root: Uint8Array, h: number, index: number, leaf: Uint8Array, siblings: Uint8Array[]): boolean {
  let node = leaf
  for (let k = 0; k < h; k++) {
    const sibling = at(siblings, k)
    node = ((index >> k) & 1) === 0 ? sha512256(node, sibling) : sha512256(sibling, node)
  }
  return bytesEqual(node, root)
}
