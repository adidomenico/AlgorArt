/**
 * Frontend wallet helper. The write path (call assembly, retry, vault helpers, `WalletSession`) lives in
 * `@kasakame/sdk`, re-exported here for existing importers.
 */

export * from '@kasakame/sdk'

/**
 * Best-effort disconnect to clear a dead wallet session, so reconnecting is one click instead of two. Never throws:
 * a dead bridge may fail to disconnect too. Callers must fire-and-forget (`void disconnectQuietly(...)`) - awaiting
 * a hanging disconnect would stall the UI indefinitely.
 *
 * @param activeWallet The active wallet from useWallet, if any.
 */
export async function disconnectQuietly(activeWallet: { disconnect: () => Promise<void> } | null | undefined): Promise<void> {
  await activeWallet?.disconnect().catch(() => undefined)
}
