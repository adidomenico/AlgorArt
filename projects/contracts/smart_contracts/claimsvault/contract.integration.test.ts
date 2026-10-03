import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { ABIMethod, decodeAddress } from 'algosdk'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

/**
 * LocalNet integration tests for the ClaimsVault pooling and settlement paths: two campaigns sharing one pool prove
 * per-campaign isolation, and the permissionless entries (`settleOpen`, vault `refund`, `finalize`) plus the
 * direct-credit self-harm containment run against minimal campaign fixtures. The full lifecycles live in
 * `../campaign/contract.integration.test.ts`; every assertion here is µA-exact.
 *
 * Requires `algokit localnet start` and a build (`npm run build`) so the ARC-56 artifacts exist.
 */

const ALGO = 1_000_000n
const FEE = 1_000n
const GOAL = 10n * ALGO
const WINDOW = 3_600n
const REGISTER_MBR = 18_900n
const BOX_MBR = 32_100n
const Z_HEX = '00'.repeat(32)

const FEE_CREDIT_FIRST = 2n * FEE // base + inner factory check pool
const FEE_VAULT_REFUND = 4n * FEE // app call + 1 OpUp iteration (create+delete) + inner payment
const FEE_FINALIZE_PAID = 2n * FEE // app call + inner residual-payment pool
const FEE_FINALIZE_BARE = FEE // app call only

const CAMPAIGN_SPEC_PATH = path.resolve(__dirname, '../artifacts/campaign/Campaign.arc56.json')
const FACTORY_SPEC_PATH = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')
const VAULT_SPEC_PATH = path.resolve(__dirname, '../artifacts/claimsvault/ClaimsVault.arc56.json')
const ORACLE = path.resolve(__dirname, '../oracle.py')

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

/** One reference-oracle tree (own state file, so parallel campaigns stay independent). */
class Tree {
  file: string

  constructor() {
    this.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claimvault-it-')), 'state.json')
    this.cmd('init')
  }

  cmd(cmd: string, ...args: string[]): unknown {
    const out = execFileSync('python3', [ORACLE, this.file, cmd, ...args], { encoding: 'utf8' })
    return JSON.parse(out) as unknown
  }
}

