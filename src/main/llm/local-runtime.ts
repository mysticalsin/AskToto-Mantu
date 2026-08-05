/**
 * local-runtime.ts — lifecycle manager for the `llama-server` sidecar that powers Métis Local (on-device
 * suggest/summary/vision). Owns the child process, the ephemeral loopback port, and a per-app-session
 * api key; none of the three are ever logged or exposed outside this module (the renderer gets only
 * derived readiness booleans — see PLAN.md §4.3/§4.6). The api key is handed to the child via the
 * LLAMA_API_KEY environment variable (never a `--api-key` argv flag), so it never appears in `ps`/
 * process-table output visible to other local processes.
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
import { auditLog, mainLog } from '../logger'
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
// Port-line budget: bounds the wait for the `listening on http://127.0.0.1:<port>` line, which is what
// GATES the health poll — HEALTH_BUDGET_MS only starts counting after that line is parsed. Without this
// budget a child that starts but never prints the line (wrong build, GPU driver stall, a changed log
// format in a future llama.cpp release) leaves start() pending forever with nothing surfaced to the user.
// Deliberately DOUBLE the health budget rather than equal to it: this is a hang-breaker, not a
// performance SLA, and a false timeout is the worse failure (it would silently disable Métis Local on
// slow-but-healthy hardware). Everything expensive about a cold start lands in THIS phase, not the health
// phase — Defender's first-run scan of the freshly-unpacked exe, plus the full GGUF+mmproj read off a
// cold disk, which the live spike log shows completing BEFORE the listening line is printed. In the
// healthy case the line arrives in well under a second, so the headroom costs nothing.
const PORT_LINE_BUDGET_MS: Record<LlamaPlatform, number> = { mac: 60_000, win: 120_000 }
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
}

/**
 * The sidecar spawn contract (PLAN.md §4.4) — EXACT flag set, identical on mac and win. Two slots share
 * the total context, so 65536 intentionally yields 32768 tokens per slot: enough for the app's existing
 * ~30k-token summary input cap plus its bounded local completion. b9957 otherwise permits up to 8192 MiB
 * of host-memory prompt cache; the explicit 128 MiB ceiling covers the measured two-slot checkpoint
 * working set (~77 MiB) without letting an optional background feature consume another 8 GiB.
 * `--cache-reuse`
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
    '-c', '65536',
    '--parallel', '2',
    '--cache-ram', '128',
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
// Monotonic ownership token for start attempts. stop() invalidates the active generation before killing
// its child, so a Windows Vulkan failure/exit observed during shutdown cannot continue into the CPU
// fallback after will-quit has already completed. A subsequent start receives a new generation and owns
// any child it spawns; stale continuations must never mutate that newer child's state.
let startGeneration = 0
// The in-flight start() call, if any (F1: startup race). A second concurrent caller while state ===
// 'starting' awaits THIS SAME promise instead of racing ahead on its own — so baseURL()/sessionKey() are
// never reachable by a caller whose await resolved before the sidecar actually finished spawning + health.
let startPromise: Promise<void> | null = null
// Count of local HTTP requests currently streaming from the running sidecar (switch-kill hardening): a
// model switch must never SIGKILL the child out from under a request that has already started receiving
// tokens from it (no retry exists once tokens have started — index.ts's onError only retries/fails over
// when the stream hasn't produced any token yet). beginStream()/endStream() bracket exactly the span
// local.ts's streamLocal() holds an open streamOpenAI() call against this sidecar. drainWaiters holds the
// resolvers for any start() call currently blocked in waitForDrain() below.
let activeStreamCount = 0
let drainWaiters: Array<() => void> = []
// Sticky Windows CPU fallback. spawnCandidates' Vulkan->CPU fallback only covers a candidate that never
// reached 'running'; a Vulkan build that initializes fine and then crashes DURING INFERENCE (common on
// older Intel iGPU drivers) exits via maybeAutoRestart(), which re-spawned the same Vulkan build and
// crash-looped. Once set, the Vulkan candidate is dropped for the rest of the app session. The threshold
// is ONE such crash, not more, because maybeAutoRestart's own budget permits exactly one restart per
// RESTART_WINDOW_MS before the session is marked 'unavailable' — a higher threshold could never be
// reached, so the fallback would never actually run.
let cpuPinned = false

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

/** Mark one local HTTP stream as attached to the running sidecar (switch-kill hardening). Call exactly
 *  once, immediately before making the real streamOpenAI() request — never during
 *  ensureLocalRuntimeStarted(), which hasn't touched the wire yet. Paired 1:1 with endStream(). */
