import { afterEach, describe, expect, it, vi } from 'vitest'
import { logError } from './log'

describe('logError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs the context and the error', () => {
    const consoleMock = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('boom')
    logError('pledge', failure)
    expect(consoleMock).toHaveBeenCalledWith('[AlgorArt:pledge]', failure)
  })
})
