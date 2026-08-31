import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vitest.dev/config/
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    env: {
      VITE_ALGOD_SERVER: 'http://localhost',
      VITE_ALGOD_PORT: '4001',
      VITE_ALGOD_TOKEN: 'a'.repeat(64),
      VITE_ALGOD_NETWORK: 'localnet',
      VITE_INDEXER_SERVER: 'http://localhost',
      VITE_INDEXER_PORT: '8980',
      VITE_INDEXER_TOKEN: 'a'.repeat(64),
      VITE_KMD_SERVER: 'http://localhost',
      VITE_KMD_PORT: '4002',
      VITE_KMD_TOKEN: 'a'.repeat(64),
      VITE_KMD_WALLET: 'unencrypted-default-wallet',
      VITE_KMD_PASSWORD: '',
      VITE_ENVIRONMENT: 'local',
    },
    coverage: {
      provider: 'v8',
      // Coverage gates components and utils (README: "line coverage ≥ 90% on
      // components and utils"). App shell/entry files (App, Home, main) and the
      // generated contract clients are excluded.
      include: ['src/components/**/*.{ts,tsx}', 'src/features/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}', 'src/utils/**/*.{ts,tsx}'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
})
