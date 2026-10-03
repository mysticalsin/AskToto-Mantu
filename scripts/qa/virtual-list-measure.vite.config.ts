import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'scripts/qa',
  resolve: {
    alias: {
      '@': resolve(__dirname, '../../src/renderer/src'),
      '@shared': resolve(__dirname, '../../src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, '../../out/virtual-list-measure'),
    emptyOutDir: true,
    minify: 'esbuild',
    rollupOptions: {
      input: {
        measure: resolve(__dirname, 'virtual-list-measure.html')
      }
    }
  }
})
