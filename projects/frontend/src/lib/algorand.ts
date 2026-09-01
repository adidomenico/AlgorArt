import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { getAlgodConfigFromViteEnvironment, getIndexerConfigFromViteEnvironment } from '../utils/network/getAlgoClientConfigs'

/**
 * Shared service singletons: one `AlgorandClient` (algod) and one indexer client, both configured from the Vite environment.
 *
 * The indexer is the read model (campaign lists, global state, boxes); the `AlgorandClient` drives writes (create/pledge/claim/refund)
 * through the generated `CampaignClient`.
 *
 * Construction performs no network I/O — it only builds the client objects — so this is safe at module load. Tests provide the `VITE_*`
 * values via the Vitest `env` config (see `vitest.config.ts`).
 */

const algodConfig = getAlgodConfigFromViteEnvironment()
const indexerConfig = getIndexerConfigFromViteEnvironment()

function buildIndexerToken(): algosdk.IndexerTokenHeader | string {
  const token = indexerConfig.token
  // `TokenHeader` is an object form ({ 'X-Indexer-API-Token': ... }); strings pass through.
  return typeof token === 'string' ? token : (token as algosdk.IndexerTokenHeader)
}

export const indexer = new algosdk.Indexer(buildIndexerToken(), indexerConfig.server, indexerConfig.port)

export const algorand = AlgorandClient.fromConfig({
  algodConfig: {
    server: algodConfig.server,
    port: algodConfig.port,
    token: algodConfig.token,
  },
  indexerConfig: {
    server: indexerConfig.server,
    port: indexerConfig.port,
    token: indexerConfig.token,
  },
})

/**
 * Poll the indexer until it has indexed at least the given round.
 *
 * Reads made immediately after a confirmed write can race the indexer: the transaction is on-chain, but the indexer may not have applied it
 * yet, so a follow-up read returns stale state. This helper waits (best-effort) until the indexer has caught up.
 *
 * @param round The round the indexer must catch up to (inclusive).
 * @param timeoutMs Maximum time to wait before giving up. Defaults to 10s.
 * @param pollMs Delay between polls. Defaults to 250ms.
 * @returns A promise that resolves once the indexer has caught up, or after the timeout.
 */
export async function waitForIndexerRound(round: bigint, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const health = await indexer.makeHealthCheck().do()
      if (health.round >= round) return
    } catch {
      // Indexer temporarily unreachable — retry until the timeout elapses.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Wait until the indexer has applied everything algod has committed up to now.
 *
 * Used after a write whose confirmation round isn't directly available (e.g. the generated `create` result only returns the app id, not the
 * confirmation). It snapshots algod's current last round and waits for the indexer to catch up to it.
 *
 * @param timeoutMs Maximum time to wait before giving up. Defaults to 10s.
 * @param pollMs Delay between polls. Defaults to 250ms.
 * @returns A promise that resolves once the indexer has caught up, or after the timeout.
 */
export async function waitForIndexerCatchUp(timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const status = await algorand.client.algod.status().do()
  await waitForIndexerRound(status.lastRound, timeoutMs, pollMs)
}
