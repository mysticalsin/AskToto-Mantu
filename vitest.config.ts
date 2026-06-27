import { defineConfig, mergeConfig } from 'vitest/config'
import { resolve } from 'path'
import electronViteConfig from './electron.vite.config'

const vitestConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**/*', 'src/shared/**/*', 'src/preload/**/*']
    }
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})

export default mergeConfig(electronViteConfig, vitestConfig)
