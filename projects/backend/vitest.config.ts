import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./vitest.global-setup.ts'],
    // Spec files share one throwaway database and clean it with blanket
    // DELETEs, so concurrent files can wipe each other's in-flight rows.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // App modules only: the listen entry (like the frontend's main) and the
      // manually-exercised ops scripts in scripts/ are not counted.
      include: ['src/app.ts', 'src/auth.ts', 'src/db.ts', 'src/uploads.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
