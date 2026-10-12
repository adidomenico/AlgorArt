/** Profiles and notification settings, keyed by wallet address (design.md: no passwords, wallet is the account). */

/**
 * Create the profiles and settings tables.
 *
 * @param pgm Migration builder.
 */
exports.up = (/** @type {import('node-pg-migrate').MigrationBuilder} */ pgm) => {
  pgm.createTable('profiles', {
    address: { type: 'text', primaryKey: true },
    display_name: { type: 'text' },
    avatar_cid: { type: 'text' },
    bio: { type: 'text' },
    email: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createTable('settings', {
    address: { type: 'text', primaryKey: true },
    notify_funded: { type: 'boolean', notNull: true, default: true },
    notify_failed: { type: 'boolean', notNull: true, default: true },
    theme: { type: 'text', notNull: true, default: 'system' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
}

/**
 * Drop the settings and profiles tables.
 *
 * @param pgm Migration builder.
 */
exports.down = (/** @type {import('node-pg-migrate').MigrationBuilder} */ pgm) => {
  pgm.dropTable('settings')
  pgm.dropTable('profiles')
}
