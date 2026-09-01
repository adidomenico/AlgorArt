import type { TransactionSigner } from 'algosdk'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createCampaign, claim, pledge, refund } from './transaction'

const { sendCreateMock, sendClaimMock, sendRefundMock, sendPledgeMock, paymentMock } = vi.hoisted(() => ({
  sendCreateMock: vi.fn(),
  sendClaimMock: vi.fn(),
  sendRefundMock: vi.fn(),
  sendPledgeMock: vi.fn(),
  paymentMock: vi.fn(),
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
  },
}))

const session = {
  address: 'ADDRESS',
  signer: (() => new Uint8Array()) as unknown as TransactionSigner,
}

describe('transaction helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createCampaign deploys via the factory and returns appId/appAddress', async () => {
    sendCreateMock.mockResolvedValue({ result: { appId: 9n, appAddress: { toString: () => 'ESCROW' } } })

    const result = await createCampaign(session, 5_000_000n, 1_000n)

    expect(sendCreateMock).toHaveBeenCalledWith({ args: { goal: 5_000_000n, deadline: 1_000n } })
    expect(result).toEqual({ appId: 9n, appAddress: 'ESCROW' })
  })

  it('pledge builds a payment to the escrow and sends the pledge', async () => {
    paymentMock.mockResolvedValue({ payment: 'txn' })
    sendPledgeMock.mockResolvedValue({})

    await pledge(42n, session, 1_000_000n)

    expect(paymentMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      receiver: 'ESCROWADDRESS',
      amount: expect.anything(),
    })
    expect(sendPledgeMock).toHaveBeenCalled()
  })

  it('claim sends a bare claim call covering inner fees', async () => {
    sendClaimMock.mockResolvedValue({})
    await claim(42n, session)
    expect(sendClaimMock).toHaveBeenCalledWith({ args: [], coverAppCallInnerTransactionFees: true })
  })

  it('refund sends a bare refund call covering inner fees', async () => {
    sendRefundMock.mockResolvedValue({})
    await refund(42n, session)
    expect(sendRefundMock).toHaveBeenCalledWith({ args: [], coverAppCallInnerTransactionFees: true })
  })
})
