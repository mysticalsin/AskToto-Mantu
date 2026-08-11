#!/usr/bin/env node
// Compile the metis-mac-helper Swift sidecar (native/mac-helper/main.swift → resources/mac-helper/).
// Runs in every mac packaging chain BEFORE electron-builder (see package.json predist/dist:local/
// release:build:mac/release:mas); check-mac-helper.mjs then hard-fails the build if the binary is
// missing. Non-darwin hosts skip cleanly — the helper is mac-only by definition and Windows packaging
// chains never call this script.
//
// Incremental: recompiles only when the source is newer than the existing binary, so repeat packaging
// runs don't pay the swiftc startup. Signing needs no extra step here — electron-builder's
// hardenedRuntime pass signs every executable found inside the packed .app (same mechanism as the
// llama-server and ffmpeg sidecars).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'native', 'mac-helper', 'main.swift')
const outDir = join(repoRoot, 'resources', 'mac-helper')
const outBinary = join(outDir, 'metis-mac-helper')

// The mac package is universal, so this sidecar has to carry both slices: the helper is spawned by the
// main process, and an arm64-only helper is simply not executable on an Intel Mac — screen context
// would silently degrade there with nothing failing at build time.
const TARGETS = [
  { arch: 'arm64', triple: 'arm64-apple-macos13.0' },
  { arch: 'x86_64', triple: 'x86_64-apple-macos13.0' }
]

/** Architectures actually present in a Mach-O file, or [] if it cannot be read. */
function archesOf(file) {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/)
  } catch {
    return []
  }
}

if (process.platform !== 'darwin') {
  console.log('[build-mac-helper] non-darwin host — skipped (mac-only sidecar)')
  process.exit(0)
}

if (!existsSync(source)) {
  console.error(`[build-mac-helper] missing Swift source at ${source}`)
  process.exit(1)
}

// The freshness check tests the SLICES as well as the timestamp. Before this script went universal it
// emitted an arm64-only binary, and that leftover is newer than an unchanged main.swift — so an mtime
// test alone would skip the rebuild and quietly ship a helper that cannot run on Intel.
const wanted = TARGETS.map((t) => t.arch)
const existing = existsSync(outBinary) ? archesOf(outBinary) : []
const hasAllSlices = wanted.every((a) => existing.includes(a))
if (hasAllSlices && statSync(outBinary).mtimeMs >= statSync(source).mtimeMs) {
  console.log(`[build-mac-helper] universal binary is up to date (${existing.join(', ')}) — skipped`)
  process.exit(0)
}
if (existsSync(outBinary) && !hasAllSlices) {
  console.log(`[build-mac-helper] existing binary is ${existing.join(', ') || 'unreadable'} — rebuilding universal`)
}

mkdirSync(outDir, { recursive: true })
const slicePaths = TARGETS.map((t) => join(outDir, `.metis-mac-helper.${t.arch}`))
try {
  for (const [i, target] of TARGETS.entries()) {
    console.log(`[build-mac-helper] compiling metis-mac-helper for ${target.arch} (swiftc -O)…`)
    // Explicit deployment target (review finding): without it swiftc stamps the BUILD machine's OS as the
    // binary's minimum — built on a macOS 27 beta box, dyld on a macOS 26 user machine would refuse to
    // load the helper and silently degrade screen context. Vision text recognition + NSWorkspace need
    // nothing newer than macOS 13.
    execFileSync('xcrun', ['swiftc', '-O', '-target', target.triple, '-o', slicePaths[i], source], {
      stdio: 'inherit'
    })
  }
  // swiftc cannot emit a fat binary directly, so build each slice and merge. lipo is the same tool
  // electron-builder's universal target uses for the app itself.
  console.log('[build-mac-helper] merging slices with lipo…')
  execFileSync('lipo', ['-create', ...slicePaths, '-output', outBinary], { stdio: 'inherit' })
} catch (err) {
  console.error(
    '[build-mac-helper] swiftc failed. Xcode (or the Command Line Tools) with a Swift toolchain is ' +
      'required on mac build machines. Original error:',
    err?.message ?? err
  )
  process.exit(1)
} finally {
  for (const p of slicePaths) rmSync(p, { force: true })
}

// Prove the merge produced what was asked for rather than reporting success on lipo's exit code alone.
const built = archesOf(outBinary)
const missing = wanted.filter((a) => !built.includes(a))
if (missing.length) {
  console.error(
    `[build-mac-helper] built binary is missing ${missing.join(', ')} (got: ${built.join(', ') || 'nothing readable'}).`
  )
  process.exit(1)
}
console.log(`[build-mac-helper] built ${outBinary} (${built.join(', ')})`)
