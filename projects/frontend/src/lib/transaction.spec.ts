import type { TransactionSigner } from 'algosdk'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPledge,
  claim,
  createCampaign,
  deleteCampaign,
  fetchMyLeaves,
  fetchVaultBox,
  fetchVaultConfig,
  pledge,
  refund,
  vaultAddress,
} from './transaction'

const {
  sendCreateMock,
  sendRegisterMock,
  sendUnregisterMock,
  sendClaimMock,
  sendRefundMock,
  sendCancelPledgeMock,
  sendDeleteMock,
  sendVaultRefundMock,
  paramsPledgeMock,
  paramsCreditMock,
  paymentMock,
  composerAddMock,
  composerSendMock,
  setSignerMock,
  campaignBoxValueMock,
  refundWindowMock,
  sweepTargetMock,
  waitForIndexerRoundMock,
  waitForIndexerCatchUpMock,
  loadTreeMock,
  frontierMock,
  pathBlobMock,
  fetchMyLeavesMock,
} = vi.hoisted(() => ({
  sendCreateMock: vi.fn(),
  sendRegisterMock: vi.fn(),
  sendUnregisterMock: vi.fn(),
  sendClaimMock: vi.fn(),
  sendRefundMock: vi.fn(),
  sendCancelPledgeMock: vi.fn(),
  sendDeleteMock: vi.fn(),
  sendVaultRefundMock: vi.fn(),
  paramsPledgeMock: vi.fn(),
  paramsCreditMock: vi.fn(),
  paymentMock: vi.fn(),
  composerAddMock: vi.fn(),
  composerSendMock: vi.fn(),
  setSignerMock: vi.fn(),
  campaignBoxValueMock: vi.fn(),
  refundWindowMock: vi.fn(),
  sweepTargetMock: vi.fn(),
  waitForIndexerRoundMock: vi.fn(),
  waitForIndexerCatchUpMock: vi.fn(),
  loadTreeMock: vi.fn(),
  frontierMock: vi.fn(),
  pathBlobMock: vi.fn(),
  fetchMyLeavesMock: vi.fn(),
}))

vi.mock('../contracts/Campaign', () => ({
  CampaignClient: class {
    appAddress = 'ESCROWADDRESS'
    params = {
      pledge: (...args: unknown[]) => paramsPledgeMock(...args),
      cancelPledge: (...args: unknown[]) => paramsPledgeMock(...args),
      refund: (...args: unknown[]) => paramsPledgeMock(...args),
      claim: (...args: unknown[]) => paramsPledgeMock(...args),
      delete: { delete: (...args: unknown[]) => paramsPledgeMock(...args) },
    }
    send = {
      claim: sendClaimMock,
      refund: sendRefundMock,
      cancelPledge: sendCancelPledgeMock,
      delete: { delete: sendDeleteMock },
    }
  },
  CampaignFactory: class {
    send = { create: { create: sendCreateMock } }
  },
}))

vi.mock('../contracts/ClaimsVault', () => ({
  ClaimsVaultClient: class {
    appAddress = 'VAULTADDRESS'
    params = {
      credit: (...args: unknown[]) => paramsCreditMock(...args),
    }
    send = {
      refund: sendVaultRefundMock,
    }
    state = {
      box: { campaignBox: { value: (...args: unknown[]) => campaignBoxValueMock(...args) } },
      global: {
        refundWindow: (...args: unknown[]) => refundWindowMock(...args),
        sweepTarget: (...args: unknown[]) => sweepTargetMock(...args),
      },
    }
  },
}))

vi.mock('../contracts/Factory', () => ({
  FactoryClient: class {
    appAddress = 'FACTORYADDRESS'
    send = {
      register: sendRegisterMock,
      unregister: sendUnregisterMock,
    }
  },
}))

vi.mock('./campaign', () => ({
  factoryAppId: () => 1001n,
  vaultAppId: () => 2002n,
}))

