/**
 * Formatting helpers for amounts and deadlines.
 *
 * On-chain values are always microAlgos (`bigint`) and deadlines are UNIX
 * seconds (`bigint`). These helpers keep that conversion in one place.
 */

const MICRO_ALGOS_PER_ALGO = 1_000_000n

/** Convert a microAlgo amount (bigint or number) to a display-ready ALGO string, e.g. `"12.5"`. */
export function formatAlgo(microAlgos: bigint | number): string {
  const micro = BigInt(microAlgos)
  const whole = micro / MICRO_ALGOS_PER_ALGO
  const fraction = micro % MICRO_ALGOS_PER_ALGO
  const wholeStr = whole.toLocaleString()
  if (fraction === 0n) return wholeStr
  return `${wholeStr}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`
}

/** Parse an ALGO amount entered by a user into microAlgos (bigint). Throws on invalid input. */
export function parseAlgoToMicroAlgos(value: string): bigint {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Invalid ALGO amount')
  }
  const [whole, fraction = ''] = trimmed.split('.')
  const wholeMicro = BigInt(whole) * MICRO_ALGOS_PER_ALGO
  const fractionMicro = BigInt((fraction + '000000').slice(0, 6))
  return wholeMicro + fractionMicro
}

/** Format a UNIX-seconds deadline (bigint) as a local date string. */
export function formatDeadline(deadlineSeconds: bigint): string {
  return new Date(Number(deadlineSeconds) * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** Human-readable countdown to a UNIX-seconds deadline, e.g. `"2d 3h"` or `"closed"`. */
export function formatCountdown(deadlineSeconds: bigint, nowSeconds: bigint): string {
  const diff = Number(deadlineSeconds - nowSeconds)
  if (diff <= 0) return 'closed'

  const days = Math.floor(diff / 86_400)
  const hours = Math.floor((diff % 86_400) / 3_600)
  const minutes = Math.floor((diff % 3_600) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
