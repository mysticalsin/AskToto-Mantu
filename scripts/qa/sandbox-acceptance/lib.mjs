// WP14 sandbox acceptance — pure helpers shared by install.mjs, run-acceptance.mjs and soak.mjs: CLI parsing,
// the sandbox directory layout, the child environment, synthetic WAV construction and the step report. Nothing
// here spawns an app. Imports are limited to modules that are safe to load in a unit test.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import { strictLaunchEnvironment } from '../lib/app-driver.mjs'

export const REPORT_SCHEMA = 'sandbox-acceptance/1'
export const STEP_STATUSES = Object.freeze(['PASS', 'FAIL', 'NOT_SUPPORTED', 'SKIPPED'])
/** Exit codes shared by the three CLIs. */
export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, PRECONDITION: 2 })
/** Chromium's ProcessSingleton socket is TMPDIR/org.chromium.XXXXXX/SingletonSocket; sun_path holds 103 bytes. */
export const SINGLETON_SOCKET_SUFFIX = '/org.chromium.XXXXXX/SingletonSocket'
export const SUN_PATH_MAX = 103

export class CliError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliError'
  }
}

/**
 * Minimal strict argv parser. `spec` maps a flag name to { type: 'string' | 'number' | 'boolean', default?, min?, max? }.
 * Accepts `--flag value`, `--flag=value`, `--bool` and `--no-bool`. Unknown flags and bad values throw CliError.
 * @param {readonly string[]} argv
 * @param {Record<string, { type: 'string' | 'number' | 'boolean', default?: unknown, min?: number, max?: number }>} spec
 * @returns {Record<string, any>}
 */
export function parseCli(argv, spec) {
  const values = {}
  for (const [name, def] of Object.entries(spec)) if (def.default !== undefined) values[name] = def.default
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new CliError(`unexpected argument ${JSON.stringify(token)}`)
    const eq = token.indexOf('=')
    let name = eq === -1 ? token.slice(2) : token.slice(2, eq)
    let inline = eq === -1 ? undefined : token.slice(eq + 1)
    let negated = false
    if (!(name in spec) && name.startsWith('no-') && spec[name.slice(3)]?.type === 'boolean') {
      name = name.slice(3)
      negated = true
    }
    const def = spec[name]
    if (!def) throw new CliError(`unknown flag --${name}`)
    if (def.type === 'boolean') {
      if (inline !== undefined && inline !== 'true' && inline !== 'false')
        throw new CliError(`--${name} takes no value`)
      values[name] = negated ? false : inline === undefined ? true : inline === 'true'
      continue
    }
    if (inline === undefined) {
      i += 1
      inline = argv[i]
      if (inline === undefined || inline.startsWith('--')) throw new CliError(`--${name} needs a value`)
    }
    if (def.type === 'number') {
      const number = Number(inline)
      if (inline.trim() === '' || !Number.isFinite(number))
        throw new CliError(`--${name} needs a number, got ${JSON.stringify(inline)}`)
      if (def.min !== undefined && number < def.min) throw new CliError(`--${name} must be at least ${def.min}`)
      if (def.max !== undefined && number > def.max) throw new CliError(`--${name} must be at most ${def.max}`)
      values[name] = number
    } else {
      values[name] = inline
    }
  }
  return values
}

