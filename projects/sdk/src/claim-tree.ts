import { sha512_256 } from '@noble/hashes/sha2.js'
import { decodeAddress, hexToBytes } from 'algosdk'

/**
 * Pure claim-tree math: the frontier-Merkle tree a campaign tracks on-chain, rendered offline so callers can build
 * `pledge` frontiers and `refund` paths without trusting any server.
 *
 * A read-only TypeScript port of `docs/claim-tree-protocol-reference.py` §§2–6, proven against the committed vectors
 * in `claim-tree.vectors.ts`. Hashes use `@noble/hashes` SHA-512/256 - the same function as the AVM `sha512_256`
 * opcode (NOT plain SHA-256).
 *
 * Proof staleness is inherent (every null changes the root): callers rebuild right before submitting and retry once on
 * a root-mismatch rejection. See docs/claim-tree-protocol.md §7.
 */

/** A pledge as the tree sees it: the three leaf preimage fields. */
export interface PledgeRecord {
  /** Backer address (decoded to 32 bytes for the leaf). */
  backer: string
  /** Pledged amount, in microAlgos. */
  amount: bigint
  /** Pledge payment transaction ID, hex. */
  txidHex: string
}

/** Tree working state: live leaves (or `Z` once nulled) in position order, plus the live total. */
export interface TreeState {
  /** Leaf values by position (`Z` = 32 zero bytes once nulled); `n = leaves.length`. */
  leaves: Uint8Array[]
  /** Live pledge total, in microAlgos. */
  raised: bigint
}

/** An authentication path: within-peak siblings (ascending), higher-peak fold (if any), lower peaks (ascending). */
export interface AuthPath {
  siblings: Uint8Array[]
  top: Uint8Array | null
  lower: Uint8Array[]
}

/** A confirmed pledge call with its paired payment, in chain order. */
export interface PledgeEvent extends PledgeRecord {
  /** Confirmed round of the pledge group. */
  round: bigint
}

/** A confirmed spend (cancel, campaign refund, or vault refund): only the position matters for replay. */
export interface SpendEvent {
  /** Nulled position. */
  position: number
}

/**
 * A fresh consumed-leaf marker (32 zero bytes). Returned new each call - never mutate the result.
 *
 * @returns 32 zero bytes.
 */
export function zeroLeaf(): Uint8Array {
  return new Uint8Array(32)
}

/**
 * Hash two child nodes into their parent.
 *
 * @param left Left child.
 * @param right Right child.
 * @returns The parent node.
 */
export function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const preimage = new Uint8Array(left.length + right.length)
  preimage.set(left, 0)
  preimage.set(right, left.length)
  return sha512_256(preimage)
}

/**
 * Encode an unsigned 64-bit integer big-endian.
 *
 * @param value The value (must fit in 64 bits).
 * @returns 8 bytes big-endian.
 */
export function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let v = value
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * Decode 8 bytes big-endian.
 *
 * @param value Exactly 8 bytes.
 * @returns The decoded bigint.
 */
export function u64beDecode(value: Uint8Array): bigint {
  if (value.length !== 8) throw new Error(`bad uint64 length: ${value.length.toString()}`)
  let v = 0n
  for (const byte of value) v = (v << 8n) | BigInt(byte)
  return v
}

/**
 * Build a pledge leaf: `H(0x01 ‖ backer ‖ amount-be64 ‖ txid)`.
 *
 * @param backer Backer address (checksum-validated by decoding).
 * @param amount Pledged amount, in microAlgos.
 * @param txidHex Pledge payment transaction ID, hex.
 * @returns The leaf value.
 */
export function leafFor(backer: string, amount: bigint, txidHex: string): Uint8Array {
  const preimage = new Uint8Array(1 + 32 + 8 + 32)
  preimage[0] = 0x01
  preimage.set(decodeAddress(backer).publicKey, 1)
  preimage.set(u64be(amount), 33)
  preimage.set(hexToBytes(txidHex), 41)
  return sha512_256(preimage)
}

