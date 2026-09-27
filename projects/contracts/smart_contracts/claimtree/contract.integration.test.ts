import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import type { Address } from 'algosdk'
import { decodeAddress } from 'algosdk'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

/**
 * ClaimTree spike: differential test of the on-chain frontier-Merkle tree (`contract.algo.ts`) against the independent Python
 * reference oracle (`spike_oracle.py`, backed by `docs/claim-tree-protocol-reference.py`).
 *
 * Every step runs against REAL LocalNet transactions with REAL payment TxIDs (the leaf binds `sender ‖ amount ‖ txnId`, so the
 * oracle learns each TxID from the confirmed payment and the very first root assertion proves the SDK's TxID matches the AVM's).
 * After every pledge/refund the test asserts `n`, `root`, and `raised` equal the oracle — plus rejections for a forged frontier,
 * a double refund, and a stale proof (spec §5 D, §7).
 *
 * The `refund` method sizes `ensureBudget(2800)` far above its natural cost, so every successful refund PROVES the Amendment A1
 * OpUp mechanism fires on LocalNet (without working OpUp the call could not run).
 *
 * Spike scope (see `contract.algo.ts` header): single app, no vault/credit split, no status machine — pledges pay the escrow and
 * refunds pay out of it. Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifact exists.
 */

const ALGO = 1_000_000n
const GOAL = 10n * ALGO
// Refund fee cover: 1 inner payment + OpUp create/delete inners, caller-paid via GroupCredit (see contract header).
const REFUND_EXTRA_FEE = 9_000n

const SPEC_PATH = path.resolve(__dirname, '../artifacts/claimtree/ClaimTree.arc56.json')
const ORACLE = path.resolve(__dirname, 'spike_oracle.py')

interface Frontier {
  n: number
  peaks: string[]
}

interface StepResult {
  n: number
  root: string
  raised: number
}

interface PathResult {
  siblings: string[]
  top: string | null
  lower: string[]
  root: string
  backer: string
  amount: number
  txid: string
}

