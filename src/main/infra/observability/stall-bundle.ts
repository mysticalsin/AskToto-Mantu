/**
 * stall-bundle.ts — turns a raw /usr/bin/sample capture of a stalled main process into a content-free
 * bundle and keeps the newest MAX_BUNDLES of them (M2-0192, ARCHITECTURE C15).
 *
 * `metis-mac-helper stall-watch` (see stall-sampler.ts) writes each capture into captureDir() as
 * `<bootId>.<capturedAtMs>.<stalledMs>.sample`. A capture is the full sample(1) report, which names the
 * app's install path and every loaded image's path, so it never leaves captureDir():
 * collectStallCaptures() projects it into a bundle and deletes it, whether or not the projection succeeds.
 *
 * The projection is an allowlist, not a scrub. Only the call graph's thread headers and frame lines
 * survive, each rebuilt from parsed fields: sample count, symbol name, image name and offset. The report
 * header, thread and queue names, source file:line, the summary sections and Binary Images are dropped. A
 * symbol or image name holding `/`, `\`, `@` or a control character becomes `<redacted>`, so no bundle
 * contains any of those characters and no path or email can survive. Symbol and image names come from the
 * symbol tables of loaded code, never from user data.
 */
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Bundles kept; the oldest capture is dropped first. */
export const MAX_BUNDLES = 10
/** Stack bytes kept per bundle. The main thread is written first, so the cut never drops it. */
export const MAX_BUNDLE_BYTES = 512 * 1024
/** A 5 s sample of the main process is a few hundred KB; a file this large is not one. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const MAX_FIELD_CHARS = 512
const REDACTED = '<redacted>'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CAPTURE_NAME = new RegExp(`^(${UUID})\\.(\\d{1,15})\\.(\\d{1,15})\\.sample$`)
const BUNDLE_NAME = new RegExp(`^${UUID}\\.(\\d{1,15})\\.\\d{1,15}\\.txt$`)

const THREAD_LINE = /^\s+(\d+)\s+Thread_\d+(.*)$/
const FRAME_LINE = /^\s+([+!:| ]*)(\d+)\s+(.+)$/
const SYMBOLIZED = /^(.+?) {2}\(in ([^)]+)\) \+ (\d+)/
const UNSYMBOLIZED = /^\?\?\? {2}\(in ([^)]+)\) {2}load address 0x[0-9a-f]+ \+ (0x[0-9a-f]+)/
const UNKNOWN = /^\?\?\?(\s|$)/
const UNSAFE = /[/\\@\p{Cc}]/u

interface Capture {
  bootId: string
  capturedAtMs: number
  stalledMs: number
}

/** One capture's fate, for the caller to audit. `bootId` is the boot that stalled; after a relaunch that
 *  is not the current boot. `bundle` is a file name inside bundleDir(). */
export type CaptureOutcome =
  | { kind: 'bundled'; bootId: string; stalledMs: number; bundle: string }
  | { kind: 'failed'; bootId: string }

export function bundleDir(userData: string): string {
  return join(userData, 'diagnostics', 'stalls')
}

export function captureDir(userData: string): string {
  return join(bundleDir(userData), 'raw')
}

function safe(field: string): string {
  return field.length > MAX_FIELD_CHARS || UNSAFE.test(field) ? REDACTED : field
}

function projectFrame(tree: string, count: string, rest: string): string {
  const symbolized = SYMBOLIZED.exec(rest)
  if (symbolized) return `${tree}${count} ${safe(symbolized[1])}  (in ${safe(symbolized[2])}) + ${symbolized[3]}`
  const unsymbolized = UNSYMBOLIZED.exec(rest)
  if (unsymbolized) return `${tree}${count} ???  (in ${safe(unsymbolized[1])}) + ${unsymbolized[2]}`
  return `${tree}${count} ${UNKNOWN.test(rest) ? '???' : REDACTED}`
}

/** The call graph of a sample(1) report as thread stacks and symbol names only, main thread first. Pure.
 *  Empty when the report has no call-graph thread (for example sample's own error text). */
