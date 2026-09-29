#!/usr/bin/env node
// check-no-dev-tooling.mjs — packaging gate for ADR-025: developer graph tooling must never ship in the
// product. Walks a packaged output directory (never following symlinks) and fails when it contains
// graphify, code-review-graph or a bundled Python interpreter, other than the allowlisted runner script.
//
// Usage: node scripts/check-no-dev-tooling.mjs <package-directory>

import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { findDevTooling } from './lib/dev-tooling-paths.mjs'

const target = process.argv[2]
if (!target) throw new Error('Usage: node scripts/check-no-dev-tooling.mjs <package-directory>')
const root = resolve(target)
if (!existsSync(root)) throw new Error(`[check:no-dev-tooling] no such directory: ${root}`)

function listEntries(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    out.push(relative(root, full))
    if (entry.isDirectory()) out.push(...listEntries(full))
  }
  return out
}

const findings = findDevTooling(listEntries(root))
if (findings.length > 0) {
  for (const { path, reason } of findings) console.error(`[check:no-dev-tooling] ${reason}: ${path}`)
  console.error(`[check:no-dev-tooling] FAIL — ${findings.length} developer-tooling path(s) in the package (ADR-025).`)
  process.exit(1)
}
console.log(`[check:no-dev-tooling] OK — no graphify, code-review-graph or bundled Python in ${root}`)
