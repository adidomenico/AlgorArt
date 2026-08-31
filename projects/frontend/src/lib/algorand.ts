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
 * Clients are created lazily so importing the read-model helpers (and their
 * unit tests) does not require `VITE_*` environment variables to be present.
 */

let indexerInstance: algosdk.Indexer | undefined
let algorandInstance: AlgorandClient | undefined

function buildIndexerToken(): algosdk.IndexerTokenHeader | string {
  const token = getIndexerConfigFromViteEnvironment().token
  // `TokenHeader` is an object form ({ 'X-Algo-API-Token': ... }); strings pass through.
  return typeof token === 'string' ? token : (token as algosdk.IndexerTokenHeader)
}

/** Lazily-created indexer client (read model). */
export function getIndexer(): algosdk.Indexer {
  if (!indexerInstance) {
    const config = getIndexerConfigFromViteEnvironment()
    indexerInstance = new algosdk.Indexer(buildIndexerToken(), config.server, config.port)
  }
  return indexerInstance
}

/** Lazily-created `AlgorandClient` (write path, algod + indexer). */
export function getAlgorand(): AlgorandClient {
  if (!algorandInstance) {
    const algodConfig = getAlgodConfigFromViteEnvironment()
    const indexerConfig = getIndexerConfigFromViteEnvironment()
    algorandInstance = AlgorandClient.fromConfig({
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
  }
  return algorandInstance
}
