import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelPledge, claim, closeOut, createCampaign, deleteCampaign, pledge, refund, vaultAddress } from './transaction'

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
  sendIssueClaimAsaMock,
  sendAttachClaimAsaMock,
  sendSeedSupplyMock,
  sendVaultRefundMock,
  asaOfValueMock,
  paymentMock,
  assetTransferMock,
  assetOptInMock,
  fetchClaimAsaIdMock,
  fetchClaimHoldingMock,
  lookupApplicationsMock,
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
  sendIssueClaimAsaMock: vi.fn(),
  sendAttachClaimAsaMock: vi.fn(),
  sendSeedSupplyMock: vi.fn(),
  sendVaultRefundMock: vi.fn(),
  asaOfValueMock: vi.fn(),
  paymentMock: vi.fn(),
  assetTransferMock: vi.fn(),
  assetOptInMock: vi.fn(),
  fetchClaimAsaIdMock: vi.fn(),
  fetchClaimHoldingMock: vi.fn(),
  lookupApplicationsMock: vi.fn(),
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
      attachClaimAsa: sendAttachClaimAsaMock,
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
    send = {
      issueClaimAsa: sendIssueClaimAsaMock,
      seedSupply: sendSeedSupplyMock,
      refund: sendVaultRefundMock,
    }
    state = {
      box: { asaOf: { value: (...args: unknown[]) => asaOfValueMock(...args) } },
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
  fetchClaimAsaId: (...args: unknown[]) => fetchClaimAsaIdMock(...args),
  fetchClaimHolding: (...args: unknown[]) => fetchClaimHoldingMock(...args),
}))

vi.mock('./algorand', () => ({
  algorand: {
    createTransaction: { payment: paymentMock, assetTransfer: assetTransferMock },
    send: { assetOptIn: assetOptInMock },
    client: { algod: { status: () => ({ do: () => Promise.resolve({ lastRound: 99n }) }) } },
  },
  indexer: {
    lookupApplications: (...args: unknown[]) => lookupApplicationsMock(...args),
  },
  waitForIndexerRound: (...args: unknown[]) => waitForIndexerRoundMock(...args),
  waitForIndexerCatchUp: (...args: unknown[]) => waitForIndexerCatchUpMock(...args),
}))

const session = {
  address: 'ADDRESS',
  signer: (() => new Uint8Array()) as unknown as TransactionSigner,
}

// The real app-account address of the configured vault (app id 2002).
const VAULT_APP_ADDRESS = algosdk.getApplicationAddress(2002).toString()

/**
 * The vault's box references for a campaign — the same bytes the helpers build.
 *
 * @param appId The campaign application id.
 * @param prefixes The vault box key prefixes.
 * @returns Box references for the vault app.
 */
function vaultBoxes(appId: bigint, prefixes: string[]) {
  const appIdBytes = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    appIdBytes[i] = Number(appId & 0xffn)
    appId >>= 8n
  }
  return prefixes.map((prefix) => ({
    appId: 2002n,
    name: new Uint8Array([...new TextEncoder().encode(prefix), ...appIdBytes]),
  }))
}

