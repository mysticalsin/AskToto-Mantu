import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, delimiter, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

/**
 * Invisible first-run dependency bootstrap ("Apple builds this: the user never sees plumbing").
 *
 * Ensures `graphify` (the knowledge-graph CLI AskToto shells out to — see graphify.ts) is installed,
 * entirely in the background, without ever surfacing an error, a terminal window, or a progress bar
 * to the user. Also preflights `npm` availability so the onboarding CLI-connect chooser can pre-warn
 * in plain language before the user picks an option that needs it.
 *
 * SECURITY / RELIABILITY INVARIANTS:
 *   - No shell:true, ever. All spawns pass argv as arrays. On Windows, a `.cmd`/`.bat` shim (if `where`
 *     resolves one) is launched via ComSpec as the *target executable* — not shell:true, and it is only
 *     ever fed the fixed, hardcoded installer argv this file defines (never free text) — mirrors the
 *     same pattern/CVE-2024-27980 rationale documented in cli.ts's resolveSpawnTarget.
 *   - No login-shell assumption on Windows — there isn't one. PATH resolution there goes through
 *     `where` plus a couple of known install-location fallbacks, never a user profile script.
 *   - runFirstRunBootstrap() NEVER rejects and NEVER throws into the caller — every failure path is
 *     swallowed, logged, and recorded in the state file instead. Call it fire-and-forget (`void
 *     runFirstRunBootstrap(...)`) after window creation, at low priority; it never blocks startup.
 *   - Fully self-contained: no imports from any other AskToto module, so it typechecks/tests standalone
 *     and can't be destabilized by concurrent edits elsewhere (e.g. cli.ts, index.ts).
 *
 * State persists at `<userDataDir>/bootstrap.json` (see BootstrapState) so the retry budget and last
 * known graphify/npm status survive app restarts. readBootstrapState() is the read path a future IPC
 * handler exposes to the renderer (see the wiring contract in the module doc / handoff notes).
 */

// ─── Types ──────────────────────────────────────────────────────────────────────────────────────

export type BootstrapGraphifyState = 'ok' | 'unavailable' | 'unknown'
export type BootstrapNpmState = 'ok' | 'missing' | 'unknown'

export interface BootstrapState {
  graphify: BootstrapGraphifyState
  npm: BootstrapNpmState
  /** epoch ms of the last install *attempt* (not detection-only run), or null if never attempted. */
  lastAttempt: number | null
  /** number of app launches that have attempted an install; capped at MAX_LAUNCH_ATTEMPTS. */
  attempts: number
  /** last install error message, or null once graphify is confirmed installed. Diagnostic only —
   *  never shown to the user; the onboarding UI reads `graphify`/`npm`, not this field. */
  error: string | null
}

/** Structurally compatible with electron-log's default export — no import needed to stay self-contained. */
export interface BootstrapLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface RunFirstRunBootstrapOpts {
  userDataDir: string
  log: BootstrapLogger
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

interface InstallStep {
  command: string
  args: string[]
}

// ─── Tunables ───────────────────────────────────────────────────────────────────────────────────

export const MAX_LAUNCH_ATTEMPTS = 3
export const INSTALL_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 15_000

const DEFAULT_STATE: BootstrapState = {
  graphify: 'unknown',
  npm: 'unknown',
  lastAttempt: null,
  attempts: 0,
  error: null
}

// ─── PATH augmentation (GUI-launched Electron apps get a minimal PATH; mirrors graphify.ts) ─────

const POSIX_EXTRA_BINS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.local', 'share', 'uv', 'tools', 'graphifyy', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin'
]
const WIN_EXTRA_BINS = [
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'Python'),
  join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm'),
  join(homedir(), '.local', 'bin')
]

function augmentedPath(isWin: boolean): string {
  const cur = (process.env.PATH || '').split(delimiter)
  const extra = (isWin ? WIN_EXTRA_BINS : POSIX_EXTRA_BINS).filter((p) => p && !cur.includes(p) && existsSync(p))
  return [...cur, ...extra].join(delimiter)
}

function installEnv(isWin: boolean): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentedPath(isWin) }
}

// ─── Windows command resolution (no shell:true, no login-shell assumption) ──────────────────────

const execFileAsync = promisify(execFile)

/** cmd.exe target for the `.cmd`/`.bat` shim route below. Windows CreateProcess resolves a bare
 *  filename by searching the app's own directory, then the CURRENT WORKING DIRECTORY, before it ever
 *  consults PATH — so a bare 'cmd.exe' could be shadowed by a binary planted in an attacker-writable
 *  cwd. Prefer a valid absolute ComSpec (the user's real shell) when one is set, else pin to the known
 *  System32 binary. Kept local (no import from cli.ts) — this module stays fully self-contained. */
