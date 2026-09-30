import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HERMETIC_TEST_FILES,
  MAX_INGEST_ATTEMPTS,
  MIN_LAUNCHES,
  QUIET_PERIOD_MS,
  STATE_FILES,
  UNACKED_SLUG,
  blockedControl,
  bootAudit,
  bootVerdict,
  censusStep,
  ciOnlyProblem,
  hermeticArgv,
  initialCensus,
  launchEnv,
  ledgerVerdict,
  llamaStartOffsets,
  parseArgs,
  schedulerVerdict,
  seedIndex,
  seedProfile,
  seededRecords,
  verdict,
  worstCaseRunMs
} from './ex-suite.mjs'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'

const root = join(__dirname, '..', '..')
const NOW = 1_780_000_000_000
const OBSERVATIONS = Object.fromEntries(
  Object.values(STATE_FILES).map((file, i) => [file, { version: `${NOW - 10_000 + i}:48`, changedAtMs: NOW - 5_000 + i }])
)

type Index = { ingested: Record<string, Record<string, unknown>> }

/** A ledger as read back after a quit: the seeded index plus whatever the boot recorded. */
function indexAfter(changes: Record<string, Record<string, unknown> | undefined>): Index {
  const index = structuredClone(seedIndex({ now: NOW, observations: OBSERVATIONS })) as Index
  for (const [file, record] of Object.entries(changes)) {
    if (record === undefined) delete index.ingested[file]
    else index.ingested[file] = record
  }
  return index
}

const unackedOk = { [STATE_FILES['completed-unacked']]: { at: NOW + 1, ok: true, attempts: 0 } }
const eligibleOk = { [STATE_FILES.eligible]: { at: NOW + 2, ok: true, sourceVersion: OBSERVATIONS['eligible.md'].version, attempts: 0 } }
const seeded = () => seededRecords(seedIndex({ now: NOW, observations: OBSERVATIONS }))

describe('seeding', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ex-suite-seed-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('seeds the five states in the hermetic EX shape', () => {
    const index = seedIndex({ now: NOW, observations: OBSERVATIONS }) as Index & { backfillRequested: boolean }
    expect(index.backfillRequested).toBe(true)
    expect(Object.keys(index.ingested).sort()).toEqual(['backedoff.md', 'exhausted.md', 'unreadable.md'])
    expect(index.ingested['backedoff.md']).toMatchObject({ ok: false, attempts: 2, retryAfter: NOW + 60 * 60_000, sourceVersion: OBSERVATIONS['backedoff.md'].version })
    expect(index.ingested['exhausted.md']).toMatchObject({ ok: false, attempts: MAX_INGEST_ATTEMPTS, exhausted: true })
    expect(index.ingested['unreadable.md']).toMatchObject({ ok: false, unreadable: { changedAtMs: OBSERVATIONS['unreadable.md'].changedAtMs } })
    // BrainIndexSchema order, so an untouched record serializes to the same bytes after the app rewrites the file.
    expect(Object.keys(index.ingested['exhausted.md'])).toEqual(['at', 'ok', 'error', 'sourceVersion', 'attempts', 'retryAfter', 'exhausted'])
    expect(index.ingested['eligible.md']).toBeUndefined()
  })

  it('writes a plaintext profile with a startable local model and the ledger under the meetings folder', () => {
    const { profile, meetingsFolder, seeded: records } = seedProfile(dir, NOW)
    const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
    expect(settings).toEqual({ ...LOCAL_LLM_SETTINGS, encryptTranscripts: false, meetingsFolder })
    expect(settings.localLlm.enabled).toBe(true)
    const index = JSON.parse(readFileSync(join(meetingsFolder, '.brain', 'index.json'), 'utf8'))
    const unreadable = statSync(join(meetingsFolder, 'unreadable.md'))
    expect(index.ingested['unreadable.md'].unreadable.changedAtMs).toBe(Math.round(unreadable.ctimeMs))
    expect(index.ingested['backedoff.md'].sourceVersion).toBe(`${Math.round(statSync(join(meetingsFolder, 'backedoff.md')).mtimeMs)}:${statSync(join(meetingsFolder, 'backedoff.md')).size}`)
    expect(JSON.parse(readFileSync(join(meetingsFolder, '.brain', 'meetings', `${UNACKED_SLUG}.json`), 'utf8')).title24).toBe('Unacked synthetic extraction')
    for (const file of Object.values(STATE_FILES)) expect(existsSync(join(meetingsFolder, file))).toBe(true)
    expect(records.exhausted).toBe(JSON.stringify(index.ingested['exhausted.md']))
  })

  it('launches on the isolated profile with the QA host-floor override and no API keys', () => {
    const env = launchEnv({ PATH: '/bin', OPENAI_API_KEY: 'k', anthropic_api_key: 'k', METIS_HK_M_SCENARIO: 'idle' }, 'profile-dir')
    expect(env).toEqual({ PATH: '/bin', ASKTOTO_USERDATA: 'profile-dir', METIS_DISABLE_APPLE_FM: '1', METIS_QA_HOST_FLOOR_OVERRIDE: '1' })
  })
})

