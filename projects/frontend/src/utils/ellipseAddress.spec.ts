import { describe, expect, it } from 'vitest'
import { ellipseAddress } from './ellipseAddress'

describe('ellipseAddress', () => {
  it('ellipsises a long address', () => {
    const result = ellipseAddress('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')
    expect(result).toBe('ABCDEF...456789')
  })

  it('returns empty string for null', () => {
    expect(ellipseAddress(null)).toBe('')
  })

  it('supports a custom width', () => {
    const result = ellipseAddress('ABCDEFGHIJ', 3)
    expect(result).toBe('ABC...HIJ')
  })
})
