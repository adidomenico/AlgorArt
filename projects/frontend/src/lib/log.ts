/**
 * Log an action failure for debugging. Console output never leaves the browser, so this is safe for addresses and
 * error details - and it beats diagnosing from screenshots.
 *
 * @param context The action that failed (pledge, create, claim, ...).
 * @param error The caught failure.
 */
export function logError(context: string, error: unknown): void {
  console.error(`[AlgorArt:${context}]`, error)
}