export function beginStream(): void {
  activeStreamCount++
}

/** Mark one local HTTP stream as finished — success, error, or abort, exactly once per beginStream()
 *  call. Wakes any start() call currently blocked in waitForDrain() once the count reaches zero. */
export function endStream(): void {
  if (activeStreamCount > 0) activeStreamCount--
  if (activeStreamCount === 0 && drainWaiters.length > 0) {
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }
}

/** How many local streams are currently attached to the sidecar. The background screen-preprocess describe
 *  reads this to yield to real user-facing streams (live suggest/summary) rather than compete for a slot. */
export function activeStreams(): number {
  return activeStreamCount
}

/** Resolves once activeStreamCount reaches zero (immediately, if it already is). start()'s model-switch
 *  branch awaits this instead of killing the sidecar out from under an in-flight stream. */
function waitForDrain(): Promise<void> {
  if (activeStreamCount === 0) return Promise.resolve()
  return new Promise((resolve) => drainWaiters.push(resolve))
}

function spawnAndWaitHealthy(
  binaryPath: string,
  modelPaths: ModelPaths,
  platform: LlamaPlatform,
  generation: number,
  variant: BinaryVariant
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildSpawnArgs({ gguf: modelPaths.gguf, mmproj: modelPaths.mmproj })
    let proc: ChildProcess
    try {
      // The per-session api key travels via env, never argv (see module doc comment) — `ps`/the process
      // table can see the flag list of every local process but not another process's environment.
      proc = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, LLAMA_API_KEY: apiKey }
      })
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

    let portLineTimer: NodeJS.Timeout | null = setTimeout(() => {
      portLineTimer = null
      if (settled) return
      settled = true
      // Kill + reap before rejecting. The candidate loop's stopChildProcess() only kills a child that is
      // still the module's CURRENT one, so a superseded/cancelled attempt would otherwise leave a live
      // llama-server.exe behind holding the model's RAM. The 'exit' handler below clears child/port once
      // the kill lands; a stale proc's exit is already ignored by its `child !== proc` guard.
      if (!proc.killed) proc.kill('SIGKILL')
      const tail = outputBuffer.trim()
      const detail = tail ? ` — last output: ${tail.slice(-800)}` : ''
      mainLog.warn('local runtime: sidecar never reported a listening port', { platform, variant })
      reject(
        new Error(
          `llama-server started but never reported a listening port within ${PORT_LINE_BUDGET_MS[platform]}ms (${binaryPath})${detail}`
        )
      )
    }, PORT_LINE_BUDGET_MS[platform])
    const clearPortLineTimer = (): void => {
      if (portLineTimer) {
        clearTimeout(portLineTimer)
        portLineTimer = null
      }
    }

    const onOutput = (chunk: Buffer): void => {
      if (boundPort !== null) return
      outputBuffer += chunk.toString('utf8')
      const parsed = parseBoundPort(outputBuffer)
      if (parsed === null) return
      boundPort = parsed
      // The port line arrived — from here HEALTH_BUDGET_MS owns the deadline.
      clearPortLineTimer()
      // Keep the candidate port local until health succeeds. A detached process can flush buffered output
      // after stop() and even after a newer generation is already healthy; publishing here would redirect
      // the running app to the killed process's endpoint.
      if (generation !== startGeneration || child !== proc) {
        settled = true
        reject(new StartCancelledError())
        return
      }
      pollHealth(parsed, HEALTH_BUDGET_MS[platform]).then(
        () => {
          if (!settled) {
            if (generation !== startGeneration || child !== proc) {
              settled = true
              reject(new StartCancelledError())
              return
            }
            port = parsed
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
      clearPortLineTimer()
      if (!settled) {
        settled = true
        reject(err)
      }
    })

    proc.once('exit', (code, signal) => {
      clearPortLineTimer()
      // This process is no longer the module's current child: stop() already detached it, or a newer start
      // owns the global child/port/state. Its own pre-health promise must still reject, but a stale exit must
      // never clear or restart the newer child. A settled stale process needs no further action at all.
      if (child !== proc) {
        if (!settled) {
          settled = true
          const tail = outputBuffer.trim()
          const detail = tail ? ` — last output: ${tail.slice(-800)}` : ''
          reject(new Error(`llama-server exited before becoming healthy (code=${code}, signal=${signal})${detail}`))
        }
        return
      }

      const wasRunning = state === 'running'
      child = null
      port = null
      if (!settled) {
        settled = true
        const tail = outputBuffer.trim()
        const detail = tail ? ` — last output: ${tail.slice(-800)}` : ''
        reject(new Error(`llama-server exited before becoming healthy (code=${code}, signal=${signal})${detail}`))
        return
      }
      if (wasRunning) {
        state = 'stopped'
        auditLog('local.runtime.crash', { platform, code, signal, variant })
        // Vulkan initialized well enough to reach 'running' and then died — restarting the same GPU build
        // would crash-loop (see cpuPinned). Pin CPU BEFORE maybeAutoRestart so the restart it triggers
        // already skips the Vulkan candidate.
        if (variant === 'vulkan' && !cpuPinned) {
          cpuPinned = true
          mainLog.warn('local runtime: pinning CPU sidecar for this session after a Vulkan crash', { code, signal })
        }
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
class StartCancelledError extends Error {
  constructor() {
    super('local runtime start cancelled')
    this.name = 'StartCancelledError'
  }
}

function assertCurrentGeneration(generation: number): void {
  if (generation !== startGeneration) throw new StartCancelledError()
}

async function spawnCandidates(modelPaths: ModelPaths, platform: LlamaPlatform, generation: number): Promise<void> {
  // cpuPinned drops the Vulkan candidate for the rest of the session (no-op on mac, which has no Vulkan
  // candidate). Filtered here rather than in resolveBinaryPath() so that stays a pure path resolver.
  const candidates = resolveBinaryPath(platform).filter((c) => !(cpuPinned && c.variant === 'vulkan'))
  let lastErr: Error | null = null
  for (let i = 0; i < candidates.length; i++) {
    assertCurrentGeneration(generation)
    const candidate = candidates[i]
    if (!existsSync(candidate.path)) {
      lastErr = new Error(`llama-server binary missing at ${candidate.path}`)
      continue
    }
    try {
      await spawnAndWaitHealthy(candidate.path, modelPaths, platform, generation, candidate.variant)
      assertCurrentGeneration(generation)
      state = 'running'
      scheduleIdleStop()
      auditLog('local.runtime.start', { platform, variant: candidate.variant })
      return
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      // A cancelled generation was already detached/killed by stop(). Do not touch the module-level child
      // here: a newer start may already own it by the time this stale continuation resumes.
      if (generation !== startGeneration || err instanceof StartCancelledError) throw new StartCancelledError()
      stopChildProcess()
      // Windows only: a failed Vulkan spawn/health falls back to the CPU candidate once.
      if (platform !== 'win' || i === candidates.length - 1) break
    }
  }
  assertCurrentGeneration(generation)
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
    if (activeStreamCount > 0) {
      // A different model was requested while >=1 request is actively streaming from the current sidecar
      // (switch-kill hardening) — killing it now would truncate that response mid-flight with no retry
      // (index.ts's onError only retries/fails over when the stream hasn't produced a token yet). Defer:
      // wait for every in-flight stream to finish, then re-evaluate (mirrors the 'starting' branch above)
      // instead of switching here. A caller for the SAME model that becomes active in the meantime resolves
      // via the samePaths() check above once this recurses. Diagnostic only (mainLog, not auditLog) — no
      // security-relevant action has happened yet; the eventual stop/start still audits as it always did.
      mainLog.info('local runtime: model switch deferred — stream(s) active', { activeStreamCount })
      await waitForDrain()
      return start(modelPaths, platform)
    }
    // Model switch: kill the running sidecar synchronously before spawning the newly requested model.
    clearIdleTimer()
    stopChildProcess()
    auditLog('local.runtime.stop', { reason: 'model_switch' })
  }
  lastModelPaths = modelPaths
  state = 'starting'
  const generation = ++startGeneration
  const p = spawnCandidates(modelPaths, platform, generation)
  startPromise = p
  try {
    await p
  } finally {
    // A stale start may finish after a newer one has already installed its own shared promise.
    if (startPromise === p) startPromise = null
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
  startGeneration++
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
