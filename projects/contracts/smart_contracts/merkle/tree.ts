import { createHash } from 'node:crypto'

/**
 * Reference implementation of the fixed-height padded Merkle tree used by the `Campaign` contract (see
 * `docs/commitment-redesign.md`).
 *
 * This is a **fanout-8** tree: each internal node is `sha256` over its 8 children, so the height is `log8(N)`. At
 * `h = 5` that is 32,768 leaves (backers), and a pledge (append + fold) or refund (proof verify) is only ~5 sha256
 * ops — inside the AVM's 700-cost app-call budget (a binary tree could not fit; see the docs).
 *
 * This file is plain TypeScript, not a contract: it defines the exact hash scheme the AVM port reproduces and provides
 * a naive reference the on-chain incremental tree is property-tested against.
 */

export const FANOUT = 8

/**
 * SHA-256 over the concatenation of the given byte arrays (matches the AVM `sha256` opcode).
 *
 * @param parts Byte arrays to hash, in order.
 * @returns The 32-byte digest.
 */
export function hash(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256')
  for (const part of parts) h.update(part)
  return new Uint8Array(h.digest())
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
 * The hash of a pledge leaf: `sha256(address(32) || amount(8))`.
 *
 * @param address The backer's 32-byte public key.
 * @param amount Pledged microAlgos.
 * @returns The leaf hash.
 */
export function leafHash(address: Uint8Array, amount: bigint): Uint8Array {
  return hash(address, bigEndian64(amount))
}

// Empty-subtree roots, memoized: EMPTY[0] = sha256(b''), EMPTY[k] = sha256(FANOUT copies of EMPTY[k-1]).
const emptyCache: Uint8Array[] = []

function cachedEmpty(k: number): Uint8Array {
  while (emptyCache.length <= k) {
    const height = emptyCache.length
    if (height === 0) {
      emptyCache.push(hash())
    } else {
      const child = at(emptyCache, height - 1)
      emptyCache.push(hash(...Array.from({ length: FANOUT }, () => child)))
    }
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
 * The root of an empty fanout-F subtree of height `k`. Distinct from any real leaf (which hashes a 40-byte input).
 *
 * @param k Subtree height (0 = a single empty leaf).
 * @returns The empty-subtree root.
 */
export function emptyNode(k: number): Uint8Array {
  return cachedEmpty(k)
}

/**
 * Incremental fixed-height fanout-F padded Merkle tree, mirroring what the on-chain contract maintains.
 *
 * Leaves occupy slots `0..count-1`; slots beyond `count` are empty. The `peaks` array holds, at each level `k`, the
 * `count`'s base-F digit worth of completed subtrees. The root is the empty-padded fold of the peaks, which is O(h)
 * sha256 ops (one per level).
 */
export class WideTree {
  readonly fanout: number
  readonly height: number
  private readonly peaks: Uint8Array[][]
  private count_ = 0

  constructor(fanout: number, height: number) {
    this.fanout = fanout
    this.height = height
    // One more level than the height: a fully-loaded tree produces a single peak at level `height`.
    this.peaks = Array.from({ length: height + 1 }, () => [])
  }

  get count(): number {
    return this.count_
  }

  get root(): Uint8Array {
    return this.fold()
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
    while (k < this.height && this.peak(k).length === this.fanout - 1) {
      node = hash(...this.peak(k), node)
      this.peaks[k] = []
      k++
    }
    this.peak(k).push(node)
    return this.count_++
  }

  // The completed-subtree peaks at level `k`, bounds-checked.
  private peak(k: number): Uint8Array[] {
    const peak = this.peaks[k]
    if (peak === undefined) throw new Error('level out of range')
    return peak
  }

  /** Fold the completed-subtree peaks (bottom-up, empty-padded) into the root. */
  private fold(): Uint8Array {
    // A fully-loaded tree collapses into a single peak at level `height`; the fold loop below covers the partial case.
    if (this.peak(this.height).length > 0) return at(this.peak(this.height), 0)
    let partial: Uint8Array | null = null
    for (let k = 0; k < this.height; k++) {
      const children: Uint8Array[] = [...this.peak(k)]
      if (partial !== null) children.push(partial)
      while (children.length < this.fanout) children.push(emptyNode(k))
      partial = hash(...children)
    }
    return partial ?? emptyNode(this.height)
  }
}

/**
 * The full tree, bottom-up: `layers[k][j]` is the node at level `k`, index `j`. Reference only (O(fanout^h)).
 *
 * @param leaves Leaf hashes, in slot order.
 * @param fanout The branching factor.
 * @param height The tree height.
 * @returns The layers, from leaves (`layers[0]`) to root (`layers[height]`).
 */
export function buildLayers(leaves: Uint8Array[], fanout: number, height: number): Uint8Array[][] {
  const size = fanout ** height
  const layer = new Array<Uint8Array>(size).fill(emptyNode(0))
  const leafCount = Math.min(leaves.length, size)
  for (let i = 0; i < leafCount; i++) layer[i] = at(leaves, i)
  const layers: Uint8Array[][] = [layer]
  for (let k = 1; k <= height; k++) {
    const prev = at(layers, k - 1)
    const next = new Array<Uint8Array>(prev.length / fanout)
    for (let i = 0; i < next.length; i++) next[i] = hash(...prev.slice(i * fanout, i * fanout + fanout))
    layers.push(next)
  }
  return layers
}

/**
 * The root of `leaves` padded to a full `fanout^h`-leaf tree. Reference only.
 *
 * @param leaves Leaf hashes, in slot order.
 * @param fanout The branching factor.
 * @param height The tree height.
 * @returns The root hash.
 */
export function rootOf(leaves: Uint8Array[], fanout: number, height: number): Uint8Array {
  return at(at(buildLayers(leaves, fanout, height), height), 0)
}

/**
 * The `h × (fanout − 1)` sibling hashes proving the leaf at slot `index`. Siblings are grouped by level (level `k`'s
 * `fanout − 1` siblings first). Reference only.
 *
 * @param leaves Leaf hashes, in slot order.
 * @param fanout The branching factor.
 * @param height The tree height.
 * @param index The leaf slot index.
 * @returns The sibling hashes, grouped by level.
 */
export function siblingsFor(leaves: Uint8Array[], fanout: number, height: number, index: number): Uint8Array[] {
  const layers = buildLayers(leaves, fanout, height)
  const siblings: Uint8Array[] = []
  let i = index
  for (let k = 0; k < height; k++) {
    const layer = at(layers, k)
    const blockStart = i - (i % fanout)
    for (let j = 0; j < fanout; j++) {
      if (j !== i % fanout) siblings.push(at(layer, blockStart + j))
    }
    i = Math.floor(i / fanout)
  }
  return siblings
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Verify a Merkle proof against a root. The leaf's position at level `k` is the k-th base-F digit of `index`; the
 * contract runs this same chain for `refund`/`cancelPledge`.
 *
 * @param root The committed root.
 * @param fanout The branching factor.
 * @param height The tree height.
 * @param index The leaf slot index.
 * @param leaf The leaf hash.
 * @param siblings The `height × (fanout − 1)` sibling hashes, grouped by level.
 * @returns `true` when the leaf at `index` is consistent with `root`.
 */
export function verify(root: Uint8Array, fanout: number, height: number, index: number, leaf: Uint8Array, siblings: Uint8Array[]): boolean {
  let node = leaf
  let i = index
  for (let k = 0; k < height; k++) {
    const digit = i % fanout
    const levelSiblings = siblings.slice(k * (fanout - 1), k * (fanout - 1) + fanout - 1)
    const children: Uint8Array[] = []
    for (let j = 0; j < fanout; j++) {
      if (j < digit) children.push(at(levelSiblings, j))
      else if (j === digit) children.push(node)
      else children.push(at(levelSiblings, j - 1))
    }
    node = hash(...children)
    i = Math.floor(i / fanout)
  }
  return bytesEqual(node, root)
}
