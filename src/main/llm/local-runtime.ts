/**
 * local-runtime.ts — lifecycle manager for the `llama-server` sidecar that powers Métis Local (on-device
 * suggest/summary/vision). Owns the child process, the ephemeral loopback port, and a per-app-session
 * api key; none of the three are ever logged or exposed outside this module (the renderer gets only
 * derived readiness booleans — see PLAN.md §4.3/§4.6).
 *
 * Module-level state (not a class) matches the rest of src/main (store.ts, parakeet.ts): the app runs at
 * most one sidecar per process, so a singleton closure is simpler than an instance nobody ever
 * constructs twice.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { auditLog } from '../logger'
import { errMsg } from './shared'

export type LlamaPlatform = 'mac' | 'win'
export type WinVariant = 'vulkan' | 'cpu'
export type BinaryVariant = WinVariant | 'mac'

export interface ModelPaths {
  gguf: string
  mmproj: string
}

export interface BinaryCandidate {
  path: string
  variant: BinaryVariant
}

export type RuntimeState = 'stopped' | 'starting' | 'running' | 'unavailable'

// Health budget: Windows Defender's first-run scan of a freshly-unpacked exe can add tens of seconds
// before the process even starts executing (PLAN.md §7 risk 3) — mac has no such AV tax.
const HEALTH_BUDGET_MS: Record<LlamaPlatform, number> = { mac: 30_000, win: 60_000 }
const HEALTH_POLL_INTERVAL_MS = 250
const IDLE_STOP_MS = 15 * 60_000
const RESTART_WINDOW_MS = 10 * 60_000
const PREWARM_TIMEOUT_MS = 5_000
const PORT_LINE_RE = /listening on http:\/\/127\.0\.0\.1:(\d+)/

export function detectPlatform(platform: NodeJS.Platform = process.platform): LlamaPlatform {
  return platform === 'win32' ? 'win' : 'mac'
}

/** Extract the ephemeral port llama-server bound to (`--port 0`) from a stdout/stderr line. Matches the
 *  exact text the live spike observed (PLAN.md §4.4: "listening on http://127.0.0.1:60657"). */
export function parseBoundPort(line: string): number | null {
  const m = PORT_LINE_RE.exec(line)
  return m ? Number(m[1]) : null
}

/**
 * Walk up from `startDir` to the nearest ancestor holding package.json. Electron-vite bundles the ENTIRE
 * main process into a single out/main/index.js (see electron.vite.config.ts's rollupOptions.input — only
 * `index` is listed), so at real app runtime `__dirname` here resolves to out/main regardless of this
 * file's source nesting (src/main/llm/). Under vitest, modules are NOT bundled — `__dirname` reflects the
 * real, deeper src/main/llm/ path. A fixed '..' count can only be correct for one of those two cases;
 * walking up to the marker file is correct for both without depending on either tool's internals.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

function llamaResourcesDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'llama')
  return join(findRepoRoot(__dirname), 'resources', 'llama')
}

/**
 * Candidate binaries for `platform`, in try order. Windows prefers the Vulkan (GPU) build; start()
 * falls back to the CPU build once if Vulkan fails to spawn or exits immediately (PLAN.md §4.5/§8 Rock
 * 1). Mac ships a single arm64 build.
 */
export function resolveBinaryPath(platform: LlamaPlatform = detectPlatform()): BinaryCandidate[] {
  const base = llamaResourcesDir()
  if (platform === 'mac') return [{ path: join(base, 'mac', 'llama-server'), variant: 'mac' }]
  return [
    { path: join(base, 'win', 'vulkan', 'llama-server.exe'), variant: 'vulkan' },
    { path: join(base, 'win', 'cpu', 'llama-server.exe'), variant: 'cpu' }
  ]
}

export interface SpawnArgsInput {
  gguf: string
  mmproj: string
  apiKey: string
}

