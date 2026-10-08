import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Nav from './Nav'

const useWalletMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
  WalletId: { KMD: 'kmd' },
}))

describe('Nav', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
  })

  it('renders the brand and connect button when disconnected', () => {
    render(<Nav onNavigateHome={() => {}} />)
    expect(screen.getByText('AlgorArt')).toBeInTheDocument()
    expect(screen.getByText('Connect wallet')).toBeInTheDocument()
  })

  it('renders the ellipsed address and account button when connected', () => {
    useWalletMock.mockReturnValue({ activeAddress: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' })
    render(<Nav onNavigateHome={() => {}} />)
    expect(screen.getByText('ABCDEF...456789')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument()
  })

  it('calls onNavigateHome when the brand is clicked', async () => {
    const onNavigateHome = vi.fn()
    const user = userEvent.setup()
    render(<Nav onNavigateHome={onNavigateHome} />)
    await user.click(screen.getByText('AlgorArt'))
    expect(onNavigateHome).toHaveBeenCalled()
  })

  it('opens the wallet modal when the connect button is clicked', async () => {
    const user = userEvent.setup()
    render(<Nav onNavigateHome={() => {}} />)
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
    render(<Nav onNavigateHome={() => {}} />)
    await user.click(screen.getByText('Connect wallet'))
    await user.click(screen.getByText('Pera Wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    expect(await screen.findByText(/Could not connect with Pera Wallet/)).toBeInTheDocument()
  })

  it('keeps the menu open when disconnecting while it is open', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'CONNECTED', wallets: [] })
    const user = userEvent.setup()
    const { rerender } = render(<Nav onNavigateHome={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Account' }))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    rerender(<Nav onNavigateHome={() => {}} />)
    expect(dialog).not.toHaveClass('hidden')
  })

  it('hides the menu when a provider flow starts', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    useWalletMock.mockReturnValue({
      activeAddress: null,
      wallets: [{ id: 'pera', metadata: { name: 'Pera Wallet', icon: '' }, connect, isActive: false }],
    })
    const user = userEvent.setup()
    render(<Nav onNavigateHome={() => {}} />)
    await user.click(screen.getByText('Connect wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    await user.click(screen.getByText('Pera Wallet'))
    expect(dialog).toHaveClass('hidden')
  })

  it('closes the wallet banner after a successful connect', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    const user = userEvent.setup()
    const { rerender } = render(<Nav onNavigateHome={() => {}} />)
    await user.click(screen.getByText('Connect wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    useWalletMock.mockReturnValue({ activeAddress: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', wallets: [] })
    rerender(<Nav onNavigateHome={() => {}} />)
    expect(dialog).toHaveClass('hidden')
  })

  it('toggles the wallet banner when the connect button is clicked twice', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    const user = userEvent.setup()
    render(<Nav onNavigateHome={() => {}} />)
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
        <Nav onNavigateHome={() => {}} />
        <main>page content</main>
      </>,
    )
    await user.click(screen.getByText('Connect wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).not.toHaveClass('hidden')
    await user.click(screen.getByText('page content'))
    expect(dialog).toHaveClass('hidden')
  })
})
