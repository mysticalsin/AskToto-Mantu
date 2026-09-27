import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const SCRIPT = 'scripts/qa/freeze-repro/run-matrix.sh'
const SHA = 'a'.repeat(64)

describe('M2-0008 freeze reproduction matrix harness', () => {
  it('dry-run creates the content-free matrix bundle and all required OS-fixture evidence files', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    try {
      const result = spawnSync('bash', [SCRIPT, '--artifact', SHA, '--build-run-id', '123', '--out', out, '--dry-run'], {
        encoding: 'utf8',
        timeout: 30_000
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain(out)
      expect(readFileSync(join(out, 'environment.json'), 'utf8')).toContain('"dry_run": 1')
      expect(readFileSync(join(out, 'node-options-fuse.json'), 'utf8')).toContain('NOT_EXERCISED')
      expect(readFileSync(join(out, 'dataless-fixtures.json'), 'utf8')).toContain('"fixtures"')

      const fixtures = JSON.parse(readFileSync(join(out, 'fifo-fixtures.json'), 'utf8')) as {
        kind: string
        count: number
        fixtures: string[]
      }
      expect(fixtures.kind).toBe('fifo')
      expect(fixtures.count).toBeGreaterThanOrEqual(6)
      expect(fixtures.fixtures.some((path) => path.endsWith('.brain/index.json'))).toBe(true)
      expect(fixtures.fixtures.filter((path) => path.endsWith('.md'))).toHaveLength(4)

      const matrix = readFileSync(join(out, 'matrix.jsonl'), 'utf8')
      expect(matrix).toContain('row-1-history-open')
      expect(matrix).toContain('row-2-brain-status-blocked-brain')
      expect(matrix).toContain('row-3-macos-activate')
      expect(matrix).toContain('row-4-second-instance-reopen')
      expect(matrix).toContain('row-5-dataless-brain-idle')
      expect(matrix).toContain('row-9-network-off-flapping')

      const interrupts = readFileSync(join(out, 'interrupt-results.jsonl'), 'utf8')
      expect(interrupts).toContain('network-off')
      expect(interrupts).toContain('file-provider-cancel')
      expect(interrupts).toContain('process-signal')
      expect(readFileSync(join(out, 'M2-0008.records.README.md'), 'utf8')).toContain('dry run')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses a live run unless the operator asserts the QA account boundary', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    try {
      const result = spawnSync('bash', [SCRIPT, '--artifact', SHA, '--build-run-id', '123', '--out', out], {
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('--qa-account is required')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
