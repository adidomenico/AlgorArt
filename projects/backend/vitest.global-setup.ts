import { Client } from 'pg'

const TEST_DATABASE_URL = 'postgresql://algorart:algorart@localhost:5432/algorart_test'

/**
 * Prepare the throwaway test database: create it, point the app at it, and migrate.
 */
export async function setup(): Promise<void> {
  const admin = new Client({ connectionString: 'postgresql://algorart:algorart@localhost:5432/postgres' })
  await admin.connect()
  try {
    await admin.query('CREATE DATABASE algorart_test')
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already exists')) throw error
  } finally {
    await admin.end()
  }
  process.env.DATABASE_URL = TEST_DATABASE_URL
  process.env.SESSION_SECRET ??= 'test-secret'
  const { runner } = await import('node-pg-migrate')
  await runner({
    databaseUrl: TEST_DATABASE_URL,
    dir: 'migrations',
    direction: 'up',
    schema: 'public',
    migrationsTable: 'pgmigrations',
    verbose: false,
  })
}

/**
 * Close the shared pool so the worker does not hang.
 */
export async function teardown(): Promise<void> {
  const { pool } = await import('./src/db.js')
  await pool().end()
}
