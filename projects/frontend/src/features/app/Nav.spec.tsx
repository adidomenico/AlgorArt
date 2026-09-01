import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import Nav from './Nav'

const useWalletMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
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
    expect(screen.getByText('Account')).toBeInTheDocument()
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

  it('closes the wallet modal via the modal Close button', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null, wallets: [] })
    const user = userEvent.setup()
    render(<Nav onNavigateHome={() => {}} />)
    await user.click(screen.getByText('Connect wallet'))
    const dialog = document.getElementById('connect_wallet_modal')
    expect(dialog).toHaveClass('modal-open')
    await user.click(screen.getByText('Close'))
    expect(dialog).not.toHaveClass('modal-open')
  })
})
