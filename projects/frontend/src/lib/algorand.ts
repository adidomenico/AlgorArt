import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { getAlgodConfigFromViteEnvironment, getIndexerConfigFromViteEnvironment } from '../utils/network/getAlgoClientConfigs'

/**
 * Shared service singletons: one `AlgorandClient` (algod) and one indexer
 * client, both configured from the Vite environment.
 *
 * The indexer is the read model (campaign lists, global state, boxes); the
 * `AlgorandClient` drives writes (create/pledge/claim/refund) through the
 * generated `CampaignClient`.
 *
 * Construction performs no network I/O — it only builds the client objects —
 * so this is safe at module load. Tests provide the `VITE_*` values via the
 * Vitest `env` config (see `vitest.config.ts`).
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
