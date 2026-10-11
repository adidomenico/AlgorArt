import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PledgeForm from './PledgeForm'

const pledgeMock = vi.fn()

vi.mock('../../lib/transaction', async () => {
  const actual: { isSessionError: (error: unknown) => boolean; disconnectQuietly: (wallet: unknown) => Promise<void> } =
    await vi.importActual('../../lib/transaction')
  return {
    pledge: (...args: unknown[]) => pledgeMock(...args),
    isSessionError: actual.isSessionError,
    disconnectQuietly: actual.disconnectQuietly,
  }
})

const activeWalletSession = {
  activeAddress: 'ADDRESS',
  activeWallet: { disconnect: (...args: unknown[]) => disconnectMock(...args) },
  transactionSigner: {},
}

const disconnectMock = vi.fn()

const useWalletMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

describe('PledgeForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disconnectMock.mockResolvedValue(undefined)
    useWalletMock.mockReturnValue(activeWalletSession)
  })

  it('submits a pledge and calls onPledged', async () => {
    pledgeMock.mockResolvedValue(undefined)
    const onPledged = vi.fn()
    const user = userEvent.setup()
    render(<PledgeForm appId={42n} onPledged={onPledged} />)

    await user.type(screen.getByPlaceholderText('Amount in ALGO'), '5')
    await user.click(screen.getByRole('button', { name: 'Pledge' }))

    expect(pledgeMock).toHaveBeenCalledWith(42n, { address: 'ADDRESS', signer: {} }, 5_000_000n)
    expect(onPledged).toHaveBeenCalled()
  })

  it('shows an error message when pledge fails', async () => {
    pledgeMock.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<PledgeForm appId={42n} onPledged={() => {}} />)

    await user.type(screen.getByPlaceholderText('Amount in ALGO'), '5')
    await user.click(screen.getByRole('button', { name: 'Pledge' }))

    expect(await screen.findByText(/Failed to pledge/)).toBeInTheDocument()
  })

  it('suggests reconnecting when the wallet session is dead', async () => {
    pledgeMock.mockRejectedValue(new Error('PeraWalletConnect was not initialized correctly.'))
    const user = userEvent.setup()
    render(<PledgeForm appId={42n} onPledged={() => {}} />)

    await user.type(screen.getByPlaceholderText('Amount in ALGO'), '5')
    await user.click(screen.getByRole('button', { name: 'Pledge' }))

    expect(await screen.findByText(/Connect your wallet again/)).toBeInTheDocument()
    expect(disconnectMock).toHaveBeenCalledOnce()
  })

  it('tells the user to reconnect manually when there is no wallet to clear', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: null, transactionSigner: {} })
    pledgeMock.mockRejectedValue(new Error('PeraWalletConnect was not initialized correctly.'))
    const user = userEvent.setup()
    render(<PledgeForm appId={42n} onPledged={() => {}} />)

    await user.type(screen.getByPlaceholderText('Amount in ALGO'), '5')
    await user.click(screen.getByRole('button', { name: 'Pledge' }))

    expect(await screen.findByText(/Disconnect and reconnect your wallet/)).toBeInTheDocument()
  })

  it('hints at connecting when disconnected', () => {
    useWalletMock.mockReturnValue({ activeAddress: null, activeWallet: null, transactionSigner: {} })
    render(<PledgeForm appId={42n} onPledged={() => {}} />)

    expect(screen.getByText(/Connect your wallet to pledge/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pledge' })).toBeDisabled()
  })

  it('shows an error for invalid amounts', async () => {
    const user = userEvent.setup()
    render(<PledgeForm appId={42n} onPledged={() => {}} />)

    await user.type(screen.getByPlaceholderText('Amount in ALGO'), 'abc')
    await user.click(screen.getByRole('button', { name: 'Pledge' }))

    expect(await screen.findByText(/Failed to pledge/)).toBeInTheDocument()
  })

  it('does nothing when the wallet is not connected', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null, transactionSigner: null })
    const user = userEvent.setup()
    render(<PledgeForm appId={42n} onPledged={() => {}} />)

    const button = screen.getByRole('button', { name: 'Pledge' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(pledgeMock).not.toHaveBeenCalled()
  })
})
