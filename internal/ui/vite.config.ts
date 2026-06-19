import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Pin root + outDir to this file's dir so `vite build` works no matter the
  // cwd it's invoked from (root `npm run ui:build`, package prepack, etc.).
  root: here,
  plugins: [react()],
  build: {
    // The daemon serves packages/afw/ui-dist (see daemon/server.ts).
    outDir: resolve(here, '../../packages/afw/ui-dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9877',
      '/wire': 'http://localhost:9877',
      '/health': 'http://localhost:9877',
    },
  },
})
