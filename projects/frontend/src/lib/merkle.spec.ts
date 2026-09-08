import algosdk from 'algosdk'
import { describe, expect, it } from 'vitest'
import { bigEndian64, emptyNode, leafHash, proofBytes, rootOf, siblingsFor, verify } from './merkle'

// The empty-subtree roots hardcoded in the contract (see `EMPTY` in contract.algo.ts). Cross-checking these proves the frontend's hash
// scheme matches the on-chain verifier byte-for-byte.
const EMPTY_HEX = [
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'da4974409dcfd785cec6321826272da5cf679e2d48a28bab45e77d489752a47b',
  'e99ccc670b5de422c4e062a6d4c022ab4e130c184efc2cf3267f3f781dd9df77',
  'e22ee633fd2bb6de05e7e4668b908956c114db86d75ea7514b392466965e0b03',
  'c7bffaadfee1012c52d1c1506240e8ba7b30528717ec89f99729c4c738a034b4',
  '4b2f7eba53965fb076d3d078f8d9f7100e0a9258f582b88304350729ad4a78e8',
]

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('merkle', () => {
  it('bigEndian64 encodes a uint64 as 8 big-endian bytes', () => {
    expect(Array.from(bigEndian64(1n))).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(Array.from(bigEndian64(256n))).toEqual([0, 0, 0, 0, 0, 0, 1, 0])
    expect(Array.from(bigEndian64(0x0102030405060708n))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('computes the empty-subtree roots matching the contract constants', async () => {
    for (let k = 0; k < EMPTY_HEX.length; k++) {
      expect(hex(await emptyNode(k))).toBe(EMPTY_HEX[k])
    }
  })

  it('roots the empty tree at EMPTY[5]', async () => {
    expect(hex(await rootOf([]))).toBe(EMPTY_HEX[5])
  })

  it('generates a proof that verifies against the root for each leaf index', async () => {
    const address = algosdk.decodeAddress('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ').publicKey
    const leaves = await Promise.all([leafHash(address, 100n), leafHash(address, 200n), leafHash(address, 300n)])
    const root = await rootOf(leaves)

    for (let index = 0; index < leaves.length; index++) {
      const leaf = leaves[index] ?? new Uint8Array()
      const siblings = await siblingsFor(leaves, index)
      const proof = await proofBytes(leaves, index)
      expect(hex(proof)).toBe(hex(Buffer.concat(siblings)))
      expect(await verify(root, index, leaf, siblings)).toBe(true)
    }
  })

  it('rejects a proof bound to a different amount', async () => {
    const address = algosdk.decodeAddress('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ').publicKey
    const leaves = await Promise.all([leafHash(address, 100n), leafHash(address, 200n)])
    const root = await rootOf(leaves)
    const index = 1

    const tampered = await leafHash(address, 999n)
    const siblings = await siblingsFor(leaves, index)
    expect(await verify(root, index, tampered, siblings)).toBe(false)
  })

  it('produces proofs consistent across multiple leaves (carry across fanout-8)', async () => {
    const address = algosdk.decodeAddress('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ').publicKey
    const leaves = await Promise.all(Array.from({ length: 10 }, (_, i) => leafHash(address, BigInt(i + 1))))
    const root = await rootOf(leaves)

    for (let index = 0; index < leaves.length; index++) {
      const leaf = leaves[index] ?? new Uint8Array()
      const siblings = await siblingsFor(leaves, index)
      expect(await verify(root, index, leaf, siblings)).toBe(true)
    }
  })
})