describe('transaction helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    waitForIndexerRoundMock.mockResolvedValue(undefined)
    waitForIndexerCatchUpMock.mockResolvedValue(undefined)
    fetchClaimAsaIdMock.mockResolvedValue(777n)
    fetchClaimHoldingMock.mockResolvedValue({ optedIn: true, balance: 1_000_000n })
    asaOfValueMock.mockResolvedValue(777n)
  })

  it('vaultAddress derives from the configured vault app id', () => {
    expect(vaultAddress()).toBe(VAULT_APP_ADDRESS)
  })

  it('createCampaign runs the full setup chain: create, fund, register, issue, attach, seed', async () => {
    sendCreateMock.mockResolvedValue({ result: { appId: 9n, appAddress: { toString: () => 'ESCROW' } } })
    paymentMock.mockResolvedValueOnce({ payment: 'fund-txn' }).mockResolvedValueOnce({ payment: 'register-txn' })
    sendFundMock.mockResolvedValue({ confirmation: {} })
    sendRegisterMock.mockResolvedValue({ confirmation: {} })
    sendIssueClaimAsaMock.mockResolvedValue({ confirmation: {} })
    sendAttachClaimAsaMock.mockResolvedValue({ confirmation: {} })
    sendSeedSupplyMock.mockResolvedValue({ confirmation: {} })

    const result = await createCampaign(session, 'My campaign', 'ipfs://meta', 5_000_000n, 1_000n)

    expect(sendCreateMock).toHaveBeenCalledWith({
      args: {
        vault: 2002n,
        title: new TextEncoder().encode('My campaign'),
        metadataUri: new TextEncoder().encode('ipfs://meta'),
        goal: 5_000_000n,
        deadline: 1_000n,
      },
      appReferences: [2002n],
    })
    expect(paymentMock).toHaveBeenNthCalledWith(1, { sender: 'ADDRESS', receiver: 'ESCROWADDRESS', amount: microAlgos(200_000n) })
    expect(sendFundMock).toHaveBeenCalledWith({ args: { payment: { payment: 'fund-txn' } }, extraFee: microAlgos(1000) })
    expect(paymentMock).toHaveBeenNthCalledWith(2, { sender: 'ADDRESS', receiver: 'FACTORYADDRESS', amount: microAlgos(18_900n) })
    expect(sendRegisterMock).toHaveBeenCalledWith({ args: { app: 9n, payment: { payment: 'register-txn' } }, appReferences: [9n] })
    expect(sendIssueClaimAsaMock).toHaveBeenCalledWith({ args: { app: 9n }, appReferences: [9n, 1001n], extraFee: microAlgos(1000) })
    expect(sendAttachClaimAsaMock).toHaveBeenCalledWith({
      args: { asset: 777n },
      appReferences: [2002n],
      assetReferences: [777n],
      extraFee: microAlgos(1000),
    })
    expect(sendSeedSupplyMock).toHaveBeenCalledWith({
      args: { app: 9n },
      appReferences: [9n],
      assetReferences: [777n],
      extraFee: microAlgos(1000),
    })
    expect(result).toEqual({ appId: 9n, appAddress: 'ESCROW' })
    expect(waitForIndexerCatchUpMock).toHaveBeenCalled()
  })

  it('pledge opts in when needed, then pays the VAULT and mints claim units', async () => {
    fetchClaimHoldingMock.mockResolvedValue({ optedIn: false, balance: 0n })
    paymentMock.mockResolvedValue({ payment: 'txn' })
    sendPledgeMock.mockResolvedValue({ confirmation: { confirmedRound: 7n } })

    await pledge(42n, session, 1_000_000n)

    expect(assetOptInMock).toHaveBeenCalledWith({ sender: 'ADDRESS', assetId: 777n })
    expect(paymentMock).toHaveBeenCalledWith({ sender: 'ADDRESS', receiver: VAULT_APP_ADDRESS, amount: microAlgos(1_000_000n) })
    expect(sendPledgeMock).toHaveBeenCalledWith({
      args: { payment: { payment: 'txn' } },
      appReferences: [2002n],
      assetReferences: [777n],
      extraFee: microAlgos(1000),
    })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(7n)
  })

  it('pledge skips the opt-in when already opted in', async () => {
    paymentMock.mockResolvedValue({ payment: 'txn' })
    sendPledgeMock.mockResolvedValue({ confirmation: {} })

    await pledge(42n, session, 1_000_000n)

    expect(assetOptInMock).not.toHaveBeenCalled()
  })

  it('claim carries the vault app, asset, and box references', async () => {
    sendClaimMock.mockResolvedValue({ confirmation: { confirmedRound: 3n } })
    await claim(42n, session)
    expect(sendClaimMock).toHaveBeenCalledWith({
      args: [],
      appReferences: [2002n],
      assetReferences: [777n],
      boxReferences: vaultBoxes(42n, ['a', 'd', 'o', 's']),
      extraFee: microAlgos(2000),
    })
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(3n)
  })

  it('refund surrenders to the vault through the campaign while it is alive', async () => {
    assetTransferMock.mockResolvedValue({ axfer: 'txn' })
    lookupApplicationsMock.mockImplementation(() => ({ do: () => Promise.resolve({ application: { deleted: false } }) }))
    sendRefundMock.mockResolvedValue({ confirmation: {} })

    await refund(42n, session)

    expect(assetTransferMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      assetId: 777n,
      receiver: VAULT_APP_ADDRESS,
      amount: 1_000_000n,
    })
    expect(sendRefundMock).toHaveBeenCalledWith({
      args: { axfer: { axfer: 'txn' } },
      appReferences: [2002n],
      boxReferences: vaultBoxes(42n, ['a', 'd']),
      extraFee: microAlgos(2000),
    })
    expect(sendVaultRefundMock).not.toHaveBeenCalled()
  })

  it('refund goes directly through the vault once the campaign is deleted', async () => {
    assetTransferMock.mockResolvedValue({ axfer: 'txn' })
    lookupApplicationsMock.mockImplementation(() => ({ do: () => Promise.resolve({ application: { deleted: true } }) }))
    sendVaultRefundMock.mockResolvedValue({ confirmation: { confirmedRound: 11n } })

    await refund(42n, session)

    expect(sendVaultRefundMock).toHaveBeenCalledWith({
      args: { app: 42n, axfer: { axfer: 'txn' } },
      appReferences: [42n],
      extraFee: microAlgos(1000),
    })
    expect(sendRefundMock).not.toHaveBeenCalled()
    expect(waitForIndexerRoundMock).toHaveBeenCalledWith(11n)
  })

  it('cancelPledge surrenders to the vault with the payout boxes', async () => {
    assetTransferMock.mockResolvedValue({ axfer: 'txn' })
    sendCancelPledgeMock.mockResolvedValue({ confirmation: {} })

    await cancelPledge(42n, session)

    expect(assetTransferMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      assetId: 777n,
      receiver: VAULT_APP_ADDRESS,
      amount: 1_000_000n,
    })
    expect(sendCancelPledgeMock).toHaveBeenCalledWith({
      args: { axfer: { axfer: 'txn' } },
      appReferences: [2002n],
      boxReferences: vaultBoxes(42n, ['a', 'd']),
      extraFee: microAlgos(2000),
    })
  })

  it('closeOut closes the claim holding to the vault', async () => {
    assetTransferMock.mockResolvedValue({ axfer: 'txn' })
    sendCloseOutMock.mockResolvedValue({ confirmation: {} })

    await closeOut(42n, session)

    expect(assetTransferMock).toHaveBeenCalledWith({
      sender: 'ADDRESS',
      assetId: 777n,
      receiver: VAULT_APP_ADDRESS,
      amount: 0n,
      closeAssetTo: VAULT_APP_ADDRESS,
    })
    expect(sendCloseOutMock).toHaveBeenCalledWith({ args: { axfer: { axfer: 'txn' } }, appReferences: [2002n] })
  })

  it('deleteCampaign carries the vault references and unregisters from the Factory', async () => {
    sendDeleteMock.mockResolvedValue({ confirmation: { confirmedRound: 5n } })
    sendUnregisterMock.mockResolvedValue({ confirmation: {} })

    await deleteCampaign(42n, session)

    expect(sendDeleteMock).toHaveBeenCalledWith({
      args: [],
      appReferences: [2002n],
      assetReferences: [777n],
      boxReferences: vaultBoxes(42n, ['a', 'd', 's']),
      extraFee: microAlgos(3000),
    })
    expect(sendUnregisterMock).toHaveBeenCalledWith({ args: { app: 42n }, appReferences: [42n], extraFee: microAlgos(1000) })
  })

  it('deleteCampaign works for a never-funded campaign (no asset or box references)', async () => {
    fetchClaimAsaIdMock.mockResolvedValue(undefined)
    sendDeleteMock.mockResolvedValue({ confirmation: {} })
    sendUnregisterMock.mockResolvedValue({ confirmation: {} })

    await deleteCampaign(42n, session)

    expect(sendDeleteMock).toHaveBeenCalledWith({
      args: [],
      appReferences: [2002n],
      assetReferences: [],
      boxReferences: [],
      extraFee: microAlgos(1000),
    })
  })
})
