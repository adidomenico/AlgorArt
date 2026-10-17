/**
 * The campaign read model (registry reads, global-state decode, list/detail mapping, session caches) lives in
 * `@kasakame/sdk`, re-exported here for existing importers. The app ids are read from the Vite environment once, in
 * `lib/algorand.ts`, and handed to `configureSdk`.
 */

export * from '@kasakame/sdk'
