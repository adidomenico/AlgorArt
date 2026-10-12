import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampaignViewModel } from '../../lib/campaign'
import { clearCachedCampaigns, setCachedCampaigns } from '../../lib/campaign'
import CampaignList from './CampaignList'

// Capture the resolver so we can control when the promise settles, letting us
// unmount the component before the async result arrives (covers the
// `cancelled` guard branches in the effect's cleanup path).
let resolveList: ((value: { campaigns: CampaignViewModel[]; nowSeconds: bigint }) => void) | undefined
let rejectList: ((reason: unknown) => void) | undefined

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

const useWalletMock = vi.fn()
beforeEach(() => {
  clearCachedCampaigns()
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
const fetchMyPledgeMock = vi.fn()

vi.mock('../../lib/campaign', async () => {
  const actual = await vi.importActual('../../lib/campaign')
  return {
    ...actual,
    listCampaigns: (...args: unknown[]) => listCampaignsMock(...args),
    fetchMyPledge: (...args: unknown[]) => fetchMyPledgeMock(...args),
  }
})

describe('CampaignList', () => {
  it('renders campaign cards when campaigns are loaded', async () => {
    listCampaignsMock.mockResolvedValue({ campaigns, nowSeconds: 1_000_000_000n })
    render(<CampaignList onSelectCampaign={() => {}} />)

    expect(await screen.findByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
  })

  it('renders an empty state when there are no campaigns', async () => {
    listCampaignsMock.mockResolvedValue({ campaigns: [], nowSeconds: 1_000_000_000n })
    render(<CampaignList onSelectCampaign={() => {}} />)

    expect(await screen.findByText(/No campaigns yet/)).toBeInTheDocument()
  })

  it('renders an error state when loading fails', async () => {
    listCampaignsMock.mockRejectedValue(new Error('boom'))
    render(<CampaignList onSelectCampaign={() => {}} />)

    expect(await screen.findByText(/Failed to load campaigns/)).toBeInTheDocument()
  })

  it('paints cached campaigns instantly without loading', () => {
    setCachedCampaigns({ campaigns, nowSeconds: 1_000_000_000n })
    let resolveRefresh: ((value: { campaigns: CampaignViewModel[]; nowSeconds: bigint }) => void) | undefined
    listCampaignsMock.mockReturnValue(
      new Promise<{ campaigns: CampaignViewModel[]; nowSeconds: bigint }>((resolve) => {
        resolveRefresh = resolve
      }),
    )
    render(<CampaignList onSelectCampaign={() => {}} />)
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.queryByText(/Loading campaigns/)).not.toBeInTheDocument()

    if (resolveRefresh === undefined) throw new Error('refresh was not requested')
    resolveRefresh({ campaigns, nowSeconds: 2_000_000_000n })
  })

  it('renders cards fast, then streams pledge totals in', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'CONNECTED' })
    listCampaignsMock.mockResolvedValue({ campaigns, nowSeconds: 1_000_000_000n })
    let resolvePledge: ((value: bigint | undefined) => void) | undefined
    fetchMyPledgeMock.mockReturnValue(
      new Promise<bigint | undefined>((resolve) => {
        resolvePledge = resolve
      }),
    )
    render(<CampaignList onSelectCampaign={() => {}} />)

    // Cards render while pledge totals are still loading.
    expect(await screen.findByText('#1')).toBeInTheDocument()
    expect(listCampaignsMock).toHaveBeenCalledWith()
    expect(fetchMyPledgeMock).toHaveBeenCalledTimes(2)

    if (resolvePledge === undefined) throw new Error('pledges were not requested')
    resolvePledge(250_000n)
    expect(await screen.findAllByText(/Your pledge/)).toHaveLength(2)
  })

  it('skips pledge totals that fail to load', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'CONNECTED' })
    listCampaignsMock.mockResolvedValue({ campaigns, nowSeconds: 1_000_000_000n })
    fetchMyPledgeMock.mockRejectedValue(new Error('offline'))
    render(<CampaignList onSelectCampaign={() => {}} />)

    expect(await screen.findByText('#1')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(/Your pledge/)).not.toBeInTheDocument()
  })

  it('does not merge pledges when unmounted mid-fill', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'CONNECTED' })
    listCampaignsMock.mockResolvedValue({ campaigns, nowSeconds: 1_000_000_000n })
    let resolvePledge: ((value: bigint | undefined) => void) | undefined
    fetchMyPledgeMock.mockReturnValue(
      new Promise<bigint | undefined>((resolve) => {
        resolvePledge = resolve
      }),
    )
    const { unmount } = render(<CampaignList onSelectCampaign={() => {}} />)
    expect(await screen.findByText('#1')).toBeInTheDocument()
    unmount()

    if (resolvePledge === undefined) throw new Error('pledges were not requested')
    resolvePledge(250_000n)
    await new Promise((r) => setTimeout(r, 0))
  })

  it('calls onSelectCampaign when a card is clicked', async () => {
    listCampaignsMock.mockResolvedValue({ campaigns, nowSeconds: 1_000_000_000n })
    const onSelectCampaign = vi.fn()
    const user = userEvent.setup()
    render(<CampaignList onSelectCampaign={onSelectCampaign} />)

    await user.click(await screen.findByText('#1'))
    expect(onSelectCampaign).toHaveBeenCalledWith(1n)
  })

  it('does not update state when unmounted before the load resolves', async () => {
    listCampaignsMock.mockReturnValue(
      new Promise<{ campaigns: CampaignViewModel[]; nowSeconds: bigint }>((resolve) => {
        resolveList = resolve
      }),
    )
    const { unmount } = render(<CampaignList onSelectCampaign={() => {}} />)
    // Let the effect reach listCampaigns before unmounting.
    await new Promise((r) => setTimeout(r, 0))
    unmount()

    await new Promise((r) => setTimeout(r, 0))
    resolveList?.({ campaigns, nowSeconds: 1_000_000_000n })
    expect(screen.queryByText('#1')).not.toBeInTheDocument()
  })

  it('does not update state when unmounted before the load rejects', async () => {
    listCampaignsMock.mockReturnValue(
      new Promise<{ campaigns: CampaignViewModel[]; nowSeconds: bigint }>((_, reject) => {
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
