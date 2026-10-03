#!/usr/bin/env node
// M2-0194 attribution excerpts for the freeze-repro bundle. Reads the userData profiles a freeze-repro run
// used and writes, into the bundle directory, the audit rows that attribute a stall (stall, sampler, reveal,
// sidecar) plus the NAMES of the stall bundles the sampler produced. The audit log already carries only
// projected, content-free fields; stall-bundle contents are never read or copied, only their file names.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const EXCERPT_FILES = Object.freeze({
  stall: 'stall-excerpt.jsonl',
  reveal: 'reveal-excerpt.jsonl',
  sidecar: 'sidecar-excerpt.jsonl',
  sampler: 'sampler-excerpt.jsonl'
})
export const STALL_BUNDLE_NAMES_FILE = 'stall-bundle-names.json'
export const STALLS_FILE = 'stalls.jsonl'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** Name of a bundle written by src/main/infra/observability/stall-bundle.ts: `<bootId>.<capturedAtMs>.<stalledMs>.txt`. */
export const STALL_BUNDLE_NAME = new RegExp(`^${UUID}\\.\\d{1,15}\\.\\d{1,15}\\.txt$`)
const AUDIT_LOG_NAME = /^audit(-\d+)?\.log$/

/** Largest file a collector bundle can be: MAX_BUNDLE_BYTES of stacks plus room for the header. */
export const MAX_STALL_BUNDLE_FILE_BYTES = 512 * 1024 + 4096
const BUNDLE_NAME_PARTS = new RegExp(`^(${UUID})\\.(\\d{1,15})\\.(\\d{1,15})\\.txt$`)
const BUNDLE_THREAD = /^Thread \d+( \(main\))? {2}\d+$/
const BUNDLE_FRAME = /^[+!:| ]*\d+ (.+)$/
const BUNDLE_FRAME_REST = [/^\S.*? {2}\(in [^)]+\) \+ \d+$/, /^\?\?\? {2}\(in [^)]+\) \+ 0x[0-9a-f]+$/, /^\?\?\?$/, /^<redacted>$/]
const UNSAFE = /[/\\@\p{Cc}]/u

/**
 * The script-side mirror of isStallBundle in src/main/infra/observability/stall-bundle.ts (a parity test
 * keeps them in step): true only when `text` is exactly the header the collector writes for the capture
 * `name` encodes, then a thread header first and only thread headers and projected frame lines after it,
 * none holding `/`, `\`, `@` or a control character, optionally ending in `[truncated]`. Pure.
 */
export function isStallBundle(name, text) {
  const m = BUNDLE_NAME_PARTS.exec(name)
  if (!m) return false
  const capturedAt = new Date(Number(m[2]))
  if (Number.isNaN(capturedAt.getTime())) return false
  const header = [
    'metis stall bundle v1',
    `bootId: ${m[1]}`,
    `capturedAt: ${capturedAt.toISOString()}`,
    `stalledMs: ${Number(m[3])}`,
    'source: sample(1), 5 s at 10 ms; thread stacks and symbol names only',
    ''
  ]
  const lines = text.split('\n')
  if (lines.length < header.length + 2 || lines[lines.length - 1] !== '') return false
  if (header.some((line, i) => lines[i] !== line)) return false
  const stacks = lines.slice(header.length, -1)
  if (!BUNDLE_THREAD.test(stacks[0])) return false
  return stacks.every((line, i) => {
    if (UNSAFE.test(line)) return false
    if (line === '[truncated]') return i === stacks.length - 1
    if (BUNDLE_THREAD.test(line)) return true
    const frame = BUNDLE_FRAME.exec(line)
    return frame !== null && BUNDLE_FRAME_REST.some((rest) => rest.test(frame[1]))
  })
}

const ATTRIBUTION_EVENTS = new Set(['app.stall', 'app.stall.sampled', 'reveal', 'sidecar.spawn', 'sidecar.exit', 'sidecar.reaped'])
const ENUM_FIELD = /^(reason|status|result|outcome|sidecar|name|phase|source|kind)$/
const ENUM_VALUE = /^[A-Za-z0-9._:-]{1,96}$/

/** The excerpt an audit event belongs to, or null when the event is not part of the attribution record. */
export function excerptOf(event) {
  if (event === 'app.stall') return 'stall'
  if (event === 'app.stall.sampled') return 'sampler'
  if (event === 'reveal') return 'reveal'
  if (event === 'sidecar.spawn' || event === 'sidecar.exit' || event === 'sidecar.reaped') return 'sidecar'
  return null
}

