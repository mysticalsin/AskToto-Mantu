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
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { auditLog, mainLog } from '../logger'
import { observeSidecar } from '../infra/observability/sidecar-events'
import { errMsg } from './shared'
import { recordSidecarIntent, recordSidecarSpawned, recordSidecarSupervisedSpawned } from '../infra/process/registry'
import { markSidecarProcessUsable, spawnSidecarProcess, stopSidecarProcess } from '../infra/process/supervisor'
import { assertLegacyRuntimeClosure } from '../features/components/speech-pack/package-runtime-state'
import type { RuntimeFeatureLease } from '../features/components/speech-pack/runtime-lease'
import { runtimeHostEnvironment } from '../features/components/speech-pack/runtime-lease'
import { acquirePackageRuntimeLease } from '../features/components/speech-pack/runtime-admission'
import { trackLocalRuntimeChild, type LocalRuntimeChildLifecycle } from './local-runtime-child'

export type LlamaPlatform = 'mac' | 'win'
export type WinVariant = 'vulkan' | 'cpu'
export type BinaryVariant = WinVariant | 'mac'

export interface ModelPaths {
  gguf: string
  mmproj: string
  /** MQA-270 (B1): whether the multimodal projector is loaded. Measured on the pinned binary: llama-server
   *  loads the mmproj AT STARTUP, not lazily ("srv load_model: loaded multimodal model" prints before
   *  "listening on") — costing 1.03 GB private on the CPU profile whether or not a vision ask ever comes.
   *  false spawns with --no-mmproj; a later vision request restarts through start()'s existing switch
   *  path, which already drains in-flight streams. */
  vision: boolean
  /** Machine-aware sizing (local-models.ts spawnProfileFor). Travels with the paths so the spawn is
   *  fully described by one object and no caller has to know the model's sizing. */
  ctxSize: number
  parallel: number
  gpuLayers: number
  /** Present only when the main runtime store supplied a verified immutable generation. */
  runtimeLease?: RuntimeFeatureLease
  runtimeBinary?: string
  runtimeModelId?: 'qwen3.5-0.8b' | 'qwen3.5-4b'
}

export interface BinaryCandidate {
  path: string
  variant: BinaryVariant
}

export type RuntimeState = 'stopped' | 'starting' | 'running' | 'unavailable'

// Health budget: Windows Defender's first-run scan of a freshly-unpacked exe can add tens of seconds
// before the process even starts executing (PLAN.md §7 risk 3) — mac has no such AV tax.
const HEALTH_BUDGET_MS: Record<LlamaPlatform, number> = { mac: 30_000, win: 60_000 }
// The listener-line budget bounds stalls before the health timer starts. Double the health budget to
// tolerate Defender scans and cold model reads without leaving a malformed child pending forever.
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
 * 1). Mac is a universal package carrying BOTH sidecars, so it selects by process.arch and offers a
 * single candidate — the other arch's binary cannot execute here, so listing it as a fallback would
 * only turn a clear "binary missing" into a confusing exec-format failure.
 */
export function resolveBinaryPath(platform: LlamaPlatform = detectPlatform()): BinaryCandidate[] {
  const base = llamaResourcesDir()
  if (platform === 'mac') {
    // process.arch is the arch of the RUNNING slice of a universal binary, which is what has to match
    // the sidecar — not the hardware. A universal app launched under Rosetta reports x64 and must get
    // the x64 sidecar, so this is deliberately not a hardware query.
    return [{ path: join(base, 'mac', process.arch, 'llama-server'), variant: 'mac' }]
  }
  return [
    { path: join(base, 'win', 'vulkan', 'llama-server.exe'), variant: 'vulkan' },
    { path: join(base, 'win', 'cpu', 'llama-server.exe'), variant: 'cpu' }
  ]
}

