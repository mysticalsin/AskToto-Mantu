#!/usr/bin/env node
/**
 * Mark ledger rows FIXED and attach their regression tests.
 *
 * Hand-editing docs/qa/BUG-LEDGER.md rows is error-prone once there are ~100 of them — a shifted cell
 * silently breaks scripts/check-bug-ledger.mjs's column parsing, and a typo'd test path passes the row
 * but fails the gate later for a confusing reason. This does the edit by column index and then leaves
 * verification to the gate itself.
 *
 * Usage:
 *   node scripts/qa/mark-fixed.mjs MQA-042=src/main/foo.test.ts MQA-043=src/a.test.ts,src/b.test.ts
 *   node scripts/qa/mark-fixed.mjs --json '{"MQA-042":["src/main/foo.test.ts"]}'
 *
 * Always run `npm run check:bugs` afterwards — this script deliberately does not validate that the
 * named test exists or cites the id; that is the gate's job, and duplicating it here would let the two
 * drift apart.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LEDGER = join(repoRoot, 'docs', 'qa', 'BUG-LEDGER.md')

const args = process.argv.slice(2)
if (!args.length) {
  console.error('usage: mark-fixed.mjs MQA-0NN=path/to.test.ts [MQA-0MM=a.test.ts,b.test.ts ...]')
  console.error('   or: mark-fixed.mjs --json \'{"MQA-0NN":["path/to.test.ts"]}\'')
  process.exit(2)
}

/** @type {Record<string, string[]>} */
const map = {}
if (args[0] === '--json') {
  const parsed = JSON.parse(args[1] ?? '{}')
  for (const [id, tests] of Object.entries(parsed)) map[id] = Array.isArray(tests) ? tests : [tests]
} else {
  for (const arg of args) {
    const [id, tests] = arg.split('=')
    if (!id || !tests) {
      console.error(`skipping malformed argument: ${arg}`)
      continue
    }
    map[id] = tests.split(',').map((t) => t.trim()).filter(Boolean)
  }
}

const lines = readFileSync(LEDGER, 'utf8').split(/\r?\n/)
const COL = { id: 1, status: 5, test: 6 } // cells[0] is the empty string before the leading pipe
const updated = []
const missing = new Set(Object.keys(map))

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!line.startsWith('| MQA-')) continue
  const cells = line.split('|')
  const id = (cells[COL.id] ?? '').trim()
  const tests = map[id]
  if (!tests) continue
  missing.delete(id)
  cells[COL.status] = ' FIXED '
  cells[COL.test] = ' ' + tests.map((t) => '`' + t + '`').join(', ') + ' '
  lines[i] = cells.join('|')
  updated.push(id)
}

writeFileSync(LEDGER, lines.join('\n'))

console.log(`marked FIXED: ${updated.length} (${updated.join(', ') || 'none'})`)
if (missing.size) {
  console.error(`NOT FOUND in the ledger: ${[...missing].join(', ')}`)
  process.exit(1)
}
console.log('now run: npm run check:bugs')