function auditTMs(row) {
  if (typeof row.ts === 'string') {
    const parsed = Date.parse(row.ts)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function stallDurationMs(row) {
  if (row.event === 'app.stall' && typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)) return row.durationMs
  if (row.event === 'app.stall.sampled' && typeof row.stalledMs === 'number' && Number.isFinite(row.stalledMs)) return row.stalledMs
  return null
}

function projectedAuditRow(row) {
  const out = { event: row.event }
  const tMs = auditTMs(row)
  if (tMs !== null) out.tMs = tMs
  const stalledMs = stallDurationMs(row)
  if (stalledMs !== null) out.stalledMs = stalledMs
  for (const [key, value] of Object.entries(row)) {
    if (key === 'event' || key === 'ts' || key === 'tMs' || key === 'stalledMs' || key === 'bundle' || key === 'path' || key === 'message') {
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (ENUM_FIELD.test(key) && typeof value === 'string' && ENUM_VALUE.test(value)) out[key] = value
  }
  return out
}

/** Group the attribution rows of one audit log by excerpt; lines that are not JSON are ignored. */
export function excerptRows(auditText) {
  const rows = { stall: [], reveal: [], sidecar: [], sampler: [] }
  for (const line of auditText.split(/\r?\n/)) {
    if (!line) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const excerpt = row && typeof row === 'object' && ATTRIBUTION_EVENTS.has(row.event) ? excerptOf(row.event) : null
    if (excerpt) rows[excerpt].push(projectedAuditRow(row))
  }
  return rows
}

/** Only well-formed stall-bundle file names survive; anything else in the directory is not listed. */
export function stallBundleNames(fileNames) {
  return fileNames.filter((name) => STALL_BUNDLE_NAME.test(name)).sort()
}

function attributionAuditRows(auditText) {
  const rows = []
  for (const line of auditText.split(/\r?\n/)) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && ATTRIBUTION_EVENTS.has(row.event)) rows.push(row)
    } catch {
      // Non-JSON audit lines are ignored by the excerpt path as well.
    }
  }
  return rows
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  const rows = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object') rows.push(row)
    } catch {
      // A corrupt auxiliary row is ignored here; the evidence checker validates the emitted bundle.
    }
  }
  return rows
}

function readRowWindows(matrixPath) {
  return readJsonl(matrixPath)
    .filter((row) => typeof row.row === 'string' && Number.isFinite(row.row_started_ms) && Number.isFinite(row.row_finished_ms))
    .map((row) => ({ row: row.row, start: row.row_started_ms, end: row.row_finished_ms }))
}

function matrixRowAt(tMs, windows) {
  if (!Number.isFinite(tMs)) return 'unknown'
  const match = windows.find((window) => tMs >= window.start && tMs <= window.end)
  return match?.row ?? 'unknown'
}

function readSampleIndex(sampleIndexPath) {
  return readJsonl(sampleIndexPath)
    .filter((row) => row.role === 'main' && Number.isFinite(row.capturedMs) && typeof row.file === 'string')
    .map((row) => ({ capturedMs: row.capturedMs, file: row.file }))
}

function closestSample(tMs, sampleIndex) {
  if (!Number.isFinite(tMs) || sampleIndex.length === 0) return null
  let best = null
  for (const sample of sampleIndex) {
    const distance = Math.abs(sample.capturedMs - tMs)
    if (!best || distance < best.distance) best = { ...sample, distance }
  }
  return best
}

function readSampleFrames(samplesDir, sampleFile) {
  if (!sampleFile) return { frames: [], errorClass: 'sample_missing' }
  const sample = basename(sampleFile)
  const samplePath = join(samplesDir, sample)
  try {
    if (!existsSync(samplePath)) return { frames: [], errorClass: 'sample_missing' }
  } catch {
    return { frames: [], errorClass: 'sample_directory_missing' }
  }
  const frames = []
  let inCallGraph = false
  let inMainThread = false
  for (const line of readFileSync(samplePath, 'utf8').split(/\r?\n/)) {
    if (!inCallGraph) {
      inCallGraph = line.trim() === 'Call graph:'
      continue
    }
    const isThreadHeader = /^\s*\d+\s+Thread[_\s]/.test(line)
    if (isThreadHeader) {
      if (inMainThread) break
      inMainThread = /\bcom\.apple\.main-thread\b/.test(line)
      continue
    }
    if (!inMainThread) continue
    if (/^\s*Total number in stack/.test(line)) break
    const frameLine = line.replace(/^\s*[+!:| ]+\s*/, '').replace(/^\d+\s+/, '')
    const match = frameLine.match(/^(.+?)\s+\(in\s+([^)]+)\)/)
    if (!match) continue
    const symbol = match[1].replace(/\s+\+\s+\d+.*$/, '').trim()
    const image = basename(match[2].trim())
    if (symbol && image) frames.push({ symbol, image })
    if (frames.length >= 12) break
  }
  return { frames, errorClass: frames.length > 0 ? null : 'sample_frames_missing' }
}

