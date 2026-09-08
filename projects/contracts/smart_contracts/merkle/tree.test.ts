import { describe, expect, test } from 'vitest'
import { FANOUT, WideTree, emptyNode, hash, leafHash, rootOf, siblingsFor, verify } from './tree'

// A deterministic 32-byte "address" (real addresses are 32-byte public keys).
function fakeAddress(seed: number): Uint8Array {
  const out = new Uint8Array(32)
  out[0] = seed & 0xff
  out[1] = (seed >> 8) & 0xff
  out[31] = seed & 0xff
  return out
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error('index out of bounds')
  return value
}

describe('emptyNode', () => {
  test('is distinct from a real leaf and recurses over the fanout', () => {
    const empty0 = emptyNode(0)
    expect(hex(empty0)).not.toEqual(hex(leafHash(fakeAddress(1), 0n)))
    expect(empty0.length).toBe(32)
    const children = Array.from({ length: FANOUT }, () => empty0)
    expect(emptyNode(1)).toEqual(hash(...children))
  })
})

describe('WideTree (incremental) matches the naive reference', () => {
  for (const height of [1, 2, 3]) {
    test(`height=${String(height)}: random sequences agree on the root`, () => {
      for (let round = 0; round < 50; round++) {
        const length = Math.floor(Math.random() * (FANOUT ** height + 1))
        const leaves: Uint8Array[] = []
        const tree = new WideTree(FANOUT, height)
        for (let i = 0; i < length; i++) {
          const leaf = leafHash(fakeAddress(i * 7 + 1), BigInt(1_000_000 + i))
          leaves.push(leaf)
          tree.append(leaf)
        }
        expect(tree.count).toBe(length)
        expect(hex(tree.root)).toBe(hex(rootOf(leaves, FANOUT, height)))
      }
    })
  }
})

describe('proofs', () => {
  test('verify every leaf of a random sequence', () => {
    const height = 3
    const length = 20
    const leaves: Uint8Array[] = []
    const tree = new WideTree(FANOUT, height)
    for (let i = 0; i < length; i++) {
      const leaf = leafHash(fakeAddress(i + 1), BigInt(2_000_000 + i * 3))
      leaves.push(leaf)
      tree.append(leaf)
    }
    for (let index = 0; index < length; index++) {
      const siblings = siblingsFor(leaves, FANOUT, height, index)
      expect(siblings).toHaveLength(height * (FANOUT - 1))
      expect(verify(tree.root, FANOUT, height, index, at(leaves, index), siblings)).toBe(true)
    }
  })

  test('rejects a tampered sibling, a wrong index, and a wrong leaf', () => {
    const height = 2
    const leaves = [leafHash(fakeAddress(1), 100n), leafHash(fakeAddress(2), 200n), leafHash(fakeAddress(3), 300n)]
    const tree = new WideTree(FANOUT, height)
    for (const leaf of leaves) tree.append(leaf)
    const index = 1
    const siblings = siblingsFor(leaves, FANOUT, height, index)

    const flipped = new Uint8Array(at(siblings, 2))
    flipped[0] = at(flipped, 0) ^ 0xff
    const tampered = siblings.slice()
    tampered[2] = flipped
    expect(verify(tree.root, FANOUT, height, index, at(leaves, index), tampered)).toBe(false)
    expect(verify(tree.root, FANOUT, height, index + 1, at(leaves, index), siblings)).toBe(false)
    expect(verify(tree.root, FANOUT, height, index, leafHash(fakeAddress(9), 999n), siblings)).toBe(false)
  })

  test('an empty tree roots to emptyNode(height)', () => {
    for (const height of [0, 1, 2]) {
      expect(hex(new WideTree(FANOUT, height).root)).toBe(hex(emptyNode(height)))
    }
  })
})
