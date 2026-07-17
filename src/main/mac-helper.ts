/**
 * mac-helper.ts — main-process gateway to the `metis-mac-helper` Swift sidecar (macOS only).
 *
 * The helper (native/mac-helper/main.swift, compiled by scripts/build-mac-helper.mjs, shipped via
 * electron-builder's mac extraResources) provides two OS capabilities Electron lacks natively:
 *   - `watch-frontmost`: NSWorkspace app-activation events as TSV lines in the EXACT shape
 *     foreground-watcher.ts already parses from the Windows PowerShell watcher — this module only
 *     supplies the spawn spec; lifecycle/restart/parsing stay in foreground-watcher.ts, one code path
 *     for both platforms.
 *   - `ocr -`: Vision-framework text recognition over an image piped on stdin, JSON out. Spawn-per-call
 *     by design: upstream throttles describes to >=2.5s apart, so a ~100ms process start beats another
 *     long-lived server to babysit.
 *
 * Everything here degrades to null/absent — a missing or broken helper must leave the app exactly as it
 * behaved before the helper existed (VLM describe, 6s-timer-only mac trigger), never crash a feature.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { mainLog } from './logger'

const OCR_TIMEOUT_MS = 8_000
/** Skip lines Vision itself doubts — low-confidence fragments add noise, not context. */
const OCR_MIN_CONFIDENCE = 0.3
/** An extract shorter than this means an image-heavy/near-empty screen — the VLM caption reads those
 *  better than three stray words do. */
const OCR_MIN_USEFUL_CHARS = 40
/** Cap the extract so a dense document screen can't blow up the ask prompt it gets injected into. */
const OCR_MAX_CHARS = 1_500

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