/**
 * An empty tree.
 *
 * @returns Tree state with no positions and zero raised.
 */
export function emptyTree(): TreeState {
  return { leaves: [], raised: 0n }
}

/**
 * Append one pledge leaf (frontier merge cascade), returning new state.
 *
 * @param state Current tree state (not mutated).
 * @param pledge The pledge record.
 * @returns The new tree state.
 */
export function appendLeaf(state: TreeState, pledge: PledgeRecord): TreeState {
  const leaf = leafFor(pledge.backer, pledge.amount, pledge.txidHex)
  const peaks = treeFrontier(state)
  // Merge cascade over the trailing ones of N: the first t peaks fold into the leaf, lowest first.
  let merged = leaf
  const t = trailingOnes(BigInt(state.leaves.length))
  for (const peak of peaks.slice(0, t)) {
    merged = hashPair(peak, merged)
  }
  return { leaves: [...state.leaves, leaf], raised: state.raised + pledge.amount }
}

/**
 * Trailing one-bits of n (the merge cascade length).
 *
 * @param n The value.
 * @returns The trailing-ones count.
 */
function trailingOnes(n: bigint): number {
  let t = 0
  while ((n >> BigInt(t)) & 1n) t += 1
  return t
}

/**
 * Fold ascending peaks into the single stored root (acc = highest; acc = H(acc ‖ peak) descending).
 *
 * @param peaks Ascending peak values.
 * @returns The fold root (`Z` while empty).
 */
export function foldPeaks(peaks: Uint8Array[]): Uint8Array {
  if (peaks.length === 0) return zeroLeaf()
  return peaks.reduceRight((acc, peak) => hashPair(acc, peak))
}

/**
 * The frontier peaks of the current leaves, ascending level order.
 *
 * @param state Current tree state.
 * @returns The ascending peaks.
 */
export function treeFrontier(state: TreeState): Uint8Array[] {
  return peaksWithLevels(state.leaves.length, buildNodes(state.leaves)).map((peak) => peak.value)
}

/**
 * The single stored root for the current leaves.
 *
 * @param state Current tree state.
 * @returns The fold root (`Z` while empty).
 */
export function treeRoot(state: TreeState): Uint8Array {
  return foldPeaks(treeFrontier(state))
}

/**
 * Null one position (in-place consumption marker), returning new state.
 *
 * @param state Current tree state (not mutated).
 * @param position Position to null.
 * @param amount Pledged amount committed by the leaf (decremented from raised).
 * @returns The new tree state.
 */
export function nullLeaf(state: TreeState, position: number, amount: bigint): TreeState {
  if (position < 0 || position >= state.leaves.length) throw new RangeError(`unknown position: ${position.toString()}`)
  const leaves = [...state.leaves]
  leaves[position] = zeroLeaf()
  return { leaves, raised: state.raised - amount }
}

/**
 * The expected path shape for `(n, k)`: first level whose sibling block extends past N, lower-peak count, higher fold.
 * Mirrors the contract's derivation (used for arg-size estimates).
 *
 * @param n Tree size (positions ever appended).
 * @param k Leaf position.
 * @returns Within-peak length r, lower-peak count c, and whether a higher fold exists.
 */
export function pathShape(n: bigint, k: bigint): { r: number; c: number; hasTop: boolean } {
  let r = 0
  for (let level = 0; level < 64; level++) {
    const i = k >> BigInt(level)
    const sib = (i & 1n) === 0n ? i + 1n : i - 1n
    if ((sib + 1n) * 2n ** BigInt(level) <= n) {
      r += 1
    } else {
      break
    }
  }
  const mod = n - ((n >> BigInt(r)) << BigInt(r))
  let c = 0
  let rest = mod
  while (rest > 0n) {
    c += Number(rest & 1n)
    rest >>= 1n
  }
  return { r, c, hasTop: n >> BigInt(r + 1) > 0n }
}

/**
 * The authentication path for position k against the current leaves.
 *
 * @param state Current tree state.
 * @param k Leaf position.
 * @returns Siblings (ascending), higher fold (if any), lower peaks (ascending).
 */
