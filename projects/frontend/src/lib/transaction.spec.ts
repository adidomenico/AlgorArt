import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelPledge, claim, closeOut, createCampaign, deleteCampaign, pledge, refund } from './transaction'

const {
  sendCreateMock,
  sendFundMock,
  sendClaimMock,
  sendRefundMock,
  sendPledgeMock,
  sendCancelPledgeMock,
  sendCloseOutMock,
  sendDeleteMock,
  sendRegisterMock,
  sendUnregisterMock,
  paymentMock,
  assetTransferMock,
  assetOptInMock,
  fetchClaimAsaIdMock,
  fetchClaimHoldingMock,
  waitForIndexerRoundMock,
  waitForIndexerCatchUpMock,
} = vi.hoisted(() => ({
  sendCreateMock: vi.fn(),
  sendFundMock: vi.fn(),
  sendClaimMock: vi.fn(),
  sendRefundMock: vi.fn(),
  sendPledgeMock: vi.fn(),
  sendCancelPledgeMock: vi.fn(),
  sendCloseOutMock: vi.fn(),
  sendDeleteMock: vi.fn(),
  sendRegisterMock: vi.fn(),
  sendUnregisterMock: vi.fn(),
  paymentMock: vi.fn(),
  assetTransferMock: vi.fn(),
  assetOptInMock: vi.fn(),
  fetchClaimAsaIdMock: vi.fn(),
  fetchClaimHoldingMock: vi.fn(),
  waitForIndexerRoundMock: vi.fn(),
  waitForIndexerCatchUpMock: vi.fn(),
}))

