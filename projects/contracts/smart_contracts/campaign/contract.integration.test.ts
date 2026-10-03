import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { ABIMethod, OnApplicationComplete, decodeAddress } from 'algosdk'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

/**
 * LocalNet integration tests for the claim-tree architecture: deploy the Factory + ClaimsVault + Campaign v2 TEAL to a
 * live algod and exercise full lifecycles end-to-end with **differential tree assertions and fund accounting** — every
 * pledge/cancel/refund asserts root/n/raised (and the vault box's paidIn/paidOut) against the Python reference oracle
 * (`../oracle.py`), driven with the REAL confirmed payment TxIDs; every payout asserts µA-exact fund movement; and the
 * attack matrix covers double-spends, stale/forged proofs, unregistered credit, top-level inner-only calls, the
 * settleOpen interplay, and window enforcement.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

const ALGO = 1_000_000n
const FEE = 1_000n
const GOAL = 10n * ALGO
const WINDOW = 3_600n // refund window (seconds) for the test vault; the deploy default is 730 days
const REGISTER_MBR = 18_900n

// Measured fee totals per operation (µA): each inner transaction costs its caller 1,000 via fee pooling.
const FEE_PLEDGE_CALL = FEE // no inners fire at test-tree sizes (pooled 1,400 covers the estimate)
const FEE_CREDIT = 2n * FEE // base + extraFee headroom for the possible first-touch factory check (charged always)
const FEE_SPEND = 4n * FEE // app call + 1 OpUp iteration (create+delete = 2 inners) + inner payBack
const FEE_VAULT_REFUND = 4n * FEE // app call + 1 OpUp iteration (create+delete = 2 inners) + inner payment
const FEE_CLAIM = 3n * FEE // app call + inner payClaim + inner payment pools
const FEE_DELETE_SETTLED = 3n * FEE // app call + inner settle/notify + escrow-close pools
const FEE_UNREGISTER = 2n * FEE // app call + inner deposit-back pool

const CAMPAIGN_SPEC_PATH = path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')
const VAULT_SPEC_PATH = path.resolve(__dirname, '../artifacts/claimsvault/ClaimsVault.arc56.json')
const ORACLE = path.resolve(__dirname, '../oracle.py')

// The campaign's embedded vault selectors, recomputed from the vault ARC-56 in the sync test below.
const VAULT_SELECTORS = {
  payBack: 'b0e0eedf',
  payClaim: 'f8c4e0cb',
  settle: '09200848',
  notifyDelete: '87060e1d',
} as const
const FACTORY_SELECTOR = '716a3d0e'

interface OracleState {
  n: number
  root: string
  raised: number
}

interface OraclePath {
  siblings: string[]
  top: string | null
  lower: string[]
}

describe('Campaign + ClaimsVault claim-tree (localnet)', () => {
  const fixture = algorandFixture()
  let algorand: AlgorandClient
  let campaignSpec: Arc56Contract
  let factorySpec: Arc56Contract
  let vaultSpec: Arc56Contract
  let factoryId: bigint
  let vaultId: bigint
  let vaultAddress: string
  let vaultClient: AppClient
  let sweeperAddr: string
  let stateFile: string

  beforeAll(async () => {
    await fixture.newScope()
    algorand = fixture.context.algorand
    campaignSpec = JSON.parse(fs.readFileSync(CAMPAIGN_SPEC_PATH, 'utf8')) as Arc56Contract
    factorySpec = JSON.parse(fs.readFileSync(FACTORY_SPEC_PATH, 'utf8')) as Arc56Contract
    vaultSpec = JSON.parse(fs.readFileSync(VAULT_SPEC_PATH, 'utf8')) as Arc56Contract

    const owner = await fixture.context.generateAccount({ initialFunds: (50).algo(), suppressLog: true })
    const sweeper = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    sweeperAddr = sweeper.addr.toString()

    const factoryFactory = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: owner.addr })
    const factoryClient = (await factoryFactory.send.create({ method: 'create()void', args: [], sender: owner.addr, suppressLog: true }))
      .appClient
    factoryId = factoryClient.appId
    await algorand.send.payment({
      sender: owner.addr,
      receiver: factoryClient.appAddress,
      amount: microAlgos(ALGO),
      suppressLog: true,
    })

    const campaignTeal = fs.readFileSync(path.resolve(__dirname, '../artifacts/campaign/Campaign.approval.teal'), 'utf8')
    const compiled = await algorand.app.compileTeal(campaignTeal)
    const approvalHash = createHash('sha256').update(compiled.compiledBase64ToBytes).digest()
    await factoryClient.send.call({
      method: 'setApprovalHash(byte[])void',
      args: [approvalHash],
      sender: owner.addr,
      suppressLog: true,
    })

    const vaultFactory = new AppFactory({ appSpec: vaultSpec, algorand, defaultSender: owner.addr })
    vaultClient = (
      await vaultFactory.send.create({
        method: 'create(uint64,address,uint64)void',
        args: [factoryId, sweeper.addr, WINDOW],
        sender: owner.addr,
        appReferences: [factoryId],
        suppressLog: true,
      })
    ).appClient
    vaultId = vaultClient.appId
    vaultAddress = vaultClient.appAddress.toString()
    await algorand.send.payment({
      sender: owner.addr,
      receiver: vaultClient.appAddress,
      amount: microAlgos(ALGO),
      suppressLog: true,
    })
  })

  function oracle(cmd: string, ...args: string[]): unknown {
    const out = execFileSync('python3', [ORACLE, stateFile, cmd, ...args], { encoding: 'utf8' })
    return JSON.parse(out) as unknown
  }

  function freshOracle(): void {
    stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claimtree-it-')), 'state.json')
    oracle('init')
  }

  function addrHex(addr: string): string {
    return Buffer.from(decodeAddress(addr).publicKey).toString('hex')
  }

  /**
   * Decode an unpadded RFC 4648 base32 string (confirmed TxIDs) to bytes.
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

  function concatHex(hexes: string[]): Uint8Array {
    return new Uint8Array(Buffer.concat(hexes.map((h) => Buffer.from(h, 'hex'))))
  }

  function appIdBytes(appId: bigint): Buffer {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64BE(appId)
    return buf
  }

  function vaultBoxRef(appId: bigint): { appId: bigint; name: Uint8Array } {
    return { appId: vaultId, name: new Uint8Array(Buffer.concat([Buffer.from('c'), appIdBytes(appId)])) }
  }

  function registrationBoxRef(appId: bigint): { appId: bigint; name: Uint8Array } {
    return { appId: factoryId, name: new Uint8Array(Buffer.concat([Buffer.from('r'), appIdBytes(appId)])) }
  }

  async function boxOf(
    appId: bigint,
  ): Promise<{ paidIn: bigint; paidOut: bigint; root: string; n: bigint; status: number; settledAt: bigint }> {
    const raw = Buffer.from((await vaultClient.state.box.getMapValue('campaignBox', appId)) as Uint8Array)
    return {
      paidIn: raw.subarray(0, 8).readBigUInt64BE(),
      paidOut: raw.subarray(8, 16).readBigUInt64BE(),
      root: raw.subarray(16, 48).toString('hex'),
      n: raw.subarray(48, 56).readBigUInt64BE(),
      status: raw[56] === undefined ? 0 : raw[56],
      settledAt: raw.subarray(57, 65).readBigUInt64BE(),
    }
  }

  async function boxExists(appId: bigint): Promise<boolean> {
    try {
      await vaultClient.state.box.getMapValue('campaignBox', appId)
      return true
    } catch {
      return false
    }
  }

  async function campaignState(appClient: AppClient): Promise<{ n: bigint; root: string; raised: bigint; status: bigint }> {
    const n = (await appClient.state.global.getValue('n')) as bigint
    const raised = (await appClient.state.global.getValue('raised')) as bigint
    const status = (await appClient.state.global.getValue('status')) as bigint
    const root = (await appClient.state.global.getValue('root')) as Uint8Array
    return { n, root: Buffer.from(root).toString('hex'), raised, status }
  }

  async function balanceOf(addr: string): Promise<bigint> {
    return (await algorand.account.getInformation(addr)).balance.microAlgo
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

  /**
   * Deploy + register a campaign; returns its client. Registration is required before first credit.
   *
   * @param creatorAddr The campaign creator's address.
   * @param goal Funding target in microAlgos.
   * @param deadlineOffset Seconds from the current chain time to the deadline.
   * @returns The app client and id.
   */
  async function deployCampaign(creatorAddr: string, goal = GOAL, deadlineOffset = 600): Promise<{ appClient: AppClient; appId: bigint }> {
    const status = await algorand.client.algod.status().do()
    const block = await algorand.client.algod.block(status.lastRound).do()
    const deadline = block.block.header.timestamp + BigInt(deadlineOffset)
    const factory = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creatorAddr })
    const appClient = (
      await factory.send.create({
        method: 'create(uint64,byte[],byte[],uint64,uint64)void',
        args: [vaultId, new TextEncoder().encode('Seed campaign'), new TextEncoder().encode('ipfs://seed'), goal, deadline],
        sender: creatorAddr,
        appReferences: [vaultId],
        suppressLog: true,
      })
    ).appClient
    const appId = appClient.appId

    const factoryClient = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: creatorAddr }).getAppClientById({
      appId: factoryId,
    })
    const registerPayment = await algorand.createTransaction.payment({
      sender: creatorAddr,
      receiver: factoryClient.appAddress,
      amount: microAlgos(REGISTER_MBR),
    })
    await factoryClient.send.call({
      method: 'register(uint64,pay)void',
      args: [appId, registerPayment],
      sender: creatorAddr,
      appReferences: [appId],
      suppressLog: true,
    })
    return { appClient, appId }
  }

  /**
   * Pledge through the real group `[pay, campaign.pledge, vault.credit]`, asserting root/n/raised and the vault box
   * against the oracle at every step. Returns the confirmed payment TxID (hex).
   *
   * @param appClient The campaign client (for state reads).
   * @param appId The campaign application id.
   * @param backerAddr The backer's address.
   * @param amount Pledge amount in microAlgos.
   * @returns The confirmed payment TxID (hex).
   */
  async function pledge(appClient: AppClient, appId: bigint, backerAddr: string, amount: bigint): Promise<string> {
    const front = oracle('frontier') as { peaks: string[] }
    const pay = await algorand.createTransaction.payment({ sender: backerAddr, receiver: vaultAddress, amount: microAlgos(amount) })
    const composer = algorand.send.newGroup()
    // The payment object is referenced by the pledge call, which pulls it into the group ahead of the call.
    // (Do NOT also pass it via addTransaction — the composer does not dedupe and the group would carry it twice.)
    composer.addAppCallMethodCall({
      appId,
      method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
      args: [pay, concatHex(front.peaks)],
      sender: backerAddr,
    })
    composer.addAppCallMethodCall({
      appId: vaultId,
      method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
      args: [appId, amount],
      sender: backerAddr,
      appReferences: [factoryId],
      boxReferences: [vaultBoxRef(appId), registrationBoxRef(appId)],
      extraFee: microAlgos(FEE),
    })
    const result = await composer.send({ suppressLog: true })
    const payTxid = result.txIds[0]
    if (payTxid === undefined) throw new Error('pledge group returned no payment TxID')
    const txidHex = Buffer.from(base32ToBytes(payTxid)).toString('hex')

    const exp = oracle('append', addrHex(backerAddr), amount.toString(), txidHex) as OracleState
    const st = await campaignState(appClient)
    expect(st.n).toEqual(BigInt(exp.n))
    expect(st.root).toEqual(exp.root)
    expect(st.raised).toEqual(BigInt(exp.raised))
    const box = await boxOf(appId)
    expect(box.paidIn).toEqual(BigInt(exp.raised))
    expect(box.paidOut).toEqual(0n)
    return txidHex
  }

  /**
   * Spend a leaf through the campaign (`cancelPledge`/`refund`), asserting state against the oracle.
   *
   * @param appClient The campaign client (for state reads and the spend call).
   * @param appId The campaign application id.
   * @param backerAddr The leaf owner's address.
   * @param k Leaf position.
   * @param amount Pledged amount committed by the leaf.
   * @param txidHex Pledge payment TxID (hex).
   * @param method Which spend entry point to exercise.
   */
  async function spend(
    appClient: AppClient,
    appId: bigint,
    backerAddr: string,
    k: number,
    amount: bigint,
    txidHex: string,
    method: 'cancelPledge(uint64,uint64,byte[],byte[])void' | 'refund(uint64,uint64,byte[],byte[])void',
  ): Promise<void> {
    const p = oracle('path', k.toString()) as OraclePath
    const blob = concatHex([...p.siblings, ...(p.top === null ? [] : [p.top]), ...p.lower])
    await appClient.send.call({
      method,
      args: [BigInt(k), amount, Buffer.from(txidHex, 'hex'), blob],
      sender: backerAddr,
      appReferences: [vaultId],
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(3n * FEE),
      suppressLog: true,
    })
    const exp = oracle('null', k.toString(), amount.toString()) as OracleState
    const st = await campaignState(appClient)
    expect(st.n).toEqual(BigInt(exp.n))
    expect(st.root).toEqual(exp.root)
    expect(st.raised).toEqual(BigInt(exp.raised))
    const box = await boxOf(appId)
    expect(box.paidOut).toEqual(box.paidIn - BigInt(exp.raised))
  }

  test('embedded vault selectors match the vault ARC-56', () => {
    const approval = fs.readFileSync(path.resolve(__dirname, '../artifacts/campaign/Campaign.approval.teal'), 'utf8')
    for (const method of [
      'payBack(uint64,address,uint64)void',
      'payClaim(uint64)void',
      'settle(uint64,byte[],uint64)void',
      'notifyDelete(uint64)void',
    ] as const) {
      const selector = createHash('sha512-256').update(method).digest('hex').slice(0, 8)
      expect(approval).toContain(selector)
    }
    expect(VAULT_SELECTORS.payBack).toEqual(createHash('sha512-256').update('payBack(uint64,address,uint64)void').digest('hex').slice(0, 8))
    expect(VAULT_SELECTORS.payClaim).toEqual(createHash('sha512-256').update('payClaim(uint64)void').digest('hex').slice(0, 8))
    expect(VAULT_SELECTORS.settle).toEqual(createHash('sha512-256').update('settle(uint64,byte[],uint64)void').digest('hex').slice(0, 8))
    expect(VAULT_SELECTORS.notifyDelete).toEqual(createHash('sha512-256').update('notifyDelete(uint64)void').digest('hex').slice(0, 8))
    const vaultApproval = fs.readFileSync(path.resolve(__dirname, '../artifacts/claimsvault/ClaimsVault.approval.teal'), 'utf8')
    expect(vaultApproval).toContain(FACTORY_SELECTOR)
  })

  test('pledge → cancel → refund lifecycle, differentially verified with exact fund movement', async () => {
    freshOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addrA = backerA.addr.toString()
    const addrB = backerB.addr.toString()
    const { appClient, appId } = await deployCampaign(creator.addr.toString())

    const balA0 = await balanceOf(addrA)
    const vaultBal0 = await balanceOf(vaultAddress)

    // Four pledges (A re-pledges): N=4, raised=7 ALGO. First touch carries the factory check fee.
    const txA1 = await pledge(appClient, appId, addrA, 3n * ALGO)
    const txB1 = await pledge(appClient, appId, addrB, 1n * ALGO)
    const txA2 = await pledge(appClient, appId, addrA, 2n * ALGO)
    const txB2 = await pledge(appClient, appId, addrB, 1n * ALGO)
    expect(await balanceOf(vaultAddress)).toEqual(vaultBal0 + 7n * ALGO)
    // A pledged twice: 2 payments + 2 pledge calls + 2 credits (extraFee headroom charged on each).
    expect(await balanceOf(addrA)).toEqual(balA0 - 5n * ALGO - (2n * FEE + 2n * FEE_PLEDGE_CALL + 2n * FEE_CREDIT))

    // Forged frontier: same length, one flipped byte — the fold check rejects, state untouched.
    const front = oracle('frontier') as { peaks: string[] }
    const forged = Buffer.concat(front.peaks.map((p) => Buffer.from(p, 'hex')))
    forged[0] = forged[0] === 0 ? 1 : 0
    const forgedPay = await algorand.createTransaction.payment({ sender: addrA, receiver: vaultAddress, amount: microAlgos(ALGO) })
    await expect(
      appClient.send.call({
        method: 'pledge(pay,byte[])void',
        args: [forgedPay, new Uint8Array(forged)],
        sender: addrA,
        suppressLog: true,
      }),
    ).rejects.toThrow()
    const oracleState = oracle('state') as OracleState
    const st = await campaignState(appClient)
    expect(st.n).toEqual(BigInt(oracleState.n))

    // Cancel A's second pledge pre-deadline (differential).
    const balA1 = await balanceOf(addrA)
    await spend(appClient, appId, addrA, 2, 2n * ALGO, txA2, 'cancelPledge(uint64,uint64,byte[],byte[])void')
    expect(await balanceOf(addrA)).toEqual(balA1 + 2n * ALGO - FEE_SPEND)

    // Past the deadline with raised (5 ALGO) < goal: failed. Refund B then A, non-sequentially.
    await advanceTime(900)
    const balB = await balanceOf(addrB)
    await spend(appClient, appId, addrB, 1, 1n * ALGO, txB1, 'refund(uint64,uint64,byte[],byte[])void')
    expect(await balanceOf(addrB)).toEqual(balB + 1n * ALGO - FEE_SPEND)
    await spend(appClient, appId, addrA, 0, 3n * ALGO, txA1, 'refund(uint64,uint64,byte[],byte[])void')
    await spend(appClient, appId, addrB, 3, 1n * ALGO, txB2, 'refund(uint64,uint64,byte[],byte[])void')
    const end = await campaignState(appClient)
    expect(end.raised).toEqual(0n)
    expect(end.status).toEqual(1n)

    // Double refund of k=0: the leaf holds Z now.
    const dup = oracle('path', '0') as OraclePath
    const blob = concatHex([...dup.siblings, ...(dup.top === null ? [] : [dup.top]), ...dup.lower])
    await expect(
      appClient.send.call({
        method: 'refund(uint64,uint64,byte[],byte[])void',
        args: [0n, 3n * ALGO, Buffer.from(txA1, 'hex'), blob],
        sender: addrA,
        appReferences: [vaultId],
        boxReferences: [vaultBoxRef(appId)],
        extraFee: microAlgos(3n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/proof does not match root/)
  })

  test('unregistered campaigns cannot touch the vault', async () => {
    freshOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    // Deploy without registering. The deadline is deliberately far: this test proves the registration gate, and must
    // not depend on suite clock residue from earlier time-travel.
    const status = await algorand.client.algod.status().do()
    const block = await algorand.client.algod.block(status.lastRound).do()
    const deadline = block.block.header.timestamp + 100_000n
    const factory = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creator.addr })
    const appClient = (
      await factory.send.create({
        method: 'create(uint64,byte[],byte[],uint64,uint64)void',
        args: [vaultId, new TextEncoder().encode('Rogue'), new TextEncoder().encode('ipfs://rogue'), GOAL, deadline],
        sender: creator.addr,
        appReferences: [vaultId],
        suppressLog: true,
      })
    ).appClient
    const appId = appClient.appId
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()

    const pay = await algorand.createTransaction.payment({ sender: addr, receiver: vaultAddress, amount: microAlgos(ALGO) })
    const composer = algorand.send.newGroup()
    composer.addAppCallMethodCall({
      appId,
      method: ABIMethod.fromSignature('pledge(pay,byte[])void'),
      args: [pay, new Uint8Array()],
      sender: addr,
    })
    composer.addAppCallMethodCall({
      appId: vaultId,
      method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
      args: [appId, ALGO],
      sender: addr,
      appReferences: [factoryId],
      boxReferences: [vaultBoxRef(appId), registrationBoxRef(appId)],
      extraFee: microAlgos(FEE),
    })
    await expect(composer.send({ suppressLog: true })).rejects.toThrow(/campaign not registered/)
    expect(await boxExists(appId)).toEqual(false)
  })

  test('inner-only vault methods reject top-level callers', async () => {
    freshOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appClient, appId } = await deployCampaign(creator.addr.toString())
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    // One pledge so the box exists: the rejects below then prove caller authority, not box absence.
    await pledge(appClient, appId, backer.addr.toString(), 1n * ALGO)
    const stranger = await fixture.context.generateAccount({ initialFunds: (10).algo(), suppressLog: true })
    const saddr = stranger.addr.toString()

    await expect(
      vaultClient.send.call({
        method: 'payBack(uint64,address,uint64)void',
        args: [appId, saddr, 100n],
        sender: saddr,
        appReferences: [appId],
        boxReferences: [vaultBoxRef(appId)],
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      vaultClient.send.call({ method: 'payClaim(uint64)void', args: [appId], sender: saddr, suppressLog: true }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      vaultClient.send.call({
        method: 'settle(uint64,byte[],uint64)void',
        args: [appId, new Uint8Array(32), 0n],
        sender: saddr,
        suppressLog: true,
      }),
    ).rejects.toThrow(/not the campaign app/)
    await expect(
      vaultClient.send.call({ method: 'notifyDelete(uint64)void', args: [appId], sender: saddr, suppressLog: true }),
    ).rejects.toThrow(/not the campaign app/)
  })

  test('successful claim pays the creator exactly, then deletes O(1)', async () => {
    freshOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const caddr = creator.addr.toString()
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()
    const { appClient, appId } = await deployCampaign(caddr, 3n * ALGO)

    await pledge(appClient, appId, addr, 2n * ALGO)
    await pledge(appClient, appId, addr, 2n * ALGO)
    await advanceTime(900)

    const balC0 = await balanceOf(caddr)
    await appClient.send.call({
      method: 'claim()void',
      args: [],
      sender: caddr,
      appReferences: [vaultId],
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(2n * FEE),
      suppressLog: true,
    })
    // 4 ALGO in, 0 out: the creator receives the full live total minus the claim fee.
    expect(await balanceOf(caddr)).toEqual(balC0 + 4n * ALGO - FEE_CLAIM)
    const box = await boxOf(appId)
    expect(box.status).toEqual(3)
    expect(box.paidOut).toEqual(box.paidIn)

    // Delete: notifyDelete releases the box (32,100 MBR back to the pool), escrow closes to the creator.
    const balC1 = await balanceOf(caddr)
    await appClient.send.delete({
      method: 'delete()void',
      sender: caddr,
      appReferences: [vaultId],
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(2n * FEE),
      suppressLog: true,
    })
    expect(await boxExists(appId)).toEqual(false)
    // The escrow never held funds, so deletion only costs its fees.
    expect(await balanceOf(caddr)).toEqual(balC1 - FEE_DELETE_SETTLED)

    // Unregister returns the factory deposit.
    const factoryClient = new AppFactory({ appSpec: factorySpec, algorand, defaultSender: caddr }).getAppClientById({
      appId: factoryId,
    })
    const balC2 = await balanceOf(caddr)
    await factoryClient.send.call({
      method: 'unregister(uint64)void',
      args: [appId],
      sender: caddr,
      appReferences: [appId],
      extraFee: microAlgos(FEE),
      suppressLog: true,
    })
    expect(await balanceOf(caddr)).toEqual(balC2 + REGISTER_MBR - FEE_UNREGISTER)
  })

  test('failed campaign settles on delete; vault refunds after deletion; finalize sweeps the residual', async () => {
    freshOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const caddr = creator.addr.toString()
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addrA = backerA.addr.toString()
    const addrB = backerB.addr.toString()
    const { appClient, appId } = await deployCampaign(caddr)

    const txA = await pledge(appClient, appId, addrA, 3n * ALGO)
    const txB = await pledge(appClient, appId, addrB, 1n * ALGO)
    await advanceTime(900)

    // Creator deletes the failed campaign: settle writes root/N + FAILED into the vault box.
    // Note: built via the manual composer (appClient.send.delete mis-encodes this call); same pattern as pledge().
    const deleteComposer = algorand.send.newGroup()
    deleteComposer.addAppCallMethodCall({
      appId,
      method: ABIMethod.fromSignature('delete()void'),
      args: [],
      sender: caddr,
      onComplete: OnApplicationComplete.DeleteApplicationOC,
      appReferences: [vaultId],
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(2n * FEE),
    })
    await deleteComposer.send({ suppressLog: true })
    const settled = await boxOf(appId)
    expect(settled.status).toEqual(2)
    expect(settled.n).toEqual(2n)

    // Either backer refunds straight from the vault (no campaign involved).
    const balB = await balanceOf(addrB)
    const pathB = oracle('path', '1') as OraclePath
    const blobB = concatHex([...pathB.siblings, ...(pathB.top === null ? [] : [pathB.top]), ...pathB.lower])
    await vaultClient.send.call({
      method: 'refund(uint64,uint64,uint64,byte[],byte[])void',
      args: [appId, 1n, 1n * ALGO, Buffer.from(txB, 'hex'), blobB],
      sender: addrB,
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(3n * FEE),
      suppressLog: true,
    })
    expect(await balanceOf(addrB)).toEqual(balB + 1n * ALGO - FEE_VAULT_REFUND)
    const afterRefund = await boxOf(appId)
    expect(afterRefund.paidOut).toEqual(1n * ALGO)

    // Finalize before the window closes is rejected; after it, the 3 ALGO residual goes to the sweeper.
    await expect(
      vaultClient.send.call({ method: 'finalize(uint64)void', args: [appId], sender: addrA, extraFee: microAlgos(FEE), suppressLog: true }),
    ).rejects.toThrow(/refund window still open/)
    await advanceTime(4_000)
    const balS0 = await balanceOf(sweeperAddr)
    await vaultClient.send.call({
      method: 'finalize(uint64)void',
      args: [appId],
      sender: addrA,
      extraFee: microAlgos(FEE),
      suppressLog: true,
    })
    expect(await balanceOf(sweeperAddr)).toEqual(balS0 + 3n * ALGO)
    expect(await boxExists(appId)).toEqual(false)
    void txA
  })

  test('pristine and all-cancelled campaigns delete cleanly', async () => {
    freshOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const caddr = creator.addr.toString()
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()

    // Pristine: no box exists, so settle is a no-op; the escrow (holding nothing) closes to the creator.
    const pristine = await deployCampaign(caddr)
    const balP0 = await balanceOf(caddr)
    await pristine.appClient.send.delete({
      method: 'delete()void',
      sender: caddr,
      appReferences: [vaultId],
      boxReferences: [vaultBoxRef(pristine.appId)],
      extraFee: microAlgos(2n * FEE),
      suppressLog: true,
    })
    expect(await balanceOf(caddr)).toEqual(balP0 - FEE_DELETE_SETTLED)
    expect(await boxExists(pristine.appId)).toEqual(false)

    // All cancelled: the box settles to FAILED with nothing owed.
    const { appClient, appId } = await deployCampaign(caddr)
    const txid = await pledge(appClient, appId, addr, 1n * ALGO)
    await spend(appClient, appId, addr, 0, 1n * ALGO, txid, 'cancelPledge(uint64,uint64,byte[],byte[])void')
    await appClient.send.delete({
      method: 'delete()void',
      sender: caddr,
      appReferences: [vaultId],
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(2n * FEE),
      suppressLog: true,
    })
    const box = await boxOf(appId)
    expect(box.status).toEqual(2)
    expect(box.paidIn).toEqual(box.paidOut)
  })

  test('settleOpen lets a stranger settle a vanished-creator campaign; campaign path then rejects', async () => {
    freshOracle()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appClient, appId } = await deployCampaign(creator.addr.toString())

    const txid = await pledge(appClient, appId, addr, 2n * ALGO)
    await advanceTime(900)

    // Anyone settles: reads the live campaign globals, flips the box to FAILED.
    await vaultClient.send.call({
      method: 'settleOpen(uint64)void',
      args: [appId],
      sender: stranger.addr,
      appReferences: [appId],
      suppressLog: true,
    })
    expect((await boxOf(appId)).status).toEqual(2)

    // The campaign path now fails at the vault (box not open) — the backer must use vault.refund instead.
    const path = oracle('path', '0') as OraclePath
    const blob = concatHex([...path.siblings, ...(path.top === null ? [] : [path.top]), ...path.lower])
    await expect(
      appClient.send.call({
        method: 'refund(uint64,uint64,byte[],byte[])void',
        args: [0n, 2n * ALGO, Buffer.from(txid, 'hex'), blob],
        sender: addr,
        appReferences: [vaultId],
        boxReferences: [vaultBoxRef(appId)],
        extraFee: microAlgos(3n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/campaign is not open/)
  })
})
