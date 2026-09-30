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
