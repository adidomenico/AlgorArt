import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CampaignViewModel } from '../../lib/campaign'
import CampaignList from './CampaignList'

// Capture the resolver so we can control when the promise settles, letting us
// unmount the component before the async result arrives (covers the
// `cancelled` guard branches in the effect's cleanup path).
let resolveList: ((value: CampaignViewModel[]) => void) | undefined
let rejectList: ((reason: unknown) => void) | undefined

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => ({ activeAddress: null }),
}))

const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
const campaigns: CampaignViewModel[] = [
  {
    id: 1n,
    creator: 'CREATOR1',
    goalMicroAlgos: 10_000_000n,
    raisedMicroAlgos: 5_000_000n,
    deadlineSeconds: nowSeconds + 86_400n,
    status: 'open',
  },
  {
    id: 2n,
    creator: 'CREATOR2',
    goalMicroAlgos: 20_000_000n,
    raisedMicroAlgos: 20_000_000n,
    deadlineSeconds: nowSeconds - 1n,
    status: 'funded',
  },
]

const listCampaignsMock = vi.fn()

vi.mock('../../lib/campaign', async () => {
  const actual = await vi.importActual('../../lib/campaign')
  return {
    ...actual,
    listCampaigns: (...args: unknown[]) => listCampaignsMock(...args),
  }
})

describe('CampaignList', () => {
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
    unmount()

    await new Promise((r) => setTimeout(r, 0))
    resolveList?.(campaigns)
  })

  it('does not update state when unmounted before the load rejects', async () => {
    listCampaignsMock.mockReturnValue(
      new Promise<CampaignViewModel[]>((_, reject) => {
        rejectList = reject
      }),
    )
    const { unmount } = render(<CampaignList onSelectCampaign={() => {}} />)
    unmount()

    await new Promise((r) => setTimeout(r, 0))
    rejectList?.(new Error('boom'))
  })
})
