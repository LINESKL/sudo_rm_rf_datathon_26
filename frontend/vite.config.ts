import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import { demoApi } from './dev/demo-api.ts'

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'demo' ? [demoApi()] : [])],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: { __DEMO__: JSON.stringify(mode === 'demo') },
  server: {
    proxy:
      mode === 'demo'
        ? undefined
        : {
            '/api': 'http://127.0.0.1:8000',
            '/ui': 'http://127.0.0.1:8000',
            '/previews': 'http://127.0.0.1:8000',
            '/health': 'http://127.0.0.1:8000',
          },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    clearMocks: true,
  },
}))
