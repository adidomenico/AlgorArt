import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
const cancelPledgeMock = vi.fn()
const deleteCampaignMock = vi.fn()
const fetchMyLeavesMock = vi.fn()
const fetchVaultBoxMock = vi.fn()
const fetchVaultConfigMock = vi.fn()

vi.mock('../../lib/transaction', () => ({
  claim: (...args: unknown[]) => claimMock(...args),
  refund: (...args: unknown[]) => refundMock(...args),
  cancelPledge: (...args: unknown[]) => cancelPledgeMock(...args),
  deleteCampaign: (...args: unknown[]) => deleteCampaignMock(...args),
  fetchMyLeaves: (...args: unknown[]) => fetchMyLeavesMock(...args),
  fetchVaultBox: (...args: unknown[]) => fetchVaultBoxMock(...args),
  fetchVaultConfig: (...args: unknown[]) => fetchVaultConfigMock(...args),
}))

const useWalletMock = vi.fn()

const fetchChainTimestampMock = vi.fn()

vi.mock('../../lib/algorand', () => ({
  fetchChainTimestamp: (...args: unknown[]) => fetchChainTimestampMock(...args),
}))

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

vi.mock('./PledgeForm', () => ({
  default: () => <div>PLEDGE_FORM</div>,
}))

const nowSeconds = BigInt(Math.floor(Date.now() / 1000))

function viewModel(
  status: string,
  overrides: {
    creator?: string
    title?: string
    metadataUri?: string
    myPledgeMicroAlgos?: bigint | undefined
    goalMicroAlgos?: bigint
    raisedMicroAlgos?: bigint
  } = {},
) {
  return {
    id: 42n,
    creator: overrides.creator ?? 'CREATOR',
    title: overrides.title ?? '',
    metadataUri: overrides.metadataUri ?? '',
    goalMicroAlgos: overrides.goalMicroAlgos ?? 10_000_000n,
    raisedMicroAlgos: overrides.raisedMicroAlgos ?? 10_000_000n,
    deadlineSeconds: nowSeconds + 86_400n,
    status,
    myPledgeMicroAlgos: overrides.myPledgeMicroAlgos,
  }
}

