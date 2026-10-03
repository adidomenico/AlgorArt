import { encodeAddress } from 'algosdk'
import { describe, expect, it } from 'vitest'
import {
  appendLeaf,
  base32ToBytes,
  concatHashes,
  emptyTree,
  foldPeaks,
  frontierForPledge,
  leafFor,
  nullLeaf,
  pathBlobForRefund,
  pathShape,
  treeFrontier,
  treePathFor,
  treeRoot,
  u64be,
  u64beDecode,
  zeroLeaf,
} from './claimtree'
import { CLAIM_TREE_VECTORS } from './claimtree.vectors'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('claim-tree vectors (differential vs the Python oracle)', () => {
  it('replays every vector step: roots, totals, frontiers, and paths', () => {
    let state = emptyTree()
    expect(hex(treeRoot(state))).toEqual(hex(zeroLeaf()))

    for (const step of CLAIM_TREE_VECTORS.steps) {
      if (step.op === 'append') {
        // The generator's address must decode to its pubkey (validates the checksum construction).
        expect(encodeAddress(Buffer.from(step.backerPubkey, 'hex'))).toEqual(step.backerAddress)
        const frontier = treeFrontier(state).map((peak) => hex(peak))
        expect(frontier).toEqual(step.frontier)

        state = appendLeaf(state, { backer: step.backerAddress, amount: BigInt(step.amount), txidHex: step.txid })
        expect(state.leaves.length).toEqual(step.expect.n)
        expect(hex(treeRoot(state))).toEqual(step.expect.root)
        expect(state.raised).toEqual(BigInt(step.expect.raised))
      } else {
        const path = treePathFor(state, step.k)
        expect(path.siblings.map((sibling) => hex(sibling))).toEqual(step.path.siblings)
        expect(path.top === null ? null : hex(path.top)).toEqual(step.path.top)
        expect(path.lower.map((peak) => hex(peak))).toEqual(step.path.lower)

        state = nullLeaf(state, step.k, BigInt(step.amount))
        expect(state.leaves.length).toEqual(step.expect.n)
        expect(hex(treeRoot(state))).toEqual(step.expect.root)
        expect(state.raised).toEqual(BigInt(step.expect.raised))
      }
    }
  })

  it('binds leaves to backer, amount, and txid', () => {
    const backerA = encodeAddress(new Uint8Array(32).fill(7))
    const backerB = encodeAddress(new Uint8Array(32).fill(8))
    expect(hex(leafFor(backerA, 1n, '00'.repeat(32)))).not.toEqual(hex(leafFor(backerB, 1n, '00'.repeat(32))))
    expect(hex(leafFor(backerA, 1n, '00'.repeat(32)))).not.toEqual(hex(leafFor(backerA, 2n, '00'.repeat(32))))
    expect(hex(leafFor(backerA, 1n, '00'.repeat(32)))).not.toEqual(hex(leafFor(backerA, 1n, '11'.repeat(32))))
  })

  it('round-trips pledge and refund call args', () => {
    const backer = encodeAddress(new Uint8Array(32).fill(7))
    let state = emptyTree()
    state = appendLeaf(state, { backer, amount: 5n, txidHex: '11'.repeat(32) })
    state = appendLeaf(state, { backer, amount: 6n, txidHex: '22'.repeat(32) })
    state = appendLeaf(state, { backer, amount: 7n, txidHex: '33'.repeat(32) })
    // N=3: two peaks (levels 0 and 1); k=2 has r=0 with a higher fold.
    expect(frontierForPledge(state).length).toEqual(64)
    const blob = pathBlobForRefund(state, 2)
    expect(blob.length).toEqual(32)
    // k=0 at N=3: one sibling plus one lower peak, no top.
    expect(pathBlobForRefund(state, 0).length).toEqual(64)
    expect(pathShape(3n, 2n)).toEqual({ r: 0, c: 0, hasTop: true })
    expect(pathShape(4n, 0n)).toEqual({ r: 2, c: 0, hasTop: false })
  })
})

describe('claim-tree guards', () => {
  it('rejects unknown positions', () => {
    const state = emptyTree()
    expect(() => treePathFor(state, 0)).toThrow(RangeError)
    expect(() => nullLeaf(state, 0, 1n)).toThrow(RangeError)
  })

  it('rejects malformed inputs', () => {
    expect(() => u64beDecode(new Uint8Array(7))).toThrow('bad uint64 length')
    expect(() => base32ToBytes('!')).toThrow('bad base32 character')
  })

  it('encodes uint64 big-endian', () => {
    expect(hex(u64be(0x0203040506070809n))).toEqual('0203040506070809')
    expect(u64beDecode(u64be(123456789n))).toEqual(123456789n)
  })

  it('folds no peaks to zero and concatenates hashes', () => {
    expect(hex(foldPeaks([]))).toEqual(hex(zeroLeaf()))
    expect(concatHashes([]).length).toEqual(0)
  })
})
