import { describe, expect, it, vi } from 'vitest'
import { ensureLiveSessionFor } from './session'

const wallet = { walletKey: 'defly' }

function managerWith(adapter: { resumeSession: () => Promise<unknown> } | undefined) {
  return { getWallet: vi.fn().mockReturnValue(adapter) }
}

describe('ensureLiveSessionFor', () => {
  it('resolves without touching the manager when no wallet is active', async () => {
    const manager = managerWith({ resumeSession: vi.fn() })

    await expect(ensureLiveSessionFor(manager, null)).resolves.toBeUndefined()
    await expect(ensureLiveSessionFor(manager, undefined)).resolves.toBeUndefined()
    expect(manager.getWallet).not.toHaveBeenCalled()
  })

  it('resolves without signing when the adapter is gone', async () => {
    const manager = managerWith(undefined)

    await expect(ensureLiveSessionFor(manager, wallet)).resolves.toBeUndefined()
    expect(manager.getWallet).toHaveBeenCalledWith('defly')
  })

  it('resolves when the bridge revalidates', async () => {
    const resumeSession = vi.fn().mockResolvedValue(['ADDRESS'])
    const manager = managerWith({ resumeSession })

    await expect(ensureLiveSessionFor(manager, wallet)).resolves.toBeUndefined()
    expect(resumeSession).toHaveBeenCalledOnce()
  })

  it('throws a session-classified error when the bridge is dead', async () => {
    const resumeSession = vi.fn().mockRejectedValue(new Error('No accounts found!'))
    const manager = managerWith({ resumeSession })

    await expect(ensureLiveSessionFor(manager, wallet)).rejects.toThrow('Wallet session expired')
  })
})
