import { appIdFromEnv } from '../utils/network/getAlgoClientConfigs'

/**
 * Frontend env readers for the configured app ids. The campaign read model (registry reads, global-state decode,
 * list/detail mapping, session caches) lives in `@kasakame/sdk`, re-exported here for existing importers.
 */
export * from '@kasakame/sdk'

/**
 * The Factory app id the frontend treats as canonical, from the environment.
 *
 * @returns The Factory app id, or 0 when not configured (registration filter disabled).
 */
export function factoryAppId(): bigint {
  return appIdFromEnv('VITE_FACTORY_APP_ID')
}

/**
 * The ClaimsVault app id the frontend pays pledges into and refunds from, from the environment.
 *
 * @returns The vault app id, or 0 when not configured.
 */
export function vaultAppId(): bigint {
  return appIdFromEnv('VITE_VAULT_APP_ID')
}