describe('ClaimsVault pooling + settlement (localnet)', () => {
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

  function addrHex(addr: string): string {
    return Buffer.from(decodeAddress(addr).publicKey).toString('hex')
  }

  function concatHex(hexes: string[]): Uint8Array {
    return new Uint8Array(Buffer.concat(hexes.map((h) => Buffer.from(h, 'hex'))))
  }

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

  async function balanceOf(addr: string): Promise<bigint> {
    return (await algorand.account.getInformation(addr)).balance.microAlgo
  }

  async function minBalanceOf(addr: string): Promise<bigint> {
    return (await algorand.account.getInformation(addr)).minBalance.microAlgo
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
   * Pledge through `[pay, campaign.pledge, vault.credit]`, tracking the tree. Returns the payment TxID (hex).
   *
   * @param appId The campaign application id.
   * @param backerAddr The backer's address.
   * @param amount Pledge amount in microAlgos.
   * @param tree This campaign's oracle tree.
   * @returns The confirmed payment TxID (hex).
   */
  async function pledge(appId: bigint, backerAddr: string, amount: bigint, tree: Tree): Promise<string> {
    const front = tree.cmd('frontier') as { peaks: string[] }
    const pay = await algorand.createTransaction.payment({ sender: backerAddr, receiver: vaultAddress, amount: microAlgos(amount) })
    const composer = algorand.send.newGroup()
    // The payment object is referenced by the pledge call, which pulls it into the group ahead of the call.
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
    const exp = tree.cmd('append', addrHex(backerAddr), amount.toString(), txidHex) as OracleState
    const box = await boxOf(appId)
    expect(box.paidIn).toEqual(BigInt(exp.raised))
    return txidHex
  }

  async function campaignRefund(
    appClient: AppClient,
    appId: bigint,
    backerAddr: string,
    k: number,
    amount: bigint,
    txidHex: string,
    tree: Tree,
  ): Promise<void> {
    const p = tree.cmd('path', k.toString()) as OraclePath
    const blob = concatHex([...p.siblings, ...(p.top === null ? [] : [p.top]), ...p.lower])
    await appClient.send.call({
      method: 'refund(uint64,uint64,byte[],byte[])void',
      args: [BigInt(k), amount, Buffer.from(txidHex, 'hex'), blob],
      sender: backerAddr,
      appReferences: [vaultId],
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(3n * FEE),
      suppressLog: true,
    })
    const exp = tree.cmd('null', k.toString(), amount.toString()) as OracleState
    const box = await boxOf(appId)
    // The vault box root stays Z until settlement; only the campaign tracks the live root (campaign suite).
    expect(box.paidOut).toEqual(box.paidIn - BigInt(exp.raised))
  }

  async function vaultRefund(appId: bigint, backerAddr: string, k: number, amount: bigint, txidHex: string, tree: Tree): Promise<void> {
    const p = tree.cmd('path', k.toString()) as OraclePath
    const blob = concatHex([...p.siblings, ...(p.top === null ? [] : [p.top]), ...p.lower])
    await vaultClient.send.call({
      method: 'refund(uint64,uint64,uint64,byte[],byte[])void',
      args: [appId, BigInt(k), amount, Buffer.from(txidHex, 'hex'), blob],
      sender: backerAddr,
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(3n * FEE),
      suppressLog: true,
    })
    const exp = tree.cmd('null', k.toString(), amount.toString()) as OracleState
    const box = await boxOf(appId)
    expect(box.root).toEqual(exp.root)
    expect(box.paidOut).toEqual(box.paidIn - BigInt(exp.raised))
  }

  test('first touch creates the box with exact MBR accounting', async () => {
    const tree = new Tree()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appId } = await deployCampaign(creator.addr.toString())
    expect(await boxExists(appId)).toEqual(false)

    const vaultBal0 = await balanceOf(vaultAddress)
    const vaultMin0 = await minBalanceOf(vaultAddress)
    const balB0 = await balanceOf(backer.addr.toString())
    await pledge(appId, backer.addr.toString(), 2n * ALGO, tree)

    expect(await boxExists(appId)).toEqual(true)
    const box = await boxOf(appId)
    expect(box.paidIn).toEqual(2n * ALGO)
    expect(box.paidOut).toEqual(0n)
    expect(box.status).toEqual(1)
    // The pool total rises by exactly the pledge; the new box parks 32,100 µA of minimum balance.
    expect(await balanceOf(vaultAddress)).toEqual(vaultBal0 + 2n * ALGO)
    expect(await minBalanceOf(vaultAddress)).toEqual(vaultMin0 + BOX_MBR)
    expect(await balanceOf(backer.addr.toString())).toEqual(balB0 - 2n * ALGO - (FEE + FEE + FEE_CREDIT_FIRST))
  })

  test('two campaigns share the pool with per-campaign isolation', async () => {
    const treeA = new Tree()
    const treeB = new Tree()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const caddr = creator.addr.toString()
    const backerA = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backerB = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addrA = backerA.addr.toString()
    const addrB = backerB.addr.toString()
    const { appClient: clientA, appId: idA } = await deployCampaign(caddr)
    const { appId: idB } = await deployCampaign(caddr)
    const vaultBal0 = await balanceOf(vaultAddress)

    const txA0 = await pledge(idA, addrA, 3n * ALGO, treeA)
    const txA1 = await pledge(idA, addrB, 1n * ALGO, treeA)
    await pledge(idB, addrB, 2n * ALGO, treeB)

    // Drain A entirely through its campaign; B must be untouched: same root, zero paid out.
    await advanceTime(900)
    await campaignRefund(clientA, idA, addrA, 0, 3n * ALGO, txA0, treeA)
    await campaignRefund(clientA, idA, addrB, 1, 1n * ALGO, txA1, treeA)
    const boxA = await boxOf(idA)
    expect(boxA.paidOut).toEqual(boxA.paidIn)
    const boxB = await boxOf(idB)
    expect(boxB.paidOut).toEqual(0n)
    // B was never settled: its box root is still Z (only settled boxes carry roots).
    expect(boxB.root).toEqual(Z_HEX)
    expect(boxB.paidIn).toEqual(2n * ALGO)
    // Pool holds exactly B's live pledge (A's 4 ALGO left; both boxes' MBR stays parked in min-balance).
    expect(await balanceOf(vaultAddress)).toEqual(vaultBal0 + 2n * ALGO)
  })

  test('settleOpen + vault refunds + zero-residual finalize', async () => {
    const tree = new Tree()
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const backer = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = backer.addr.toString()
    const stranger = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const { appId } = await deployCampaign(creator.addr.toString())

    const txid = await pledge(appId, addr, 2n * ALGO, tree)
    await advanceTime(900)

    // A stranger settles the vanished-creator campaign; anyone can read the FAILED state but only the box matters.
    await vaultClient.send.call({
      method: 'settleOpen(uint64)void',
      args: [appId],
      sender: stranger.addr,
      appReferences: [appId],
      suppressLog: true,
    })
    expect((await boxOf(appId)).status).toEqual(2)

    // The backer refunds straight from the vault; a second attempt fails on the nulled leaf.
    const balB = await balanceOf(addr)
    await vaultRefund(appId, addr, 0, 2n * ALGO, txid, tree)
    expect(await balanceOf(addr)).toEqual(balB + 2n * ALGO - FEE_VAULT_REFUND)
    const dup = tree.cmd('path', '0') as OraclePath
    const blob = concatHex([...dup.siblings, ...(dup.top === null ? [] : [dup.top]), ...dup.lower])
    await expect(
      vaultClient.send.call({
        method: 'refund(uint64,uint64,uint64,byte[],byte[])void',
        args: [appId, 0n, 2n * ALGO, Buffer.from(txid, 'hex'), blob],
        sender: addr,
        boxReferences: [vaultBoxRef(appId)],
        extraFee: microAlgos(3n * FEE),
        suppressLog: true,
      }),
    ).rejects.toThrow(/proof does not match root/)

    // Nothing left: finalize deletes the box with no payment (only its own fee).
    await advanceTime(4_000)
    const vaultMin = await minBalanceOf(vaultAddress)
    const caller = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const balC0 = await balanceOf(caller.addr.toString())
    await vaultClient.send.call({
      method: 'finalize(uint64)void',
      args: [appId],
      sender: caller.addr,
      suppressLog: true,
    })
    expect(await boxExists(appId)).toEqual(false)
    expect(await balanceOf(caller.addr.toString())).toEqual(balC0 - FEE_FINALIZE_BARE)
    // The box MBR returns to the spendable pool (nothing was swept).
    expect(await minBalanceOf(vaultAddress)).toEqual(vaultMin - BOX_MBR)
  })

  test('direct credit without a pledge strands only the deviator funds (spec §17 #29)', async () => {
    const creator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const deviator = await fixture.context.generateAccount({ initialFunds: (100).algo(), suppressLog: true })
    const addr = deviator.addr.toString()
    const { appId } = await deployCampaign(creator.addr.toString())

    // Pay + credit with no pledge call: the payment is added explicitly (credit takes no txn arg, so no duplication).
    const pay = await algorand.createTransaction.payment({ sender: addr, receiver: vaultAddress, amount: microAlgos(ALGO) })
    const composer = algorand.send.newGroup()
    composer.addTransaction(pay)
    composer.addAppCallMethodCall({
      appId: vaultId,
      method: ABIMethod.fromSignature('credit(uint64,uint64)void'),
      args: [appId, ALGO],
      sender: addr,
      appReferences: [factoryId],
      boxReferences: [vaultBoxRef(appId), registrationBoxRef(appId)],
      extraFee: microAlgos(FEE),
    })
    await composer.send({ suppressLog: true })

    // paidIn counts the real payment, but no leaf exists: no proof can ever verify against it.
    const box = await boxOf(appId)
    expect(box.paidIn).toEqual(ALGO)
    expect(box.n).toEqual(0n)
    await advanceTime(900)
    // Pristine delete settles the stray box to FAILED (settle no-ops only when no box exists)...
    const campaignClient = new AppFactory({ appSpec: campaignSpec, algorand, defaultSender: creator.addr.toString() }).getAppClientById({
      appId,
    })
    await campaignClient.send.delete({
      method: 'delete()void',
      sender: creator.addr.toString(),
      appReferences: [vaultId],
      boxReferences: [vaultBoxRef(appId)],
      extraFee: microAlgos(2n * FEE),
      suppressLog: true,
    })
    expect((await boxOf(appId)).status).toEqual(2)
    // ...and after the window the stray inflow sweeps to the target: nobody else was ever affected.
    await advanceTime(4_000)
    const balS0 = await balanceOf(sweeperAddr)
    const balD0 = await balanceOf(addr)
    await vaultClient.send.call({
      method: 'finalize(uint64)void',
      args: [appId],
      sender: addr,
      extraFee: microAlgos(FEE),
      suppressLog: true,
    })
    expect(await balanceOf(sweeperAddr)).toEqual(balS0 + ALGO)
    expect(await balanceOf(addr)).toEqual(balD0 - FEE_FINALIZE_PAID)
    expect(await boxExists(appId)).toEqual(false)
  })
})
