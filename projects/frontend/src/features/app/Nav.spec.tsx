import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Nav from './Nav'

const useWalletMock = vi.fn()
const useNetworkMock = vi.fn()
const { getWalletManagerMock } = vi.hoisted(() => ({ getWalletManagerMock: vi.fn() }))

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
  useNetwork: () => useNetworkMock(),
}))

vi.mock('../../lib/wallets', () => ({
  getWalletManager: (...args: unknown[]) => getWalletManagerMock(...args),
}))

const defaultProps = {
  onNavigateHome: () => {},
  onNavigateProfile: () => {},
  onNavigatePledges: () => {},
  onNavigateProjects: () => {},
  onNavigateSettings: () => {},
}

const realVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')

function showTab() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
}

function hideTab() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
}

describe('Nav', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    useNetworkMock.mockReturnValue({ activeNetworkConfig: { caipChainId: 'algorand:testnet' } })
    getWalletManagerMock.mockReturnValue({ getWallet: () => undefined })
  })

  afterEach(() => {
    if (realVisibility) Object.defineProperty(document, 'visibilityState', realVisibility)
  })

  it('renders the brand and connect button when disconnected', () => {
    render(<Nav {...defaultProps} />)
    expect(screen.getByText('kasakame')).toBeInTheDocument()
    expect(screen.getByText('Connect wallet')).toBeInTheDocument()
  })

  it('renders the ellipsed address and account button when connected', () => {
    useWalletMock.mockReturnValue({ activeAddress: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' })
    render(<Nav {...defaultProps} />)
    expect(screen.getByText('ABCDEF...456789')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument()
  })

  it('calls onNavigateHome when the brand is clicked', async () => {
    const onNavigateHome = vi.fn()
    const user = userEvent.setup()
    render(<Nav {...defaultProps} onNavigateHome={onNavigateHome} />)
    await user.click(screen.getByText('kasakame'))
    expect(onNavigateHome).toHaveBeenCalled()
  })

  it('opens the wallet modal when the connect button is clicked', async () => {
    const user = userEvent.setup()
    render(<Nav {...defaultProps} />)
    await user.click(screen.getByText('Connect wallet'))
    expect(screen.getByText('Select wallet provider')).toBeInTheDocument()
  })

  it('reopens the menu when connecting fails', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('no extension'))
    useWalletMock.mockReturnValue({
      activeAddress: null,
      wallets: [{ id: 'pera', metadata: { name: 'Pera Wallet', icon: '' }, connect, isActive: false }],
    })
    const user = userEvent.setup()
    render(<Nav {...defaultProps} />)
    await user.click(screen.getByText('Connect wallet'))
    await user.click(screen.getByText('Pera Wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    expect(await screen.findByText(/Couldn't connect to Pera Wallet/)).toBeInTheDocument()
  })

  it('keeps the menu open when disconnecting while it is open', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'CONNECTED', wallets: [] })
    const user = userEvent.setup()
    const { rerender } = render(<Nav {...defaultProps} />)
    await user.click(screen.getByRole('button', { name: 'Account' }))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    rerender(<Nav {...defaultProps} />)
    expect(dialog).not.toHaveClass('hidden')
  })

  it('hides the menu when a provider flow starts', async () => {
    const connect = vi.fn().mockResolvedValue([{ address: 'ADDRESS' }])
    useWalletMock.mockReturnValue({
      activeAddress: null,
      wallets: [{ id: 'pera', metadata: { name: 'Pera Wallet', icon: '' }, connect, isActive: false }],
    })
    const user = userEvent.setup()
    render(<Nav {...defaultProps} />)
    await user.click(screen.getByText('Connect wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    await user.click(screen.getByText('Pera Wallet'))
    expect(dialog).toHaveClass('hidden')
  })

  it('closes the wallet banner after a successful connect', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    const user = userEvent.setup()
    const { rerender } = render(<Nav {...defaultProps} />)
    await user.click(screen.getByText('Connect wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    useWalletMock.mockReturnValue({ activeAddress: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', wallets: [] })
    rerender(<Nav {...defaultProps} />)
    expect(dialog).toHaveClass('hidden')
  })

  it('toggles the wallet banner when the connect button is clicked twice', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    const user = userEvent.setup()
    render(<Nav {...defaultProps} />)
    await user.click(screen.getByText('Connect wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    await user.click(screen.getByText('Connect wallet'))
    expect(dialog).toHaveClass('hidden')
  })

  it('closes the wallet banner when clicking outside the nav', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    const user = userEvent.setup()
    render(
      <>
        <Nav {...defaultProps} />
        <main>page content</main>
      </>,
    )
    await user.click(screen.getByText('Connect wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    await user.click(screen.getByText('page content'))
    expect(dialog).toHaveClass('hidden')
  })

  it('hides the menu button when disconnected', () => {
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    render(<Nav {...defaultProps} />)
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument()
  })

  it('opens the menu and navigates to each section', async () => {
    const props = {
      onNavigateHome: vi.fn(),
      onNavigateProfile: vi.fn(),
      onNavigatePledges: vi.fn(),
      onNavigateProjects: vi.fn(),
      onNavigateSettings: vi.fn(),
    }
    useWalletMock.mockReturnValue({ activeAddress: 'CONNECTED', wallets: [] })
    const user = userEvent.setup()
    render(<Nav {...props} />)

    await user.click(screen.getByRole('button', { name: 'Menu' }))
    await user.click(screen.getByRole('button', { name: 'Profile' }))
    expect(props.onNavigateProfile).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Profile' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Menu' }))
    await user.click(screen.getByRole('button', { name: 'My Pledges' }))
    expect(props.onNavigatePledges).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Menu' }))
    await user.click(screen.getByRole('button', { name: 'My Projects' }))
    expect(props.onNavigateProjects).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Menu' }))
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(props.onNavigateSettings).toHaveBeenCalledOnce()
  })

  it('closes the menu when clicking outside of it', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'CONNECTED', wallets: [] })
    const user = userEvent.setup()
    render(
      <>
        <Nav {...defaultProps} />
        <main>page content</main>
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Menu' }))
    expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument()
    await user.click(screen.getByText('page content'))
    expect(screen.queryByRole('button', { name: 'Profile' })).not.toBeInTheDocument()
  })

  it('revalidates the bridge when the tab becomes visible', async () => {
    const resumeSession = vi.fn().mockResolvedValue(['ADDRESS'])
    getWalletManagerMock.mockReturnValue({ getWallet: (key: unknown) => (key === 'defly' ? { resumeSession } : undefined) })
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: { walletKey: 'defly' }, wallets: [] })
    showTab()
    render(<Nav {...defaultProps} />)

    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => {
      expect(resumeSession).toHaveBeenCalledOnce()
    })
  })

  it('skips revalidation while the tab is hidden', async () => {
    const resumeSession = vi.fn().mockResolvedValue(['ADDRESS'])
    getWalletManagerMock.mockReturnValue({ getWallet: () => ({ resumeSession }) })
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: { walletKey: 'defly' }, wallets: [] })
    hideTab()
    render(<Nav {...defaultProps} />)

    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => {
      expect(screen.getByText('kasakame')).toBeInTheDocument()
    })
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('stays silent when revalidation finds a dead bridge', async () => {
    const resumeSession = vi.fn().mockRejectedValue(new Error('No accounts found!'))
    getWalletManagerMock.mockReturnValue({ getWallet: () => ({ resumeSession }) })
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: { walletKey: 'defly' }, wallets: [] })
    showTab()
    render(<Nav {...defaultProps} />)

    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => {
      expect(resumeSession).toHaveBeenCalledOnce()
    })
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument()
  })

  it('stops revalidating after unmount', async () => {
    const resumeSession = vi.fn().mockResolvedValue(['ADDRESS'])
    getWalletManagerMock.mockReturnValue({ getWallet: () => ({ resumeSession }) })
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: { walletKey: 'defly' }, wallets: [] })
    showTab()
    const { unmount } = render(<Nav {...defaultProps} />)
    unmount()

    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => {
      expect(screen.queryByText('kasakame')).not.toBeInTheDocument()
    })
    expect(resumeSession).not.toHaveBeenCalled()
  })
})