export function projectSample(report: string): string[] {
  const threads: { main: boolean; lines: string[] }[] = []
  let inCallGraph = false
  for (const line of report.split(/\r?\n/)) {
    if (!inCallGraph) {
      inCallGraph = line.trim() === 'Call graph:'
      continue
    }
    if (/^\S/.test(line)) break // the next report section starts in column 0
    const thread = THREAD_LINE.exec(line)
    if (thread) {
      const main = thread[2].includes('com.apple.main-thread')
      threads.push({ main, lines: [`Thread ${threads.length}${main ? ' (main)' : ''}  ${thread[1]}`] })
      continue
    }
    const frame = FRAME_LINE.exec(line)
    if (frame && threads.length > 0) threads[threads.length - 1].lines.push(projectFrame(frame[1], frame[2], frame[3]))
  }
  return [...threads.filter((t) => t.main), ...threads.filter((t) => !t.main)].flatMap((t) => t.lines)
}

function capped(lines: string[]): string[] {
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    bytes += Buffer.byteLength(line) + 1
    if (bytes > MAX_BUNDLE_BYTES) return [...kept, '[truncated]']
    kept.push(line)
  }
  return kept
}

function renderBundle(capture: Capture, stacks: string[]): string {
  return [
    'metis stall bundle v1',
    `bootId: ${capture.bootId}`,
    `capturedAt: ${new Date(capture.capturedAtMs).toISOString()}`,
    `stalledMs: ${capture.stalledMs}`,
    'source: sample(1), 5 s at 10 ms; thread stacks and symbol names only',
    '',
    ...capped(stacks),
    ''
  ].join('\n')
}

function parseCapture(name: string): Capture | null {
  const m = CAPTURE_NAME.exec(name)
  return m ? { bootId: m[1], capturedAtMs: Number(m[2]), stalledMs: Number(m[3]) } : null
}

async function bundleCapture(userData: string, path: string, capture: Capture): Promise<CaptureOutcome> {
  const failed: CaptureOutcome = { kind: 'failed', bootId: capture.bootId }
  try {
    if ((await stat(path)).size > MAX_CAPTURE_BYTES) return failed
    const stacks = projectSample(await readFile(path, 'utf8'))
    if (stacks.length === 0) return failed
    const bundle = `${capture.bootId}.${capture.capturedAtMs}.${capture.stalledMs}.txt`
    await writeFile(join(bundleDir(userData), bundle), renderBundle(capture, stacks), { mode: 0o600 })
    return { kind: 'bundled', bootId: capture.bootId, stalledMs: capture.stalledMs, bundle }
  } catch {
    return failed
  }
}

async function pruneBundles(userData: string): Promise<void> {
  const names = await readdir(bundleDir(userData)).catch((): string[] => [])
  const newestFirst = names
    .flatMap((name) => {
      const m = BUNDLE_NAME.exec(name)
      return m ? [{ name, capturedAtMs: Number(m[1]) }] : []
    })
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs)
  for (const { name } of newestFirst.slice(MAX_BUNDLES)) {
    await rm(join(bundleDir(userData), name), { force: true }).catch(() => undefined)
  }
}

/** Turn every pending capture into a bundle or a failure, delete it either way, then keep the newest
 *  MAX_BUNDLES bundles. Never rejects; a missing capture directory is nothing to do. */
export async function collectStallCaptures(userData: string): Promise<CaptureOutcome[]> {
  const dir = captureDir(userData)
  const names = await readdir(dir).catch((): string[] => [])
  const outcomes: CaptureOutcome[] = []
  for (const name of names) {
    const capture = parseCapture(name)
    if (capture) outcomes.push(await bundleCapture(userData, join(dir, name), capture))
    await rm(join(dir, name), { force: true }).catch(() => undefined)
  }
  if (outcomes.some((o) => o.kind === 'bundled')) await pruneBundles(userData)
  return outcomes
}
