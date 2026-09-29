import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// M2-0422: the boot sidecar reaper, sidecar observer and stall sampler run on the main thread during boot.
// A synchronous child-process call there freezes the app for the length of the `ps` run (measured at ~15% of a
// 1.3 s uninterrupted boot stretch), so these files may only use the asynchronous execFile/spawn.
const BOOT_PATH_FILES = [
  'infra/process/reaper',
  'infra/observability/sidecar-events',
  'infra/observability/stall-sampler'
]

describe('M2-0422 boot path never blocks the main thread on a child process', () => {
  for (const file of BOOT_PATH_FILES) {
    it(`${file} has no execFileSync / spawnSync / execSync`, () => {
      const source = readFileSync(join(__dirname, `${file}.ts`), 'utf8')
      expect(source).not.toMatch(/\b(execFileSync|spawnSync|execSync)\b/)
    })
  }
})