describe('ledgerVerdict', () => {
  const extraction = 'a'.repeat(64)

  it('passes when held records stay as seeded, the unacked source merges once and the eligible one is attempted once', () => {
    const snapshots = [1, 2, 3].map(() => ({ index: indexAfter({ ...unackedOk, ...eligibleOk }), extractionSha256: extraction }))
    const result = ledgerVerdict(seeded(), snapshots)
    expect(result.failures).toEqual([])
    expect(result.states).toEqual({
      'backed-off': 'unchanged',
      exhausted: 'unchanged',
      unreadable: 'unchanged',
      'completed-unacked': { mergedAfterFirstBoot: true, extractionStable: true },
      eligible: { outcome: 'ok', attempts: 0, changedAfterAttempt: false }
    })
  })

  it('fails when an exhausted record is revived by an automatic boot', () => {
    const revived = { ...seedIndex({ now: NOW, observations: OBSERVATIONS }).ingested['exhausted.md'], attempts: 0 } as Record<string, unknown>
    delete revived.exhausted
    const snapshots = [
      { index: indexAfter(unackedOk), extractionSha256: extraction },
      { index: indexAfter({ ...unackedOk, 'exhausted.md': revived }), extractionSha256: extraction }
    ]
    const result = ledgerVerdict(seeded(), snapshots)
    expect(result.failures).toEqual(['boot 2: the exhausted record changed'])
    expect(result.states.exhausted).toBe('changed-after-boot-2')
  })

  it('fails when the unacked source is re-extracted after it merged', () => {
    const snapshots = [
      { index: indexAfter(unackedOk), extractionSha256: extraction },
      { index: indexAfter(unackedOk), extractionSha256: 'b'.repeat(64) },
      { index: indexAfter(unackedOk), extractionSha256: 'b'.repeat(64) }
    ]
    const result = ledgerVerdict(seeded(), snapshots)
    expect(result.failures).toEqual(['boot 2: the completed-unacked extraction was re-extracted'])
    expect(result.states['completed-unacked']).toEqual({ mergedAfterFirstBoot: true, extractionStable: false })
  })

  it('fails when the unacked source is still not ok after the first boot', () => {
    const result = ledgerVerdict(seeded(), [{ index: indexAfter({}), extractionSha256: extraction }])
    expect(result.failures).toEqual(['boot 1: the completed-unacked source is not ok'])
  })

  it('accepts one recorded eligible failure that is then held, and fails a second attempt', () => {
    const failed = { [STATE_FILES.eligible]: { at: NOW + 3, ok: false, error: 'model failed', attempts: 1, retryAfter: NOW + 60_000 } }
    const again = { [STATE_FILES.eligible]: { at: NOW + 400_000, ok: false, error: 'model failed', attempts: 2, retryAfter: NOW + 520_000 } }
    const held = [1, 2, 3].map(() => ({ index: indexAfter({ ...unackedOk, ...failed }), extractionSha256: extraction }))
    expect(ledgerVerdict(seeded(), held).failures).toEqual([])
    expect(ledgerVerdict(seeded(), held).states.eligible).toEqual({ outcome: 'failed-held', attempts: 1, changedAfterAttempt: false })
    const retried = [held[0], { index: indexAfter({ ...unackedOk, ...again }), extractionSha256: extraction }]
    expect(ledgerVerdict(seeded(), retried).failures).toEqual([
      'boot 2: the eligible source has 2 attempts',
      'boot 2: the eligible source was attempted again'
    ])
  })

  it('fails an unreadable ledger', () => {
    expect(ledgerVerdict(seeded(), [{ index: null, extractionSha256: extraction }]).failures).toEqual(['boot 1: the ledger was unreadable after quit'])
  })
})

