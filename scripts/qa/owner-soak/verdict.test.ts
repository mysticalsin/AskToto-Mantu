import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

it('runs the dependency-free owner-soak evaluator suite', () => {
  const result = spawnSync(process.execPath, ['--test', join(__dirname, 'verdict.test.mjs')], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  })
  expect(result.error).toBeUndefined()
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})
