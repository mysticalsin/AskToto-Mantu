#!/usr/bin/env node
// Guard: the metis-mac-helper sidecar must exist (and be executable) before a mac package is built —
// a mac build without it silently ships a degraded product (no event-driven screen context, no Vision
// OCR). Mirrors check-llama-sidecar.mjs: loud exit 1 with the fix, no partial pass.
// Usage: node scripts/check-mac-helper.mjs <mac|win>   (win exits 0 — the helper is mac-only)
import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
if (!target || !['mac', 'win'].includes(target)) {
  console.error('usage: node scripts/check-mac-helper.mjs <mac|win>')
  process.exit(1)
}
if (target === 'win') {
  console.log('[check-mac-helper] win target — mac-only sidecar, nothing to check')
  process.exit(0)
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const binary = join(repoRoot, 'resources', 'mac-helper', 'metis-mac-helper')

if (!existsSync(binary)) {
  console.error(
    `Missing mac helper sidecar binary at ${binary}.\n` +
      'Run: node scripts/build-mac-helper.mjs (requires Xcode / Swift toolchain on the mac build machine).'
  )
  process.exit(1)
}
try {
  accessSync(binary, constants.X_OK)
} catch {
  console.error(`mac helper sidecar at ${binary} is not executable — rebuild it: node scripts/build-mac-helper.mjs`)
  process.exit(1)
}
console.log('[check-mac-helper] ok')