vi.mock('../contracts/Campaign', () => ({
  CampaignClient: class {
    appAddress = 'ESCROWADDRESS'
    send = {
      fund: sendFundMock,
      claim: sendClaimMock,
      refund: sendRefundMock,
      pledge: sendPledgeMock,
      cancelPledge: sendCancelPledgeMock,
      closeOut: sendCloseOutMock,
      delete: { delete: sendDeleteMock },
    }
  },
  CampaignFactory: class {
    send = { create: { create: sendCreateMock } }
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
  fetchClaimAsaId: (...args: unknown[]) => fetchClaimAsaIdMock(...args),
  fetchClaimHolding: (...args: unknown[]) => fetchClaimHoldingMock(...args),
}))

vi.mock('./algorand', () => ({
  algorand: {
    createTransaction: { payment: paymentMock, assetTransfer: assetTransferMock },
    send: { assetOptIn: assetOptInMock },
    client: { algod: { status: () => ({ do: () => Promise.resolve({ lastRound: 99n }) }) } },
  },
  waitForIndexerRound: (...args: unknown[]) => waitForIndexerRoundMock(...args),
  waitForIndexerCatchUp: (...args: unknown[]) => waitForIndexerCatchUpMock(...args),
}))

const session = {
  address: 'ADDRESS',
  signer: (() => new Uint8Array()) as unknown as TransactionSigner,
}

describe('transaction helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    waitForIndexerRoundMock.mockResolvedValue(undefined)
    waitForIndexerCatchUpMock.mockResolvedValue(undefined)
  })

  it('createCampaign deploys, funds the storage deposit (issuing the Claim ASA), and registers with the Factory', async () => {
    sendCreateMock.mockResolvedValue({ result: { appId: 9n, appAddress: { toString: () => 'ESCROW' } } })
    paymentMock.mockResolvedValueOnce({ payment: 'fund-txn' }).mockResolvedValueOnce({ payment: 'register-txn' })
    sendFundMock.mockResolvedValue({ confirmation: {} })
    sendRegisterMock.mockResolvedValue({ confirmation: {} })

    const result = await createCampaign(session, 'My campaign', 'ipfs://meta', 5_000_000n, 1_000n)

    expect(sendCreateMock).toHaveBeenCalledWith({
      args: {
        title: new TextEncoder().encode('My campaign'),
        metadataUri: new TextEncoder().encode('ipfs://meta'),
        goal: 5_000_000n,
        deadline: 1_000n,
      },
    })
    expect(paymentMock).toHaveBeenNthCalledWith(1, {
      sender: 'ADDRESS',
      receiver: 'ESCROWADDRESS',
      amount: microAlgos(200_000n),
    })
    expect(sendFundMock).toHaveBeenCalledWith({ args: { payment: { payment: 'fund-txn' } }, extraFee: microAlgos(1000) })
    expect(paymentMock).toHaveBeenNthCalledWith(2, {
      sender: 'ADDRESS',
      receiver: 'FACTORYADDRESS',
      amount: microAlgos(18_900n),
    })
    expect(sendRegisterMock).toHaveBeenCalledWith({ args: { app: 9n, payment: { payment: 'register-txn' } }, appReferences: [9n] })
    expect(result).toEqual({ appId: 9n, appAddress: 'ESCROW' })
    expect(waitForIndexerCatchUpMock).toHaveBeenCalled()
  })

  it('pledge opts in when needed, then pays the escrow and mints claim units', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(777n)
    fetchClaimHoldingMock.mockResolvedValue({ optedIn: false, balance: 0n })
    paymentMock.mockResolvedValue({ payment: 'txn' })
    sendPledgeMock.mockResolvedValue({ confirmation: { confirmedRound: 7n } })

    await pledge(42n, session, 1_000_000n)

    expect(assetOptInMock).toHaveBeenCalledWith({ sender: 'ADDRESS', assetId: 777n })
    expect(paymentMock).toHaveBeenCalledWith({ sender: 'ADDRESS', receiver: 'ESCROWADDRESS', amount: microAlgos(1_000_000n) })
    expect(sendPledgeMock).toHaveBeenCalledWith({
      args: { payment: { payment: 'txn' } },
      assetReferences: [777n],
      extraFee: microAlgos(1000),
    })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(7n)
  })

  it('pledge skips the opt-in when already opted in', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(777n)
    fetchClaimHoldingMock.mockResolvedValue({ optedIn: true, balance: 0n })
    paymentMock.mockResolvedValue({ payment: 'txn' })
    sendPledgeMock.mockResolvedValue({ confirmation: {} })

    await pledge(42n, session, 1_000_000n)

    expect(assetOptInMock).not.toHaveBeenCalled()
  })

  it('pledge rejects when the Claim ASA is not issued yet', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(undefined)
    await expect(pledge(42n, session, 1_000_000n)).rejects.toThrow(/no claim asset/)
  })

  it('claim calls the contract once', async () => {
    sendClaimMock.mockResolvedValue({ confirmation: { confirmedRound: 3n } })
    await claim(42n, session)
    expect(sendClaimMock).toHaveBeenCalledWith({ args: [], extraFee: microAlgos(1000) })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(3n)
  })

  it('refund surrenders the full claim balance', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(777n)
    fetchClaimHoldingMock.mockResolvedValue({ optedIn: true, balance: 1_000_000n })
    assetTransferMock.mockResolvedValue({ axfer: 'txn' })
    sendRefundMock.mockResolvedValue({ confirmation: {} })

    await refund(42n, session)

    expect(assetTransferMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      assetId: 777n,
      receiver: 'ESCROWADDRESS',
      amount: 1_000_000n,
    })
    expect(sendRefundMock).toHaveBeenCalledWith({ args: { axfer: { axfer: 'txn' } }, extraFee: microAlgos(1000) })
  })

  it('refund rejects when the backer holds no claim units', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(777n)
    fetchClaimHoldingMock.mockResolvedValue({ optedIn: true, balance: 0n })
    await expect(refund(42n, session)).rejects.toThrow(/no claim units/)
  })

  it('cancelPledge surrenders the full claim balance', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(777n)
    fetchClaimHoldingMock.mockResolvedValue({ optedIn: true, balance: 500_000n })
    assetTransferMock.mockResolvedValue({ axfer: 'txn' })
    sendCancelPledgeMock.mockResolvedValue({ confirmation: {} })

    await cancelPledge(42n, session)

    expect(assetTransferMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      assetId: 777n,
      receiver: 'ESCROWADDRESS',
      amount: 500_000n,
    })
    expect(sendCancelPledgeMock).toHaveBeenCalledWith({ args: { axfer: { axfer: 'txn' } }, extraFee: microAlgos(1000) })
  })

  it('closeOut closes the claim holding to the escrow', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(777n)
    assetTransferMock.mockResolvedValue({ axfer: 'txn' })
    sendCloseOutMock.mockResolvedValue({ confirmation: {} })

    await closeOut(42n, session)

    expect(assetTransferMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      assetId: 777n,
      receiver: 'ESCROWADDRESS',
      amount: 0n,
      closeAssetTo: 'ESCROWADDRESS',
    })
    expect(sendCloseOutMock).toHaveBeenCalledWith({ args: { axfer: { axfer: 'txn' } } })
  })

  it('deleteCampaign deletes with the Claim ASA reference and unregisters from the Factory', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(777n)
    sendDeleteMock.mockResolvedValue({ confirmation: { confirmedRound: 5n } })
    sendUnregisterMock.mockResolvedValue({ confirmation: {} })

    await deleteCampaign(42n, session)

    expect(sendDeleteMock).toHaveBeenCalledWith({ args: [], assetReferences: [777n], extraFee: microAlgos(2000) })
    expect(sendUnregisterMock).toHaveBeenCalledWith({ args: { app: 42n }, appReferences: [42n], extraFee: microAlgos(1000) })
  })

  it('deleteCampaign works for a never-funded campaign (no asset reference)', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(undefined)
    sendDeleteMock.mockResolvedValue({ confirmation: {} })
    sendUnregisterMock.mockResolvedValue({ confirmation: {} })

    await deleteCampaign(42n, session)

    expect(sendDeleteMock).toHaveBeenCalledWith({ args: [], assetReferences: [], extraFee: microAlgos(1000) })
  })
})
