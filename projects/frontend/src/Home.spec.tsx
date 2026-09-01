import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Home from './Home'

const useWalletMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

vi.mock('./features/app/Nav', () => ({
  default: ({ onNavigateHome }: { onNavigateHome: () => void }) => (
    <button type="button" onClick={onNavigateHome}>
      NAV_HOME
    </button>
  ),
}))

vi.mock('./features/campaigns/CampaignList', () => ({
  default: ({ onSelectCampaign }: { onSelectCampaign: (id: bigint) => void }) => (
    <button
      type="button"
      onClick={() => {
        onSelectCampaign(42n)
      }}
    >
      OPEN_CAMPAIGN_42
    </button>
  ),
}))

vi.mock('./features/campaigns/CampaignDetail', () => ({
  default: ({ appId, onBack }: { appId: bigint; onBack: () => void }) => (
    <div>
      DETAIL_{appId.toString()}
      <button type="button" onClick={onBack}>
        BACK
      </button>
    </div>
  ),
}))

vi.mock('./features/campaigns/CreateCampaignForm', () => ({
  default: ({ onCreated, onCancel }: { onCreated: (id: bigint) => void; onCancel: () => void }) => (
    <div>
      CREATE_FORM
      <button
        type="button"
        onClick={() => {
          onCreated(99n)
        }}
      >
        CREATED_99
      </button>
      <button type="button" onClick={onCancel}>
        CANCEL
      </button>
    </div>
  ),
}))

const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {})

describe('Home', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({})
  })

  afterEach(() => {
    // Reset the history state so tests don't leak between cases.
    window.history.replaceState(null, '')
  })

  it('renders the campaign list by default', () => {
    render(<Home />)
    expect(screen.getByText('Campaigns')).toBeInTheDocument()
  })

  it('opens the detail view when a campaign is selected', async () => {
    const user = userEvent.setup()
    render(<Home />)

    await user.click(screen.getByText('OPEN_CAMPAIGN_42'))

    expect(screen.getByText('DETAIL_42')).toBeInTheDocument()
  })

  it('uses the browser back button to return to the list', async () => {
    const user = userEvent.setup()
    render(<Home />)

    await user.click(screen.getByText('OPEN_CAMPAIGN_42'))
    expect(screen.getByText('DETAIL_42')).toBeInTheDocument()

    await user.click(screen.getByText('BACK'))
    expect(backSpy).toHaveBeenCalled()
  })

  it('restores the list when a popstate has no state', () => {
    render(<Home />)

    window.history.pushState(null, '')
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))

    expect(screen.getByText('Campaigns')).toBeInTheDocument()
  })

  it('navigates home from the brand button', async () => {
    const user = userEvent.setup()
    render(<Home />)

    await user.click(screen.getByText('OPEN_CAMPAIGN_42'))
    await user.click(screen.getByText('NAV_HOME'))

    expect(screen.getByText('Campaigns')).toBeInTheDocument()
  })
})