export interface SpawnArgsInput {
  gguf: string
  mmproj: string
  /** MQA-270 (B1): load the multimodal projector? See ModelPaths.vision. */
  vision: boolean
  /** Total context across the slots. Per-model AND per-machine — see local-models.ts spawnProfileFor. */
  ctxSize: number
  /** Concurrent slots (`--parallel`). */
  parallel: number
  /** Layers offloaded to the GPU (`-ngl`). 0 on a small machine: measured, offloading every layer costs
   *  ~3.2 GB of HOST memory where the GPU has no dedicated VRAM, which is what put an 8 GB machine over. */
  gpuLayers: number
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
/**
 * llama-server slots (`--parallel`). Exported because ROUTING needs it: with every slot busy, a further
 * request queues inside the sidecar and produces no tokens until one frees, which the ask path cannot
 * tell apart from a hung model — measured, a third concurrent ask sat for 48s and then failed with
 * "Stream timed out — no response from the model." Callers use this to route elsewhere instead of waiting.
 */
export const LOCAL_PARALLEL_SLOTS = 2

/** True when every sidecar slot is already serving a stream, so a new one would only queue. */
export function atCapacity(): boolean {
  return activeStreamCount >= LOCAL_PARALLEL_SLOTS
}

/** MQA-270 (B5): threads for llama-server, leaving headroom for everything else. Unpinned, llama.cpp's
 *  `-t -1` resolves to EVERY physical core — measured n_threads=8 on an 8-core box — which on a 4-core
 *  laptop starves the Electron renderer and the Parakeet ASR worker simultaneously: the "Metis lags"
 *  report is those three fighting for the same cores, not the model being slow. Node exposes only
 *  logical cores, so physical is estimated as logical/2 (SMT assumption; an estimate is fine — the cost
 *  of guessing low is generation throughput, the cost of guessing high is the UI freezing). Floor of 2
 *  so a 2-core machine still generates at all. */
export function inferenceThreads(logicalCores = availableParallelism()): number {
  const physical = Math.max(1, Math.floor(logicalCores / 2))
  return Math.max(2, physical - 2)
}

export function buildSpawnArgs(input: SpawnArgsInput, threads = inferenceThreads()): string[] {
  const t = threads
  return [
    '-m',
    input.gguf,
    // MQA-270 (B1): the projector is start-up-loaded, never lazy, so --no-mmproj is the only way to not
    // pay its 1.03 GB when no vision surface is live. --no-mmproj-offload does NOT free it (measured
    // 5589 vs 5614 MB); both flags verified against the pinned b9957 binary's --help.
    ...(input.vision ? ['--mmproj', input.mmproj] : ['--no-mmproj']),
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '-c',
    String(input.ctxSize),
    '--parallel',
    String(input.parallel),
    '--cache-ram',
    '128',
    '-ngl',
    String(input.gpuLayers),
    // MQA-270 (B5): cap generation (-t) and batch (-tb) threads, and the HTTP pool. All three flags
    // verified against the pinned b9957 binary's --help. Costs some throughput on big machines; buys
    // back the renderer and ASR worker on small ones, which is where the lag lived.
    '-t',
    String(t),
    '-tb',
    String(t),
    '--threads-http',
    '2',
    '--no-ui',
    '--jinja',
    '--reasoning',
    'off'
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
const childLifecycles = new WeakMap<ChildProcess, LocalRuntimeChildLifecycle>()
let currentChildLifecycle: { readonly child: ChildProcess; readonly lifecycle: LocalRuntimeChildLifecycle } | null =
  null
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

/** Tokens one slot of the running sidecar holds, or null when none is up. start() keeps a same-model
 *  sidecar even when the machine's profile has since changed, so this, not the profile, bounds a request. */
export function activeSlotTokens(): number | null {
  if (state === 'stopped' || !lastModelPaths) return null
  return Math.floor(lastModelPaths.ctxSize / lastModelPaths.parallel)
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
    void stop().catch((error: unknown) => mainLog.warn('local runtime idle stop failed', { error: errMsg(error) }))
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

async function spawnAndWaitHealthy(
  binaryPath: string,
  modelPaths: ModelPaths,
  platform: LlamaPlatform,
  generation: number,
  variant: BinaryVariant
): Promise<void> {
  const physicalAdmission = await modelPaths.runtimeLease?.preparePhysicalAdmission()
  try {
    physicalAdmission?.assertCurrentSync()
    assertCurrentGeneration(generation)
    const launch = new Promise<void>((resolve, reject) => {
      const args = buildSpawnArgs({
        gguf: modelPaths.gguf,
        mmproj: modelPaths.mmproj,
        vision: modelPaths.vision,
        ctxSize: modelPaths.ctxSize,
        parallel: modelPaths.parallel,
        gpuLayers: modelPaths.gpuLayers
      })
      let proc: ChildProcess
      let waitForSpawnRecorded = (): Promise<void> => Promise.resolve()
      try {
        // The per-session api key travels via env, never argv (see module doc comment) — `ps`/the process
        // table can see the flag list of every local process but not another process's environment.
        recordSidecarIntent('llama-server', args)
        const launched = spawnSidecarProcess(
          'llama-server',
          binaryPath,
          args,
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: modelPaths.runtimeLease
              ? { ...runtimeHostEnvironment(modelPaths.runtimeLease), LLAMA_API_KEY: apiKey }
              : { ...process.env, LLAMA_API_KEY: apiKey }
          },
          auditLog,
          process.env,
          process.platform,
          {
            prepareUnsupervisedFallback: async () => {
              const fallbackAdmission = await modelPaths.runtimeLease?.preparePhysicalAdmission()
              return {
                assertCurrentSync: () => {
                  fallbackAdmission?.assertCurrentSync()
                  assertCurrentGeneration(generation)
                },
                dispose: async () => {
                  await fallbackAdmission?.dispose()
                }
              }
            },
            onUnsupervisedFallbackSpawned: (fallback) =>
              recordSidecarSpawned('llama-server', fallback, binaryPath, args)
          }
        )
        proc = launched.child
        if (launched.supervised) {
          // Both the wrapper and the sidecar it spawns are registered, so the next-launch reaper still finds
          // them if the wrapper itself dies; a later direct fallback registers its own spawn via the hook.
          const supervisedRecorded = launched.wrapperLaunch
            ? recordSidecarSupervisedSpawned('llama-server', proc, launched.wrapperLaunch, {
                executable: binaryPath,
                args
              })
            : Promise.resolve()
          waitForSpawnRecorded = async () => {
            await supervisedRecorded
            await launched.waitForUnsupervisedFallback?.()
          }
        } else {
          const spawnRecorded = recordSidecarSpawned('llama-server', proc, binaryPath, args)
          waitForSpawnRecorded = () => spawnRecorded
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      child = proc
      const lifecycle = trackLocalRuntimeChild(proc, (error) =>
        mainLog.warn('local runtime child lifecycle failed', { error: errMsg(error) })
      )
      childLifecycles.set(proc, lifecycle)
      const ownedChild = { child: proc, lifecycle }
      currentChildLifecycle = ownedChild
      void lifecycle.exit.finally(() => {
        if (currentChildLifecycle === ownedChild) currentChildLifecycle = null
      })
      observeSidecar('llama-server', proc, auditLog)
      let settled = false
      let boundPort: number | null = null
      // The "listening on" line can arrive split across separate stdout/stderr `data` events (llama-server
      // emits a few KB of model-load logging first) — accumulate and search the buffer, not each raw chunk
      // in isolation, or a mid-line split silently loses the port and the health poll never starts.
      let outputBuffer = ''

      let portLineTimer: NodeJS.Timeout | null = setTimeout(() => {
        portLineTimer = null
        if (settled) return
        const tail = outputBuffer.trim()
        const detail = tail ? ` — last output: ${tail.slice(-800)}` : ''
        mainLog.warn('local runtime: sidecar never reported a listening port', { platform, variant })
        rejectAfterExit(
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

      const rejectAfterExit = (error: Error): void => {
        if (settled) return
        settled = true
        clearPortLineTimer()
        void stopChildProcess(proc).finally(() => reject(error))
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
          rejectAfterExit(new StartCancelledError())
          return
        }
        pollHealth(parsed, HEALTH_BUDGET_MS[platform]).then(
          async () => {
            if (!settled) {
              if (generation !== startGeneration || child !== proc) {
                rejectAfterExit(new StartCancelledError())
                return
              }
              await waitForSpawnRecorded()
              if (settled) return
              if (generation !== startGeneration || child !== proc) {
                rejectAfterExit(new StartCancelledError())
                return
              }
              markSidecarProcessUsable(proc)
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
          const error = err instanceof Error ? err : new Error(String(err))
          if (proc.pid == null) {
            settled = true
            lifecycle.confirmNoChild()
            reject(error)
          } else rejectAfterExit(error)
        }
      })

      proc.once('exit', (code, signal) => {
        clearPortLineTimer()
        // A stale child may reject its own start, but must never mutate a newer child's state.
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
          maybeAutoRestart(platform, lifecycle.exit)
        }
      })
    })
    return launch
  } finally {
    await physicalAdmission?.dispose()
  }
}

function maybeAutoRestart(platform: LlamaPlatform, exited: Promise<void>): void {
  const generation = startGeneration
  const now = Date.now()
  restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS)
  if (restartTimestamps.length >= 1) {
    // One restart per 10-minute window; the provider waterfall covers fallback after exhaustion.
    state = 'unavailable'
    auditLog('local.runtime.missing', { platform, reason: 'restart_budget_exhausted' })
    return
  }
  restartTimestamps.push(now)
  if (!lastModelPaths) return
  auditLog('local.runtime.restart', { platform })
  void (async () => {
    let lease: RuntimeFeatureLease | null = null
    try {
      await exited
      assertCurrentGeneration(generation)
      const previous = lastModelPaths
      if (!previous) return
      let next = previous
      if (previous.runtimeLease) {
        if (!previous.runtimeModelId) throw new Error('Managed local model identity is unavailable.')
        lease = await acquirePackageRuntimeLease('local-llm', previous.runtimeModelId)
        if (!lease) throw new Error('Managed local model runtime is unavailable.')
        assertCurrentGeneration(generation)
        next = {
          ...previous,
          runtimeLease: lease,
          runtimeBinary: lease.entry('llama-server'),
          gguf: lease.modelFile(previous.runtimeModelId, 'model.gguf'),
          mmproj: lease.modelFile(previous.runtimeModelId, 'mmproj.gguf')
        }
      }
      await start(next, platform)
      lease = null
    } finally {
      await lease?.release()
    }
  })().catch(() => {
    if (generation === startGeneration) state = 'unavailable'
  })
}

/** A vision-loaded runtime satisfies text requests; the reverse requires a restart. */
function samePaths(a: ModelPaths | null, b: ModelPaths): boolean {
  return (
    !!a &&
    a.gguf === b.gguf &&
    a.mmproj === b.mmproj &&
    (a.vision || !b.vision) &&
    a.runtimeLease?.generationIdentity === b.runtimeLease?.generationIdentity &&
    a.runtimeBinary === b.runtimeBinary
  )
}

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
  // Filter the sticky Windows Vulkan fallback here, keeping resolveBinaryPath() pure.
  const candidates = modelPaths.runtimeBinary
    ? [{ path: modelPaths.runtimeBinary, variant: platform === 'win' ? ('cpu' as const) : ('mac' as const) }]
    : resolveBinaryPath(platform).filter((c) => !(cpuPinned && c.variant === 'vulkan'))
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
      // Cancellation already owns this process's exit barrier; never mutate newer state here.
      if (generation !== startGeneration || err instanceof StartCancelledError) throw new StartCancelledError()
      await stopChildProcess()
      // Windows only: a failed Vulkan spawn/health falls back to the CPU candidate once.
      if (platform !== 'win' || i === candidates.length - 1) break
    }
  }
  assertCurrentGeneration(generation)
  state = 'stopped'
  auditLog('local.runtime.missing', { platform, error: errMsg(lastErr) })
  throw lastErr ?? new Error('llama-server failed to start')
}

/** Reuse a matching runtime or drain streams and await exact child exit before switching models. */
export async function start(modelPaths: ModelPaths, platform: LlamaPlatform = detectPlatform()): Promise<void> {
  const requestGeneration = startGeneration
  if (!modelPaths.runtimeLease) await assertLegacyRuntimeClosure('local LLM')
  if (state === 'starting') {
    await startPromise
    return start(modelPaths, platform)
  }
  assertCurrentGeneration(requestGeneration)
  if (state === 'unavailable') {
    throw new Error('local runtime unavailable for this session (restart budget exhausted)')
  }
  if (state === 'running') {
    if (samePaths(lastModelPaths, modelPaths)) {
      const matchedChild = child
      if (modelPaths.runtimeLease !== lastModelPaths?.runtimeLease) {
        await modelPaths.runtimeLease?.release()
        assertCurrentGeneration(requestGeneration)
        if (state !== 'running' || !matchedChild || child !== matchedChild || !samePaths(lastModelPaths, modelPaths))
          throw new StartCancelledError()
      }
      return
    }
    if (activeStreamCount > 0) {
      // Drain active streams before changing the runtime they use.
      mainLog.info('local runtime: model switch deferred — stream(s) active', { activeStreamCount })
      await waitForDrain()
      assertCurrentGeneration(requestGeneration)
      return start(modelPaths, platform)
    }
    clearIdleTimer()
    state = 'stopped'
    port = null
    await stopChildProcess(child)
    assertCurrentGeneration(requestGeneration)
    auditLog('local.runtime.stop', { reason: 'model_switch' })
  }
  if (child) {
    await stopChildProcess(child)
    assertCurrentGeneration(requestGeneration)
  } else if (currentChildLifecycle) {
    await currentChildLifecycle.lifecycle.exit
    assertCurrentGeneration(requestGeneration)
  }
  lastModelPaths = modelPaths
  state = 'starting'
  const generation = ++startGeneration
  const p = spawnCandidates(modelPaths, platform, generation)
  startPromise = p
  try {
    await p
    assertCurrentGeneration(generation)
    if (modelPaths.runtimeLease) {
      const startedChild = child
      const lifecycle = startedChild && childLifecycles.get(startedChild)
      if (!lifecycle || lifecycle.exited) throw new StartCancelledError()
      lifecycle.transferLease(modelPaths.runtimeLease)
    }
  } finally {
    // A stale start may finish after a newer one has already installed its own shared promise.
    if (startPromise === p) startPromise = null
  }
}

async function stopChildProcess(stopping: ChildProcess | null = child): Promise<void> {
  if (!stopping) {
    await currentChildLifecycle?.lifecycle.exit
    return
  }
  const lifecycle = childLifecycles.get(stopping)
  if (!lifecycle) throw new Error('Local runtime child is missing its exit barrier.')
  await lifecycle.stop(stopSidecarProcess)
  if (child === stopping) {
    child = null
    port = null
  }
}

/** Kill the sidecar (SIGKILL) and resolve only after its exact exit and lease release. */
export async function stop(): Promise<void> {
  clearIdleTimer()
  const wasRunning = state === 'running' || state === 'starting'
  startGeneration++
  state = 'stopped'
  port = null
  if (wasRunning) auditLog('local.runtime.stop', { reason: 'explicit' })
  await stopChildProcess(child)
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
 * `slot` 1 is the summary slot: the Stop-time warm targets it so the recap reuses the meeting's prefix.
 */
export function prewarm(messages: Array<{ role: string; content: string }>, slot: 0 | 1 = 0): void {
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
      id_slot: slot,
      cache_prompt: true,
      stream: false
    }),
    signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS)
  }).catch(() => {
    /* best-effort — see doc comment */
  })
}
