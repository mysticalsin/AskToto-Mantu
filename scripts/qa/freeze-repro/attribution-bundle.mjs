#!/usr/bin/env node
// M2-0194 attribution excerpts for the freeze-repro bundle. Reads the userData profiles a freeze-repro run
// used and writes, into the bundle directory, the audit rows that attribute a stall (stall, sampler, reveal,
// sidecar) plus the NAMES of the stall bundles the sampler produced. The audit log already carries only
// projected, content-free fields; stall-bundle contents are never read or copied, only their file names.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const EXCERPT_FILES = Object.freeze({
  stall: 'stall-excerpt.jsonl',
  reveal: 'reveal-excerpt.jsonl',
  sidecar: 'sidecar-excerpt.jsonl',
  sampler: 'sampler-excerpt.jsonl'
})
export const STALL_BUNDLE_NAMES_FILE = 'stall-bundle-names.json'

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

/** The excerpt an audit event belongs to, or null when the event is not part of the attribution record. */
export function excerptOf(event) {
  if (event === 'app.stall' || event === 'app.stall.summary') return 'stall'
  if (event === 'app.stall.sampled' || event === 'app.stall.sample_failed') return 'sampler'
  if (event === 'reveal') return 'reveal'
  if (typeof event === 'string' && event.startsWith('sidecar.')) return 'sidecar'
  return null
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
    const excerpt = row && typeof row === 'object' ? excerptOf(row.event) : null
    if (excerpt) rows[excerpt].push(row)
  }
  return rows
}

/** Only well-formed stall-bundle file names survive; anything else in the directory is not listed. */
export function stallBundleNames(fileNames) {
  return fileNames.filter((name) => STALL_BUNDLE_NAME.test(name)).sort()
}

export function writeAttributionBundle({ profiles, out }) {
  const rows = { stall: [], reveal: [], sidecar: [], sampler: [] }
  const names = []
  for (const profile of profiles) {
    const logs = join(profile, 'logs')
    const auditFiles = existsSync(logs) ? readdirSync(logs).filter((name) => AUDIT_LOG_NAME.test(name)).sort() : []
    for (const file of auditFiles) {
      const parsed = excerptRows(readFileSync(join(logs, file), 'utf8'))
      for (const key of Object.keys(rows)) rows[key].push(...parsed[key])
    }
    const stalls = join(profile, 'diagnostics', 'stalls')
    if (existsSync(stalls)) names.push(...stallBundleNames(readdirSync(stalls)))
  }
  mkdirSync(out, { recursive: true })
  for (const [key, file] of Object.entries(EXCERPT_FILES)) {
    writeFileSync(join(out, file), rows[key].map((row) => `${JSON.stringify(row)}\n`).join(''))
  }
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
