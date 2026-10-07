import { Pool } from 'pg'

let shared: Pool | undefined

/**
 * Process-wide Postgres pool, configured from `DATABASE_URL`.
 *
 * @returns The shared connection pool.
 */
export function pool(): Pool {
  if (shared === undefined) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set (copy .env.template to .env)')
    }
    shared = new Pool({ connectionString })
  }
  return shared
}
