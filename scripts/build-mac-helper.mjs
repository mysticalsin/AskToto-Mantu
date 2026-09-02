#!/usr/bin/env node
// Compile mac sidecars (native/mac-helper → resources/mac-helper/):
//   metis-mac-helper              Swift (watch-frontmost / ocr / transcribe / screen-metrics)
//   libmetis-noconstrain.dylib    constructor swizzle (DYLD_INSERT, show-tree / adhoc only)
//   metis-noconstrain.node        N-API Init() swizzle (packaged hardened-runtime, required in-process)
//
// Runs in every mac packaging chain BEFORE electron-builder (see package.json predist/dist:local/
// release:build:mac/release:mas); check-mac-helper.mjs then hard-fails the build if a product is
// missing. Non-darwin hosts skip cleanly — these artifacts are mac-only.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const helperSource = join(repoRoot, 'native', 'mac-helper', 'main.swift')
const noconstrainSource = join(repoRoot, 'native', 'mac-helper', 'metis-noconstrain.m')
const outDir = join(repoRoot, 'resources', 'mac-helper')
const helperOut = join(outDir, 'metis-mac-helper')
const dylibOut = join(outDir, 'libmetis-noconstrain.dylib')
const nodeOut = join(outDir, 'metis-noconstrain.node')

const TARGETS = [
  { arch: 'arm64', triple: 'arm64-apple-macos13.0', clangArch: 'arm64' },
  { arch: 'x86_64', triple: 'x86_64-apple-macos13.0', clangArch: 'x86_64' }
]

function archesOf(file) {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/)
  } catch {
    return []
  }
}

function needsRebuild(outFile, sources) {
  if (!existsSync(outFile)) return true
  const existing = archesOf(outFile)
  const wanted = TARGETS.map((t) => t.arch)
  if (!wanted.every((a) => existing.includes(a))) return true
  const outMtime = statSync(outFile).mtimeMs
  return sources.some((s) => existsSync(s) && statSync(s).mtimeMs > outMtime)
}

function nodeIncludeDir() {
  return join(dirname(dirname(process.execPath)), 'include', 'node')
}

if (process.platform !== 'darwin') {
  console.log('[build-mac-helper] non-darwin host — skipped (mac-only sidecar)')
  process.exit(0)
}

