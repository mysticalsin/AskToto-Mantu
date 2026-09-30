import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateSoak, longestActiveRun, soakRecordContent, soakRecordProblems, verdictFor } from './verdict.mjs'

const CLI = fileURLToPath(new URL('./verdict.mjs', import.meta.url))

const day = (overrides = {}) => ({
  records: 40, boots: 1, uncleanShutdowns: 0, stallsOver5s: 0, orphanReaps: 0, revealNoOps: 0, brainIndexQuarantined: 0,
  ...overrides
})

const daysFrom = (keys) => Object.fromEntries(keys.map((key) => [key, day()]))
const FIVE = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']

function summary({ days = daysFrom(FIVE), soak = {}, version = '1.9.7', window = {}, ...rest } = {}) {
  return {
    kind: 'metis-diagnostics-summary',
    schema: 2,
    generatedAt: '2026-10-06T08:00:00.000Z',
    app: { version, platform: 'darwin', arch: 'arm64' },
    window: { from: '2026-09-20T00:00:00.000Z', to: '2026-10-06T07:59:00.000Z', records: 900, generations: 1, truncated: false, ...window },
    scope: {
      version,
      from: '2026-10-01T06:00:00.000Z',
      to: '2026-10-05T20:00:00.000Z',
      records: 200,
      daySpan: 5,
      idleDays: 0,
      days,
      soak: {
        stallsOver5s: 0,
        uncleanShutdowns: 0,
        orphanReaps: { registry: 0, 'legacy-orphan': 0, afterUncleanExit: 0 },
        revealNoOps: 0,
        brainIndexQuarantined: 0,
        ...soak
      }
    },
    ...rest
  }
}

test('V1 a clean five-day soak proceeds and writes a record the checker accepts', () => {
  const result = evaluateSoak(summary())
  assert.deepEqual(result.problems, [])
  assert.equal(result.verdict, 'PROCEED')
  assert.deepEqual(result.run, { first: '2026-10-01', last: '2026-10-05', length: 5 })
  assert.deepEqual(soakRecordProblems(soakRecordContent(result)), [])
})

test('V2 rotation mid-window: a summary that read several generations is judged on its counts alone', () => {
  const result = evaluateSoak(summary({ window: { generations: 4 } }))
  assert.equal(result.verdict, 'PROCEED')
  assert.equal(evaluateSoak(summary({ window: { generations: 4, truncated: true } })).problems.length, 1)
})

test('V3 a version change: a summary of another version is ineligible, however clean', () => {
  const problems = evaluateSoak(summary({ version: '1.9.6' })).problems
  assert.deepEqual(problems.filter((p) => p.startsWith('app.version') || p.startsWith('scope.version')).length, 2)
  assert.equal(evaluateSoak(summary({ version: '1.9.6' })).verdict, undefined)
})

test('V4 a missing day breaks the run: two days then three is not five consecutive', () => {
  const days = daysFrom(['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-06'])
  const result = evaluateSoak(summary({ days }))
  assert.match(result.problems.join('\n'), /at least 5 consecutive active days, found 3/)
  assert.deepEqual(longestActiveRun(days), { first: '2026-10-04', last: '2026-10-06', length: 3 })
})

test('V5 six days with a gap early still qualifies on the later five-day run', () => {
  const result = evaluateSoak(summary({ days: daysFrom(['2026-09-28', ...FIVE]) }))
  assert.equal(result.run.length, 5)
  assert.equal(result.verdict, 'PROCEED')
})

test('V6 an unclean boot with its reaps holds and the record carries the counts', () => {
  const result = evaluateSoak(summary({
    soak: { uncleanShutdowns: 1, orphanReaps: { registry: 2, 'legacy-orphan': 1, afterUncleanExit: 3 } }
  }))
  assert.equal(result.verdict, 'HOLD')
  assert.equal(result.counts.orphan_reaps, 3)
  const content = soakRecordContent(result)
  assert.match(content, /^unclean_shutdowns: 1$/m)
  assert.match(content, /^orphan_reaps: 3$/m)
  assert.match(content, /^orphan_reaps_after_unclean_exit: 3$/m)
  assert.match(content, /^verdict: HOLD$/m)
  assert.deepEqual(soakRecordProblems(content), [])
})

