import { SessionError } from '@txnlab/use-wallet'
import { describe, expect, it } from 'vitest'
import { classifyError, errorMessage, isSessionError, isStaleProofError } from './errors'

describe('classifyError', () => {
  it('detects typed session errors without message matching', () => {
    expect(classifyError(new SessionError('No session found!'))).toBe('session')
  })

  it('detects dead wallet sessions', () => {
    expect(classifyError(new Error('PeraWalletConnect was not initialized correctly.'))).toBe('session')
    expect(classifyError(new Error('Wallet session expired'))).toBe('session')
    expect(classifyError(new Error('no session found'))).toBe('session')
  })

  it('detects user rejections first', () => {
    expect(classifyError(new Error('Transaction rejected by user'))).toBe('rejected')
    expect(classifyError(new Error('Sign denied'))).toBe('rejected')
    expect(classifyError(new Error('cancelled previous request'))).toBe('rejected')
  })

  it('detects stale proofs', () => {
    expect(classifyError(new Error('stale or forged frontier'))).toBe('stale-proof')
    expect(classifyError(new Error('proof does not match root'))).toBe('stale-proof')
  })

  it('falls back to unknown', () => {
    expect(classifyError(new Error('boom'))).toBe('unknown')
    expect(classifyError('boom')).toBe('unknown')
    expect(classifyError(undefined)).toBe('unknown')
  })
})

describe('error predicates', () => {
  it('isSessionError matches sessions only', () => {
    expect(isSessionError(new Error('Wallet session expired'))).toBe(true)
    expect(isSessionError(new Error('boom'))).toBe(false)
  })

  it('isStaleProofError matches stale proofs only', () => {
    expect(isStaleProofError(new Error('proof does not match root'))).toBe(true)
    expect(isStaleProofError(new Error('boom'))).toBe(false)
  })
})

describe('errorMessage', () => {
  it('reports rejections plainly for every action', () => {
    expect(errorMessage('rejected', 'pledge')).toBe('Transaction rejected in your wallet.')
    expect(errorMessage('rejected', 'create')).toBe('Transaction rejected in your wallet.')
    expect(errorMessage('rejected', 'transaction')).toBe('Transaction rejected in your wallet.')
  })

  it('maps failures per action', () => {
    expect(errorMessage('unknown', 'pledge')).toBe('Failed to pledge. Please try again.')
    expect(errorMessage('unknown', 'create')).toBe('Failed to create campaign. Please try again.')
    expect(errorMessage('unknown', 'transaction')).toBe(
      'Transaction failed. Another pledge or refund may have landed first - please try again.',
    )
    expect(errorMessage('stale-proof', 'pledge')).toBe('Failed to pledge. Please try again.')
  })
})
