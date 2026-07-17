/**
 * fm-runtime.ts — lifecycle manager for Apple's `fm serve` sidecar (macOS 27+), the second engine behind
 * the 'local' provider. `fm` is Apple's preinstalled Foundation Models CLI (/usr/bin/fm); `fm serve`
 * exposes the on-device Apple Foundation Model over the same OpenAI-compatible /v1/chat/completions
 * surface llama-server speaks, so local.ts reuses streamOpenAI unchanged against this module's baseURL().
 *
 * Differences from local-runtime.ts (llama-server), and why:
 *  - No model files, no integrity hashing, no RAM gate: the model is OS-owned and OS-updated; there is
 *    nothing on disk for Métis to verify or account for.
 *  - No --port 0 support (fm validates 1–65535), so we pick a free loopback port ourselves and poll
 *    /health on it instead of parsing a "listening on" log line.
 *  - No auth: `fm serve` has no --api-key/env equivalent, so the server is an UNAUTHENTICATED loopback
 *    endpoint while running. Exposure is bounded: it binds 127.0.0.1, serves only the user's own
 *    on-device model (no Métis data is reachable through it), and stops after 15 idle minutes. The
 *    per-user OS quota for the model is the same one any local process could already consume via
 *    /usr/bin/fm directly.
 *  - No auto-restart: the next real request restarts it via start(); a crash loop (2 crashes in 10
 *    minutes) marks the engine unavailable for the session and local.ts falls back to llama-server.
 *
 * Availability is a live OS condition (Apple Intelligence can be toggled off, the model can be
 * mid-download), so eligibility is probed via `fm available` with a short TTL cache rather than assumed
 * from binary presence.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { auditLog, mainLog } from '../logger'
import { errMsg } from './shared'

export const FM_BINARY_PATH = '/usr/bin/fm'
/** Model id `fm serve`'s Chat Completions endpoint expects for the on-device system model. */
export const FM_SYSTEM_MODEL = 'system'

export type FmRuntimeState = 'stopped' | 'starting' | 'running' | 'unavailable'

export interface FmAvailability {
  available: boolean
  /** Machine-ish reason when unavailable — e.g. 'appleIntelligenceNotEnabled', 'binary-missing',
   *  'probe-unparsed', 'probe-failed'. null when available. */
  reason: string | null
}

const HEALTH_BUDGET_MS = 20_000
const HEALTH_POLL_INTERVAL_MS = 250
const IDLE_STOP_MS = 15 * 60_000
const CRASH_WINDOW_MS = 10 * 60_000
const CRASH_BUDGET = 2
const PROBE_TIMEOUT_MS = 10_000
const PROBE_TTL_MS = 60_000
// Negative results live longer (review finding): the probe spawns a real `fm available` subprocess on
// the TTFT-critical suggest path. "Apple Intelligence is off" flips rarely — re-checking every minute
// taxes exactly the machines that will never use the engine. Positive results keep the short TTL so a
// mid-session toggle-OFF is noticed quickly (the failing spawn is additionally crash-budgeted).
const PROBE_TTL_UNAVAILABLE_MS = 10 * 60_000
const PREWARM_TIMEOUT_MS = 5_000

/** Kill switch for ops/debugging: launch Métis with METIS_DISABLE_APPLE_FM=1 to force llama-server. */
export function disabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.METIS_DISABLE_APPLE_FM === '1'
}

/** Platform + binary gate only — cheap and synchronous. Says nothing about Apple Intelligence being
 *  enabled; that live OS condition is probeAvailability()'s job. */
export function supported(
  platform: NodeJS.Platform = process.platform,
  binaryExists: (path: string) => boolean = existsSync
): boolean {
  return platform === 'darwin' && binaryExists(FM_BINARY_PATH)
}