describe('the llama-server census', () => {
  const installRoot = '/Applications/Metis.app'
  const bootMs = NOW
  const main = { pid: 100, ppid: 1, startedMs: bootMs, exe: `${installRoot}/Contents/MacOS/Metis`, role: 'Metis' }
  const helper = { pid: 101, ppid: 100, startedMs: bootMs + 2_000, exe: `${installRoot}/Contents/Resources/mac-helper/metis-mac-helper`, role: 'metis-mac-helper' }
  const llamaAt = (offsetMs: number) => ({ pid: 102, ppid: 101, startedMs: bootMs + offsetMs, exe: `${installRoot}/Contents/Resources/llama/llama-server`, role: 'llama-server' })
  const unrelated = { pid: 200, ppid: 1, startedMs: bootMs + 10_000, exe: '/tmp/other/llama-server', role: 'llama-server' }

  /** Samples a boot every second for `seconds`, with the table `at(ms)` returns. */
  function sampleBoot(seconds: number, at: (ms: number) => object[]) {
    let state = initialCensus(bootMs)
    for (let s = 0; s <= seconds; s++) {
      state = censusStep(state, { atMs: bootMs + s * 1_000, table: at(s * 1_000), mainPid: main.pid, installRoot })
    }
    return state
  }

  it('records only owned llama-servers this boot started, relative to main', () => {
    expect(llamaStartOffsets([main, helper, llamaAt(125_000), unrelated], { mainPid: 100, installRoot })).toEqual([125_000])
    expect(llamaStartOffsets([{ ...llamaAt(-5_000), ppid: 1 }, main], { mainPid: 100, installRoot })).toEqual([])
    expect(llamaStartOffsets([helper], { mainPid: 100, installRoot })).toBeNull()
  })

  it('fails a boot whose llama-server starts 90 s after boot', () => {
    const census = sampleBoot(130, (ms) => (ms >= 90_000 ? [main, helper, llamaAt(90_000)] : [main, helper, unrelated]))
    expect(census).toMatchObject({ mainSeen: true, firstLlamaStartMs: 90_000, maxGapMs: 1_000 })
    const result = bootVerdict([{ boot: 1, census, audit: bootAudit([], bootMs), quit: { outcome: 'clean' } }])
    expect(result.failures).toEqual(['boot 1: llama-server started 90 s after boot'])
    expect(verdict({ ...result, control: { status: 'PASS' } })).toEqual({ result: 'FAIL', exitCode: 1 })
  })

  it('passes a boot whose only llama-server starts after the quiet period', () => {
    const census = sampleBoot(135, (ms) => (ms >= QUIET_PERIOD_MS + 5_000 ? [main, helper, llamaAt(125_000)] : [main, helper]))
    expect(census.firstLlamaStartMs).toBe(125_000)
    expect(bootVerdict([{ boot: 1, census, audit: bootAudit([], bootMs), quit: { outcome: 'clean' } }])).toEqual({ failures: [], preconditions: [] })
  })

  it('fails a model start the audit log records inside the quiet period, even between samples', () => {
    const audit = bootAudit([{ event: 'sidecar.spawn', name: 'llama-server', ts: new Date(bootMs + 60_000).toISOString() }], bootMs)
    expect(audit.firstAuditedModelStartMs).toBe(60_000)
    expect(bootVerdict([{ boot: 1, census: sampleBoot(130, () => [main]), audit, quit: { outcome: 'clean' } }]).failures).toEqual([
      'boot 1: a local model start was audited 60 s after boot'
    ])
  })

  it('treats a census with a sampling gap over 2 s as no evidence', () => {
    let state = initialCensus(bootMs)
    state = censusStep(state, { atMs: bootMs, table: [main], mainPid: 100, installRoot })
    state = censusStep(state, { atMs: bootMs + 5_000, table: [main], mainPid: 100, installRoot })
    expect(bootVerdict([{ boot: 1, census: state, audit: null, quit: { outcome: 'clean' } }]).preconditions).toEqual([
      'boot 1: the census left a 5000 ms gap in the quiet period'
    ])
  })

  it('fails a relaunch whose previous launch did not end cleanly, and a quit that did not end the app', () => {
    const census = sampleBoot(130, () => [main])
    const boots = [
      { boot: 1, census, audit: bootAudit([{ event: 'app.started', prevShutdown: 'unknown' }], bootMs), quit: { outcome: 'timeout' } },
      { boot: 2, census, audit: bootAudit([{ event: 'app.started', prevShutdown: 'unclean' }], bootMs), quit: { outcome: 'clean' } }
    ]
    expect(bootVerdict(boots).failures).toEqual([
      'boot 1: the quit path did not end the app',
      'boot 2: the previous launch did not end cleanly'
    ])
  })
})

