#!/usr/bin/env node
/**
 * verify-audit-log.mjs — proves the audit trail's hash chain is unbroken, or names the first break.
 *
 * Every record src/main/logger.ts writes carries `seq` (monotonic, never reset by rotation) and `prev`
 * (hex SHA-256 of the previous record's exact line). This walks the retained generations in order —
 * `audit-<epoch-ms>.log` archives (numeric ascending), then the live `audit.log` — and verifies that
 * every chained record links to the line physically before it. Records from builds that predate the
 * chain lack the fields and are reported as a legacy prefix, not a failure; a chained record followed
 * by an unchained one IS a failure (a truncate-and-append hides there).
 *
 * Usage:
 *   node scripts/verify-audit-log.mjs "%APPDATA%/asktoto/logs"
 *   node scripts/verify-audit-log.mjs            (defaults to the installed app's logs dir)
 *
 * Exit 0 = chain verified. Exit 1 = break found (details on stdout). Exit 2 = no audit data found.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const sha256 = (line) => createHash('sha256').update(line, 'utf8').digest('hex')

/**
 * Pure verification over the raw lines of the whole retained trail, in physical order.
 * Returns { ok, total, chained, legacy, breaks: [{ index, reason }] }.
 */
export function verifyAuditLines(lines) {
  const breaks = []
  let legacy = 0
  let chained = 0
  let inChain = false
  let prevLine = null // the physical line before the current one (legacy or chained)
  let prevSeq = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    let rec
    try {
      rec = JSON.parse(raw)
    } catch {
      breaks.push({ index: i, reason: 'not valid JSON — the trail was edited or corrupted here' })
      prevLine = raw
      continue
    }
    const isChained = typeof rec.seq === 'number' && typeof rec.prev === 'string'
    if (!isChained) {
      if (inChain) {
        breaks.push({ index: i, reason: 'unchained record AFTER the chain started — truncate-and-append signature' })
      } else {
        legacy++
      }
      prevLine = raw
      continue
    }
    if (!inChain) {
      // First chained record: prev must be GENESIS (fresh trail) or the hash of the physically
      // preceding legacy line (logger.ts resumes the tip from whatever line was last on disk).
      const okStart = rec.prev === 'GENESIS' || (prevLine !== null && rec.prev === sha256(prevLine))
      if (!okStart) breaks.push({ index: i, reason: 'chain start links to neither GENESIS nor the preceding line' })
      inChain = true
    } else {
      if (rec.seq !== prevSeq + 1) {
        breaks.push({ index: i, reason: `seq jumped ${prevSeq} -> ${rec.seq} — records deleted or reordered` })
      }
      if (prevLine === null || rec.prev !== sha256(prevLine)) {
        breaks.push({ index: i, reason: 'prev-hash does not match the preceding record — that record was altered' })
      }
    }
    chained++
    prevSeq = rec.seq
    prevLine = raw
  }
  return { ok: breaks.length === 0, total: lines.length, chained, legacy, breaks }
}

function readTrail(dir) {
  const files = []
  if (existsSync(dir)) {
    const archives = readdirSync(dir)
      .filter((f) => /^audit-\d+\.log$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    files.push(...archives.map((f) => join(dir, f)))
    // Legacy single-generation archive from before generational rotation shipped.
    if (existsSync(join(dir, 'audit.old.log'))) files.splice(0, 0, join(dir, 'audit.old.log'))
    if (existsSync(join(dir, 'audit.log'))) files.push(join(dir, 'audit.log'))
  }
  const lines = []
  for (const f of files) {
    // electron-log writes CRLF on Windows; the writer hashed the logical line without it.
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      const clean = l.replace(/\r$/, '')
      if (clean.length) lines.push(clean)
    }
  }
  return { files, lines }
}

// CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('verify-audit-log.mjs')) {
  const dir = process.argv[2] ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'asktoto', 'logs')
  const { files, lines } = readTrail(dir)
  if (!lines.length) {
    console.error(`[verify-audit-log] no audit data under ${dir}`)
    process.exit(2)
  }
  const r = verifyAuditLines(lines)
  console.log(`[verify-audit-log] ${files.length} file(s), ${r.total} records — ${r.chained} chained, ${r.legacy} legacy (pre-chain)`)
  if (r.ok) {
    console.log('[verify-audit-log] OK — hash chain unbroken across the retained trail')
    process.exit(0)
  }
  for (const b of r.breaks.slice(0, 10)) console.log(`[verify-audit-log] BREAK at record ${b.index + 1}: ${b.reason}`)
  if (r.breaks.length > 10) console.log(`[verify-audit-log] ... and ${r.breaks.length - 10} more`)
  process.exit(1)
}
