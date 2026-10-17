import { defineConfig } from 'vitest/config'

// https://vitest.dev/config/
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      // The SDK is utils: same 100% gate as the frontend. Genuinely unreachable defensive
      // branches carry `/* v8 ignore next */` with a reason instead of theater tests.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/generated/**'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
