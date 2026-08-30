import typescript from '@rollup/plugin-typescript'
import { defineConfig } from 'vitest/config'
import { puyaTsTransformer } from '@algorandfoundation/algorand-typescript-testing/vitest-transformer'

export default defineConfig({
  esbuild: {},
  test: {
    setupFiles: 'vitest.setup.ts',
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
