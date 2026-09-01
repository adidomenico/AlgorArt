import type { TransactionSigner } from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claim, createCampaign, pledge, refund } from './transaction'

const { sendCreateMock, sendClaimMock, sendRefundMock, sendPledgeMock, paymentMock, waitForIndexerRoundMock, waitForIndexerCatchUpMock } =
  vi.hoisted(() => ({
    sendCreateMock: vi.fn(),
    sendClaimMock: vi.fn(),
    sendRefundMock: vi.fn(),
    sendPledgeMock: vi.fn(),
    paymentMock: vi.fn(),
    waitForIndexerRoundMock: vi.fn(),
    waitForIndexerCatchUpMock: vi.fn(),
  }))

vi.mock('../contracts/Campaign', () => ({
  CampaignClient: class {
    appAddress = 'ESCROWADDRESS'
    send = {
      claim: sendClaimMock,
      refund: sendRefundMock,
      pledge: sendPledgeMock,
    }
  },
  CampaignFactory: class {
    send = { create: { create: sendCreateMock } }
  },
}))

vi.mock('./algorand', () => ({
  algorand: {
    createTransaction: { payment: paymentMock },
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

  it('createCampaign deploys via the factory and returns appId/appAddress', async () => {
    sendCreateMock.mockResolvedValue({ result: { appId: 9n, appAddress: { toString: () => 'ESCROW' } } })

    const result = await createCampaign(session, 'My campaign', 'ipfs://meta', 5_000_000n, 1_000n)

    expect(sendCreateMock).toHaveBeenCalledWith({
      args: {
        title: new TextEncoder().encode('My campaign'),
        metadataUri: new TextEncoder().encode('ipfs://meta'),
        goal: 5_000_000n,
        deadline: 1_000n,
      },
    })
    expect(result).toEqual({ appId: 9n, appAddress: 'ESCROW' })
    expect(waitForIndexerCatchUpMock).toHaveBeenCalled()
  })

  it('pledge builds a payment to the escrow and sends the pledge', async () => {
    paymentMock.mockResolvedValue({ payment: 'txn' })
    sendPledgeMock.mockResolvedValue({ confirmation: { confirmedRound: 7n } })

    await pledge(42n, session, 1_000_000n)

    expect(paymentMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      receiver: 'ESCROWADDRESS',
      amount: expect.anything(),
    })
    expect(sendPledgeMock).toHaveBeenCalled()
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(7n)
  })

  it('claim sends a bare claim call covering inner fees', async () => {
    sendClaimMock.mockResolvedValue({ confirmation: { confirmedRound: 8n } })
    await claim(42n, session)
    expect(sendClaimMock).toHaveBeenCalledWith({ args: [], coverAppCallInnerTransactionFees: true })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(8n)
  })

  it('refund sends a bare refund call covering inner fees', async () => {
    sendRefundMock.mockResolvedValue({ confirmation: { confirmedRound: 9n } })
    await refund(42n, session)
    expect(sendRefundMock).toHaveBeenCalledWith({ args: [], coverAppCallInnerTransactionFees: true })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(9n)
  })

  it('skips the indexer wait when the confirmed round is unavailable', async () => {
    sendClaimMock.mockResolvedValue({ confirmation: {} })
    await claim(42n, session)
    expect(waitForIndexerRoundMock).not.toHaveBeenCalled()
  })
})