/**
 * The sidecar spawn contract (PLAN.md §4.4) — EXACT flag set, identical on mac and win. `--cache-reuse`
 * is deliberately absent: the live spike log shows llama.cpp disables it for multimodal loads, so the
 * per-slot `cache_prompt` request field (shared.ts's llamaSlotOptions, set by the future local strategy)
 * is the load-bearing prompt-cache mechanism instead. `--reasoning off` is mandatory — without it Qwen3.5
 * emits into `reasoning_content` and `content` comes back empty.
 */
export function buildSpawnArgs(input: SpawnArgsInput): string[] {
  return [
    '-m', input.gguf,
    '--mmproj', input.mmproj,
    '--host', '127.0.0.1',
    '--port', '0',
    '--api-key', input.apiKey,
    '-c', '8192',
    '--parallel', '2',
    '-ngl', '99',
    '--no-ui',
    '--jinja',
    '--reasoning', 'off'
  ]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollHealth(port: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.status === 200) return
      lastErr = new Error(`health endpoint returned ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await sleep(HEALTH_POLL_INTERVAL_MS)
  }
  throw new Error(`llama-server did not become healthy within ${budgetMs}ms: ${errMsg(lastErr)}`)
}

// ─── Session state (per app process — see the module doc comment) ─────────────────────────────────────
const apiKey = randomBytes(32).toString('hex') // 32 bytes -> 64 hex chars, generated once per app session
let child: ChildProcess | null = null
let port: number | null = null
let state: RuntimeState = 'stopped'
let idleTimer: NodeJS.Timeout | null = null
let restartTimestamps: number[] = []
let lastModelPaths: ModelPaths | null = null
// The in-flight start() call, if any (F1: startup race). A second concurrent caller while state ===
// 'starting' awaits THIS SAME promise instead of racing ahead on its own — so baseURL()/sessionKey() are
// never reachable by a caller whose await resolved before the sidecar actually finished spawning + health.
let startPromise: Promise<void> | null = null

/** The per-session sidecar api key. Lives only in this module's memory — never logged, never sent to
 *  the renderer (main injects it directly into the local provider's outbound request). */
export function sessionKey(): string {
  return apiKey
}

/** The sidecar's OpenAI-compatible base URL. Throws when not running — callers must check isRunning(). */
export function baseURL(): string {
  if (port === null) throw new Error('local runtime is not running')
  return `http://127.0.0.1:${port}/v1`
}

export function isRunning(): boolean {
  return state === 'running'
}

/** The raw lifecycle state — exported ONLY for ensureLocalRuntimeStarted's (local.ts) cold-start gate
 *  (PLAN.md hardening F5): the streamed-sha256 integrity re-check should run once per sidecar spawn
 *  (state === 'stopped' right before a fresh start), never on every request against an already-running or
 *  already-starting sidecar. Every other caller keeps using isRunning()/markActivity()/etc. */
export function getState(): RuntimeState {
  return state
}

/** The gguf path of the model currently running/starting/loaded, or null when start() has never run this
 *  session. Exported ONLY for ensureLocalRuntimeStarted's (local.ts) integrity re-check gate (G2
 *  hardening): getState()==='stopped' alone only catches a COLD start — a model SWITCH requested while the
 *  runtime is already running/starting also needs its (different, not-yet-verified) GGUF re-hashed before
 *  it loads, which getState() alone can't distinguish from a warm same-model request. */
export function getActiveModelKey(): string | null {
  return lastModelPaths?.gguf ?? null
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleStop(): void {
  clearIdleTimer()
  if (state !== 'running') return
  idleTimer = setTimeout(() => {
    auditLog('local.runtime.stop', { reason: 'idle' })
    stop()
  }, IDLE_STOP_MS)
}

/** Reset the 15-minute idle-stop countdown. Call on every local request AND on a live prewarm — both
 *  prove the sidecar is in active use for the current meeting. */
export function markActivity(): void {
  scheduleIdleStop()
}

function spawnAndWaitHealthy(binaryPath: string, modelPaths: ModelPaths, platform: LlamaPlatform): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildSpawnArgs({ gguf: modelPaths.gguf, mmproj: modelPaths.mmproj, apiKey })
    let proc: ChildProcess
    try {
      proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    child = proc
    let settled = false
    let boundPort: number | null = null
    // The "listening on" line can arrive split across separate stdout/stderr `data` events (llama-server
    // emits a few KB of model-load logging first) — accumulate and search the buffer, not each raw chunk
    // in isolation, or a mid-line split silently loses the port and the health poll never starts.
    let outputBuffer = ''

    const onOutput = (chunk: Buffer): void => {
      if (boundPort !== null) return
      outputBuffer += chunk.toString('utf8')
      const parsed = parseBoundPort(outputBuffer)
      if (parsed === null) return
      boundPort = parsed
      port = parsed
      pollHealth(parsed, HEALTH_BUDGET_MS[platform]).then(
        () => {
          if (!settled) {
            settled = true
            resolve()
          }
        },
        (err) => {
          if (!settled) {
            settled = true
            reject(err)
          }
        }
      )
    }
    proc.stdout?.on('data', onOutput)
    proc.stderr?.on('data', onOutput)

    proc.once('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })

    proc.once('exit', (code, signal) => {
      // G1 guard: this exit event belongs to a proc that is no longer the module's current `child` (a
      // newer instance already took over — e.g. a model switch mid-flight) AND its own start promise
      // already settled (it reached healthy at some point, so this is NOT the pre-health rejection path
      // below). That combination means this exit is stale — a late SIGKILL exit for a sidecar that was
      // already superseded. Acting on it here would clobber the NEW instance's child/port/state ownership
      // (orphaning it — will-quit's stop() would then kill nothing) and could fire a spurious crash audit
      // + auto-restart for a switch that already succeeded. Do nothing and let the new instance's own
      // lifecycle continue undisturbed. The pre-health case (settled === false) always falls through below
      // regardless of identity, so a proc that dies before ever becoming healthy still rejects correctly.
      if (child !== proc && settled) return

      const wasRunning = state === 'running'
      child = null
      port = null
      if (!settled) {
        settled = true
        reject(new Error(`llama-server exited before becoming healthy (code=${code}, signal=${signal})`))
        return
      }
      if (wasRunning) {
        state = 'stopped'
        auditLog('local.runtime.crash', { platform, code, signal })
        maybeAutoRestart(platform)
      }
    })
  })
}

function maybeAutoRestart(platform: LlamaPlatform): void {
  const now = Date.now()
  restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS)
  if (restartTimestamps.length >= 1) {
    // Already restarted once in this 10-minute window — stay down for the rest of the session; the
    // provider waterfall (index.ts, Rock 3) covers cloud fallback from here.
    state = 'unavailable'
    auditLog('local.runtime.missing', { platform, reason: 'restart_budget_exhausted' })
    return
  }
  restartTimestamps.push(now)
  if (!lastModelPaths) return
  auditLog('local.runtime.restart', { platform })
  void start(lastModelPaths, platform).catch(() => {
    state = 'unavailable'
  })
}

