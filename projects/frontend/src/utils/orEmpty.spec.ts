import { describe, expect, it } from 'vitest'
import { orEmpty } from './orEmpty'

describe('orEmpty', () => {
  it('returns the value when set', () => {
    expect(orEmpty('Kyogre')).toBe('Kyogre')
  })

  it('returns an empty string when missing', () => {
    expect(orEmpty(null)).toBe('')
    expect(orEmpty(undefined)).toBe('')
  })
})
