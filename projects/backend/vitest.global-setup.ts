import 'dotenv/config'
import { Client } from 'pg'

/**
 * Swap the database path segment of a Postgres URL, preserving credentials, host, port, and query string.
 *
 * @param url Full Postgres connection URL.
 * @param db Database name to point at.
 * @returns The rewritten URL.
 */
function withDatabase(url: string, db: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${db}`
  return parsed.toString()
}

/**
 * Prepare the throwaway test database: create it, point the app at it, and migrate.
 */
export async function setup(): Promise<void> {
  const appUrl = process.env.DATABASE_URL
  if (!appUrl) {
    throw new Error('DATABASE_URL is not set (copy .env.template to .env)')
  }
  // Pin the SIWA domain binding: tests assert against these values, never the developer's deployment config.
  process.env.APP_DOMAIN = 'localhost'
  process.env.APP_URI = 'http://localhost:5173'
  const admin = new Client({ connectionString: withDatabase(appUrl, 'postgres') })
  await admin.connect()
  try {
    await admin.query('CREATE DATABASE kasakame_test')
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already exists')) throw error
  } finally {
    await admin.end()
  }
  const testUrl = withDatabase(appUrl, 'kasakame_test')
  process.env.DATABASE_URL = testUrl
  process.env.SESSION_SECRET ??= 'test-secret'
  const { runner } = await import('node-pg-migrate')
  await runner({
    databaseUrl: testUrl,
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