const ANSI_RE = /\[[0-9;]*m/g
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/**
 * Parse `fm available` output. Observed disabled output (macOS 27.0 beta, 26A5378n):
 *   Error: PCC inference is not available in this context.
 *   System model unavailable: appleIntelligenceNotEnabled
 * The PCC line is expected noise for a Developer ID app (PCC is App Store-gated) and is ignored — only
 * the SYSTEM model line decides. The enabled-format is parsed tolerantly ("System model … available"
 * without "unavailable") because Apple documents no machine-readable output; anything unrecognized is
 * conservatively unavailable ('probe-unparsed') so a CLI format change degrades to llama-server, never
 * to a broken ask path. E2E-verify the enabled branch whenever the OS build changes.
 */
export function parseAvailability(output: string): FmAvailability {
  const text = stripAnsi(output)
  const unavailable = /system model unavailable:?\s*([\w.-]+)?/i.exec(text)
  if (unavailable) return { available: false, reason: unavailable[1] ?? 'unknown' }
  const systemLine = text
    .split('\n')
    .find((line) => /system model/i.test(line) && /\bavailable\b/i.test(line))
  if (systemLine) return { available: true, reason: null }
  // `fm available` prints nothing recognizable — likely a format change or a hard error. Log-worthy
  // (the caller does) but never a crash: unavailable is always a safe answer.
  return { available: false, reason: 'probe-unparsed' }
}

/** The exact serve argv — loopback-only host is load-bearing (see the module doc's no-auth note). */
export function buildServeArgs(port: number): string[] {
  return ['serve', '--host', '127.0.0.1', '--port', String(port)]
}

// ─── Session state (module singleton, matching local-runtime.ts) ─────────────────────────────────────
let child: ChildProcess | null = null
let port: number | null = null
let state: FmRuntimeState = 'stopped'
let idleTimer: NodeJS.Timeout | null = null
let crashTimestamps: number[] = []
let startGeneration = 0
let startPromise: Promise<void> | null = null
let activeStreamCount = 0
let availabilityCache: { value: FmAvailability; at: number } | null = null
let probeInFlight: Promise<FmAvailability> | null = null

export function getState(): FmRuntimeState {
  return state
}

export function isRunning(): boolean {
  return state === 'running'
}

/** OpenAI-compatible base URL of the running server. Throws when not running — callers go through
 *  start() first (same contract as local-runtime.baseURL()). */
export function baseURL(): string {
  if (port === null) throw new Error('fm runtime is not running')
  return `http://127.0.0.1:${port}/v1`
}

export function activeStreams(): number {
  return activeStreamCount
}

export function beginStream(): void {
  activeStreamCount++
}

export function endStream(): void {
  if (activeStreamCount > 0) activeStreamCount--
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
    auditLog('local.runtime.stop', { engine: 'apple-fm', reason: 'idle' })
    stop()
  }, IDLE_STOP_MS)
}

/** Reset the 15-minute idle-stop countdown — call on every request the server actually serves. */
export function markActivity(): void {
  scheduleIdleStop()
}

/** Last probe result without touching the wire (null until the first probe this session). Routing
 *  decisions await probeAvailability(); this exists for status surfaces that must stay synchronous. */
export function availabilitySnapshot(): FmAvailability | null {
  return availabilityCache?.value ?? null
}

function runProbe(): Promise<FmAvailability> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(FM_BINARY_PATH, ['available'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ available: false, reason: `probe-failed: ${errMsg(err)}` })
      return
    }
    let output = ''
    let settled = false
    const settle = (value: FmAvailability): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle({ available: false, reason: 'probe-timeout' })
    }, PROBE_TIMEOUT_MS)
    proc.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    proc.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    proc.once('error', (err) => {
      clearTimeout(timer)
      settle({ available: false, reason: `probe-failed: ${errMsg(err)}` })
    })
    proc.once('exit', () => {
      clearTimeout(timer)
      const parsed = parseAvailability(output)
      if (parsed.reason === 'probe-unparsed') {
        mainLog.warn('[fm-runtime] unrecognized `fm available` output', { output: output.slice(0, 500) })
      }
      settle(parsed)
    })
  })
}

/**
 * Whether the Apple engine can serve requests right now. TTL-cached (60s) because it runs on the hot
 * suggest path; concurrent callers share one in-flight probe. `force` bypasses the cache (Settings
 * refresh). Never rejects — a probe failure IS an availability answer (unavailable + reason).
 */
export async function probeAvailability(force = false): Promise<FmAvailability> {
  if (!supported()) return { available: false, reason: 'binary-missing' }
  if (!force && availabilityCache) {
    const ttl = availabilityCache.value.available ? PROBE_TTL_MS : PROBE_TTL_UNAVAILABLE_MS
    if (Date.now() - availabilityCache.at < ttl) return availabilityCache.value
  }
  if (probeInFlight) return probeInFlight
  const p = runProbe()
    .then((value) => {
      availabilityCache = { value, at: Date.now() }
      return value
    })
    .finally(() => {
      probeInFlight = null
    })
  probeInFlight = p
  return p
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('could not allocate a loopback port'))
      })
    })
  })
}

