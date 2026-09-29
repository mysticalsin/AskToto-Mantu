import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      expect(readFileSync(join(out, 'external-blockers.json'), 'utf8')).toContain('"BLOCKED_EXTERNAL"')
      expect(readFileSync(join(out, 'launch-plan.json'), 'utf8')).toContain('"electron_user_data_dir_switch":true')
      expect(readFileSync(join(out, 'diagnostic-reports.json'), 'utf8')).toContain('"consented":false')
      expect(readFileSync(join(out, 'diagnostic-reports.json'), 'utf8')).toContain('Metis/AskToto process names or sampled process ids only')
      expect(readFileSync(join(out, 'M2-0008.lead-action.md'), 'utf8')).toContain('LEAD_ACTION:')
      expect(readFileSync(join(out, 'M2-0008.lead-action.md'), 'utf8')).toContain('OBSERVED')
      expect(readFileSync(join(out, 'M2-0008.lead-action.md'), 'utf8')).toContain('DERIVED')

      const fixtures = JSON.parse(readFileSync(join(out, 'fifo-fixtures.json'), 'utf8')) as {
        kind: string
        count: number
        fixtures: { path: string; opened_by_1_9_6: boolean | null }[]
      }
      expect(fixtures.kind).toBe('fifo')
      expect(fixtures.count).toBeGreaterThanOrEqual(6)
      expect(fixtures.fixtures.some((fixture) => fixture.path.endsWith('.brain/index.json'))).toBe(true)
      expect(fixtures.fixtures.filter((fixture) => fixture.path.endsWith('.md'))).toHaveLength(4)
      expect(fixtures.fixtures.every((fixture) => Object.hasOwn(fixture, 'opened_by_1_9_6'))).toBe(true)

      const matrix = readFileSync(join(out, 'matrix.jsonl'), 'utf8')
      expect(matrix).toContain('row-1-history-open')
      expect(matrix).toContain('row-2-brain-status-blocked-brain')
      expect(matrix).toContain('row-3-macos-activate')
      expect(matrix).toContain('row-4-second-instance-reopen')
      expect(matrix).toContain('row-5-dataless-brain-idle')
      expect(matrix).toContain('row-9-network-off-flapping')
      expect(matrix).toContain('"fixture":"dataless-brain-index"')
      expect(matrix).toContain('"fixture":"dataless-meeting"')

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

  it('refuses a live run without mandatory dataless fixtures', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    const profile = mkdtempSync(join(tmpdir(), 'm2-0008-profile-'))
    const app = join(out, 'Metis')
    try {
      writeFileSync(app, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
      chmodSync(app, 0o700)
      const result = spawnSync('bash', [
        SCRIPT,
        '--artifact', SHA,
        '--build-run-id', '123',
        '--out', out,
        '--app', app,
        '--profile-template', profile,
        '--implementer-session-id', 'impl-1',
        '--validator-session-id', 'valid-1',
        '--qa-account'
      ], {
        encoding: 'utf8',
        env: { ...process.env, M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1' },
        timeout: 30_000
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('--dataless-brain-index is required')
    } finally {
      rmSync(out, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('refuses PASS evidence when a live run cannot collect both main and renderer samples', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    const profile = mkdtempSync(join(tmpdir(), 'm2-0008-profile-'))
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'm2-0008-fixtures-'))
    const pathRoot = mkdtempSync(join(tmpdir(), 'm2-0008-path-'))
    const app = join(out, 'Metis')
    const fakeStat = join(pathRoot, 'stat')
    const brainIndex = join(fixtureRoot, 'index.json')
    const meeting = join(fixtureRoot, 'meeting.md')
    try {
      writeFileSync(app, '#!/usr/bin/env bash\nfor arg in "$@"; do [ "$arg" = "-e" ] && exit 0; done\nsleep 120\n', 'utf8')
      chmodSync(app, 0o700)
      writeFileSync(brainIndex, '{}\n', 'utf8')
      writeFileSync(meeting, '# synthetic\n', 'utf8')
      writeFileSync(fakeStat, '#!/usr/bin/env bash\nprintf "1073741824\\n"\n', 'utf8')
      chmodSync(fakeStat, 0o700)

      const result = spawnSync('bash', [
        SCRIPT,
        '--artifact', SHA,
        '--build-run-id', '123',
        '--out', out,
        '--app', app,
        '--profile-template', profile,
        '--dataless-brain-index', brainIndex,
        '--dataless-meeting', meeting,
        '--implementer-session-id', 'impl-1',
        '--validator-session-id', 'valid-1',
        '--qa-account'
      ], {
        encoding: 'utf8',
        input: '\n\n\n\n\n\n\n\n\n',
        env: {
          ...process.env,
          PATH: `${pathRoot}:${process.env.PATH ?? ''}`,
          M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1',
          M2_0008_CONTRACT_IDLE_SECONDS: '1',
          M2_0008_CONTRACT_LAUNCH_SETTLE_SECONDS: '1'
        },
        timeout: 45_000
      })

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('required main and renderer samples')
      const manifest = readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8')
      expect(manifest).toContain('"result": "FAIL"')
      expect(manifest).not.toContain('"result": "PASS"')
      expect(manifest).toContain('"required_evidence_level": "LIVE_VERIFIED"')
      expect(readFileSync(join(out, 'owner-bug-records.json'), 'utf8')).toContain('"history-freeze"')
      expect(readFileSync(join(out, 'owner-bug-records.json'), 'utf8')).toContain('"no-reopen"')
      expect(readFileSync(join(out, 'diagnostic-reports.json'), 'utf8')).toContain('"consented":false')

      const matrix = readFileSync(join(out, 'matrix.jsonl'), 'utf8')
      expect(matrix).toContain('"fixture":"dataless-brain-index"')
      expect(matrix).toContain('"fixture":"dataless-meeting"')
      expect(matrix).not.toContain(brainIndex)
      expect(matrix).not.toContain(meeting)
    } finally {
      rmSync(out, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
      rmSync(fixtureRoot, { recursive: true, force: true })
      rmSync(pathRoot, { recursive: true, force: true })
    }
  })

  it('refuses PASS evidence when required live rows and interrupt checks are not exercised', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    const profile = mkdtempSync(join(tmpdir(), 'm2-0008-profile-'))
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'm2-0008-fixtures-'))
    const pathRoot = mkdtempSync(join(tmpdir(), 'm2-0008-path-'))
    const app = join(out, 'Metis')
    const fakeStat = join(pathRoot, 'stat')
    const brainIndex = join(fixtureRoot, 'index.json')
    const meeting = join(fixtureRoot, 'meeting.md')
    try {
      writeFileSync(app, '#!/usr/bin/env bash\nfor arg in "$@"; do [ "$arg" = "-e" ] && exit 0; done\nsleep 120\n', 'utf8')
      chmodSync(app, 0o700)
      writeFileSync(brainIndex, '{}\n', 'utf8')
      writeFileSync(meeting, '# synthetic\n', 'utf8')
      writeFileSync(fakeStat, '#!/usr/bin/env bash\nprintf "1073741824\\n"\n', 'utf8')
      chmodSync(fakeStat, 0o700)

      const result = spawnSync('bash', [
        SCRIPT,
        '--artifact', SHA,
        '--build-run-id', '123',
        '--out', out,
        '--app', app,
        '--profile-template', profile,
        '--dataless-brain-index', brainIndex,
        '--dataless-meeting', meeting,
        '--implementer-session-id', 'impl-1',
        '--validator-session-id', 'valid-1',
        '--qa-account'
      ], {
        encoding: 'utf8',
        input: '\n\n\n\n\n\n\n\n\n',
        env: {
          ...process.env,
          PATH: `${pathRoot}:${process.env.PATH ?? ''}`,
          M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1',
          M2_0008_CONTRACT_IDLE_SECONDS: '1',
          M2_0008_CONTRACT_LAUNCH_SETTLE_SECONDS: '1'
        },
        timeout: 45_000
      })

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('required matrix rows exercised')
      expect(result.stderr).toContain('required interrupt checks exercised')
      const manifest = readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8')
      expect(manifest).toContain('"result": "FAIL"')
      expect(manifest).toContain('"matrix_result_failures": 6')
      expect(manifest).toContain('"interrupt_result_failures": 3')
      expect(manifest).toContain('"first": "M2-0008"')
      expect(manifest).toContain('"second": "M2-0009"')
    } finally {
      rmSync(out, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
      rmSync(fixtureRoot, { recursive: true, force: true })
      rmSync(pathRoot, { recursive: true, force: true })
    }
  })

  it('--candidate-run emits an M2-0194 attribution bundle that check.mjs accepts', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0194-freeze-contract-'))
    try {
      const run = spawnSync('bash', [SCRIPT, '--artifact', SHA, '--build-run-id', '123', '--candidate-run', '456', '--out', out, '--dry-run'], {
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)

      const environment = JSON.parse(readFileSync(join(out, 'environment.json'), 'utf8')) as { ticket: string; candidate_run: string }
      expect(environment.ticket).toBe('M2-0194')
      expect(environment.candidate_run).toBe('456')
      expect(readFileSync(join(out, 'M2-0194.lead-action.md'), 'utf8')).toContain('LIVE_VERIFIED')
      for (const file of ['stall-excerpt.jsonl', 'sampler-excerpt.jsonl', 'reveal-excerpt.jsonl', 'sidecar-excerpt.jsonl']) {
        expect(readFileSync(join(out, file), 'utf8')).toBe('')
      }
      expect(JSON.parse(readFileSync(join(out, 'stall-bundle-names.json'), 'utf8'))).toEqual({ names: [] })

      const check = spawnSync(process.execPath, ['scripts/evidence/check.mjs', '--ticket', 'M2-0194', '--bundle', out], {
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0)
      expect(check.stdout).toContain('M2-0194 bundle: OK')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('rejects a --candidate-run that is not a run id', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0194-freeze-contract-'))
    try {
      const result = spawnSync('bash', [SCRIPT, '--artifact', SHA, '--build-run-id', '123', '--candidate-run', 'abc', '--out', out, '--dry-run'], {
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('--candidate-run must be a positive integer')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('collects DiagnosticReports only with explicit consent and process-scoped matching', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    try {
      const result = spawnSync('bash', [SCRIPT, '--artifact', SHA, '--build-run-id', '123', '--out', out, '--dry-run', '--collect-diagnostic-reports'], {
        encoding: 'utf8',
        timeout: 30_000
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const diagnosticReports = readFileSync(join(out, 'diagnostic-reports.json'), 'utf8')
      expect(diagnosticReports).toContain('"consented":true')
      expect(diagnosticReports).toContain('Metis/AskToto process names or sampled process ids only')
      expect(diagnosticReports).toContain('"copied":[')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
