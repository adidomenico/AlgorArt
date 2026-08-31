import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import Account from './Account'

const useWalletMock = vi.fn()
const getAlgodConfigMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
}))

vi.mock('../utils/network/getAlgoClientConfigs', () => ({
  getAlgodConfigFromViteEnvironment: () => getAlgodConfigMock(),
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
})
