/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 4522,
    // Docker Desktop bind mounts may not forward Windows filesystem events.
    watch: { usePolling: true, interval: 250 },
    proxy: {
      '/api': process.env.API_URL ?? 'http://127.0.0.1:4521',
    },
  },
  test: {
    environment: 'jsdom',
  },
})
