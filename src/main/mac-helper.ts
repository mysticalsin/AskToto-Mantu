/**
 * mac-helper.ts — main-process gateway to the `metis-mac-helper` Swift sidecar (macOS only).
 *
 * The helper (native/mac-helper/main.swift, compiled by scripts/build-mac-helper.mjs, shipped via
 * electron-builder's mac extraResources) provides OS capabilities Electron lacks natively:
 *   - `watch-frontmost`: NSWorkspace app-activation events as TSV lines in the EXACT shape
 *     foreground-watcher.ts already parses from the Windows PowerShell watcher — this module only
 *     supplies the spawn spec; lifecycle/restart/parsing stay in foreground-watcher.ts, one code path
 *     for both platforms.
 *   - `ocr -`: Vision-framework text recognition over an image piped on stdin, JSON out. Spawn-per-call
 *     by design: upstream throttles describes to >=2.5s apart, so a ~100ms process start beats another
 *     long-lived server to babysit.
 *   - `screen-metrics`: one-shot per-display notch/menu-bar geometry (island/metrics.ts caches + joins
 *     this to Electron's `Display.id`, which IS the `CGDirectDisplayID` NSScreen reports — see that
 *     module's header for the coordinate-space caveat this raw payload carries).
 *   - `stat-flags`: one-shot st_flags per path for cloud-only file detection. Unlike the features
 *     above it fails SAFE, not open: infra/storage/dataless.ts classifies every file 'unknown' (never
 *     read by list or search) when the helper is missing or fails. check-mac-helper.mjs keeps the
 *     helper in every mac package; a dev checkout needs `node scripts/build-mac-helper.mjs` once.
 *   - `proc-info`: one-shot process identity for the sidecar registry/reaper. It returns the kernel
 *     process start time and executable realpath so PID reuse cannot be mistaken for ownership.
 *   - `stall-watch`: long-running, one per boot, samples main when `run-alive.json` stops changing;
 *     infra/observability/stall-sampler.ts owns its arguments and protocol.
 *   - `code-identity` / `bundle-copies`: one-shot, read-only signing identity and installed-copy census for
 *     the Screen Recording diagnosis (capture-permissions/). Neither touches the permissions database.
 *
 * Everything here degrades to null/absent — a missing or broken helper must leave the app exactly as it
 * behaved before the helper existed (VLM describe, 6s-timer-only mac trigger, floating non-notch island),
 * never crash a feature.
 *
 * NOTE for reviewers: this VM has no macOS/Xcode/Swift toolchain, so the Swift side of screen-metrics
 * (native/mac-helper/main.swift) is written and reasoned about but NOT compiled or run here. It needs a
 * real on-Mac build + manual QA pass (scripts/build-mac-helper.mjs, then this module's getMacScreenMetrics
 * against a real notch MacBook) before it can be trusted in production. See island/metrics.ts's header.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { mainLog } from './logger'

const OCR_TIMEOUT_MS = 8_000
/** Skip lines Vision itself doubts — low-confidence fragments add noise, not context. */
const OCR_MIN_CONFIDENCE = 0.3
/** An extract shorter than this means an image-heavy/near-empty screen — the VLM caption reads those
 *  better than three stray words do. */
const OCR_MIN_USEFUL_CHARS = 40
/** Cap the extract so a dense document screen can't blow up the ask prompt it gets injected into. */
const OCR_MAX_CHARS = 1_500
/** screen-metrics is a single NSScreen.screens enumeration with no I/O — generous but bounded so a
 *  hung/misbehaving helper can't stall the overlay's top-anchor path forever. */
const SCREEN_METRICS_TIMEOUT_MS = 3_000
const PROC_INFO_TIMEOUT_MS = 3_000
/** code-identity reads one signature; bundle-copies is one LaunchServices query. Both are bounded so a hung
 *  helper leaves the permission diagnosis on its version-only fallback instead of waiting. */
const IDENTITY_TIMEOUT_MS = 5_000

export interface OcrLine {
  text: string
  confidence: number
  /** Vision-normalized [x, y, w, h], origin bottom-left, 0..1. */
  box: [number, number, number, number]
}

export interface OcrResult {
  width: number
  height: number
  lines: OcrLine[]
}

export interface ProcessIdentity {
  pid: number
  ppid?: number
  pgid?: number
  osStartTime: string
  exeRealpath: string
  args: string[]
}

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

