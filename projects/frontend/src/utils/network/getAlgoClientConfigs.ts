import type { AlgoViteClientConfig, AlgoViteKMDConfig } from '../../interfaces/network'

/**
 * App environment merged from both sources, read live at call time (module scope would freeze test stubs).
 * import.meta.env only exists under Vite (tsx leaves it empty); process.env covers node scripts.
 *
 * @returns The merged environment.
 */
function appEnv(): Record<string, string | undefined> {
  return {
    ...(typeof process === 'undefined' ? {} : process.env),
    ...import.meta.env,
  }
}

/**
 * Read the algod client config from the Vite environment.
 *
 * @returns Algod client config.
 */
export function getAlgodConfigFromViteEnvironment(): AlgoViteClientConfig {
  const env = appEnv()
  const server = env.VITE_ALGOD_SERVER
  if (!server) {
    throw new Error('Attempt to get default algod configuration without specifying VITE_ALGOD_SERVER in the environment variables')
  }

  return {
    server,
    port: env.VITE_ALGOD_PORT ?? '',
    token: env.VITE_ALGOD_TOKEN ?? '',
    network: env.VITE_ALGOD_NETWORK ?? '',
  }
}

/**
 * Read the indexer client config from the Vite environment.
 *
 * @returns Indexer client config.
 */
export function getIndexerConfigFromViteEnvironment(): AlgoViteClientConfig {
  const env = appEnv()
  const server = env.VITE_INDEXER_SERVER
  if (!server) {
    throw new Error('Attempt to get default algod configuration without specifying VITE_INDEXER_SERVER in the environment variables')
  }

  return {
    server,
    port: env.VITE_INDEXER_PORT ?? '',
    token: env.VITE_INDEXER_TOKEN ?? '',
    network: env.VITE_ALGOD_NETWORK ?? '',
  }
}

/**
 * Read the KMD client config from the Vite environment.
 *
 * @returns KMD client config.
 */
export function getKmdConfigFromViteEnvironment(): AlgoViteKMDConfig {
  const env = appEnv()
  const server = env.VITE_KMD_SERVER
  if (!server) {
    throw new Error('Attempt to get default kmd configuration without specifying VITE_KMD_SERVER in the environment variables')
  }

  return {
    server,
    port: env.VITE_KMD_PORT ?? '',
    token: env.VITE_KMD_TOKEN ?? '',
    wallet: env.VITE_KMD_WALLET ?? '',
    password: env.VITE_KMD_PASSWORD ?? '',
  }
}
