import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampaignViewModel } from '../../lib/campaign'
import CampaignList from './CampaignList'

// Capture the resolver so we can control when the promise settles, letting us
// unmount the component before the async result arrives (covers the
// `cancelled` guard branches in the effect's cleanup path).
let resolveList: ((value: CampaignViewModel[]) => void) | undefined
let rejectList: ((reason: unknown) => void) | undefined

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

const useWalletMock = vi.fn()
beforeEach(() => {
  useWalletMock.mockReturnValue({ activeAddress: null })
})

const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
const campaigns: CampaignViewModel[] = [
  {
    id: 1n,
    creator: 'CREATOR1',
    title: 'First campaign',
    metadataUri: '',
    goalMicroAlgos: 10_000_000n,
    raisedMicroAlgos: 5_000_000n,
    deadlineSeconds: nowSeconds + 86_400n,
    status: 'open',
  },
  {
    id: 2n,
    creator: 'CREATOR2',
    title: 'Second campaign',
    metadataUri: 'ipfs://QmSecond',
    goalMicroAlgos: 20_000_000n,
    raisedMicroAlgos: 20_000_000n,
    deadlineSeconds: nowSeconds - 1n,
    status: 'funded',
  },
]

const listCampaignsMock = vi.fn()
const fetchChainTimestampMock = vi.fn()

vi.mock('../../lib/campaign', async () => {
  const actual = await vi.importActual('../../lib/campaign')
  return {
    ...actual,
    listCampaigns: (...args: unknown[]) => listCampaignsMock(...args),
  }
})

vi.mock('../../lib/algorand', () => ({
  fetchChainTimestamp: (...args: unknown[]) => fetchChainTimestampMock(...args),
}))

describe('CampaignList', () => {
  beforeEach(() => {
    fetchChainTimestampMock.mockResolvedValue(1_000_000_000n)
  })

  it('renders campaign cards when campaigns are loaded', async () => {
    listCampaignsMock.mockResolvedValue(campaigns)
    render(<CampaignList onSelectCampaign={() => {}} />)

    expect(await screen.findByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
  })

  it('renders an empty state when there are no campaigns', async () => {
    listCampaignsMock.mockResolvedValue([])
    render(<CampaignList onSelectCampaign={() => {}} />)

    expect(await screen.findByText(/No campaigns yet/)).toBeInTheDocument()
  })

  it('renders an error state when loading fails', async () => {
    listCampaignsMock.mockRejectedValue(new Error('boom'))
    render(<CampaignList onSelectCampaign={() => {}} />)

    expect(await screen.findByText(/Failed to load campaigns/)).toBeInTheDocument()
  })

  it('passes the connected address when loading', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'CONNECTED' })
    listCampaignsMock.mockResolvedValue(campaigns)
    render(<CampaignList onSelectCampaign={() => {}} />)

    expect(await screen.findByText('#1')).toBeInTheDocument()
    expect(listCampaignsMock).toHaveBeenCalledWith(1_000_000_000n, 'CONNECTED')
  })

  it('calls onSelectCampaign when a card is clicked', async () => {
    listCampaignsMock.mockResolvedValue(campaigns)
    const onSelectCampaign = vi.fn()
    const user = userEvent.setup()
    render(<CampaignList onSelectCampaign={onSelectCampaign} />)

    await user.click(await screen.findByText('#1'))
    expect(onSelectCampaign).toHaveBeenCalledWith(1n)
  })

  it('does not update state when unmounted before the load resolves', async () => {
    listCampaignsMock.mockReturnValue(
      new Promise<CampaignViewModel[]>((resolve) => {
        resolveList = resolve
      }),
    )
    const { unmount } = render(<CampaignList onSelectCampaign={() => {}} />)
    // Let the effect reach listCampaigns before unmounting.
    await new Promise((r) => setTimeout(r, 0))
    unmount()

    await new Promise((r) => setTimeout(r, 0))
    resolveList?.(campaigns)
    expect(screen.queryByText('#1')).not.toBeInTheDocument()
  })

  it('does not list campaigns when unmounted before the timestamp resolves', async () => {
    let resolveTimestamp: ((value: bigint) => void) | undefined
    fetchChainTimestampMock.mockReturnValue(
      new Promise<bigint>((resolve) => {
        resolveTimestamp = resolve
      }),
    )
    listCampaignsMock.mockClear()
    const { unmount } = render(<CampaignList onSelectCampaign={() => {}} />)
    unmount()

    if (resolveTimestamp === undefined) throw new Error('timestamp was not requested')
    resolveTimestamp(1_000_000_000n)
    await new Promise((r) => setTimeout(r, 0))
    expect(listCampaignsMock).not.toHaveBeenCalled()
  })

  it('does not update state when unmounted before the load rejects', async () => {
    listCampaignsMock.mockReturnValue(
      new Promise<CampaignViewModel[]>((_, reject) => {
        rejectList = reject
      }),
    )
    const { unmount } = render(<CampaignList onSelectCampaign={() => {}} />)
    // Let the effect reach listCampaigns so the component observes the
    // rejection - an unobserved rejection fails the run as unhandled.
    await new Promise((r) => setTimeout(r, 0))
    unmount()

    await new Promise((r) => setTimeout(r, 0))
    rejectList?.(new Error('boom'))
    expect(screen.queryByText(/Failed to load campaigns/)).not.toBeInTheDocument()
  })
})