/** Absolute path where the helper binary lives for THIS run (packaged resources vs repo checkout) —
 *  same dual resolution local-runtime.ts uses for llama-server. */
export function macHelperPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'mac-helper', 'metis-mac-helper')
  return join(findRepoRoot(__dirname), 'resources', 'mac-helper', 'metis-mac-helper')
}

export function macHelperPresent(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && existsSync(macHelperPath())
}

/** Spawn spec for the darwin foreground watcher, or null when the helper isn't available (the watcher
 *  then returns its inert handle, exactly the pre-helper mac behavior). */
export function macWatcherSpawnSpec(): { command: string; args: string[] } | null {
  if (!macHelperPresent()) return null
  return { command: macHelperPath(), args: ['watch-frontmost'] }
}

/** Spawn spec for the one-shot `screen-metrics` subcommand, or null when the helper isn't available —
 *  mirrors macWatcherSpawnSpec()'s degrade-to-null contract. Exported so a unit test can assert the
 *  command/args without spawning a real helper. */
export function macScreenMetricsSpawnSpec(): { command: string; args: string[] } | null {
  if (!macHelperPresent()) return null
  return { command: macHelperPath(), args: ['screen-metrics'] }
}

/** Spawn spec for the one-shot `stat-flags` subcommand, or null when the helper isn't available.
 *  infra/storage/dataless.ts owns the wire protocol and the SF_DATALESS decoding. */
export function macStatFlagsSpawnSpec(): { command: string; args: string[] } | null {
  if (!macHelperPresent()) return null
  return { command: macHelperPath(), args: ['stat-flags'] }
}

export function macProcInfoSpawnSpec(pid: number): { command: string; args: string[] } | null {
  if (!macHelperPresent()) return null
  return { command: macHelperPath(), args: ['proc-info', String(pid)] }
}

/** Read-only `code-identity` (M2-0429): the static signature of an app bundle or binary. */
export function macCodeIdentitySpawnSpec(path: string): { command: string; args: string[] } | null {
  if (!macHelperPresent()) return null
  return { command: macHelperPath(), args: ['code-identity', path] }
}

/** Read-only `bundle-copies` (M2-0429): every installed app LaunchServices knows for a bundle id. */
export function macBundleCopiesSpawnSpec(bundleId: string): { command: string; args: string[] } | null {
  if (!macHelperPresent()) return null
  return { command: macHelperPath(), args: ['bundle-copies', bundleId] }
}

/** Flag `diagnostics.stall_sampler` (ARCHITECTURE C15). false restores the pre-M2-0192 boot exactly: no
 *  stall-watch helper, no capture sweep, no new audit events. */
const STALL_SAMPLER_ENABLED = true

/** The helper binary for the long-running `stall-watch` sidecar, or null when there is no helper (always
 *  off macOS) or the flag is off. infra/observability/stall-sampler.ts owns its arguments and protocol. */
export function macStallWatchCommand(): string | null {
  return STALL_SAMPLER_ENABLED && macHelperPresent() ? macHelperPath() : null
}

/** Raw per-screen payload shape emitted by `metis-mac-helper screen-metrics` (see main.swift's
 *  ScreenMetric). `frame`/`visibleFrame` are AppKit `NSScreen` rects (bottom-left origin) — kept in the
 *  raw shape for diagnostics, but island/metrics.ts must NEVER use them as Electron bounds/workArea (see
 *  that module's coordinate-space note). Only the magnitude fields (notchWidth, safeAreaInsetTop,
 *  backingScaleFactor) are safe to use directly. */
const ScreenMetricSchema = z.object({
  displayID: z.number(),
  frame: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  visibleFrame: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  safeAreaInsetTop: z.number(),
  auxLeftWidth: z.number(),
  auxRightWidth: z.number(),
  notchWidth: z.number(),
  backingScaleFactor: z.number()
})
const ScreenMetricsResultSchema = z.object({ screens: z.array(ScreenMetricSchema) })
export type RawScreenMetric = z.infer<typeof ScreenMetricSchema>