/** True when `a` (the currently-running/loaded model paths, if any) is the SAME model as `b` (a fresh
 *  start() request) — the switch/no-op decision (F2) hinges on this. */
function samePaths(a: ModelPaths | null, b: ModelPaths): boolean {
  return !!a && a.gguf === b.gguf && a.mmproj === b.mmproj
}

/**
 * The candidate-spawn loop for one start attempt — unchanged in substance from before F1/F2, just
 * extracted so the public start() below can own startPromise/switch bookkeeping around it. Mutates module
 * state (child/port/state) exactly as it always has.
 */
async function spawnCandidates(modelPaths: ModelPaths, platform: LlamaPlatform): Promise<void> {
  const candidates = resolveBinaryPath(platform)
  let lastErr: Error | null = null
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (!existsSync(candidate.path)) {
      lastErr = new Error(`llama-server binary missing at ${candidate.path}`)
      continue
    }
    try {
      await spawnAndWaitHealthy(candidate.path, modelPaths, platform)
      state = 'running'
      scheduleIdleStop()
      auditLog('local.runtime.start', { platform, variant: candidate.variant })
      return
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      stopChildProcess()
      // Windows only: a failed Vulkan spawn/health falls back to the CPU candidate once.
      if (platform !== 'win' || i === candidates.length - 1) break
    }
  }
  state = 'stopped'
  auditLog('local.runtime.missing', { platform, error: errMsg(lastErr) })
  throw lastErr ?? new Error('llama-server failed to start')
}