test('V7 each of the five counts alone holds', () => {
  const single = [
    { stallsOver5s: 1 },
    { uncleanShutdowns: 1 },
    { orphanReaps: { registry: 0, 'legacy-orphan': 1, afterUncleanExit: 0 } },
    { revealNoOps: 1 },
    { brainIndexQuarantined: 1 }
  ]
  for (const soak of single) assert.equal(evaluateSoak(summary({ soak })).verdict, 'HOLD', JSON.stringify(soak))
})

test('V8 wrong kind, wrong schema and malformed counts are each ineligible', () => {
  assert.match(evaluateSoak(summary({ kind: 'other' })).problems.join('\n'), /kind/)
  assert.match(evaluateSoak(summary({ schema: 1 })).problems.join('\n'), /schema/)
  assert.match(evaluateSoak(summary({ soak: { stallsOver5s: -1 } })).problems.join('\n'), /stalls_over_5s/)
  assert.match(evaluateSoak(summary({ soak: { revealNoOps: '0' } })).problems.join('\n'), /reveal_no_ops/)
  assert.deepEqual(evaluateSoak(null).problems, ['summary: expected a JSON object'])
  assert.match(evaluateSoak({ kind: 'metis-diagnostics-summary', schema: 2 }).problems.join('\n'), /scope/)
})

test('V9 verdictFor is PROCEED only when every count is zero', () => {
  const zero = { stalls_over_5s: 0, unclean_shutdowns: 0, orphan_reaps: 0, reveal_no_ops: 0, brain_index_quarantined: 0 }
  assert.equal(verdictFor(zero), 'PROCEED')
  assert.equal(verdictFor({ ...zero, reveal_no_ops: 2 }), 'HOLD')
})

test('V10 the record validator rejects a contradicted verdict, a short window, a path and a missing field', () => {
  const good = soakRecordContent(evaluateSoak(summary()))
  assert.match(soakRecordProblems(good.replace('verdict: PROCEED', 'verdict: HOLD')).join('\n'), /contradicts the counts/)
  assert.match(soakRecordProblems(good.replace('stalls_over_5s: 0', 'stalls_over_5s: 2')).join('\n'), /contradicts the counts/)
  assert.match(soakRecordProblems(good.replace('last_day: 2026-10-05', 'last_day: 2026-10-04')).join('\n'), /consecutive_active_days/)
  assert.match(soakRecordProblems(good.replace('evidence_level: MEASURED', 'evidence_level: DESIGNED')).join('\n'), /MEASURED/)
  assert.match(soakRecordProblems(`${good}\nnote: /Users/someone/x\n`).join('\n'), /user path/)
  assert.match(soakRecordProblems(good.replace(/^verdict: .*\n/m, '')).join('\n'), /missing verdict/)
  assert.match(soakRecordProblems(`${good}\nverdict: HOLD\n`).join('\n'), /more than once/)
})

test('V11 the CLI writes the record for an eligible summary, exits 1 for an ineligible one and 2 without args', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-soak-'))
  const okPath = join(dir, 'ok.json')
  const badPath = join(dir, 'bad.json')
  writeFileSync(okPath, JSON.stringify(summary({ soak: { stallsOver5s: 1 } })))
  writeFileSync(badPath, JSON.stringify(summary({ version: '1.9.6' })))

  const output = execFileSync(process.execPath, [CLI, '--summary', okPath, '--out', join(dir, 'out')], { encoding: 'utf8' })
  assert.match(output, /owner soak: HOLD \(5 consecutive active days\)/)
  const record = readFileSync(join(dir, 'out', 'soak-5d.md'), 'utf8')
  assert.deepEqual(soakRecordProblems(record), [])

  const bad = spawnSync(process.execPath, [CLI, '--summary', badPath, '--out', join(dir, 'out2')], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /app\.version/)
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2)
})