const HelperCodeIdentitySchema = z.object({
  identifier: z.string(),
  cdhash: z.string().regex(/^(?:[0-9a-f]{40,64})?$/),
  teamId: z.string(),
  adhoc: z.boolean()
})
export type HelperCodeIdentity = z.infer<typeof HelperCodeIdentitySchema>
const BundleCopiesSchema = z.object({
  copies: z.array(z.object({ path: z.string(), version: z.string() }))
})
export type HelperBundleCopy = z.infer<typeof BundleCopiesSchema>['copies'][number]

/** Parse `code-identity` stdout; null for anything that is not the documented shape. */
export function parseCodeIdentity(stdout: string): HelperCodeIdentity | null {
  try {
    return HelperCodeIdentitySchema.parse(JSON.parse(stdout))
  } catch {
    return null
  }
}

/** Parse `bundle-copies` stdout; null for anything that is not the documented shape. */
export function parseBundleCopies(stdout: string): HelperBundleCopy[] | null {
  try {
    return BundleCopiesSchema.parse(JSON.parse(stdout)).copies
  } catch {
    return null
  }
}

/** Run a one-shot read-only helper command and parse its stdout. Null on any failure, like every mode here. */
function runHelperOnce<T>(
  spec: { command: string; args: string[] } | null,
  parse: (stdout: string) => T | null,
  timeoutMs: number
): Promise<T | null> {
  return new Promise((resolve) => {
    if (!spec) {
      resolve(null)
      return
    }
    const label = spec.args[0]
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      mainLog.warn(`[mac-helper] ${label} spawn failed`, e instanceof Error ? e.message : String(e))
      resolve(null)
      return
    }
    let settled = false
    const settle = (value: T | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle(null)
    }, timeoutMs)
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    proc.once('error', (e) => {
      mainLog.warn(`[mac-helper] ${label} error`, e instanceof Error ? e.message : String(e))
      settle(null)
    })
    proc.once('close', (code) => {
      if (code !== 0) {
        if (stderr.trim()) mainLog.warn(`[mac-helper] ${label} exited ${code}: ${stderr.trim().slice(0, 300)}`)
        settle(null)
        return
      }
      settle(parse(stdout.trim()))
    })
  })
}

/** This app's signing identity (cdhash, teamId, adhoc), or null without a helper. */
export function getCodeIdentity(path: string): Promise<HelperCodeIdentity | null> {
  return runHelperOnce(macCodeIdentitySpawnSpec(path), parseCodeIdentity, IDENTITY_TIMEOUT_MS)
}

/** Every installed copy of a bundle id, or null without a helper. */
export function getBundleCopies(bundleId: string): Promise<HelperBundleCopy[] | null> {
  return runHelperOnce(macBundleCopiesSpawnSpec(bundleId), parseBundleCopies, IDENTITY_TIMEOUT_MS)
}

const ProcessIdentitySchema = z.object({
  pid: z.number(),
  ppid: z.number().optional(),
  pgid: z.number().optional(),
  osStartTime: z.string(),
  exeRealpath: z.string(),
  args: z.array(z.string())
})

/**
 * One-shot fetch of every connected display's notch/menu-bar metrics via the helper's `screen-metrics`
 * subcommand. Null on ANY failure (missing helper, spawn error, timeout, malformed/non-conforming JSON)
 * — callers (island/metrics.ts) must degrade to the heuristic fallback, never crash a feature. Spawn-once
 * per call by design, same as OCR: this is invoked at most once per display-topology change, not polled.
 */
export function getMacScreenMetrics(): Promise<RawScreenMetric[] | null> {
  return new Promise((resolve) => {
    const spec = macScreenMetricsSpawnSpec()
    if (!spec) {
      resolve(null)
      return
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      mainLog.warn('[mac-helper] screen-metrics spawn failed', e instanceof Error ? e.message : String(e))
      resolve(null)
      return
    }
    let settled = false
    const settle = (value: RawScreenMetric[] | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle(null)
    }, SCREEN_METRICS_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    proc.once('error', (e) => {
      mainLog.warn('[mac-helper] screen-metrics error', e instanceof Error ? e.message : String(e))
      settle(null)
    })
    // 'close', never 'exit' — same rationale as extractScreenText's OCR path below: 'exit' can fire
    // while piped stdout still has undelivered chunks in flight (more displays = more JSON).
    proc.once('close', (code) => {
      if (code !== 0) {
        if (stderr.trim()) mainLog.warn(`[mac-helper] screen-metrics exited ${code}: ${stderr.trim().slice(0, 300)}`)
        settle(null)
        return
      }
      try {
        const parsed = ScreenMetricsResultSchema.parse(JSON.parse(stdout))
        settle(parsed.screens)
      } catch (e) {
        mainLog.warn('[mac-helper] screen-metrics: malformed JSON', e instanceof Error ? e.message : String(e))
        settle(null)
      }
    })
  })
}