describe('schedulerVerdict', () => {
  const scan = { event: 'scheduler.job', kind: 'backfill', trigger: 'automatic', outcome: 'scanned', queued: 1, revived: 0, heldExhausted: 1, heldBackedOff: 1, heldUnreadable: 1 }

  it('passes scans that carry held counts and no file names', () => {
    const result = schedulerVerdict([{ event: 'app.started' }, scan, { event: 'scheduler.job', kind: 'model-work', outcome: 'window-open', uptimeMs: 120_004 }])
    expect(result).toEqual({
      failures: [],
      scans: [{ trigger: 'automatic', queued: 1, revived: 0, heldExhausted: 1, heldBackedOff: 1, heldUnreadable: 1 }]
    })
  })

  it('fails no scan, a scan without held counts, an automatic scan that held nothing, and a record naming a file', () => {
    expect(schedulerVerdict([]).failures).toEqual(['no backfill scan was audited'])
    expect(schedulerVerdict([{ ...scan, heldUnreadable: undefined }]).failures).toEqual([
      'a backfill scan audit carries no held counts',
      'an automatic scan did not hold every seeded held state'
    ])
    expect(schedulerVerdict([{ ...scan, heldExhausted: 0 }]).failures).toEqual(['an automatic scan did not hold every seeded held state'])
    expect(schedulerVerdict([scan, { event: 'scheduler.job', kind: 'ingest', file: 'exhausted.md' }]).failures).toEqual([
      'a scheduler.job audit names a source file'
    ])
  })
})

