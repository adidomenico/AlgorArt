import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Account from './Account'

const useWalletMock = vi.fn()
const getAlgodConfigMock = vi.fn()
const getInformationMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

vi.mock('../utils/network/getAlgoClientConfigs', () => ({
  getAlgodConfigFromViteEnvironment: () => getAlgodConfigMock(),
}))

vi.mock('../lib/algorand', () => ({
  algorand: { account: { getInformation: (...args: unknown[]) => getInformationMock(...args) } },
}))

describe('Account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({ activeAddress: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' })
    getAlgodConfigMock.mockReturnValue({
      server: 'http://localhost',
      port: 4001,
      token: 'a'.repeat(64),
      network: 'localnet',
    })
    getInformationMock.mockResolvedValue({ balance: { microAlgo: 5_000_000n } })
  })

  it('renders the ellipsed address and network', () => {
    render(<Account />)
    expect(screen.getByText(/Address:/)).toBeInTheDocument()
    expect(screen.getByText('Network: localnet')).toBeInTheDocument()
  })

  it('falls back to localnet when the network is empty', () => {
    getAlgodConfigMock.mockReturnValue({
      server: 'http://localhost',
      port: 4001,
      token: 'a'.repeat(64),
      network: '',
    })
    render(<Account />)
    expect(screen.getByText('Network: localnet')).toBeInTheDocument()
  })

  it('renders the wallet balance', async () => {
    render(<Account />)
    expect(await screen.findByText('Balance: 5 ALGO')).toBeInTheDocument()
  })

  it('hides the balance when the lookup fails', async () => {
    getInformationMock.mockRejectedValue(new Error('offline'))
    render(<Account />)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(/Balance:/)).not.toBeInTheDocument()
  })
})
