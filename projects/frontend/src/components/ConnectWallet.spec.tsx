import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectWallet from './ConnectWallet'

const wallets = [
  {
    id: 'pera',
    metadata: { name: 'Pera Wallet', icon: 'http://icon/pera.png' },
    connect: vi.fn().mockResolvedValue([{ address: 'ADDRESS' }]),
    isActive: false,
  },
  {
    id: 'defly',
    metadata: { name: 'Defly Wallet', icon: 'http://icon/defly.png' },
    connect: vi.fn().mockResolvedValue([{ address: 'ADDRESS' }]),
    isActive: false,
  },
  { id: 'exodus', metadata: { name: 'Exodus', icon: 'http://icon/exodus.png' }, connect: vi.fn(), isActive: false },
]

const useWalletMock = vi.fn()
const useNetworkMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
  useNetwork: () => useNetworkMock(),
}))

vi.mock('./Account', () => ({
  default: () => <div>ACCOUNT_VIEW</div>,
}))

describe('ConnectWallet', () => {
  beforeEach(() => {
    useNetworkMock.mockReturnValue({ activeNetworkConfig: { caipChainId: 'algorand:testnet' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders provider buttons when disconnected', () => {
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

    expect(screen.getByText('Pera Wallet')).toBeInTheDocument()
    expect(screen.getByText('Defly Wallet')).toBeInTheDocument()
  })

  it('connects a provider when clicked', async () => {
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    useNetworkMock.mockReturnValue({ activeNetworkConfig: { caipChainId: 'algorand:testnet' } })
    wallets[0]?.connect.mockResolvedValueOnce([{ address: 'ADDRESS' }])
    const user = userEvent.setup()
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

    await user.click(screen.getByText('Pera Wallet'))
    expect(wallets[0]?.connect).toHaveBeenCalled()
  })

  it('stays silent when connecting returns no accounts', async () => {
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    useNetworkMock.mockReturnValue({ activeNetworkConfig: { caipChainId: 'algorand:testnet' } })
    wallets[0]?.connect.mockResolvedValueOnce([])
    const user = userEvent.setup()
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

    await user.click(screen.getByText('Pera Wallet'))
    expect(wallets[0]?.connect).toHaveBeenCalled()
    expect(screen.queryByText(/Could not connect/)).not.toBeInTheDocument()
  })

  it('pre-warms the backend session on connect', async () => {
    const signData = vi.fn().mockResolvedValue({ signature: new Uint8Array([1]), authenticatorData: new Uint8Array([2]) })
    useWalletMock.mockReturnValue({ wallets, activeAddress: null, signData })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ nonce: 'n' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ token: 't' }) }),
    )
    const user = userEvent.setup()
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

    await user.click(screen.getByText('Pera Wallet'))
    await waitFor(() => {
      expect(signData).toHaveBeenCalled()
    })
    expect(screen.queryByText(/Could not connect/)).not.toBeInTheDocument()
  })

  it('renders the account view and logout when connected', () => {
    const activeWallet = { ...wallets[0], isActive: true, disconnect: vi.fn() }
    useWalletMock.mockReturnValue({ wallets: [activeWallet], activeAddress: 'ADDRESS' })
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

    expect(screen.getByText('ACCOUNT_VIEW')).toBeInTheDocument()
    expect(screen.getByText('Logout')).toBeInTheDocument()
  })

  it('disconnects the active wallet on logout', async () => {
    const disconnect = vi.fn()
    const activeWallet = { ...wallets[0], isActive: true, disconnect }
    useWalletMock.mockReturnValue({ wallets: [activeWallet], activeAddress: 'ADDRESS' })
    const user = userEvent.setup()
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

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
      // eslint-disable-next-line @typescript-eslint/no-misused-spread -- jsdom `Location` is replaced with a plain mock object
      value: { ...window.location, reload: reloadSpy },
    })
    const user = userEvent.setup()
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

    await user.click(screen.getByText('Logout'))
    expect(removeItemSpy).toHaveBeenCalledWith('@txnlab/use-wallet:v5')
    expect(reloadSpy).toHaveBeenCalled()
  })

  it('renders the KMD wallet as "LocalNet Wallet" without an icon', () => {
    const kmdWallet = { id: 'kmd', metadata: { name: 'LocalNet', icon: 'http://icon/kmd.png' }, connect: vi.fn(), isActive: false }
    useWalletMock.mockReturnValue({ wallets: [kmdWallet], activeAddress: null })
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

    expect(screen.getByText('LocalNet Wallet')).toBeInTheDocument()
    expect(screen.queryByAltText('wallet_icon_kmd')).not.toBeInTheDocument()
  })

  it('shows an error when connecting fails', async () => {
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    const defly = wallets[1]
    if (defly === undefined) throw new Error('defly wallet missing from mock')
    defly.connect.mockRejectedValueOnce(new Error('no extension'))
    const onHide = vi.fn()
    const onShow = vi.fn()
    const user = userEvent.setup()
    render(<ConnectWallet openModal onHide={onHide} onShow={onShow} />)

    await user.click(screen.getByText('Defly Wallet'))
    expect(await screen.findByText(/Could not connect with Defly Wallet/)).toBeInTheDocument()
    expect(onHide).toHaveBeenCalled()
    expect(onShow).toHaveBeenCalled()
  })

  it('shows the install message when the Exodus extension is missing', async () => {
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    const exodus = wallets[2]
    if (exodus === undefined) throw new Error('exodus wallet missing from mock')
    exodus.connect.mockRejectedValueOnce(new Error('Exodus is not available'))
    const user = userEvent.setup()
    render(<ConnectWallet openModal onHide={() => {}} onShow={() => {}} />)

    await user.click(screen.getByRole('button', { name: /Exodus/ }))
    expect(await screen.findByText(/Install the Exodus extension to use it/)).toBeInTheDocument()
  })

  it('hides the menu when a provider flow starts', async () => {
    useWalletMock.mockReturnValue({ wallets, activeAddress: null })
    const onHide = vi.fn()
    const onShow = vi.fn()
    const user = userEvent.setup()
    render(<ConnectWallet openModal onHide={onHide} onShow={onShow} />)

    await user.click(screen.getByText('Defly Wallet'))
    expect(onHide).toHaveBeenCalled()
    expect(onShow).not.toHaveBeenCalled()
  })
})
