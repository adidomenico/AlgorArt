/**
 * Error taxonomy for wallet and chain failures. Probes that expect absence (vault boxes, leaves, balances,
 * metadata) keep swallowing with a comment; everything the user triggers goes through here so failures get a
 * category, a log line, and a message instead of silence.
 *
 * Detection is message matching (verified against the installed sources - see the patterns below):
 * - Contract asserts (`campaign/contract.algo.ts`, `claimsvault/contract.algo.ts`): plain strings, but ours and
 *   stable - covered by contract tests when they change.
 * - Pera/Defly/Exodus failures: plain `Error`s with vendor vocabulary (adapter packages bundle the vendor SDKs);
 *   matched here, `unknown` fallback stays sane when vendors reword.
 */

export type ErrorKind = 'session' | 'stale-proof' | 'rejected' | 'unknown'

export type FailedAction = 'pledge' | 'create' | 'transaction'

const SESSION_PATTERN = /not initialized correctly|session expired|no session|has disconnected|disconnected|no signer found/i
const STALE_PROOF_PATTERN = /stale or forged frontier|proof does not match root/i
const REJECTION_PATTERN = /\breject|\bdenied|dismissed|cancelled by user|\bcancelled\b/i
// Connect-flow dismissals (verified against the installed vendor bundles): closing the wallet popup
// rejects `connect()` with one of these instead of connecting.
const DISMISSAL_PATTERN = /closed by user|cancelled by user|modal_closed/i

/**
 * Classify a failure from a wallet signing call or chain submission.
 *
 * @param error The caught failure.
 * @returns The category driving retry, messaging, and recovery decisions.
 */
export function classifyError(error: unknown): ErrorKind {
  if (!(error instanceof Error)) return 'unknown'
  if (REJECTION_PATTERN.test(error.message)) return 'rejected'
  if (SESSION_PATTERN.test(error.message)) return 'session'
  if (STALE_PROOF_PATTERN.test(error.message)) return 'stale-proof'
  return 'unknown'
}

/**
 * Whether a signing failure means the wallet session is dead (resumed state with no live bridge). The fix is
 * always the same: disconnect and reconnect the wallet.
 *
 * @param error The failure from a wallet signing call.
 * @returns True when the user should reconnect instead of retrying.
 */
export function isSessionError(error: unknown): boolean {
  return classifyError(error) === 'session'
}

/**
 * Whether a connect-flow failure is just the user closing the wallet popup.
 * A dismissal is not an error: callers reopen the menu quietly instead of printing a message.
 *
 * @param error The failure from a wallet `connect()` call.
 * @returns True when no error message should be shown.
 */
export function isDismissalError(error: unknown): boolean {
  return error instanceof Error && DISMISSAL_PATTERN.test(error.message)
}

/**
 * Whether a submission failed on a stale Merkle proof (a concurrent pledge/refund moved the root).
 *
 * @param error The failure from a chain submission.
 * @returns True when rebuilding proofs and retrying once is correct.
 */
export function isStaleProofError(error: unknown): boolean {
  return classifyError(error) === 'stale-proof'
}

/**
 * User-facing message for a failed action. Session failures are handled separately (they need recovery, not words).
 *
 * @param kind Classified failure, anything but session.
 * @param action The action that failed.
 * @returns Message text for the UI.
 */
export function errorMessage(kind: 'rejected' | 'stale-proof' | 'unknown', action: FailedAction): string {
  if (kind === 'rejected') return 'Transaction rejected in your wallet.'
  switch (action) {
    case 'pledge':
      return 'Failed to pledge. Please try again.'
    case 'create':
      return 'Failed to create campaign. Please try again.'
    case 'transaction':
      return 'Transaction failed. Another pledge or refund may have landed first - please try again.'
  }
}
