import type { AlgorandClient } from '@algorandfoundation/algokit-utils'

/** The session the SDK operates on: one configured `AlgorandClient` plus the app ids. */
export interface SdkConfig {
  /** The algod/indexer client every SDK read and write goes through. */
  algorand: AlgorandClient
  /** Canonical Factory app id (the campaign registry). */
  factoryAppId: bigint
  /** ClaimsVault app id (pledge pool + refunds). */
  vaultAppId: bigint
}

let session: SdkConfig | undefined

/**
 * Configure the SDK session. Call once at startup: the frontend passes the `AlgorandClient` it already builds, the
 * CLI builds one from flags/env.
 *
 * @param config The session configuration.
 */
export function configureSdk(config: SdkConfig): void {
  session = config
}

/**
 * The configured session.
 *
 * @returns The session configuration.
 */
export function getSdkConfig(): SdkConfig {
  if (session === undefined) throw new Error('SDK not configured: call configureSdk() first')
  return session
}

/**
 * The chain's current timestamp (latest block header), in seconds.
 *
 * Wall-clock time (`Date.now()`) is wrong on time-traveled LocalNet chains and can drift from consensus time
 * anywhere - every deadline/status/countdown decision must use this instead.
 *
 * @returns UNIX timestamp in seconds.
 */
export async function fetchChainTimestamp(): Promise<bigint> {
  const algod = getSdkConfig().algorand.client.algod
  const status = await algod.status().do()
  const block = await algod.block(status.lastRound).do()
  return block.block.header.timestamp
}

/**
 * Poll the indexer until it has indexed at least the given round.
 *
 * Reads made immediately after a confirmed write can race the indexer: the transaction is on-chain, but the indexer
 * may not have applied it yet, so a follow-up read returns stale state. This helper waits (best-effort) until the
 * indexer has caught up.
 *
 * @param round The round the indexer must catch up to (inclusive).
 * @param timeoutMs Maximum time to wait before giving up. Defaults to 10s.
 * @param pollMs Delay between polls. Defaults to 250ms.
 * @returns A promise that resolves once the indexer has caught up, or after the timeout.
 */
export async function waitForIndexerRound(round: bigint, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const indexer = getSdkConfig().algorand.client.indexer
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const health = await indexer.makeHealthCheck().do()
      if (health.round >= round) return
    } catch {
      // Indexer temporarily unreachable - retry until the timeout elapses.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Wait until the indexer has applied everything algod has committed up to now.
 *
 * Used after a write whose confirmation round isn't directly available (e.g. the generated `create` result only
 * returns the app id, not the confirmation). It snapshots algod's current last round and waits for the indexer to
 * catch up to it.
 *
 * @param timeoutMs Maximum time to wait before giving up. Defaults to 10s.
 * @param pollMs Delay between polls. Defaults to 250ms.
 * @returns A promise that resolves once the indexer has caught up, or after the timeout.
 */
export async function waitForIndexerCatchUp(timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const status = await getSdkConfig().algorand.client.algod.status().do()
  await waitForIndexerRound(status.lastRound, timeoutMs, pollMs)
}