export function getProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  return new Promise((resolve) => {
    const spec = macProcInfoSpawnSpec(pid)
    if (!spec) {
      resolve(null)
      return
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      mainLog.warn('[mac-helper] proc-info spawn failed', e instanceof Error ? e.message : String(e))
      resolve(null)
      return
    }
    let settled = false
    const settle = (value: ProcessIdentity | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle(null)
    }, PROC_INFO_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    proc.once('error', (e) => {
      mainLog.warn('[mac-helper] proc-info error', e instanceof Error ? e.message : String(e))
      settle(null)
    })
    proc.once('close', (code) => {
      if (code !== 0) {
        if (stderr.trim()) mainLog.warn(`[mac-helper] proc-info exited ${code}: ${stderr.trim().slice(0, 300)}`)
        settle(null)
        return
      }
      const body = stdout.trim()
      if (!body) {
        settle(null)
        return
      }
      try {
        settle(ProcessIdentitySchema.parse(JSON.parse(body)))
      } catch (e) {
        mainLog.warn('[mac-helper] proc-info: malformed JSON', e instanceof Error ? e.message : String(e))
        settle(null)
      }
    })
  })
}

/**
 * Turn a raw helper OCR payload into the screen-context string screen-preprocess caches, or null when
 * the screen has too little text to be worth an OCR-based context (caller falls back to the VLM
 * caption). Pure — unit-tested directly. Lines are sorted into reading order (Vision boxes have a
 * bottom-left origin, so top-of-screen = highest y) and confidence-filtered.
 */
export function buildOcrContext(result: OcrResult): string | null {
  const usable = result.lines
    .filter((l) => l.confidence >= OCR_MIN_CONFIDENCE && l.text.trim().length > 0)
    .sort((a, b) => b.box[1] - a.box[1])
    .map((l) => l.text.trim())
  const joined = usable.join('\n')
  if (joined.length < OCR_MIN_USEFUL_CHARS) return null
  const body = joined.length > OCR_MAX_CHARS ? joined.slice(0, OCR_MAX_CHARS) + '\n[…]' : joined
  // The framing line matters: downstream this string is injected as screen context for an answer
  // provider, which should know it is reading a raw text extract, not a narrated description.
  return `Text visible on the user's screen (OCR extract, top to bottom):\n${body}`
}

/**
 * OCR a screenshot (base64 JPEG/PNG) through the helper and return the ready-to-cache context string.
 * Null on ANY failure — missing helper, spawn error, timeout, bad JSON, text-poor screen — the caller's
 * contract is "OCR when it helps, silently fall back when it can't".
 */
export function extractScreenText(imageB64: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!macHelperPresent()) {
      resolve(null)
      return
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(macHelperPath(), ['ocr', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      mainLog.warn('[mac-helper] ocr spawn failed', e instanceof Error ? e.message : String(e))
      resolve(null)
      return
    }
    let settled = false
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle(null)
    }, OCR_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    proc.once('error', (e) => {
      mainLog.warn('[mac-helper] ocr error', e instanceof Error ? e.message : String(e))
      settle(null)
    })
    // 'close', never 'exit' (review finding): 'exit' can fire while piped stdout still has undelivered
    // chunks in flight, so a dense screen's tens-of-KB JSON gets truncated and JSON.parse kills the OCR
    // path on exactly the screens it exists for. 'close' guarantees all stdio has drained.
    proc.once('close', (code) => {
      if (code !== 0) {
        if (stderr.trim()) mainLog.warn(`[mac-helper] ocr exited ${code}: ${stderr.trim().slice(0, 300)}`)
        settle(null)
        return
      }
      try {
        settle(buildOcrContext(JSON.parse(stdout) as OcrResult))
      } catch {
        settle(null)
      }
    })
    proc.stdin?.on('error', () => {
      /* helper died before reading all input — 'exit' settles */
    })
    proc.stdin?.end(Buffer.from(imageB64, 'base64'))
  })
}
