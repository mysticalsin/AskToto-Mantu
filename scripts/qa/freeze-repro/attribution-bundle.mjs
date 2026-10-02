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

function projectedAuditRow(row) {
  const out = { event: row.event }
  if (typeof row.tMs === 'number' && Number.isFinite(row.tMs)) out.tMs = row.tMs
  for (const [key, value] of Object.entries(row)) {
    if (key === 'event' || key === 'tMs' || key === 'bundle' || key === 'path' || key === 'message') continue
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

function readSampleFrames(samplesDir, row) {
  const candidates = []
  try {
    candidates.push(...readdirSync(samplesDir).filter((name) => name === `${row}-main.sample.txt` || name.startsWith(`${row}-renderer-`)).sort())
  } catch {
    return { frames: [], errorClass: 'sample_directory_missing' }
  }
  const sample = candidates.find((name) => name === `${row}-main.sample.txt`) ?? candidates[0]
  if (!sample) return { frames: [], errorClass: 'sample_missing' }
  const frames = []
  for (const line of readFileSync(join(samplesDir, sample), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\s+(.+?)\s+\(([^)]+)\)/)
    if (!match) continue
    const symbol = match[1].replace(/\s+\+\s+\d+.*$/, '').trim()
    const image = basename(match[2].trim().split(/\s+/)[0])
    if (symbol && image) frames.push({ symbol, image })
    if (frames.length >= 12) break
  }
  return { frames, errorClass: frames.length > 0 ? null : 'sample_frames_missing' }
}

function stallRowsFromAuditRows(auditRows, samplesDir) {
  const stalls = []
  for (const row of auditRows) {
    if (row.event !== 'app.stall' && row.event !== 'app.stall.sampled') continue
    const matrixRow = typeof row.row === 'string' && row.row ? row.row : 'unknown'
    const bundle = typeof row.bundle === 'string' ? basename(row.bundle) : null
    const { frames, errorClass } = readSampleFrames(samplesDir, matrixRow)
    stalls.push({
      row: matrixRow,
      tMs: typeof row.tMs === 'number' ? row.tMs : null,
      stalledMs: typeof row.stalledMs === 'number' ? row.stalledMs : null,
      bundle: bundle && STALL_BUNDLE_NAME.test(bundle) ? bundle : null,
      frames,
      attribution: null,
      ...(errorClass ? { status: 'FAIL', error_class: errorClass } : {})
    })
  }
  return stalls
}

export function writeAttributionBundle({ profiles, out, samplesDir = join(out, 'samples') }) {
  const rows = { stall: [], reveal: [], sidecar: [], sampler: [] }
  const rawAttributionRows = []
  const names = []
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
  writeFileSync(join(out, STALLS_FILE), stallRowsFromAuditRows(rawAttributionRows, samplesDir).map((row) => `${JSON.stringify(row)}\n`).join(''))
  writeFileSync(join(out, STALL_BUNDLE_NAMES_FILE), `${JSON.stringify({ names: [...new Set(names)].sort() }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { profile: { type: 'string', multiple: true }, out: { type: 'string' } } })
  if (!values.out) {
    console.error('usage: attribution-bundle.mjs --out <bundle dir> [--profile <userData dir>]...')
    process.exit(2)
  }
  writeAttributionBundle({ profiles: (values.profile ?? []).map((path) => resolve(path)), out: resolve(values.out) })
}