function comSpecExe(): string {
  const cs = process.env.ComSpec
  return cs && isAbsolute(cs) ? cs : join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
}

/** Parse `where <bin>` stdout: the first line that is an actually-launchable binary (.exe/.cmd/.bat).
 *  `where` can list several shadowed matches (e.g. an extension-less shim) — only a launchable file
 *  is useful. Returns null when nothing qualifies (including "not found" / empty output). */
export function parseWhereLines(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) ?? null
}

/**
 * Run one command on Windows. Resolves it via `where` first; if that resolves to a `.cmd`/`.bat`
 * shim, routes it through ComSpec as the target executable (a direct spawn of those throws EINVAL
 * post-CVE-2024-27980 — same pattern as cli.ts's resolveSpawnTarget/cmdShimSpawn). If `where` finds
 * nothing, falls through to a bare invocation of `command` — Windows/Node still resolves a plain
 * `.exe` launcher (what pip/py/uv/graphify normally ship) without the extension spelled out.
 */
async function winRun(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  let resolved: string | null = null
  try {
    const { stdout } = await execFileAsync('where', [command], { timeout: PROBE_TIMEOUT_MS, env: installEnv(true) })
    resolved = parseWhereLines(stdout)
  } catch {
    /* `where` found nothing on PATH — fall through to the bare command below */
  }
  const target = resolved ?? command
  const opts = { timeout: timeoutMs, windowsHide: true, env: installEnv(true) }
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    return execFileAsync(comSpecExe(), ['/d', '/s', '/c', target, ...args], opts)
  }
  return execFileAsync(target, args, opts)
}

/** Cross-platform single-command runner: login shell on POSIX (same technique as detectGraphify,
 *  so pyenv/MacPorts/cargo/conda shims on PATH are picked up), and winRun's ComSpec-aware path on
 *  Windows. */
async function platformRun(
  isWin: boolean,
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  if (isWin) return winRun(command, args, timeoutMs)
  const shell = process.env.SHELL || '/bin/zsh'
  return execFileAsync(shell, ['-lc', [command, ...args].join(' ')], { timeout: timeoutMs })
}

// ─── Detection ──────────────────────────────────────────────────────────────────────────────────

/** Is graphify already installed? darwin/POSIX: `graphify --version` through the login shell (a
 *  GUI-launched Electron app gets a minimal PATH; the login shell sources the user's real profile,
 *  same technique graphify.ts uses). Windows: `where` + a direct probe (see winRun) — no login shell. */
