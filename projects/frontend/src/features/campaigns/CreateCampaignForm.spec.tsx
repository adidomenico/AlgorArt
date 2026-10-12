import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopeType } from '@txnlab/use-wallet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CreateCampaignForm from './CreateCampaignForm'

const createCampaignMock = vi.fn()
const fetchChainTimestampMock = vi.fn()
const logErrorMock = vi.fn()
const signDataMock = vi.fn()

vi.mock('../../lib/log', () => ({
  logError: (...args: unknown[]) => logErrorMock(...args),
}))

vi.mock('../../lib/transaction', async () => {
  const actual: { disconnectQuietly: (wallet: unknown) => Promise<void> } = await vi.importActual('../../lib/transaction')
  return {
    createCampaign: (...args: unknown[]) => createCampaignMock(...args),
    disconnectQuietly: actual.disconnectQuietly,
  }
})

vi.mock('../../lib/algorand', () => ({
  fetchChainTimestamp: (...args: unknown[]) => fetchChainTimestampMock(...args),
}))

const useWalletMock = vi.fn()
const disconnectMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

describe('CreateCampaignForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disconnectMock.mockResolvedValue(undefined)
    signDataMock.mockResolvedValue({ signature: new Uint8Array([7, 8]), authenticatorData: new Uint8Array([9]) })
    useWalletMock.mockReturnValue({
      activeAddress: 'ADDRESS',
      activeWallet: { disconnect: disconnectMock, canSignData: true },
      signData: (...args: unknown[]) => signDataMock(...args),
      transactionSigner: {},
    })
    fetchChainTimestampMock.mockResolvedValue(1_000_000_000n)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('creates a campaign and calls onCreated with the new app id', async () => {
    createCampaignMock.mockResolvedValue({ appId: 99n, appAddress: 'ESCROW' })
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={onCreated} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByLabelText(/Metadata URI/), 'ipfs://QmExample')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.clear(screen.getByLabelText(/Duration/))
    await user.type(screen.getByLabelText(/Duration/), '7')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(createCampaignMock).toHaveBeenCalledWith(
      { address: 'ADDRESS', signer: {} },
      'My first novel',
      'ipfs://QmExample',
      expect.anything(),
      expect.anything(),
    )
    expect(onCreated).toHaveBeenCalledWith(99n)
  })

  it('shows an error for a zero goal', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '0')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Goal must be greater than zero/)).toBeInTheDocument()
  })

  it('shows an error for a title longer than 128 bytes', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'x'.repeat(129))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Title must be 128 bytes or fewer/)).toBeInTheDocument()
  })

  it('shows an error for a metadata uri longer than 128 bytes', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByLabelText(/Metadata URI/), 'x'.repeat(129))
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Metadata URI must be 128 bytes or fewer/)).toBeInTheDocument()
  })

  it('shows an error for an invalid duration', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
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

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Failed to create campaign/)).toBeInTheDocument()
  })

  it('suggests reconnecting when the wallet session is dead', async () => {
    createCampaignMock.mockRejectedValue(new Error('PeraWalletConnect was not initialized correctly.'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Connect your wallet again/)).toBeInTheDocument()
    expect(disconnectMock).toHaveBeenCalledOnce()
  })

  it('tells the user to reconnect manually when there is no wallet to clear', async () => {
    useWalletMock.mockReturnValue({ activeAddress: 'ADDRESS', activeWallet: null, transactionSigner: {} })
    createCampaignMock.mockRejectedValue(new Error('PeraWalletConnect was not initialized correctly.'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Disconnect and reconnect your wallet/)).toBeInTheDocument()
  })

  it('reports a rejection plainly and logs the failure', async () => {
    createCampaignMock.mockRejectedValue(new Error('Transaction rejected by user'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.type(screen.getByLabelText(/Title/), 'My first novel')
    await user.type(screen.getByPlaceholderText('e.g. 100'), '10')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(/Transaction rejected in your wallet/)).toBeInTheDocument()
    expect(logErrorMock).toHaveBeenCalledWith('create', expect.any(Error))
  })

  it('calls onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('uploads a cover image and fills the metadata URI', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ message: 'challenge' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ cid: 'QmCover' }) }),
    )
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.upload(screen.getByLabelText(/Cover image/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.click(screen.getByRole('button', { name: 'Upload cover' }))

    expect(await screen.findByDisplayValue('ipfs://QmCover')).toBeInTheDocument()
    expect(signDataMock).toHaveBeenCalledWith(btoa('challenge'), { encoding: 'base64', scope: ScopeType.AUTH })
  })

  it('shows a message when the upload fails', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 400, json: () => Promise.resolve({}) }))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.upload(screen.getByLabelText(/Cover image/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.click(screen.getByRole('button', { name: 'Upload cover' }))

    expect(await screen.findByText(/Could not start the upload/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('ipfs://…')).toHaveValue('')
  })

  it('shows a message when signing fails', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ message: 'challenge' }) }))
    signDataMock.mockRejectedValueOnce(new Error('rejected in wallet'))
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.upload(screen.getByLabelText(/Cover image/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.click(screen.getByRole('button', { name: 'Upload cover' }))

    expect(await screen.findByText(/rejected in wallet/)).toBeInTheDocument()
  })

  it('shows a message when the backend is not configured', async () => {
    // Explicitly blank: the developer's own .env may set VITE_BACKEND_URL and Vite loads it into tests.
    vi.stubEnv('VITE_BACKEND_URL', '')
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    await user.upload(screen.getByLabelText(/Cover image/), new File(['bytes'], 'cover.png', { type: 'image/png' }))
    await user.click(screen.getByRole('button', { name: 'Upload cover' }))

    expect(await screen.findByText(/VITE_BACKEND_URL/)).toBeInTheDocument()
  })

  it('keeps the upload button disabled without a file', async () => {
    const user = userEvent.setup()
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)
    const picker = screen.getByLabelText(/Cover image/)
    const button = screen.getByRole('button', { name: 'Upload cover' })

    expect(button).toBeDisabled()
    await user.upload(picker, new File(['bytes'], 'cover.png', { type: 'image/png' }))
    expect(button).toBeEnabled()
    Object.defineProperty(picker, 'files', { value: [], configurable: true })
    fireEvent.change(picker)
    expect(button).toBeDisabled()
  })

  it('hides the upload controls when the wallet cannot sign', async () => {
    useWalletMock.mockReturnValue({
      activeAddress: 'ADDRESS',
      activeWallet: { disconnect: disconnectMock, canSignData: false },
      signData: signDataMock,
      transactionSigner: {},
    })
    render(<CreateCampaignForm onCreated={() => {}} onCancel={() => {}} />)

    expect(screen.queryByLabelText(/Cover image/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Upload cover' })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Metadata URI/)).toBeInTheDocument()
  })
})
