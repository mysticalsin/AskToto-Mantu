import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { createHermeticSandbox, hermeticEnv } from './scripts/hermetic/sandbox-env.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const sandbox = createHermeticSandbox()

export default defineConfig({
  root,
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  test: {
    environment: 'node',
    env: hermeticEnv(sandbox),
    include: ['scripts/qa/fixtures/import-legacy-checkpoint-reader.integration.electron-case.ts'],
    exclude: [],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