describe('ClaimTree spike (localnet differential)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let appClient: AppClient
  let stateFile: string

  function oracle(cmd: string, ...args: string[]): unknown {
    const out = execFileSync('python3', [ORACLE, stateFile, cmd, ...args], { encoding: 'utf8' })
    return JSON.parse(out) as unknown
  }

  function hexToBytes(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, 'hex'))
  }

  function concatHex(hexes: string[]): Uint8Array {
    return new Uint8Array(Buffer.concat(hexes.map((h) => Buffer.from(h, 'hex'))))
  }

  function addrToHex(addr: string): string {
    return Buffer.from(decodeAddress(addr).publicKey).toString('hex')
  }

  /**
   * Decode an unpadded RFC 4648 base32 string (Algorand TxIDs) to bytes. Test-only helper: the differential root
   * assertion itself proves the decoded TxID is the one the AVM committed in the leaf.
   *
   * @param input Unpadded base32 input.
   * @returns The decoded bytes.
   */
  function base32ToBytes(input: string): Uint8Array {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = 0
    let value = 0
    const out: number[] = []
    for (const char of input) {
      value = (value << 5) | alphabet.indexOf(char)
      bits += 5
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 255)
        bits -= 8
        value &= (1 << bits) - 1
      }
    }
    return new Uint8Array(out)
  }

  async function onChainState(): Promise<{ n: bigint; root: string; raised: bigint }> {
    const n = (await appClient.state.global.getValue('n')) as bigint
    const raised = (await appClient.state.global.getValue('raised')) as bigint
    const root = (await appClient.state.global.getValue('root')) as Uint8Array
    return { n, root: Buffer.from(root).toString('hex'), raised }
  }

  async function expectOracleState(): Promise<void> {
    const exp = oracle('state') as StepResult
    const st = await onChainState()
    expect(st.n).toEqual(BigInt(exp.n))
    expect(st.root).toEqual(exp.root)
    expect(st.raised).toEqual(BigInt(exp.raised))
  }

  async function advanceTime(seconds: number): Promise<void> {
    const algod = algorand.client.algod
    try {
      await algod.setBlockOffsetTimestamp(seconds).do()
      await algorand.send.payment({
        sender: fixture.context.testAccount.addr,
        receiver: fixture.context.testAccount.addr,
        amount: (0.001).algo(),
        suppressLog: true,
      })
    } finally {
      await algod.setBlockOffsetTimestamp(0).do()
    }
  }

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand
    stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claimtree-spike-')), 'state.json')
    oracle('init')

    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as Arc56Contract
    const factory = new AppFactory({ appSpec: spec, algorand, defaultSender: creator.addr })
    const status = await algorand.client.algod.status().do()
    const block = await algorand.client.algod.block(status.lastRound).do()
    const deadline = block.block.header.timestamp + 300n
    appClient = (
      await factory.send.create({
        method: 'create(uint64,uint64)void',
        args: [GOAL, deadline],
        sender: creator.addr,
        suppressLog: true,
      })
    ).appClient
    await expectOracleState()
  })

  test('pledge → refund, differentially verified (double-refund, stale-proof, forged-frontier rejections)', async () => {
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerC = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })

    async function pledge(backer: { addr: Address }, amount: bigint): Promise<void> {
      const front = oracle('frontier') as Frontier
      const pay = await algorand.createTransaction.payment({
        sender: backer.addr,
        receiver: appClient.appAddress,
        amount: microAlgos(amount),
      })
      const sendResult = await appClient.send.call({
        method: 'pledge(pay,byte[])void',
        args: [pay, concatHex(front.peaks)],
        sender: backer.addr,
        suppressLog: true,
      })
      // The canonical TxID commits to the group assignment, so it is read from the CONFIRMED group (index 0 = payment) —
      // reading it from the ungrouped payment object would bind the wrong preimage.
      const payTxid = sendResult.txIds[0]
      if (payTxid === undefined) {
        throw new Error('pledge group returned no payment TxID')
      }
      const txidHex = Buffer.from(base32ToBytes(payTxid)).toString('hex')
      const exp = oracle('append', addrToHex(backer.addr.toString()), amount.toString(), txidHex) as StepResult
      const st = await onChainState()
      expect(st.n).toEqual(BigInt(exp.n))
      expect(st.root).toEqual(exp.root)
      expect(st.raised).toEqual(BigInt(exp.raised))
    }

    async function refund(k: number, backerAddr: Address | string, stale?: PathResult): Promise<void> {
      const p = (stale ?? oracle('path', k.toString())) as PathResult
      await appClient.send.call({
        method: 'refund(uint64,uint64,byte[],byte[],byte[],byte[])void',
        args: [
          BigInt(k),
          BigInt(p.amount),
          hexToBytes(p.txid),
          concatHex(p.siblings),
          p.top === null ? new Uint8Array(0) : hexToBytes(p.top),
          concatHex(p.lower),
        ],
        sender: backerAddr,
        extraFee: microAlgos(REFUND_EXTRA_FEE),
        suppressLog: true,
      })
      const exp = oracle('null', k.toString(), p.amount.toString()) as StepResult
      const st = await onChainState()
      expect(st.n).toEqual(BigInt(exp.n))
      expect(st.root).toEqual(exp.root)
      expect(st.raised).toEqual(BigInt(exp.raised))
    }

    // Four pledges (A re-pledges): N = 4, raised = 7 ALGO against a 10 ALGO goal.
    await pledge(backerA, 3n * ALGO)
    await pledge(backerB, 1n * ALGO)

    // Forged frontier: flip a byte of the genuine frontier — the fold check must reject, state untouched.
    const front = oracle('frontier') as Frontier
    const forged = concatHex(front.peaks)
    forged[0] = forged[0] === 0 ? 1 : 0
    const forgedPay = await algorand.createTransaction.payment({
      sender: backerC.addr,
      receiver: appClient.appAddress,
      amount: microAlgos(ALGO),
    })
    await expect(
      appClient.send.call({
        method: 'pledge(pay,byte[])void',
        args: [forgedPay, forged],
        sender: backerC.addr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/stale or forged frontier/)
    await expectOracleState()

    await pledge(backerA, 2n * ALGO)
    await pledge(backerC, 1n * ALGO)

    // Past the deadline with raised < goal: the campaign is failed, refunds open.
    await advanceTime(400)

    // Non-sequential refund order (spec §5 C).
    await refund(1, backerB.addr)

    // Stale proof (spec §7): capture k=0's path, advance the root via k=3, then the old path must fail.
    const stalePath = oracle('path', '0') as PathResult
    await refund(3, backerC.addr)
    await expect(refund(0, backerA.addr, stalePath)).rejects.toThrow(/proof does not match root/)
    await expectOracleState()
    await refund(0, backerA.addr)
    await refund(2, backerA.addr)

    // Double refund (spec §5 D): k=2 holds Z now — the genuine leaf no longer verifies.
    const doublePath = oracle('path', '2') as PathResult
    await expect(refund(2, backerA.addr, doublePath)).rejects.toThrow(/proof does not match root/)
    await expectOracleState()
  })
})
