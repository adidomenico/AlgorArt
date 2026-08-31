import { describe, expect, it } from 'vitest'
import { formatAlgo, formatCountdown, formatDeadline, parseAlgoToMicroAlgos } from './format'

describe('formatAlgo', () => {
  it('formats whole ALGO amounts without decimals', () => {
    expect(formatAlgo(5_000_000n)).toBe('5')
    expect(formatAlgo(1_000_000)).toBe('1')
  })

  it('formats fractional ALGO amounts', () => {
    expect(formatAlgo(5_500_000n)).toBe('5.5')
    expect(formatAlgo(250_000n)).toBe('0.25')
  })

  it('trims trailing zeros in the fraction', () => {
    expect(formatAlgo(1_100_000n)).toBe('1.1')
  })

  it('handles zero', () => {
    expect(formatAlgo(0n)).toBe('0')
  })
})

describe('parseAlgoToMicroAlgos', () => {
  it('parses whole ALGO', () => {
    expect(parseAlgoToMicroAlgos('5')).toBe(5_000_000n)
  })

  it('parses fractional ALGO', () => {
    expect(parseAlgoToMicroAlgos('0.25')).toBe(250_000n)
    expect(parseAlgoToMicroAlgos('1.5')).toBe(1_500_000n)
  })

  it('parses up to six decimal places', () => {
    expect(parseAlgoToMicroAlgos('0.123456')).toBe(123_456n)
  })

  it('rejects invalid input', () => {
    expect(() => parseAlgoToMicroAlgos('')).toThrow()
    expect(() => parseAlgoToMicroAlgos('abc')).toThrow()
    expect(() => parseAlgoToMicroAlgos('1.2.3')).toThrow()
  })

  it('trims surrounding whitespace', () => {
    expect(parseAlgoToMicroAlgos('  2  ')).toBe(2_000_000n)
  })
})

describe('formatDeadline', () => {
  it('returns a locale string for a timestamp', () => {
    // 2026-01-01T00:00:00Z
    const result = formatDeadline(1_767_225_600n)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('formatCountdown', () => {
  it('returns closed when the deadline has passed', () => {
    expect(formatCountdown(100n, 100n)).toBe('closed')
    expect(formatCountdown(100n, 200n)).toBe('closed')
  })

  it('formats days and hours', () => {
    // 2 days + 3 hours = 183600 seconds
    expect(formatCountdown(200_000n, 16_400n)).toBe('2d 3h')
  })

  it('formats hours and minutes', () => {
    // 2 hours + 3 minutes
    expect(formatCountdown(10_000n, 2_620n)).toBe('2h 3m')
  })

  it('formats minutes only', () => {
    expect(formatCountdown(600n, 120n)).toBe('8m')
  })
})
