#!/usr/bin/env node
// Guard: the metis-mac-helper sidecar must exist (and be executable) before a mac package is built —
// a mac build without it silently ships a degraded product (no event-driven screen context, no Vision
// OCR). Mirrors check-llama-sidecar.mjs: loud exit 1 with the fix, no partial pass.
// Usage: node scripts/check-mac-helper.mjs <mac|win>   (win exits 0 — the helper is mac-only)
import { accessSync, constants, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Both slices, because the mac package is universal: an arm64-only helper is not executable on an
// Intel Mac, and the failure is invisible until a user there gets no screen context at all.
const REQUIRED_ARCHES = ['arm64', 'x86_64']

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
const artifacts = [
  join(repoRoot, 'resources', 'mac-helper', 'metis-mac-helper'),
  join(repoRoot, 'resources', 'mac-helper', 'libmetis-noconstrain.dylib'),
  join(repoRoot, 'resources', 'mac-helper', 'metis-noconstrain.node')
]

function assertUniversal(binary) {
  if (!existsSync(binary)) {
    console.error(
      `Missing mac helper artifact at ${binary}.\n` +
        'Run: node scripts/build-mac-helper.mjs (requires Xcode / Swift toolchain on the mac build machine).'
    )
    process.exit(1)
  }
  try {
    accessSync(binary, constants.R_OK)
  } catch {
    console.error(`mac helper artifact at ${binary} is not readable — rebuild it: node scripts/build-mac-helper.mjs`)
    process.exit(1)
  }
  let arches = []
  try {
    arches = execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }).trim().split(/\s+/)
  } catch (err) {
    console.error(`could not read the architectures of ${binary}: ${err?.message ?? err}`)
    process.exit(1)
  }
  const missing = REQUIRED_ARCHES.filter((a) => !arches.includes(a))
  if (missing.length) {
    console.error(
      `mac helper artifact at ${binary} is missing the ${missing.join(', ')} slice (has: ${arches.join(', ')}).\n` +
        'The mac package is universal, so a single-arch helper ships a product that silently loses Hide park Y=0 ' +
        'or screen context on every Mac of the other architecture.\n' +
        'Rebuild it: node scripts/build-mac-helper.mjs'
    )
    process.exit(1)
  }
  return arches
}

const helper = artifacts[0]
try {
  accessSync(helper, constants.X_OK)
} catch {
  if (existsSync(helper)) {
    console.error(`mac helper sidecar at ${helper} is not executable — rebuild it: node scripts/build-mac-helper.mjs`)
    process.exit(1)
  }
}

const arches = artifacts.map((p) => assertUniversal(p))
console.log(`[check-mac-helper] ok helper=${arches[0].join(', ')} noconstrain=${arches[1].join(', ')}`)
