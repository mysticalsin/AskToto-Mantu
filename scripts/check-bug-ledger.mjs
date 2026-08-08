#!/usr/bin/env node
// Anti-regression gate for docs/qa/BUG-LEDGER.md.
//
// Why this exists: a bug list that is only prose rots. Someone fixes MQA-007, six weeks later a
// refactor quietly reintroduces it, and nothing fails — the ledger still cheerfully says "FIXED".
// This gate makes the ledger mechanical instead of aspirational: every entry marked FIXED must name a
// regression test that (a) exists on disk and (b) literally contains the bug id. Re-breaking the bug
// then fails a test whose name points straight back at the ledger entry explaining what went wrong the
// first time, so the same mistake cannot be made twice silently.
//
// It also enforces the hygiene that keeps the ledger usable at all: unique ids, no gaps that hint at a
// deleted-instead-of-resolved entry, a real status, and a repro for anything still OPEN.
//
// Run: `node scripts/check-bug-ledger.mjs` (wired as `npm run check:bugs`). Exits non-zero on any
// violation, so it can gate CI and the release chain. Dependency-free by design — it parses the
// ledger's fixed table shape as text.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(repoRoot, 'docs', 'qa', 'BUG-LEDGER.md')
const VALID_STATUS = new Set(['OPEN', 'FIXED', 'WONTFIX', 'ACCEPTED', 'DUPLICATE'])
const ID_RE = /^MQA-(\d{3})$/

const problems = []
const warn = []

if (!existsSync(LEDGER)) {
  console.error(`[check:bugs] FAIL — ledger missing: ${LEDGER}`)
  process.exit(1)
}

const text = readFileSync(LEDGER, 'utf8')

// Entries are markdown table rows: | MQA-001 | title | workflow | severity | status | test | notes |
const rows = text
  .split(/\r?\n/)
  .filter((line) => /^\|\s*MQA-\d{3}\s*\|/.test(line))
  .map((line, i) => {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    return { line, lineNo: i, cells }
  })

if (!rows.length) {
  console.error('[check:bugs] FAIL — no MQA-### rows found. Either the ledger is empty or its table shape changed.')
  process.exit(1)
}

const COL = { id: 0, title: 1, workflow: 2, severity: 3, status: 4, test: 5 }
const seenIds = new Map()
const seenTitles = new Map()
const numbers = []

for (const row of rows) {
  const { cells } = row
  const id = cells[COL.id] ?? ''
  const title = cells[COL.title] ?? ''
  const status = (cells[COL.status] ?? '').toUpperCase()
  const testCell = cells[COL.test] ?? ''

  if (cells.length < 6) {
    problems.push(`${id || row.line.slice(0, 40)}: row has ${cells.length} columns, expected at least 6 (id|title|workflow|severity|status|test).`)
    continue
  }

  const m = ID_RE.exec(id)
  if (!m) {
    problems.push(`"${id}" is not a well-formed id (expected MQA-### with three digits).`)
    continue
  }
  numbers.push(Number(m[1]))

  if (seenIds.has(id)) problems.push(`${id} is used more than once — ids must be unique and never reused.`)
  seenIds.set(id, true)

  const titleKey = title.toLowerCase().replace(/\s+/g, ' ').trim()
  if (titleKey && seenTitles.has(titleKey)) {
    problems.push(`${id} duplicates the title of ${seenTitles.get(titleKey)} — mark one DUPLICATE instead of tracking it twice.`)
  } else if (titleKey) {
    seenTitles.set(titleKey, id)
  }

  if (!VALID_STATUS.has(status)) {
    problems.push(`${id}: status "${cells[COL.status]}" is not one of ${[...VALID_STATUS].join(', ')}.`)
    continue
  }

  if (status === 'FIXED') {
    // The load-bearing rule. A fix with no test that names the bug is a fix that can silently rot.
    const paths = testCell
      .split(/[,\s]+/)
      .map((p) => p.replace(/[`()]/g, '').trim())
      .filter((p) => /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/.test(p))

    if (!paths.length) {
      problems.push(`${id} is FIXED but names no regression test. A fix without a test that cites ${id} can regress silently — that is exactly what this ledger exists to prevent.`)
      continue
    }
    for (const rel of paths) {
      const abs = join(repoRoot, rel)
      if (!existsSync(abs)) {
        problems.push(`${id}: regression test "${rel}" does not exist on disk.`)
        continue
      }
      const body = readFileSync(abs, 'utf8')
      if (!body.includes(id)) {
        problems.push(`${id}: "${rel}" exists but never mentions ${id}. Cite the bug id in the test name or a comment so a future failure points back to this ledger entry.`)
      }
    }
  }

  if (status === 'OPEN') {
    const repro = (cells[COL.repro] ?? '').trim()
    if (!repro && !text.includes(`### ${id}`)) {
      warn.push(`${id} is OPEN with no repro cell and no "### ${id}" detail section — it will be hard for anyone else to act on.`)
    }
  }
}

// A hole in the numbering usually means an entry was deleted rather than resolved. Deleting loses the
// institutional memory the ledger exists to hold, so surface it (as a warning — a hole can be legitimate
// if two people claimed ids concurrently).
const sorted = [...new Set(numbers)].sort((a, b) => a - b)
for (let i = 1; i < sorted.length; i++) {
  if (sorted[i] !== sorted[i - 1] + 1) {
    const missing = []
    for (let n = sorted[i - 1] + 1; n < sorted[i]; n++) missing.push(`MQA-${String(n).padStart(3, '0')}`)
    warn.push(`gap in ids: ${missing.join(', ')} — if those were resolved, mark them WONTFIX/DUPLICATE instead of deleting the row.`)
  }
}

const fixedCount = rows.filter((r) => (r.cells[COL.status] ?? '').toUpperCase() === 'FIXED').length
const openCount = rows.filter((r) => (r.cells[COL.status] ?? '').toUpperCase() === 'OPEN').length

for (const w of warn) console.warn(`[check:bugs] warn — ${w}`)

if (problems.length) {
  console.error(`[check:bugs] FAIL — ${problems.length} problem(s) in docs/qa/BUG-LEDGER.md:`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`[check:bugs] OK — ${rows.length} tracked (${fixedCount} FIXED each pinned by a regression test that cites its id, ${openCount} OPEN).`)
