import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

it('runs the dependency-free Windows signing-identity preflight regression suite', () => {
  const result = spawnSync(process.execPath, ['--test', join(__dirname, 'windows-signing-identity-preflight.test.mjs')], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 512 * 1024,
    env: { ...process.env, WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '', WIN_CSC_EXPECTED_SUBJECT: '' }
  })
  expect(result.error).toBeUndefined()
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})
