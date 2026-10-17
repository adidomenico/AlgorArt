import { describe, expect, it, vi } from 'vitest'
import { disconnectQuietly } from './transaction'

describe('disconnectQuietly', () => {
  it('disconnects quietly', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)
    await expect(disconnectQuietly({ disconnect })).resolves.toBeUndefined()
    expect(disconnect).toHaveBeenCalledOnce()

    const failing = vi.fn().mockRejectedValue(new Error('already dead'))
    await expect(disconnectQuietly({ disconnect: failing })).resolves.toBeUndefined()

    await expect(disconnectQuietly(null)).resolves.toBeUndefined()
    await expect(disconnectQuietly(undefined)).resolves.toBeUndefined()
  })
})
