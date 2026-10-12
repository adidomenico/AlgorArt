/** Single-use sign-in challenges for wallet-signature auth (design.md: no passwords). */

/**
 * Create the auth_nonces table.
 *
 * @param pgm Migration builder.
 */
exports.up = (/** @type {import('node-pg-migrate').MigrationBuilder} */ pgm) => {
  pgm.createTable('auth_nonces', {
    nonce: { type: 'text', primaryKey: true },
    address: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('auth_nonces', 'expires_at')
}

/**
 * Drop the auth_nonces table.
 *
 * @param pgm Migration builder.
 */
exports.down = (/** @type {import('node-pg-migrate').MigrationBuilder} */ pgm) => {
  pgm.dropTable('auth_nonces')
}