/**
 * Start the sidecar against `modelPaths`. Idempotent per-model (F2): a caller while the SAME model is
 * already 'running' resolves immediately with no restart; a caller for a DIFFERENT model while one is
 * 'running' stops the old sidecar first (two llama-server processes must never race for the same loopback
 * port/RAM) and starts the new one. Concurrent callers while a start is already 'starting' (F1) await the
 * SAME in-flight promise instead of racing ahead on their own — baseURL()/sessionKey() are never reachable
 * by a caller whose await resolved before the sidecar actually finished spawning + health. Once that
 * in-flight start settles, a caller whose requested model differs from what actually started re-evaluates
 * (via recursion) and triggers a switch if still needed.
 * Throws (does not silently swallow) when the session has been marked unavailable, or when every binary
 * candidate fails — the caller (Rock 3's eligibility check) treats a rejection as "local ineligible now."
 */
export async function start(modelPaths: ModelPaths, platform: LlamaPlatform = detectPlatform()): Promise<void> {
  if (state === 'unavailable') throw new Error('local runtime unavailable for this session (restart budget exhausted)')
  if (state === 'starting') {
    await startPromise
    return start(modelPaths, platform)
  }
  if (state === 'running') {
    if (samePaths(lastModelPaths, modelPaths)) return
    // Model switch: kill the running sidecar synchronously before spawning the newly requested model.
    clearIdleTimer()
    stopChildProcess()
    auditLog('local.runtime.stop', { reason: 'model_switch' })
  }
  lastModelPaths = modelPaths
  state = 'starting'
  const p = spawnCandidates(modelPaths, platform)
  startPromise = p
  try {
    await p
  } finally {
    startPromise = null
  }
}

function stopChildProcess(): void {
  if (child && !child.killed) child.kill('SIGKILL')
  child = null
  port = null
}

/** Kill the sidecar (SIGKILL) and clear idle bookkeeping. Idempotent. */
export function stop(): void {
  clearIdleTimer()
  const wasRunning = state === 'running' || state === 'starting'
  stopChildProcess()
  state = 'stopped'
  if (wasRunning) auditLog('local.runtime.stop', { reason: 'explicit' })
}

/**
 * Fire-and-forget prefill to keep the transcript-prefix KV hot for the next real request (PLAN.md §4.4's
 * pre-warm path). Posts `messages` VERBATIM — the caller (local.ts's ensureLocalRuntimeStarted callers via
 * llm/prewarm.ts's buildPrewarmMessages()) is responsible for assembling the EXACT same [system, ...history,
 * user] shape a real suggest request sends (F4 hardening: a prior version warmed only a bare user message,
 * so the warmed KV prefix never matched what streamOpenAI actually sends and the cache_prompt hit missed).
 * Pins id_slot 0 (the same slot suggest/prewarm always use) and cache_prompt so the server's per-slot cache
 * actually reuses the prefix. Never throws — a failed prewarm just means the next real request pays full
 * cost, which is why it carries its own short timeout independent of any caller's budget.
 */
export function prewarm(messages: Array<{ role: string; content: string }>): void {
  if (state !== 'running' || port === null) return
  markActivity()
  const url = `http://127.0.0.1:${port}/v1/chat/completions`
  const key = apiKey
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'local',
      messages,
      max_tokens: 1,
      id_slot: 0,
      cache_prompt: true,
      stream: false
    }),
    signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS)
  }).catch(() => {
    /* best-effort — see doc comment */
  })
}