/** A run id that is short on purpose: the sandbox paths must stay under the unix-socket length limit. */
export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `r${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** Four base-36 characters derived from the run id, for the short per-run TMPDIR. */
export function shortTmpName(runId) {
  return createHash('sha256').update(String(runId)).digest('hex').slice(0, 4)
}

/**
 * Every directory a run uses, all under `<sandboxRoot>`. The run root is `acceptance/<runId>`, which isolate.sh never
 * prunes (it prunes only `run-*`); TMPDIR is `<sandboxRoot>/t/<4 hex>` so Chromium's single-instance socket path stays
 * below the 104-byte unix-socket limit (see checkSocketBudget).
 * @param {{ sandboxRoot: string, runId: string }} args
 */
export function sandboxLayout({ sandboxRoot, runId }) {
  const runRoot = join(sandboxRoot, 'acceptance', runId)
  const home = join(runRoot, 'home')
  const userData = join(runRoot, 'userdata')
  const captureDir = join(userData, 'qa-capture')
  return {
    sandboxRoot,
    runId,
    runRoot,
    home,
    tmp: join(sandboxRoot, 't', shortTmpName(runId)),
    appData: join(home, 'AppData', 'Roaming'),
    localAppData: join(home, 'AppData', 'Local'),
    userData,
    meetingsFolder: join(userData, 'Métis Meetings'),
    auditLog: join(userData, 'logs', 'audit.log'),
    captureDir,
    captureWav: join(captureDir, 'synthetic.wav'),
    reportsDir: join(runRoot, 'reports'),
    appsDir: join(sandboxRoot, 'Applications')
  }
}

/** The launch would silently lose the single-instance lock if TMPDIR is too long; refuse that up front. */
export function checkSocketBudget(tmpDir) {
  const length = Buffer.byteLength(tmpDir + SINGLETON_SOCKET_SUFFIX)
  return length <= SUN_PATH_MAX
    ? { id: 'tmpdir-socket-budget', ok: true, detail: `${length} of ${SUN_PATH_MAX} bytes` }
    : {
        id: 'tmpdir-socket-budget',
        ok: false,
        detail: `TMPDIR + Chromium singleton socket is ${length} bytes, over ${SUN_PATH_MAX}: the app would fail requestSingleInstanceLock and quit. Use a shallower --sandbox-root.`
      }
}

/**
 * The only extra variables a scenario may add to the child environment, each a QA-identity hook that is inert in any other
 * build: the voice-actions chord FIFO and recording desktop sink (src/main/qa-voice-hooks.ts), and the one switch that lets
 * the app trust the throwaway TLS certificate of the local mock LLM. Never taken from the parent environment.
 */
export const QA_EXTRA_ENV_KEYS = Object.freeze([
  'METIS_QA_CHORD_FIFO',
  'METIS_QA_DESKTOP_SINK',
  'NODE_TLS_REJECT_UNAUTHORIZED'
])

/**
 * The only environment the QA app receives. Built from app-driver's strict allow-list (PATH, LANG, LC_*), never a copy
 * of the harness environment, then pinned to the sandbox. Credentials, OneDrive and inherited Métis overrides cannot
 * leak through. METIS_QA_CAPTURE_FILE is set only when a synthetic WAV is supplied (qa-capture-source.ts honours it
 * only for a packaged QA-identity build whose ASKTOTO_USERDATA contains the file). `extraEnv` may name only QA_EXTRA_ENV_KEYS,
 * and a chord FIFO must sit inside the profile.
 * @param {{ parentEnv: Record<string, string | undefined>, layout: ReturnType<typeof sandboxLayout>, captureFile?: string | null, platform?: string, extraEnv?: Record<string, string> }} args
 */
export function buildChildEnv({ parentEnv, layout, captureFile = null, platform = process.platform, extraEnv = {} }) {
  const env = strictLaunchEnvironment(
    parentEnv,
    {
      home: layout.home,
      userProfile: layout.home,
      appData: layout.appData,
      localAppData: layout.localAppData,
      temp: layout.tmp,
      userData: layout.userData
    },
    platform
  )
  env.ASKTOTO_LOCAL_KEYSTORE = '1'
  if (captureFile) env.METIS_QA_CAPTURE_FILE = captureFile
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!QA_EXTRA_ENV_KEYS.includes(key)) throw new Error(`${key} is not an allowed extra variable for the QA app`)
    if (key === 'METIS_QA_CHORD_FIFO') {
      const inside = isAbsolute(value) ? relative(layout.userData, value) : '..'
      if (!inside || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside))
        throw new Error('the chord FIFO must be inside the profile (ASKTOTO_USERDATA)')
    }
    env[key] = String(value)
  }
  return env
}

/** Settings seeded into a fresh profile so the overlay is on screen, not parked, and onboarding does not own the window. */
export function seedSettings(now = Date.now(), extra = {}) {
  return { onboardingDone: true, onboardingDoneAt: now, overlayLayout: 'bar', autoHideOverlay: false, ...extra }
}

/** The executable inside a .app bundle: electron-builder names it after the bundle. */
export function executableForApp(appPath) {
  return join(appPath, 'Contents', 'MacOS', basename(appPath, '.app'))
}

export const sha256Buffer = (buffer) => createHash('sha256').update(buffer).digest('hex')
export const sha256File = (path) => sha256Buffer(readFileSync(path))

// ---------------------------------------------------------------------------------------------------------------
// Synthetic audio

/**
 * A mono 16-bit PCM WAV. kind 'tone-bursts' is a speech-rate amplitude-modulated carrier pair: it exercises capture,
 * worklet and VAD but is not speech, so it cannot yield transcript text (run-acceptance reports that as NOT_SUPPORTED).
 * @param {{ seconds?: number, sampleRate?: number, kind?: 'tone-bursts' | 'silence' }} [options]
 */
export function buildWav({ seconds = 20, sampleRate = 16_000, kind = 'tone-bursts' } = {}) {
  const frames = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(frames * 2)
  for (let n = 0; n < frames; n += 1) {
    const t = n / sampleRate
    let sample = 0
    if (kind === 'tone-bursts') {
      const envelope = Math.max(0, Math.sin(2 * Math.PI * 3 * t)) // 3 Hz bursts, about syllable rate
      sample = envelope * 0.3 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 660 * t))
    }
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), n * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Parse a canonical or extended-chunk RIFF/WAVE header. Returns null unless it is 16-bit integer PCM, which is the only
 * format Chromium's fake audio capture file source accepts.
 * @param {Buffer} buffer
 */
export function parseWavInfo(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
    return null
  let offset = 12
  let fmt = null
  let dataBytes = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 8 + 16 <= buffer.length) {
      fmt = {
        format: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22)
      }
    } else if (id === 'data') {
      dataBytes = Math.min(size, buffer.length - offset - 8)
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (!fmt || dataBytes === null || fmt.format !== 1 || fmt.bitsPerSample !== 16 || fmt.channels < 1) return null
  const durationSeconds = dataBytes / (fmt.sampleRate * fmt.channels * 2)
  return { ...fmt, dataBytes, durationSeconds }
}

/** The text `say` speaks for the synthetic meeting: neutral, English, content-free of any real person or company. */
export const SYNTHETIC_SCRIPT = [
  'Good morning everyone, thanks for joining the weekly planning call.',
  'Let us start with the release schedule. The beta build is due on Thursday and the final build is due the following Tuesday.',
  'Maria will review the onboarding changes and Daniel will update the documentation by Friday.',
  'The main risk is the integration test suite, which takes about forty minutes to run.',
  'We agreed to freeze the feature list today and to meet again next Monday at ten.',
  'Does anyone have questions before we close the call? If not, thank you all and have a great week.'
].join(' ')

// ---------------------------------------------------------------------------------------------------------------
// Meeting files and audit records

/** A saved meeting: a visible .md that is not the folder README/index, an autosave draft (dot file) or a note card. */
export function isSavedMeetingFile(name) {
  if (name.startsWith('.') || !name.endsWith('.md')) return false
  if (name === 'README.md' || name === 'index.md') return false
  return !/-note-/.test(name)
}

export const isDraftMeetingFile = (name) => name.startsWith('.autosave-draft-') && name.endsWith('.md')

/** @param {string} folder @param {(name: string) => boolean} [predicate] */
export function listMeetingFiles(folder, predicate = isSavedMeetingFile) {
  try {
    return readdirSync(folder).filter(predicate).sort()
  } catch {
    return []
  }
}

/** Records of `records` (parsed audit lines) named `event`, from index `since`. */
export function auditEventsSince(records, event, since = 0) {
  return records.slice(since).filter((record) => record?.event === event)
}

// ---------------------------------------------------------------------------------------------------------------
// Step report

/**
 * @typedef {{ id: string, status: string, reason?: string, evidence: Record<string, unknown>, ms?: number }} Step
 */
/**
 * @param {{ tool: string, config?: Record<string, unknown>, meta?: Record<string, unknown>, now?: () => number }} args
 * @returns {{ schema: string, tool: string, startedAt: string, config: Record<string, unknown>, meta: Record<string, unknown>, steps: Step[], verdict: string | null, finishedAt: string | null, _now: () => number }}
 */
export function createReport({ tool, config = {}, meta = {}, now = Date.now }) {
  return {
    schema: REPORT_SCHEMA,
    tool,
    startedAt: new Date(now()).toISOString(),
    config,
    meta,
    steps: [],
    verdict: null,
    finishedAt: null,
    _now: now
  }
}

/**
 * Run one scenario step and record it. A step PASSES only when its function returns a non-empty `evidence` object of
 * what it observed; a function that returns nothing, throws, or returns an unknown status is a FAIL. There is no way
 * to record a PASS without evidence. A step may return `{ status: 'NOT_SUPPORTED' | 'FAIL' | 'SKIPPED', reason, evidence }`.
 * @param {ReturnType<typeof createReport>} report
 * @param {string} id
 * @param {() => Promise<{ status?: string, reason?: string, evidence?: Record<string, unknown> } | undefined>} fn
 * @param {{ requires?: string[] }} [options] ids that must have PASSED, else this step is SKIPPED without running
 * @returns {Promise<Step>}
 */
export async function runStep(report, id, fn, { requires = [] } = {}) {
  const started = report._now()
  const unmet = requires.filter((required) => report.steps.find((step) => step.id === required)?.status !== 'PASS')
  if (unmet.length) {
    const skipped = { id, status: 'SKIPPED', reason: `requires ${unmet.join(', ')} to PASS`, evidence: {}, ms: 0 }
    report.steps.push(skipped)
    return skipped
  }
  /** @type {Step} */
  let step
  try {
    const result = await fn()
    const evidence = result?.evidence
    const hasEvidence = evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0
    const status = result?.status ?? 'PASS'
    if (!STEP_STATUSES.includes(status))
      step = {
        id,
        status: 'FAIL',
        reason: `step returned unknown status ${JSON.stringify(status)}`,
        evidence: evidence ?? {}
      }
    else if (status === 'PASS' && !hasEvidence)
      step = {
        id,
        status: 'FAIL',
        reason: 'step returned no evidence of an observation; a PASS needs one',
        evidence: {}
      }
    else if (status !== 'PASS' && !result?.reason)
      step = { id, status: 'FAIL', reason: `step returned ${status} without a reason`, evidence: evidence ?? {} }
    else step = { id, status, ...(result?.reason ? { reason: result.reason } : {}), evidence: evidence ?? {} }
  } catch (error) {
    step = { id, status: 'FAIL', reason: error instanceof Error ? error.message : String(error), evidence: {} }
  }
  step.ms = report._now() - started
  report.steps.push(step)
  return step
}

/**
 * FAIL when any step FAILED; INCOMPLETE when none failed but a step was SKIPPED; PASS_WITH_GAPS when everything that
 * ran passed but at least one step is NOT_SUPPORTED; PASS otherwise. An empty report is INCOMPLETE.
 * @param {{ status: string }[]} steps
 */
export function reportVerdict(steps) {
  if (steps.length === 0) return 'INCOMPLETE'
  if (steps.some((step) => step.status === 'FAIL')) return 'FAIL'
  if (steps.some((step) => step.status === 'SKIPPED')) return 'INCOMPLETE'
  if (steps.some((step) => step.status === 'NOT_SUPPORTED')) return 'PASS_WITH_GAPS'
  return 'PASS'
}

export function exitCodeForVerdict(verdict) {
  return verdict === 'PASS' || verdict === 'PASS_WITH_GAPS' ? EXIT_CODES.PASS : EXIT_CODES.FAIL
}

/**
 * Finalise and return the serialisable report (drops the injected clock).
 * @param {ReturnType<typeof createReport>} report
 * @param {Record<string, unknown>} [extra]
 */
export function finishReport(report, extra = {}) {
  report.verdict = reportVerdict(report.steps)
  report.finishedAt = new Date(report._now()).toISOString()
  const out = { ...report, ...extra }
  delete out._now
  return out
}

/** One line per step for the console. */
export function formatSteps(steps) {
  return steps.map((step) => `[${step.status}] ${step.id}${step.reason ? ` — ${step.reason}` : ''}`).join('\n')
}