async function pollHealth(targetPort: number, generation: number, childGone: () => boolean): Promise<void> {
  const deadline = Date.now() + HEALTH_BUDGET_MS
  let lastErr: unknown
  while (Date.now() < deadline) {
    if (generation !== startGeneration) throw new Error('fm runtime start cancelled')
    // Fast-fail: a server that already exited can never become healthy — polling its dead port for the
    // remaining budget would stall EVERY text request ~20s before the llama fallback (review finding).
    if (childGone()) throw new Error('fm serve exited before becoming healthy')
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.status === 200) return
      lastErr = new Error(`health endpoint returned ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))
  }
  throw new Error(`fm serve did not become healthy within ${HEALTH_BUDGET_MS}ms: ${errMsg(lastErr)}`)
}

/** Count a failure (running crash OR boot failure) against the shared budget. Boot failures matter just
 *  as much as crashes (review finding): `fm available` can say yes while `fm serve` can't actually start
 *  (port race, sandbox denial) — without budgeting those, every text request would re-pay the spawn+fail
 *  cost forever instead of settling on llama-server for the session. */
function registerCrash(): void {
  const now = Date.now()
  crashTimestamps = crashTimestamps.filter((t) => now - t < CRASH_WINDOW_MS)
  crashTimestamps.push(now)
  if (crashTimestamps.length >= CRASH_BUDGET) {
    state = 'unavailable'
    auditLog('local.runtime.missing', { engine: 'apple-fm', reason: 'crash_budget_exhausted' })
  } else {
    state = 'stopped'
  }
}

async function spawnAndWaitHealthy(generation: number): Promise<void> {
  const targetPort = await findFreePort()
  if (generation !== startGeneration) throw new Error('fm runtime start cancelled')
  const proc = spawn(FM_BINARY_PATH, buildServeArgs(targetPort), {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child = proc
  let exited = false
  let exitDetail = ''
  let outputTail = ''
  const onOutput = (chunk: Buffer): void => {
    outputTail = (outputTail + chunk.toString('utf8')).slice(-800)
  }
  proc.stdout?.on('data', onOutput)
  proc.stderr?.on('data', onOutput)
  proc.once('exit', (code, signal) => {
    exited = true
    exitDetail = `code=${code}, signal=${signal}${outputTail.trim() ? ` — last output: ${outputTail.trim()}` : ''}`
    if (child !== proc) return
    const wasRunning = state === 'running'
    child = null
    port = null
    if (wasRunning) {
      // A stale idle-stop timer armed for the crashed server must never fire into a LATER start's
      // 'starting' window — stop() there would bump startGeneration and spuriously cancel it (review
      // finding). The crash itself is the stop; there is nothing left to idle-stop.
      clearIdleTimer()
      auditLog('local.runtime.crash', { engine: 'apple-fm', code, signal })
      registerCrash()
    }
  })
  proc.once('error', () => {
    /* surfaces via the health-poll fast-fail below; 'exit' handles bookkeeping */
  })
  try {
    await pollHealth(targetPort, generation, () => exited)
  } catch (err) {
    if (child === proc) {
      if (!proc.killed) proc.kill('SIGKILL')
      child = null
    }
    throw exited ? new Error(`fm serve exited before becoming healthy (${exitDetail})`) : err
  }
  if (generation !== startGeneration || child !== proc) throw new Error('fm runtime start cancelled')
  port = targetPort
}

/**
 * Start `fm serve` (idempotent). Concurrent callers while 'starting' share the in-flight promise;
 * 'running' resolves immediately; 'unavailable' (crash budget) throws so local.ts falls back to
 * llama-server for the rest of the session. There is no model-switch branch — the Apple engine serves
 * exactly one model.
 */
export async function start(): Promise<void> {
  if (state === 'unavailable') throw new Error('fm runtime unavailable for this session (crash budget exhausted)')
  if (state === 'running') return
  if (state === 'starting' && startPromise) {
    await startPromise
    return start()
  }
  state = 'starting'
  const generation = ++startGeneration
  const p = (async () => {
    try {
      await spawnAndWaitHealthy(generation)
      state = 'running'
      scheduleIdleStop()
      auditLog('local.runtime.start', { engine: 'apple-fm' })
    } catch (err) {
      if (generation === startGeneration && state === 'starting') {
        // Boot failure: budget it like a crash (sets 'stopped' or, past the budget, 'unavailable' so
        // pickLocalEngine stops re-paying the spawn+fail cost for the rest of the session).
        registerCrash()
        auditLog('local.runtime.missing', { engine: 'apple-fm', error: errMsg(err) })
      }
      throw err instanceof Error ? err : new Error(String(err))
    }
  })()
  startPromise = p
  try {
    await p
  } finally {
    if (startPromise === p) startPromise = null
  }
}

/** Kill the server and clear bookkeeping. Idempotent. Wired into will-quit beside localRuntime.stop(). */
export function stop(): void {
  clearIdleTimer()
  const wasUp = state === 'running' || state === 'starting'
  startGeneration++
  if (child && !child.killed) child.kill('SIGKILL')
  child = null
  port = null
  if (state !== 'unavailable') state = 'stopped'
  if (wasUp) auditLog('local.runtime.stop', { engine: 'apple-fm', reason: 'explicit' })
}

/**
 * Best-effort 1-token completion so the OS has mapped the model before the first real suggest request.
 * Unlike llama-server there is no per-slot KV cache to pin (no id_slot/cache_prompt) — the win here is
 * only first-request model-load latency, which is why this stays fire-and-forget with its own timeout.
 */
export function prewarm(messages: Array<{ role: string; content: string }>): void {
  if (state !== 'running' || port === null) return
  markActivity()
  void fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: FM_SYSTEM_MODEL, messages, max_tokens: 1, stream: false }),
    signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS)
  }).catch(() => {
    /* best-effort — the next real request pays the load cost instead */
  })
}
