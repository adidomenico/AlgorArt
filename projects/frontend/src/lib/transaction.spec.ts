import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelPledge, claim, createCampaign, pledge, refund } from './transaction'

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'

const {
  sendCreateMock,
  sendFundMock,
  sendClaimMock,
  sendRefundMock,
  sendPledgeMock,
  sendCancelPledgeMock,
  paymentMock,
  fetchPledgesForBackerMock,
  waitForIndexerRoundMock,
  waitForIndexerCatchUpMock,
} = vi.hoisted(() => ({
  sendCreateMock: vi.fn(),
  sendFundMock: vi.fn(),
  sendClaimMock: vi.fn(),
  sendRefundMock: vi.fn(),
  sendPledgeMock: vi.fn(),
  sendCancelPledgeMock: vi.fn(),
  paymentMock: vi.fn(),
  fetchPledgesForBackerMock: vi.fn(),
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
    }
  },
  CampaignFactory: class {
    send = { create: { create: sendCreateMock } }
  },
}))

vi.mock('./campaign', () => ({
  fetchPledgesForBacker: (...args: unknown[]) => fetchPledgesForBackerMock(...args),
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

  it('createCampaign deploys, funds the storage deposit, and returns appId/appAddress', async () => {
    sendCreateMock.mockResolvedValue({ result: { appId: 9n, appAddress: { toString: () => 'ESCROW' } } })
    paymentMock.mockResolvedValue({ payment: 'txn' })
    sendFundMock.mockResolvedValue({ confirmation: {} })

    const result = await createCampaign(session, 'My campaign', 'ipfs://meta', 5_000_000n, 1_000n)

    expect(sendCreateMock).toHaveBeenCalledWith({
      args: {
        title: new TextEncoder().encode('My campaign'),
        metadataUri: new TextEncoder().encode('ipfs://meta'),
        goal: 5_000_000n,
        deadline: 1_000n,
      },
    })
    expect(paymentMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      receiver: 'ESCROWADDRESS',
      amount: microAlgos(2_303_300n),
    })
    expect(sendFundMock).toHaveBeenCalledWith({ args: { payment: { payment: 'txn' } } })
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
    expect(sendClaimMock).toHaveBeenCalledWith({ args: [], extraFee: expect.anything() })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(8n)
  })

  it('refund reconstructs the tree and refunds each live leaf with a proof', async () => {
    fetchPledgesForBackerMock.mockResolvedValue({
      leaves: [{ address: ZERO_ADDRESS, amount: 1_000_000n }],
      live: [{ index: 0, amount: 1_000_000n }],
    })
    sendRefundMock.mockResolvedValue({ confirmation: { confirmedRound: 9n } })

    await refund(42n, session)

    expect(fetchPledgesForBackerMock).toHaveBeenCalledWith(42n, 'ADDRESS')
    expect(sendRefundMock).toHaveBeenCalledWith({
      args: { proof: expect.any(Uint8Array), index: 0, amount: 1_000_000n },
      extraFee: expect.anything(),
    })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(9n)
  })

  it('refund refunds multiple live leaves one transaction each', async () => {
    fetchPledgesForBackerMock.mockResolvedValue({
      leaves: [
        { address: ZERO_ADDRESS, amount: 1_000_000n },
        { address: ZERO_ADDRESS, amount: 2_000_000n },
      ],
      live: [
        { index: 0, amount: 1_000_000n },
        { index: 1, amount: 2_000_000n },
      ],
    })
    sendRefundMock.mockResolvedValue({ confirmation: { confirmedRound: 9n } })

    await refund(42n, session)

    expect(sendRefundMock).toHaveBeenCalledTimes(2)
    expect(sendRefundMock).toHaveBeenNthCalledWith(2, {
      args: { proof: expect.any(Uint8Array), index: 1, amount: 2_000_000n },
      extraFee: expect.anything(),
    })
  })

  it('refund throws when the backer has no live leaves', async () => {
    fetchPledgesForBackerMock.mockResolvedValue({ leaves: [], live: [] })

    await expect(refund(42n, session)).rejects.toThrow(/no live pledge/)
    expect(sendRefundMock).not.toHaveBeenCalled()
  })

  it('cancelPledge reconstructs the tree and cancels each live leaf with a proof', async () => {
    fetchPledgesForBackerMock.mockResolvedValue({
      leaves: [{ address: ZERO_ADDRESS, amount: 1_000_000n }],
      live: [{ index: 0, amount: 1_000_000n }],
    })
    sendCancelPledgeMock.mockResolvedValue({ confirmation: { confirmedRound: 10n } })

    await cancelPledge(42n, session)

    expect(sendCancelPledgeMock).toHaveBeenCalledWith({
      args: { proof: expect.any(Uint8Array), index: 0, amount: 1_000_000n },
      extraFee: expect.anything(),
    })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(10n)
  })

  it('cancelPledge throws when the backer has no live leaves', async () => {
    fetchPledgesForBackerMock.mockResolvedValue({ leaves: [], live: [] })

    await expect(cancelPledge(42n, session)).rejects.toThrow(/no live pledge/)
    expect(sendCancelPledgeMock).not.toHaveBeenCalled()
  })

  it('skips the indexer wait when the confirmed round is unavailable', async () => {
    sendClaimMock.mockResolvedValue({ confirmation: {} })
    await claim(42n, session)
    expect(waitForIndexerRoundMock).not.toHaveBeenCalled()
  })
})
