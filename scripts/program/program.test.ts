import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

it('runs the dependency-free program node:test suites', () => {
  const suites = ['claims-check'].map((name) => join(__dirname, `${name}.test.mjs`))
  const result = spawnSync(process.execPath, ['--test', ...suites], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })
  expect(result.error).toBeUndefined()
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})
