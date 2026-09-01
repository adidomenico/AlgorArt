import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ConnectWallet from './ConnectWallet'

const wallets = [
  { id: 'pera', metadata: { name: 'Pera Wallet', icon: 'http://icon/pera.png' }, connect: vi.fn(), isActive: false },
  { id: 'defly', metadata: { name: 'Defly Wallet', icon: 'http://icon/defly.png' }, connect: vi.fn(), isActive: false },
]

const useWalletMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
  WalletId: { KMD: 'kmd', PERA: 'pera', DEFLY: 'defly' },
}))

vi.mock('./Account', () => ({
  default: () => <div>ACCOUNT_VIEW</div>,
}))

describe('ConnectWallet', () => {
  it('renders provider buttons when disconnected', () => {
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    render(<ConnectWallet openModal closeModal={() => {}} />)

    expect(screen.getByText('Pera Wallet')).toBeInTheDocument()
    expect(screen.getByText('Defly Wallet')).toBeInTheDocument()
  })

  it('connects a provider when clicked', async () => {
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    const user = userEvent.setup()
    render(<ConnectWallet openModal closeModal={() => {}} />)

    await user.click(screen.getByText('Pera Wallet'))
    expect(wallets[0].connect).toHaveBeenCalled()
  })

  it('renders the account view and logout when connected', () => {
    const activeWallet = { ...wallets[0], isActive: true, disconnect: vi.fn() }
    useWalletMock.mockReturnValue({ wallets: [activeWallet], activeAddress: 'ADDRESS' })
    render(<ConnectWallet openModal closeModal={() => {}} />)

    expect(screen.getByText('ACCOUNT_VIEW')).toBeInTheDocument()
    expect(screen.getByText('Logout')).toBeInTheDocument()
  })

  it('disconnects the active wallet on logout', async () => {
    const disconnect = vi.fn()
    const activeWallet = { ...wallets[0], isActive: true, disconnect }
    useWalletMock.mockReturnValue({ wallets: [activeWallet], activeAddress: 'ADDRESS' })
    const user = userEvent.setup()
    render(<ConnectWallet openModal closeModal={() => {}} />)

    await user.click(screen.getByText('Logout'))
    expect(disconnect).toHaveBeenCalled()
  })

  it('cleans up and reloads when no wallet is active on logout', async () => {
    const inactiveWallets = wallets.map((w) => ({ ...w, isActive: false }))
    useWalletMock.mockReturnValue({ wallets: inactiveWallets, activeAddress: 'ADDRESS' })
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem')
    const reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    })
    const user = userEvent.setup()
    render(<ConnectWallet openModal closeModal={() => {}} />)

    await user.click(screen.getByText('Logout'))
    expect(removeItemSpy).toHaveBeenCalledWith('@txnlab/use-wallet:v3')
    expect(reloadSpy).toHaveBeenCalled()
  })

  it('renders the KMD wallet as "LocalNet Wallet" without an icon', () => {
    const kmdWallet = { id: 'kmd', metadata: { name: 'LocalNet', icon: 'http://icon/kmd.png' }, connect: vi.fn(), isActive: false }
    useWalletMock.mockReturnValue({ wallets: [kmdWallet], activeAddress: null })
    render(<ConnectWallet openModal closeModal={() => {}} />)

    expect(screen.getByText('LocalNet Wallet')).toBeInTheDocument()
    expect(screen.queryByAltText('wallet_icon_kmd')).not.toBeInTheDocument()
  })

  it('closes the modal when Close is clicked', async () => {
    const closeModal = vi.fn()
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    const user = userEvent.setup()
    render(<ConnectWallet openModal closeModal={closeModal} />)

    await user.click(screen.getByText('Close'))
    expect(closeModal).toHaveBeenCalled()
  })
})
