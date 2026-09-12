import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, '../../src/shared') } },
  test: {
    include: ['scripts/evals/local-recap.run.ts'],
    environment: 'node', maxWorkers: 1, fileParallelism: false,
    // Independent 45-minute batch ceiling below ends earlier and marks unrun cases failed.
    testTimeout: 2_880_000, hookTimeout: 10_000
  }
})