if (!existsSync(helperSource)) {
  console.error(`[build-mac-helper] missing Swift source at ${helperSource}`)
  process.exit(1)
}
if (!existsSync(noconstrainSource)) {
  console.error(`[build-mac-helper] missing noconstrain source at ${noconstrainSource}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

function buildHelper() {
  if (!needsRebuild(helperOut, [helperSource])) {
    console.log(`[build-mac-helper] universal binary is up to date (${archesOf(helperOut).join(', ')}) — skipped`)
    return
  }
  const existing = existsSync(helperOut) ? archesOf(helperOut) : []
  if (existing.length && !TARGETS.map((t) => t.arch).every((a) => existing.includes(a))) {
    console.log(`[build-mac-helper] existing binary is ${existing.join(', ') || 'unreadable'} — rebuilding universal`)
  }
  const slicePaths = TARGETS.map((t) => join(outDir, `.metis-mac-helper.${t.arch}`))
  try {
    for (const [i, target] of TARGETS.entries()) {
      console.log(`[build-mac-helper] compiling metis-mac-helper for ${target.arch} (swiftc -O)…`)
      execFileSync('xcrun', ['swiftc', '-O', '-target', target.triple, '-o', slicePaths[i], helperSource], {
        stdio: 'inherit'
      })
    }
    console.log('[build-mac-helper] merging slices with lipo…')
    execFileSync('lipo', ['-create', ...slicePaths, '-output', helperOut], { stdio: 'inherit' })
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
  const built = archesOf(helperOut)
  const missing = TARGETS.map((t) => t.arch).filter((a) => !built.includes(a))
  if (missing.length) {
    console.error(
      `[build-mac-helper] built binary is missing ${missing.join(', ')} (got: ${built.join(', ') || 'nothing readable'}).`
    )
    process.exit(1)
  }
  console.log(`[build-mac-helper] built ${helperOut} (${built.join(', ')})`)
}

function compileNoConstrainSlice(target, outFile, extraArgs) {
  execFileSync(
    'xcrun',
    [
      'clang',
      '-O2',
      '-target',
      target.triple,
      '-arch',
      target.clangArch,
      '-mmacosx-version-min=13.0',
      '-fobjc-arc',
      '-framework',
      'AppKit',
      '-framework',
      'Foundation',
      noconstrainSource,
      '-o',
      outFile,
      ...extraArgs
    ],
    { stdio: 'inherit' }
  )
}

function lipoSlices(slicePaths, outFile, label) {
  execFileSync('lipo', ['-create', ...slicePaths, '-output', outFile], { stdio: 'inherit' })
  const built = archesOf(outFile)
  const missing = TARGETS.map((t) => t.arch).filter((a) => !built.includes(a))
  if (missing.length) {
    console.error(`[build-mac-helper] ${label} is missing ${missing.join(', ')} (got: ${built.join(', ') || 'nothing'})`)
    process.exit(1)
  }
  console.log(`[build-mac-helper] built ${outFile} (${built.join(', ')})`)
}

function buildNoConstrain() {
  const include = nodeIncludeDir()
  if (!existsSync(join(include, 'node_api.h'))) {
    console.error(
      `[build-mac-helper] missing node_api.h at ${include}. Install Node headers (same prefix as this node).`
    )
    process.exit(1)
  }

  if (needsRebuild(dylibOut, [noconstrainSource])) {
    const slices = TARGETS.map((t) => join(outDir, `.libmetis-noconstrain.${t.arch}.dylib`))
    try {
      for (const [i, target] of TARGETS.entries()) {
        console.log(`[build-mac-helper] compiling libmetis-noconstrain.dylib for ${target.arch}…`)
        compileNoConstrainSlice(target, slices[i], ['-dynamiclib', '-install_name', '@rpath/libmetis-noconstrain.dylib'])
      }
      lipoSlices(slices, dylibOut, 'libmetis-noconstrain.dylib')
    } catch (err) {
      console.error('[build-mac-helper] clang failed for libmetis-noconstrain.dylib:', err?.message ?? err)
      process.exit(1)
    } finally {
      for (const p of slices) rmSync(p, { force: true })
    }
  } else {
    console.log(`[build-mac-helper] libmetis-noconstrain.dylib is up to date (${archesOf(dylibOut).join(', ')}) — skipped`)
  }

  if (needsRebuild(nodeOut, [noconstrainSource])) {
    const slices = TARGETS.map((t) => join(outDir, `.metis-noconstrain.${t.arch}.node`))
    try {
      for (const [i, target] of TARGETS.entries()) {
        console.log(`[build-mac-helper] compiling metis-noconstrain.node for ${target.arch}…`)
        compileNoConstrainSlice(target, slices[i], [
          '-bundle',
          '-undefined',
          'dynamic_lookup',
          '-DMETIS_NOCONSTRAIN_NAPI=1',
          '-DNODE_GYP_MODULE_NAME=metis_noconstrain',
          `-I${include}`
        ])
      }
      lipoSlices(slices, nodeOut, 'metis-noconstrain.node')
    } catch (err) {
      console.error('[build-mac-helper] clang failed for metis-noconstrain.node:', err?.message ?? err)
      process.exit(1)
    } finally {
      for (const p of slices) rmSync(p, { force: true })
    }
  } else {
    console.log(`[build-mac-helper] metis-noconstrain.node is up to date (${archesOf(nodeOut).join(', ')}) — skipped`)
  }
}

buildHelper()
buildNoConstrain()
