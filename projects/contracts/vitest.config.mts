import typescript from '@rollup/plugin-typescript'
import { defineConfig } from 'vitest/config'
import { puyaTsTransformer } from '@algorandfoundation/algorand-typescript-testing/vitest-transformer'

export default defineConfig({
  esbuild: {},
  test: {
    setupFiles: 'vitest.setup.ts',
    // Coverage measures the contract source only (tests and generated
    // artifacts are excluded). The offline AVM tests exercise the contract
    // through the puya transformer, and V8's line/branch coverage over the
    // transformed code tracks the original `.algo.ts` source.
    coverage: {
      provider: 'v8',
      include: ['smart_contracts/**/*.algo.ts'],
      exclude: ['**/*.algo.spec.ts', '**/*.algo.test.ts', 'smart_contracts/artifacts/**'],
      reporter: ['text', 'json-summary'],
      // Lines/branches/functions are the meaningful metrics. Statements is left
      // un-thresholded because the `@abimethod` decorator wraps each method
      // signature in a statement V8 never marks as executed (see docs).
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
      },
    },
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      // The contract tsconfig targets CommonJS (for ts-node deploys); Vitest/Vite
      // needs ESM output so the transformer's injected `runtime-helpers` import
      // resolves against the package's ESM-only "exports" map.
      compilerOptions: { module: 'esnext' },
      transformers: {
        before: [puyaTsTransformer],
      },
    }),
  ],
})
