import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vitejs.dev/config/
export default defineConfig({
  // `@kasakame/sdk` is a `file:` dependency: without dedupe its own copies of
  // shared runtime deps would load alongside the frontend's.
  resolve: {
    dedupe: ['algosdk', '@noble/hashes'],
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
