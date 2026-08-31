import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CampaignDetail from './CampaignDetail'

const getCampaignMock = vi.fn()

vi.mock('../../lib/campaign', async () => {
  const actual = await vi.importActual('../../lib/campaign')
  return {
    ...actual,
    getCampaign: (...args: unknown[]) => getCampaignMock(...args),
  }
})

const claimMock = vi.fn()
const refundMock = vi.fn()

vi.mock('../../lib/transaction', () => ({
  claim: (...args: unknown[]) => claimMock(...args),
  refund: (...args: unknown[]) => refundMock(...args),
}))

const useWalletMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

vi.mock('./PledgeForm', () => ({
  default: () => <div>PLEDGE_FORM</div>,
}))

const nowSeconds = BigInt(Math.floor(Date.now() / 1000))

function viewModel(status: string, overrides: { creator?: string; myPledgeMicroAlgos?: bigint } = {}) {
  return {
    id: 42n,
    creator: overrides.creator ?? 'CREATOR',
    goalMicroAlgos: 10_000_000n,
    raisedMicroAlgos: 10_000_000n,
    deadlineSeconds: nowSeconds + 86_400n,
    status,
    myPledgeMicroAlgos: overrides.myPledgeMicroAlgos,
  }
}

describe('CampaignDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: {}, transactionSigner: {} })
  })

  it('shows a loading state initially', () => {
    getCampaignMock.mockReturnValue(new Promise(() => {}))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)
    expect(screen.getByText('Loading campaign…')).toBeInTheDocument()
  })

  it('renders the campaign once loaded', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open'))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('Campaign #42')).toBeInTheDocument()
  })

  it('shows the pledge form when open and connected', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open'))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('PLEDGE_FORM')).toBeInTheDocument()
  })

  it('shows a claim button when funded and the viewer is the creator', async () => {
    getCampaignMock.mockResolvedValue(viewModel('funded', { creator: 'ADDRESS' }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('Claim funds')).toBeInTheDocument()
  })

  it('hides the claim button when the viewer is not the creator', async () => {
    getCampaignMock.mockResolvedValue(viewModel('funded', { creator: 'SOMEONEELSE' }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.queryByText('Claim funds')).not.toBeInTheDocument()
  })

  it('shows a refund button when failed and the viewer has pledged', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: 1_000_000n }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('Refund my pledge')).toBeInTheDocument()
  })

  it('hides the refund button when the viewer has not pledged', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: undefined }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.queryByText('Refund my pledge')).not.toBeInTheDocument()
  })

  it('shows an error when the campaign is missing', async () => {
    getCampaignMock.mockResolvedValue(undefined)
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText(/Campaign not found/)).toBeInTheDocument()
  })

  it('calls claim when the claim button is clicked', async () => {
    getCampaignMock.mockResolvedValue(viewModel('funded', { creator: 'ADDRESS' }))
    claimMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Claim funds'))
    expect(claimMock).toHaveBeenCalledWith(42n, { address: 'ADDRESS', signer: {} })
  })

  it('calls refund when the refund button is clicked', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: 1_000_000n }))
    refundMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Refund my pledge'))
    expect(refundMock).toHaveBeenCalledWith(42n, { address: 'ADDRESS', signer: {} })
  })

  it('shows an error when claim fails', async () => {
    getCampaignMock.mockResolvedValue(viewModel('funded', { creator: 'ADDRESS' }))
    claimMock.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Claim funds'))
    expect(await screen.findByText(/Transaction failed/)).toBeInTheDocument()
  })
})
