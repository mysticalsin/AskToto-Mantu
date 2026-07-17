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
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'native', 'mac-helper', 'main.swift')
const outDir = join(repoRoot, 'resources', 'mac-helper')
const outBinary = join(outDir, 'metis-mac-helper')

if (process.platform !== 'darwin') {
  console.log('[build-mac-helper] non-darwin host — skipped (mac-only sidecar)')
  process.exit(0)
}

if (!existsSync(source)) {
  console.error(`[build-mac-helper] missing Swift source at ${source}`)
  process.exit(1)
}

if (existsSync(outBinary) && statSync(outBinary).mtimeMs >= statSync(source).mtimeMs) {
  console.log('[build-mac-helper] binary is up to date — skipped')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
console.log('[build-mac-helper] compiling metis-mac-helper (swiftc -O)…')
try {
  // Explicit deployment target (review finding): without it swiftc stamps the BUILD machine's OS as the
  // binary's minimum — built on a macOS 27 beta box, dyld on a macOS 26 user machine would refuse to
  // load the helper and silently degrade screen context. Vision text recognition + NSWorkspace need
  // nothing newer than macOS 13.
  execFileSync('xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos13.0', '-o', outBinary, source], {
    stdio: 'inherit'
  })
} catch (err) {
  console.error(
    '[build-mac-helper] swiftc failed. Xcode (or the Command Line Tools) with a Swift toolchain is ' +
      'required on mac build machines. Original error:',
    err?.message ?? err
  )
  process.exit(1)
}
console.log(`[build-mac-helper] built ${outBinary}`)