vi.mock('./claimtree', () => ({
  loadTree: (...args: unknown[]) => loadTreeMock(...args),
  frontierForPledge: (...args: unknown[]) => frontierMock(...args),
  pathBlobForRefund: (...args: unknown[]) => pathBlobMock(...args),
  fetchMyLeaves: (...args: unknown[]) => fetchMyLeavesMock(...args),
}))

vi.mock('./algorand', () => ({
  algorand: {
    createTransaction: { payment: paymentMock },
    send: {
      newGroup: () => ({ addAppCallMethodCall: (...args: unknown[]) => composerAddMock(...args), send: composerSendMock }),
    },
    account: { setSigner: (...args: unknown[]) => setSignerMock(...args) },
  },
  waitForIndexerRound: (...args: unknown[]) => waitForIndexerRoundMock(...args),
  waitForIndexerCatchUp: (...args: unknown[]) => waitForIndexerCatchUpMock(...args),
}))

const session = {
  address: 'ADDRESS',
  signer: (() => new Uint8Array()) as unknown as TransactionSigner,
}

// The real app-account address of the configured vault (app id 2002).
const VAULT_APP_ADDRESS = algosdk.getApplicationAddress(2002n).toString()

describe('transaction helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    waitForIndexerRoundMock.mockResolvedValue(undefined)
    waitForIndexerCatchUpMock.mockResolvedValue(undefined)
    loadTreeMock.mockResolvedValue({})
    frontierMock.mockReturnValue(new Uint8Array())
    pathBlobMock.mockReturnValue(new Uint8Array())
    fetchMyLeavesMock.mockResolvedValue([])
    paramsPledgeMock.mockResolvedValue({ pledge: 'params' })
    paramsCreditMock.mockResolvedValue({ credit: 'params' })
    paymentMock.mockResolvedValue({ payment: 'pay-txn' })
    composerSendMock.mockResolvedValue({ confirmation: { confirmedRound: 99n } })
    sendCreateMock.mockResolvedValue({ result: { appId: 9n, appAddress: { toString: () => 'ESCROW' } } })
    for (const mock of [
      sendRegisterMock,
      sendUnregisterMock,
      sendClaimMock,
      sendRefundMock,
      sendCancelPledgeMock,
      sendDeleteMock,
      sendVaultRefundMock,
    ]) {
      mock.mockResolvedValue({ confirmation: { confirmedRound: 99n } })
    }
  })

  it('vaultAddress derives from the configured vault app id', () => {
    expect(vaultAddress()).toBe(VAULT_APP_ADDRESS)
  })

  it('createCampaign runs create then register (nothing funded)', async () => {
    await createCampaign(session, 'Title', 'ipfs://meta', 1_000_000n, 2_000n)

    expect(sendCreateMock).toHaveBeenCalledOnce()
    expect(sendRegisterMock).toHaveBeenCalledOnce()
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('pledge submits one atomic [pay, pledge, credit] group with a fresh frontier', async () => {
    await pledge(9n, session, 1_000_000n)

    expect(setSignerMock).toHaveBeenCalledWith('ADDRESS', session.signer)
    expect(loadTreeMock).toHaveBeenCalledOnce()
    expect(frontierMock).toHaveBeenCalledOnce()
    expect(paramsPledgeMock).toHaveBeenCalledOnce()
    expect(paramsCreditMock).toHaveBeenCalledOnce()
    // Two app calls in one group (the payment rides along as the pledge's txn arg).
    expect(composerAddMock).toHaveBeenCalledTimes(2)
    expect(composerSendMock).toHaveBeenCalledOnce()
    expect(waitForIndexerCatchUpMock).toHaveBeenCalledOnce()
  })

  it('pledge retries once on a stale frontier, then throws', async () => {
    composerSendMock.mockRejectedValueOnce(new Error('stale or forged frontier')).mockResolvedValueOnce({})
    await pledge(9n, session, 1_000_000n)
    expect(loadTreeMock).toHaveBeenCalledTimes(2)

    composerSendMock
      .mockRejectedValueOnce(new Error('stale or forged frontier'))
      .mockRejectedValueOnce(new Error('stale or forged frontier'))
    await expect(pledge(9n, session, 1_000_000n)).rejects.toThrow('stale or forged frontier')

    composerSendMock.mockRejectedValueOnce(new Error('boom'))
    await expect(pledge(9n, session, 1_000_000n)).rejects.toThrow('boom')
  })

  it('cancelPledge spends one leaf with a fresh path', async () => {
    await cancelPledge(9n, session, { position: 2, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(pathBlobMock).toHaveBeenCalledOnce()
    expect(sendCancelPledgeMock).toHaveBeenCalledOnce()
    const call = sendCancelPledgeMock.mock.calls[0]?.[0] as {
      args: { k: number; amount: bigint }
      extraFee: unknown
      boxReferences: unknown[]
    }
    expect(call.args.k).toEqual(2)
    expect(call.args.amount).toEqual(1_000_000n)
    expect(call.boxReferences).toHaveLength(1)
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
  })

  it('refund routes through the campaign while the box is open', async () => {
    campaignBoxValueMock.mockResolvedValue(new Uint8Array(65).fill(1))
    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(sendRefundMock).toHaveBeenCalledOnce()
    expect(sendVaultRefundMock).not.toHaveBeenCalled()
  })

  it('refund routes straight to the vault once settled', async () => {
    const box = new Uint8Array(65)
    box[56] = 2
    campaignBoxValueMock.mockResolvedValue(box)
    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(sendVaultRefundMock).toHaveBeenCalledOnce()
    expect(sendRefundMock).not.toHaveBeenCalled()
  })

  it('refund routes through the campaign when no box exists yet', async () => {
    campaignBoxValueMock.mockRejectedValue(new Error('box not found'))
    await refund(9n, session, { position: 0, amount: 1_000_000n, txidHex: 'ab'.repeat(32) })

    expect(sendRefundMock).toHaveBeenCalledOnce()
  })

  it('claim pays the vault-derived total', async () => {
    await claim(9n, session)

    expect(sendClaimMock).toHaveBeenCalledOnce()
    const call = sendClaimMock.mock.calls[0]?.[0] as { extraFee: unknown; boxReferences: unknown[] }
    expect(call.boxReferences).toHaveLength(1)
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
  })

  it('deleteCampaign settles, closes, and unregisters', async () => {
    await deleteCampaign(9n, session)

    expect(sendDeleteMock).toHaveBeenCalledOnce()
    expect(sendUnregisterMock).toHaveBeenCalledOnce()
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(99n)
  })

  it('fetchMyLeaves passes through the proof builder', async () => {
    fetchMyLeavesMock.mockResolvedValue([{ position: 1, amount: 5n, txidHex: 'cd' }])
    await expect(fetchMyLeaves(9n, 'ADDRESS')).resolves.toEqual([{ position: 1, amount: 5n, txidHex: 'cd' }])
    expect(fetchMyLeavesMock).toHaveBeenCalledWith(9n, 2002n, VAULT_APP_ADDRESS, 'ADDRESS')
  })

  it('fetchVaultBox unpacks the 65-byte box, or undefined when missing', async () => {
    const box = new Uint8Array(65)
    box[56] = 2
    campaignBoxValueMock.mockResolvedValue(box)
    await expect(fetchVaultBox(9n)).resolves.toMatchObject({ status: 2 })

    campaignBoxValueMock.mockRejectedValue(new Error('missing'))
    await expect(fetchVaultBox(9n)).resolves.toBeUndefined()

    campaignBoxValueMock.mockResolvedValue(new Uint8Array(3))
    await expect(fetchVaultBox(9n)).resolves.toBeUndefined()
  })

  it('fetchVaultConfig reads window and sweep target', async () => {
    refundWindowMock.mockResolvedValue(63_072_000n)
    sweepTargetMock.mockResolvedValue('SWEEP')
    await expect(fetchVaultConfig()).resolves.toEqual({ window: 63_072_000n, sweepTarget: 'SWEEP' })
  })
})
