import { pool } from './db.js'

/** A creator profile; nullable fields are unset. */
export interface Profile {
  address: string
  display_name: string | null
  avatar_cid: string | null
  bio: string | null
  email: string | null
}

/** Notification and display settings; the backend serves defaults when no row exists. */
export interface Settings {
  address: string
  notify_funded: boolean
  notify_failed: boolean
  theme: string
}

const SETTINGS_DEFAULTS = { notify_funded: true, notify_failed: true, theme: 'system' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textField(body: Record<string, unknown>, field: string, max: number): string | null | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || value.length > max) {
    throw new Error(field + ' must be a string up to ' + String(max) + ' chars')
  }
  return value
}

/**
 * Fetch a profile by address.
 *
 * @param address Wallet address.
 * @returns The profile, or null when never set.
 */
export async function getProfile(address: string): Promise<Profile | null> {
  const { rows } = await pool().query<Profile>('SELECT address, display_name, avatar_cid, bio, email FROM profiles WHERE address = $1', [
    address,
  ])
  const [profile] = rows
  return profile ?? null
}

/**
 * Create or partially update the caller's profile. Omitted fields keep their values, explicit null clears them.
 *
 * @param address Wallet address (from the session, never the body).
 * @param body Request body with optional profile fields.
 * @returns The updated profile.
 */
export async function upsertProfile(address: string, body: unknown): Promise<Profile> {
  if (!isRecord(body)) {
    throw new Error('profile must be an object')
  }
  const fields: [string, string | null][] = []
  for (const [field, max] of [
    ['display_name', 64],
    ['avatar_cid', 128],
    ['bio', 1000],
    ['email', 320],
  ] as const) {
    const value = textField(body, field, max)
    if (value !== undefined) fields.push([field, value])
  }
  if (fields.length === 0) {
    throw new Error('nothing to update')
  }
  const columns = fields.map(([column]) => column).join(', ')
  const placeholders = fields.map((_, index) => '$' + String(index + 2)).join(', ')
  const sets = fields.map(([column], index) => column + ' = $' + String(index + 2)).join(', ')
  const { rows } = await pool().query<Profile>(
    `INSERT INTO profiles (address, ${columns}, updated_at) VALUES ($1, ${placeholders}, now())
     ON CONFLICT (address) DO UPDATE SET ${sets}, updated_at = now()
     RETURNING address, display_name, avatar_cid, bio, email`,
    [address, ...fields.map(([, value]) => value)],
  )
  const [profile] = rows
  return profile as Profile
}

/**
 * Fetch the caller's settings, falling back to defaults when never saved.
 *
 * @param address Wallet address (from the session).
 * @returns The settings.
 */
export async function getSettings(address: string): Promise<Settings> {
  const { rows } = await pool().query<Settings>('SELECT address, notify_funded, notify_failed, theme FROM settings WHERE address = $1', [
    address,
  ])
  const [settings] = rows
  return settings ?? { address, ...SETTINGS_DEFAULTS }
}

/**
 * Create or partially update the caller's settings.
 *
 * @param address Wallet address (from the session, never the body).
 * @param body Request body with optional settings fields.
 * @returns The updated settings.
 */
export async function upsertSettings(address: string, body: unknown): Promise<Settings> {
  if (!isRecord(body)) {
    throw new Error('settings must be an object')
  }
  const fields: [string, boolean | string][] = []
  if (body.notify_funded !== undefined) {
    if (typeof body.notify_funded !== 'boolean') throw new Error('notify_funded must be a boolean')
    fields.push(['notify_funded', body.notify_funded])
  }
  if (body.notify_failed !== undefined) {
    if (typeof body.notify_failed !== 'boolean') throw new Error('notify_failed must be a boolean')
    fields.push(['notify_failed', body.notify_failed])
  }
  if (body.theme !== undefined) {
    if (body.theme !== 'light' && body.theme !== 'dark' && body.theme !== 'system')
      throw new Error("theme must be 'light', 'dark', or 'system'")
    fields.push(['theme', body.theme])
  }
  if (fields.length === 0) {
    throw new Error('nothing to update')
  }
  const columns = fields.map(([column]) => column).join(', ')
  const placeholders = fields.map((_, index) => '$' + String(index + 2)).join(', ')
  const sets = fields.map(([column], index) => column + ' = $' + String(index + 2)).join(', ')
  const { rows } = await pool().query<Settings>(
    `INSERT INTO settings (address, ${columns}, updated_at) VALUES ($1, ${placeholders}, now())
     ON CONFLICT (address) DO UPDATE SET ${sets}, updated_at = now()
     RETURNING address, notify_funded, notify_failed, theme`,
    [address, ...fields.map(([, value]) => value)],
  )
  const [settings] = rows
  return settings as Settings
}