async function detectGraphify(isWin: boolean): Promise<boolean> {
  try {
    if (isWin) {
      await winRun('graphify', ['--version'], PROBE_TIMEOUT_MS)
      return true
    }
    const shell = process.env.SHELL || '/bin/zsh'
    await execFileAsync(shell, ['-lc', 'graphify --version'], { timeout: PROBE_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

/** Is npm reachable? Existence check only (never executed) — the onboarding chooser only needs to
 *  know whether one-click CLI installs are possible, not npm's version. */
async function detectNpm(isWin: boolean): Promise<boolean> {
  try {
    if (isWin) {
      const { stdout } = await execFileAsync('where', ['npm'], { timeout: PROBE_TIMEOUT_MS })
      return !!parseWhereLines(stdout)
    }
    const shell = process.env.SHELL || '/bin/zsh'
    await execFileAsync(shell, ['-lc', 'command -v npm'], { timeout: PROBE_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

// ─── Install chain ──────────────────────────────────────────────────────────────────────────────

/** Installers to try, in order, for the current platform. Exported (pure, no I/O) so the
 *  fallback order is directly unit-testable without mocking child_process. */
export function installerStepsForPlatform(isWin: boolean): InstallStep[] {
  const uv: InstallStep = { command: 'uv', args: ['tool', 'install', 'graphifyy'] }
  if (isWin) {
    return [
      uv,
      { command: 'py', args: ['-m', 'pip', 'install', 'graphifyy'] },
      { command: 'pip', args: ['install', 'graphifyy'] }
    ]
  }
  return [uv, { command: 'pip3', args: ['install', 'graphifyy'] }]
}

/** Run one installer step. Never throws — captures stdout/stderr to `log` either way and returns a
 *  plain ok/error result so the caller can walk the chain without a try/catch at each step. */
async function attemptInstall(step: InstallStep, isWin: boolean, log: BootstrapLogger): Promise<{ ok: boolean; error?: string }> {
  const label = `${step.command} ${step.args.join(' ')}`
  try {
    const { stdout, stderr } = await platformRun(isWin, step.command, step.args, INSTALL_TIMEOUT_MS)
    log.info(`[bootstrap] ${label} → ok`, (stdout || stderr || '').trim().slice(0, 2000))
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.warn(`[bootstrap] ${label} → failed`, msg)
    return { ok: false, error: msg }
  }
}

// ─── State file (atomic write: tmp + rename, mirrors store.ts) ──────────────────────────────────

function statePath(userDataDir: string): string {
  return join(userDataDir, 'bootstrap.json')
}

/** Read the persisted bootstrap state. Missing/corrupt file → the 'unknown' default, never throws.
 *  This is the read path a future IPC handler exposes to the renderer (see module doc). */
export function readBootstrapState(userDataDir: string): BootstrapState {
  try {
    const raw = JSON.parse(readFileSync(statePath(userDataDir), 'utf8')) as Partial<BootstrapState>
    return {
      graphify: raw.graphify === 'ok' || raw.graphify === 'unavailable' ? raw.graphify : 'unknown',
      npm: raw.npm === 'ok' || raw.npm === 'missing' ? raw.npm : 'unknown',
      lastAttempt: typeof raw.lastAttempt === 'number' ? raw.lastAttempt : null,
      attempts: typeof raw.attempts === 'number' && raw.attempts >= 0 ? raw.attempts : 0,
      error: typeof raw.error === 'string' ? raw.error : null
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/** Best-effort persist — a failed write must never throw into the caller (the whole point of this
 *  module is to be invisible). Losing persistence just means the next launch re-detects from scratch. */
function writeBootstrapState(userDataDir: string, state: BootstrapState, log: BootstrapLogger): void {
  try {
    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true })
    const p = statePath(userDataDir)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, p)
  } catch (e) {
    log.warn('[bootstrap] failed to persist bootstrap.json', e instanceof Error ? e.message : String(e))
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────────────────────────

// In-flight run, keyed by nothing (single-app-instance) — a second call while one is already running
// joins the same promise instead of starting a concurrent pass that could race two writers on
// bootstrap.json. Installer steps within a single run are always awaited in sequence (never
// parallel), so "queueing" holds both across calls and within one call's installer chain.
let currentRun: Promise<void> | null = null

async function doRun(opts: RunFirstRunBootstrapOpts): Promise<void> {
  const { userDataDir, log } = opts
  const now = opts.now ?? Date.now
  const isWin = process.platform === 'win32'
  const state = readBootstrapState(userDataDir)

  state.npm = (await detectNpm(isWin)) ? 'ok' : 'missing'

  // Detection always runs first, regardless of retry budget — an out-of-band manual install (or one
  // from a previous successful attempt this module made) must be picked up immediately.
  if (await detectGraphify(isWin)) {
    state.graphify = 'ok'
    state.error = null
    writeBootstrapState(userDataDir, state, log)
    return
  }

  if (state.attempts >= MAX_LAUNCH_ATTEMPTS) {
    // Retry budget exhausted across launches — never try again, never surface anything.
    state.graphify = 'unavailable'
    writeBootstrapState(userDataDir, state, log)
    return
  }

  // At most one attempt *cycle* (the whole ordered installer chain) per app launch.
  state.attempts += 1
  state.lastAttempt = now()
  let lastError = 'no installer for this platform produced a usable graphify'
  let installed = false
  for (const step of installerStepsForPlatform(isWin)) {
    const res = await attemptInstall(step, isWin, log)
    if (!res.ok) {
      lastError = res.error ?? lastError
      continue
    }
    // A successful installer exit code doesn't guarantee the shim landed on PATH yet — confirm.
    installed = await detectGraphify(isWin)
    if (installed) break
    lastError = `${step.command} reported success but graphify still isn't reachable`
  }

  state.graphify = installed ? 'ok' : 'unavailable'
  state.error = installed ? null : lastError
  writeBootstrapState(userDataDir, state, log)
}

/**
 * Kick off the first-run dependency bootstrap in the background. Call fire-and-forget
 * (`void runFirstRunBootstrap(...)`) after window creation, at low priority — it never blocks
 * startup and never rejects (any unexpected failure is caught, logged, and swallowed).
 */
export function runFirstRunBootstrap(opts: RunFirstRunBootstrapOpts): Promise<void> {
  if (currentRun) return currentRun
  currentRun = doRun(opts)
    .catch((e) => {
      opts.log.error('[bootstrap] unexpected failure (swallowed)', e instanceof Error ? e.message : String(e))
    })
    .finally(() => {
      currentRun = null
    })
  return currentRun
}
