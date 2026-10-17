import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

const require = createRequire(import.meta.url)

// https://vitejs.dev/config/
export default defineConfig({
  // `@kasakame/sdk` is a `file:` dependency: without dedupe its own copies of
  // shared runtime deps would load alongside the frontend's.
  resolve: {
    dedupe: ['algosdk', '@algorandfoundation/algokit-utils', '@noble/hashes'],
    // vite-plugin-node-polyfills injects this Buffer shim into every module
    // that uses the global - including the SDK's dist/, which sits outside
    // this package and cannot resolve the plugin's node_modules from there.
    alias: {
      'vite-plugin-node-polyfills/shims/buffer': require.resolve('vite-plugin-node-polyfills/shims/buffer'),
    },
  },
  server: {
    fs: {
      // Serve the SDK's prebuilt dist/ from outside this project root.
      allow: [searchForWorkspaceRoot(process.cwd()), '../sdk'],
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      globals: {
        Buffer: true,
      },
    }),
  ],
})
