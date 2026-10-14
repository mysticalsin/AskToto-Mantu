import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHermeticSandbox, hermeticEnv } from './scripts/hermetic/sandbox-env.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const electronWorkerCase = 'src/main/infra/process/incremental-meeting-speech-worker.integration.electron-case.ts'
const sandbox = createHermeticSandbox()

export default defineConfig({
  root,
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    env: hermeticEnv(sandbox),
    include: [electronWorkerCase],
    exclude: [],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