describe('CampaignDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: {}, transactionSigner: {} })
    fetchChainTimestampMock.mockResolvedValue(1_000_000_000n)
    fetchMyLeavesMock.mockResolvedValue([])
    fetchVaultBoxMock.mockResolvedValue(undefined)
    fetchVaultConfigMock.mockResolvedValue(undefined)
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

  it('renders the title when present and the metadata uri when set', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { title: 'My first novel', metadataUri: 'ipfs://QmExample' }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('My first novel')).toBeInTheDocument()
    expect(screen.getByText(/ipfs:\/\/QmExample/)).toBeInTheDocument()
  })

  it('shows the pledge form when open and connected', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open'))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('PLEDGE_FORM')).toBeInTheDocument()
  })

  it('hides the pledge form when the viewer is the creator', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { creator: 'ADDRESS' }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.queryByText('PLEDGE_FORM')).not.toBeInTheDocument()
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

  it('shows refund buttons, one per live leaf, when failed and the viewer has pledged', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: 1_000_000n }))
    fetchMyLeavesMock.mockResolvedValue([
      { position: 0, amount: 600_000n, txidHex: 'aa' },
      { position: 2, amount: 400_000n, txidHex: 'bb' },
    ])
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findAllByText('Refund my pledge')).toHaveLength(2)
  })

  it('hides the refund button when the viewer has not pledged', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: undefined }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.queryByText('Refund my pledge')).not.toBeInTheDocument()
  })

  it('shows a cancel pledge button when open and the viewer has pledged', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { myPledgeMicroAlgos: 1_000_000n }))
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 1_000_000n, txidHex: 'aa' }])
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('Cancel pledge')).toBeInTheDocument()
  })

  it('hides the cancel pledge button when the viewer has not pledged', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { myPledgeMicroAlgos: undefined }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.queryByText('Cancel my pledge')).not.toBeInTheDocument()
  })

  it('hides the cancel pledge button when the campaign is not open', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: 1_000_000n }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.queryByText('Cancel my pledge')).not.toBeInTheDocument()
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

  it('calls refund with the leaf when the refund button is clicked', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: 1_000_000n }))
    fetchMyLeavesMock.mockResolvedValue([{ position: 2, amount: 400_000n, txidHex: 'bb' }])
    refundMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Refund my pledge'))
    expect(refundMock).toHaveBeenCalledWith(42n, { address: 'ADDRESS', signer: {} }, { position: 2, amount: 400_000n, txidHex: 'bb' })
  })

  it('calls cancelPledge with the leaf when the cancel pledge button is clicked', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { myPledgeMicroAlgos: 1_000_000n }))
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 1_000_000n, txidHex: 'aa' }])
    cancelPledgeMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Cancel pledge'))
    expect(cancelPledgeMock).toHaveBeenCalledWith(
      42n,
      { address: 'ADDRESS', signer: {} },
      { position: 0, amount: 1_000_000n, txidHex: 'aa' },
    )
  })

  it('shows an error when claim fails', async () => {
    getCampaignMock.mockResolvedValue(viewModel('funded', { creator: 'ADDRESS' }))
    claimMock.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Claim funds'))
    expect(await screen.findByText(/Transaction failed/)).toBeInTheDocument()
  })

  it('shows the refund window banner on settled campaigns', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: 1_000_000n }))
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 1_000_000n, txidHex: 'aa' }])
    fetchVaultBoxMock.mockResolvedValue({ paidIn: 1_000_000n, paidOut: 0n, status: 2, settledAt: 5_000n })
    fetchVaultConfigMock.mockResolvedValue({ window: 3_600n, sweepTarget: 'SWEEP' })
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText(/Refunds are open until/)).toBeInTheDocument()
  })

  it('shows the deleted state with vault refunds for live leaves', async () => {
    getCampaignMock.mockResolvedValue({ ...viewModel('failed'), deleted: true })
    fetchMyLeavesMock.mockResolvedValue([{ position: 3, amount: 1_000_000n, txidHex: 'aa' }])
    refundMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText(/has been deleted/)).toBeInTheDocument()
    await user.click(await screen.findByText('Refund my pledge'))
    expect(refundMock).toHaveBeenCalledWith(42n, { address: 'ADDRESS', signer: {} }, { position: 3, amount: 1_000_000n, txidHex: 'aa' })
  })

  it('navigates back after a successful delete', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { creator: 'ADDRESS' }))
    deleteCampaignMock.mockResolvedValue(undefined)
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={onBack} />)

    await user.click(await screen.findByText('Delete campaign'))
    expect(deleteCampaignMock).toHaveBeenCalled()
    expect(onBack).toHaveBeenCalled()
  })

  it('shows an error when the indexer fetch throws', async () => {
    getCampaignMock.mockRejectedValue(new Error('boom'))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText(/Failed to load campaign/)).toBeInTheDocument()
  })

  it('shows a delete button for the creator on a settled campaign', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { creator: 'ADDRESS' }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('Delete campaign')).toBeInTheDocument()
  })

  it('hides the delete button for non-creators and open campaigns with pledges', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { raisedMicroAlgos: 5_000_000n }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.queryByText('Delete campaign')).not.toBeInTheDocument()
  })

  it('shows a delete button for the creator on an abandoned (pledge-less) open campaign', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { creator: 'ADDRESS', raisedMicroAlgos: 0n }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    expect(await screen.findByText('Delete campaign')).toBeInTheDocument()
  })

  it('calls deleteCampaign when the delete button is clicked', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { creator: 'ADDRESS' }))
    deleteCampaignMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Delete campaign'))
    expect(deleteCampaignMock).toHaveBeenCalledWith(42n, { address: 'ADDRESS', signer: {} })
  })

  it('renders with a zero-percent progress when the goal is zero', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { goalMicroAlgos: 0n, raisedMicroAlgos: 5_000_000n }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.getByText(/ALGO raised of/)).toBeInTheDocument()
  })

  it('caps the progress bar at 100% when raised exceeds the goal', async () => {
    getCampaignMock.mockResolvedValue(viewModel('funded', { creator: 'ADDRESS', goalMicroAlgos: 1_000_000n }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    const fill = document.querySelector('.detail__progress-fill') as HTMLElement
    expect(fill.style.width).toBe('100%')
  })

  it('renders the viewer pledge when one exists', async () => {
    getCampaignMock.mockResolvedValue(viewModel('open', { myPledgeMicroAlgos: 250_000n }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.getByText(/Your pledge/)).toBeInTheDocument()
  })

  it('shows a success message after a successful claim', async () => {
    getCampaignMock.mockResolvedValue(viewModel('funded', { creator: 'ADDRESS' }))
    claimMock.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Claim funds'))
    expect(await screen.findByText('Claim submitted!')).toBeInTheDocument()
  })

  it('shows an error when refund fails', async () => {
    getCampaignMock.mockResolvedValue(viewModel('failed', { myPledgeMicroAlgos: 1_000_000n }))
    fetchMyLeavesMock.mockResolvedValue([{ position: 0, amount: 1_000_000n, txidHex: 'aa' }])
    refundMock.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await user.click(await screen.findByText('Refund my pledge'))
    expect(await screen.findByText(/Transaction failed/)).toBeInTheDocument()
  })

  it('does not render a claim button for an empty creator address', async () => {
    getCampaignMock.mockResolvedValue(viewModel('funded', { creator: '' }))
    render(<CampaignDetail appId={42n} onBack={() => {}} />)

    await screen.findByText('Campaign #42')
    expect(screen.queryByText('Claim funds')).not.toBeInTheDocument()
  })
})
