/** Minimal wallet surface for liveness revalidation (a slice of use-wallet's `Wallet`). */
export interface LivenessWallet {
  walletKey: string
}

/** Minimal manager surface for liveness revalidation (a slice of use-wallet's `WalletManager`). */
export interface LivenessManager {
  getWallet: (walletKey: string) => { resumeSession: () => Promise<unknown> } | undefined
}

/**
 * Recheck a connected wallet's bridge before trusting it.
 *
 * `activeAddress` and `isConnected` are store-derived, so a silently dead bridge (dropped relay, expired
 * pairing) still looks connected until something touches the wallet. Every adapter's `resumeSession()` is a
 * silent revalidation (no popups - the same call `WalletProvider` makes on load): it resolves when the bridge
 * is alive, and on failure it clears the store via `onDisconnect()` before rejecting, so the UI flips to
 * disconnected on its own.
 *
 * @param manager The shared wallet manager.
 * @param wallet The active react wallet, if any.
 * @throws {Error} `Wallet session expired` when the bridge is dead (matches the session pattern in
 * `errors.ts`, so existing catch blocks handle it).
 */
export async function ensureLiveSessionFor(manager: LivenessManager, wallet: LivenessWallet | null | undefined): Promise<void> {
  if (!wallet) return
  try {
    await manager.getWallet(wallet.walletKey)?.resumeSession()
  } catch {
    // The store is already cleared at this point - the caller only needs the classified error.
    throw new Error('Wallet session expired')
  }
}