function stallRowsFromAuditRows(auditRows, { samplesDir, rowWindows, sampleIndex, host }) {
  const stalls = []
  const windowsHostedLive = host === 'windows-latest'
  for (const row of auditRows) {
    if (row.event !== 'app.stall' && row.event !== 'app.stall.sampled') continue
    const tMs = auditTMs(row)
    const stalledMs = stallDurationMs(row)
    const matrixRow = matrixRowAt(tMs, rowWindows)
    const bundle = typeof row.bundle === 'string' ? basename(row.bundle) : null
    if (windowsHostedLive) {
      stalls.push({
        row: matrixRow,
        tMs,
        stalledMs,
        bundle: bundle && STALL_BUNDLE_NAME.test(bundle) ? bundle : null,
        frames: [],
        attribution: null,
        status: 'NOT_APPLICABLE',
        reason: 'process sampling unavailable on windows-latest; /usr/bin/sample is macOS-only'
      })
      continue
    }
    const nearestSample = closestSample(tMs, sampleIndex)
    const { frames, errorClass } = readSampleFrames(samplesDir, nearestSample?.file)
    stalls.push({
      row: matrixRow,
      tMs,
      stalledMs,
      bundle: bundle && STALL_BUNDLE_NAME.test(bundle) ? bundle : null,
      frames,
      attribution: null,
      ...(errorClass ? { status: 'FAIL', error_class: errorClass } : {})
    })
  }
  return stalls
}

export function writeAttributionBundle({
  profiles,
  out,
  samplesDir = join(out, 'samples'),
  matrixPath = join(out, 'matrix.jsonl'),
  sampleIndexPath = join(out, 'sample-index.jsonl'),
  host = 'macos-latest'
}) {
  const rows = { stall: [], reveal: [], sidecar: [], sampler: [] }
  const rawAttributionRows = []
  const names = []
  const rowWindows = readRowWindows(matrixPath)
  const sampleIndex = readSampleIndex(sampleIndexPath)
  for (const profile of profiles) {
    const logs = join(profile, 'logs')
    const auditFiles = existsSync(logs) ? readdirSync(logs).filter((name) => AUDIT_LOG_NAME.test(name)).sort() : []
    for (const file of auditFiles) {
      const auditText = readFileSync(join(logs, file), 'utf8')
      const parsed = excerptRows(auditText)
      for (const key of Object.keys(rows)) rows[key].push(...parsed[key])
      rawAttributionRows.push(...attributionAuditRows(auditText))
    }
    const stalls = join(profile, 'diagnostics', 'stalls')
    if (existsSync(stalls)) names.push(...stallBundleNames(readdirSync(stalls)))
  }
  mkdirSync(out, { recursive: true })
  for (const [key, file] of Object.entries(EXCERPT_FILES)) {
    writeFileSync(join(out, file), rows[key].map((row) => `${JSON.stringify(row)}\n`).join(''))
  }
  writeFileSync(
    join(out, STALLS_FILE),
    stallRowsFromAuditRows(rawAttributionRows, { samplesDir, rowWindows, sampleIndex, host }).map((row) => `${JSON.stringify(row)}\n`).join('')
  )
  writeFileSync(join(out, STALL_BUNDLE_NAMES_FILE), `${JSON.stringify({ names: [...new Set(names)].sort() }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', multiple: true },
      out: { type: 'string' },
      matrix: { type: 'string' },
      'sample-index': { type: 'string' },
      host: { type: 'string' }
    }
  })
  if (!values.out) {
    console.error('usage: attribution-bundle.mjs --out <bundle dir> [--profile <userData dir>]...')
    process.exit(2)
  }
  writeAttributionBundle({
    profiles: (values.profile ?? []).map((path) => resolve(path)),
    out: resolve(values.out),
    matrixPath: values.matrix ? resolve(values.matrix) : undefined,
    sampleIndexPath: values['sample-index'] ? resolve(values['sample-index']) : undefined,
    host: values.host
  })
}
