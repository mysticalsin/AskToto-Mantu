import { defineConfig, mergeConfig } from 'vitest/config'
import { resolve } from 'path'
import electronViteConfig from './electron.vite.config'

const vitestConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Also covers intelligence/ (the standalone dashboard sub-project) — its lib/ files are pure TS
    // with no DOM dependency at module-load time, so the shared node environment above is fine for them.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'intelligence/src/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.{test,spec}.{ts,tsx}',
      'eval/**/*.{test,spec}.{ts,tsx}'
    ],
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
