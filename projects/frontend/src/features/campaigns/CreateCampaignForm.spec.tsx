import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import CreateCampaignForm from './CreateCampaignForm'

const createCampaignMock = vi.fn()

vi.mock('../../lib/transaction', () => ({
  createCampaign: (...args: unknown[]) => createCampaignMock(...args),
}))

const useWalletMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

describe('CreateCampaignForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', transactionSigner: {} })
  })

  it('creates a campaign and calls onCreated with the new app id', async () => {
    createCampaignMock.mockResolvedValue({ appId: 99n, appAddress: 'ESCROW' })
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={onCreated} onCancel={() => {}} />)

    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.clear(screen.getByLabelText(/Duration/))
    await user.type(screen.getByLabelText(/Duration/), '7')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(createCampaignMock).toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledWith(99n)
  })

  it('shows an error for a zero goal', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByPlaceholderText('e.g. 100'), '0')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Goal must be greater than zero/)).toBeInTheDocument()
  })

  it('shows an error for an invalid duration', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.clear(screen.getByLabelText(/Duration/))
    await user.type(screen.getByLabelText(/Duration/), '0')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Duration must be a positive number of days/)).toBeInTheDocument()
  })

  it('shows an error when creation fails', async () => {
    createCampaignMock.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Failed to create campaign/)).toBeInTheDocument()
  })

  it('calls onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
