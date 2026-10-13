import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession } from '../../lib/backend'
import { clearProfileCache } from '../../lib/profiles'
import Profile from './Profile'

const useWalletMock = vi.fn()
const useNetworkMock = vi.fn()
const signDataMock = vi.fn()

vi.mock('@txnlab/use-wallet-react', () => ({
  useWallet: () => useWalletMock(),
  useNetwork: () => useNetworkMock(),
}))

describe('Profile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWalletMock.mockReturnValue({
      activeAddress: 'ADDRESS',
      signData: (...args: unknown[]) => signDataMock(...args),
    })
    useNetworkMock.mockReturnValue({ activeNetworkConfig: { caipChainId: 'algorand:testnet' } })
    signDataMock.mockResolvedValue({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) })
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
  })

  afterEach(() => {
    clearProfileCache()
    clearSession()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('asks to connect when disconnected', async () => {
    useWalletMock.mockReturnValue({ activeAddress: null })
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<Profile onBack={onBack} />)

    expect(screen.getByText(/Connect your wallet to view your profile/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('loads the saved profile into the form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ display_name: 'Kyogre Fan', bio: 'Collector', avatar_cid: 'QmAvatar', email: 'kyogre@example.com' }),
      }),
    )
    render(<Profile onBack={() => {}} />)

    expect(await screen.findByDisplayValue('Kyogre Fan')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Collector')).toBeInTheDocument()
    expect(screen.getByDisplayValue('QmAvatar')).toBeInTheDocument()
    expect(screen.getByDisplayValue('kyogre@example.com')).toBeInTheDocument()
  })

  it('shows an empty form when no profile exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) }))
    render(<Profile onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByLabelText(/Display Name/)).toHaveValue('')
    })
    expect(screen.getByLabelText(/Bio/)).toHaveValue('')
  })

  it('shows an empty form when the load fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<Profile onBack={() => {}} />)

    await waitFor(() => {
      expect(screen.getByLabelText(/Display Name/)).toHaveValue('')
    })
  })

  it('shows empty fields for missing profile data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ bio: 'Collector' }) }))
    render(<Profile onBack={() => {}} />)

    expect(await screen.findByDisplayValue('Collector')).toBeInTheDocument()
    expect(screen.getByLabelText(/Display Name/)).toHaveValue('')
  })

  it('saves the profile and shows success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ display_name: 'New Name', avatar_cid: 'QmNewAvatar' }),
        }),
    )
    const user = userEvent.setup()
    render(<Profile onBack={() => {}} />)

    await user.clear(screen.getByLabelText(/Display Name/))
    await user.type(screen.getByLabelText(/Display Name/), 'New Name')
    await user.type(screen.getByLabelText(/Bio/), 'A collector')
    await user.type(screen.getByLabelText(/Avatar CID/), 'QmNewAvatar')
    await user.type(screen.getByLabelText(/Email/), 'new@example.com')
    await user.click(screen.getByRole('button', { name: 'Save Profile' }))

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument()
    expect(screen.getByLabelText(/Display Name/)).toHaveValue('New Name')
    expect(screen.getByLabelText(/Bio/)).toHaveValue('')
  })

  it('shows an error when saving fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ nonce: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ token: 'session' }) })
        .mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({}) }),
    )
    const user = userEvent.setup()
    render(<Profile onBack={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Save Profile' }))

    expect(await screen.findByText('Saving failed. Try again.')).toBeInTheDocument()
  })

  it('goes back from the form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) }))
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<Profile onBack={onBack} />)

    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('does not update the form when unmounted before the load finishes', async () => {
    let resolveFetch: ((value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
      ),
    )
    const { unmount } = render(<Profile onBack={() => {}} />)
    unmount()

    if (resolveFetch === undefined) throw new Error('fetch was not called')
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve({ display_name: 'Late' }) })
    await new Promise((r) => setTimeout(r, 0))
  })
})