describe('verdict and the positive control', () => {
  it('is PRECONDITION (exit 2), never PASS, when no app path started the model', () => {
    const control = blockedControl(['window.toto.localPrewarm', 'window.toto.ask (suggest, local route)'])
    expect(control).toMatchObject({ status: 'BLOCKED_EXTERNAL', censusMeaningful: false })
    expect(control.note).toMatch(/120-s census could not be shown to be meaningful/)
    expect(verdict({ failures: [], preconditions: [], control })).toEqual({ result: 'PRECONDITION', exitCode: 2 })
    expect(verdict({ failures: [], preconditions: [], control: null })).toEqual({ result: 'PRECONDITION', exitCode: 2 })
  })

  it('is PASS only with no failure, no precondition and a control that observed llama-server', () => {
    const control = { status: 'PASS', path: 'window.toto.localPrewarm' }
    expect(verdict({ failures: [], preconditions: [], control })).toEqual({ result: 'PASS', exitCode: 0 })
    expect(verdict({ failures: [], preconditions: ['boot 1: the census never saw the main process'], control })).toEqual({ result: 'PRECONDITION', exitCode: 2 })
    expect(verdict({ failures: ['boot 1: the exhausted record changed'], preconditions: [], control: blockedControl([]) })).toEqual({ result: 'FAIL', exitCode: 1 })
  })

  it('keeps the report content-free: state names and counts, never a source file name', () => {
    const report = JSON.stringify({
      ledger: ledgerVerdict(seeded(), [{ index: indexAfter({ ...unackedOk, ...eligibleOk }), extractionSha256: 'a'.repeat(64) }]),
      boots: bootVerdict([{ boot: 1, census: initialCensus(NOW), audit: null, quit: { outcome: 'clean' } }]),
      control: blockedControl(['window.toto.localPrewarm'])
    })
    for (const file of [...Object.values(STATE_FILES), UNACKED_SLUG]) expect(report).not.toContain(file)
  })
})

describe('command line', () => {
  it('runs the two hermetic EX vitest files without --packaged', () => {
    expect(parseArgs([])).toEqual({ mode: 'hermetic' })
    const argv = hermeticArgv(root)
    expect(argv.slice(1)).toEqual(['run', ...HERMETIC_TEST_FILES])
    expect(HERMETIC_TEST_FILES.map((file) => posix.dirname(file))).toEqual(['src/main/brain', 'src/main/brain'])
    expect(HERMETIC_TEST_FILES.map((file) => posix.basename(file).replace(/\.test\.ts$/, ''))).toEqual(['ingest-retry-policy', 'ingest-maintenance-gate'])
    expect(argv[0]).toBe(join(root, 'node_modules', 'vitest', 'vitest.mjs'))
    for (const file of HERMETIC_TEST_FILES) expect(existsSync(join(root, file))).toBe(true)
  })

  it('takes --packaged <app> <report> with at least 3 launches', () => {
    expect(parseArgs(['--packaged', 'Metis.app', 'out/ex-suite.json'])).toEqual({ mode: 'packaged', appPath: 'Metis.app', reportPath: 'out/ex-suite.json', launches: MIN_LAUNCHES })
    expect(parseArgs(['--packaged', 'Metis.app', 'r.json', '--relaunches', '4']).launches).toBe(4)
    expect(() => parseArgs(['--packaged', 'Metis.app', 'r.json', '--relaunches', '2'])).toThrow(/at least 3/)
    expect(() => parseArgs(['--packaged', 'Metis.app'])).toThrow(/usage/)
    expect(() => parseArgs(['--zip', 'x'])).toThrow(/usage/)
  })

  it('runs in GitHub Actions only (D-28)', () => {
    expect(ciOnlyProblem({ GITHUB_ACTIONS: 'true' })).toBeNull()
    expect(ciOnlyProblem({})).toMatch(/D-28/)
  })

  it('bounds the whole packaged run so a job timeout can cover it', () => {
    // 3 launches of at least 130 s each, plus boot, settle, quit and the control, stay under 20 minutes.
    expect(worstCaseRunMs(3)).toBeGreaterThanOrEqual(3 * 130_000)
    expect(worstCaseRunMs(3)).toBeLessThan(20 * 60_000)
  })
})
