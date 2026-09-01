import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import PledgeForm from './PledgeForm'

const pledgeMock = vi.fn()

vi.mock('../../lib/transaction', () => ({
  pledge: (...args: unknown[]) => pledgeMock(...args),
}))

const activeWalletSession = {
  activeAddress: 'ADDRESS',
  transactionSigner: {},
}

const useWalletMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

describe('PledgeForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