export function treePathFor(state: TreeState, k: number): AuthPath {
  const n = state.leaves.length
  if (k < 0 || k >= n) throw new RangeError(`unknown position: ${k.toString()}`)
  const nodes = buildNodes(state.leaves)
  const { r } = pathShape(BigInt(n), BigInt(k))
  const siblings: Uint8Array[] = []
  nodes.forEach((row, l) => {
    if (l >= r) return
    // Index provably in range (r counts only levels whose sibling block exists).
    const [sib] = row.slice(Number((BigInt(k) >> BigInt(l)) ^ 1n)) as [Uint8Array]
    siblings.push(sib)
  })
  const peaks = peaksWithLevels(n, nodes)
  const higher = peaks.filter((peak) => peak.level > r).map((peak) => peak.value)
  const lower = peaks.filter((peak) => peak.level < r).map((peak) => peak.value)
  return { siblings, top: higher.length === 0 ? null : foldPeaks(higher), lower }
}

/**
 * Concatenate hash values for a contract call arg (frontier or path blob).
 *
 * @param parts The 32-byte values (and empty for a missing top).
 * @returns The concatenated bytes.
 */
export function concatHashes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * The `pledge` frontier arg for the current tree: concatenated ascending peaks (empty while N == 0).
 *
 * @param state Current tree state.
 * @returns The frontier bytes.
 */
export function frontierForPledge(state: TreeState): Uint8Array {
  return concatHashes(treeFrontier(state))
}

/**
 * The single-blob refund path arg (`siblings ‖ top ‖ lower`) for position k.
 *
 * @param state Current tree state.
 * @param k Leaf position.
 * @returns The path blob.
 */
export function pathBlobForRefund(state: TreeState, k: number): Uint8Array {
  const path = treePathFor(state, k)
  return concatHashes([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
}

/**
 * All full nodes: rows[l][i]; row l holds floor(n / 2^l) entries (odd leftovers dropped, never carried).
 *
 * @param leaves Leaf values in position order.
 * @returns Node rows by level.
 */
function buildNodes(leaves: Uint8Array[]): Uint8Array[][] {
  const n = leaves.length
  const nodes: Uint8Array[][] = [leaves]
  let prev = leaves
  for (let l = 1; 2 ** l <= n; l++) {
    const count = Math.floor(n / 2 ** l)
    const level: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      // Indices provably in range (count = floor(n / 2^l) over a row of exactly that many pairs).
      const [left, right] = prev.slice(2 * i, 2 * i + 2) as [Uint8Array, Uint8Array]
      level.push(hashPair(left, right))
    }
    nodes.push(level)
    prev = level
  }
  return nodes
}

/**
 * Ascending frontier peaks for size n: `nodes[l][(n >> l) - 1]` for each set bit l, with levels attached.
 *
 * @param n Tree size.
 * @param nodes Node rows from `buildNodes`.
 * @returns Peaks with levels, ascending.
 */
function peaksWithLevels(n: number, nodes: Uint8Array[][]): { value: Uint8Array; level: number }[] {
  const peaks: { value: Uint8Array; level: number }[] = []
  nodes.forEach((row, level) => {
    if (Math.floor(n / 2 ** level) % 2 === 0) return
    // Index provably in range (the set bit guarantees a full block row of exactly this many entries).
    const [peak] = row.slice(Math.floor(n / 2 ** level) - 1) as [Uint8Array]
    peaks.push({ value: peak, level })
  })
  return peaks
}

/** Decode an unpadded RFC 4648 base32 string (confirmed transaction IDs) to bytes. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode an unpadded base32 string.
 *
 * @param input Unpadded base32 input.
 * @returns The decoded bytes.
 */
export function base32ToBytes(input: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of input) {
    const digit = BASE32_ALPHABET.indexOf(char)
    if (digit < 0) throw new Error(`bad base32 character: ${char}`)
    value = (value << 5) | digit
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return new Uint8Array(out)
}
