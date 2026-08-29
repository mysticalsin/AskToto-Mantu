#!/usr/bin/env node
/**
 * Build the pure SwiftUI Métis Mac app (native-app/) into
 *   release/Metis-Native-<version>.zip
 *
 * This is NOT the Electron DMG. It is the Apple-Intelligence-native product in
 * native-app/ (MetisKit + SwiftUI shell). Requires macOS + Xcode + xcodegen.
 *
 * Usage:
 *   node scripts/build-native-mac.mjs
 *   node scripts/build-native-mac.mjs --out-dir /path/to/release
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NATIVE_ROOT = join(REPO_ROOT, 'native-app')
const PROJECT_YML = join(NATIVE_ROOT, 'project.yml')

function die(message) {
  console.error(`[build-native-mac] FAIL — ${message}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    die(`${cmd} ${args.join(' ')} exited ${result.status}${detail ? `:\n${detail}` : ''}`)
  }
  return (result.stdout || '').trim()
}

function which(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function readVersion() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
}

/** Keep native-app/project.yml MARKETING_VERSION in lockstep with package.json. */
export function syncNativeMarketingVersion(version = readVersion(), projectYmlPath = PROJECT_YML) {
  const before = readFileSync(projectYmlPath, 'utf8')
  if (!/MARKETING_VERSION:\s*"[^"]+"/.test(before)) {
    throw new Error('native-app/project.yml is missing MARKETING_VERSION')
  }
  const after = before.replace(/MARKETING_VERSION:\s*"[^"]+"/, `MARKETING_VERSION: "${version}"`)
  if (after !== before) writeFileSync(projectYmlPath, after)
  return version
}

function parseArgs(argv) {
  let outDir = join(REPO_ROOT, 'release')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') {
      outDir = resolve(argv[++i] || '')
      if (!outDir) die('--out-dir requires a path')
    }
  }
  return { outDir }
}

function findBuiltAppSync(derivedData) {
  const candidates = [
    join(derivedData, 'Build/Products/Release/Metis.app'),
    join(derivedData, 'Build/Products/Release/Métis.app')
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  const releaseDir = join(derivedData, 'Build/Products/Release')
  if (!existsSync(releaseDir)) die(`no Release products at ${releaseDir}`)
  const apps = readdirSync(releaseDir).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1) {
    die(`expected one .app under ${releaseDir}, found: ${apps.join(', ') || '(none)'}`)
  }
  return join(releaseDir, apps[0])
}

export function buildNativeMac({ outDir = join(REPO_ROOT, 'release'), version = readVersion() } = {}) {
  if (process.platform !== 'darwin') {
    die('the pure Mac native app can only be built on macOS (needs Xcode + xcodegen)')
  }
  if (!existsSync(NATIVE_ROOT)) die(`missing ${NATIVE_ROOT}`)
  if (!existsSync(PROJECT_YML)) die(`missing ${PROJECT_YML}`)
  if (!which('xcodegen')) die('xcodegen not found — install with: brew install xcodegen')
  if (!which('xcodebuild')) {
    die(
      'xcodebuild not found — install Xcode and run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer'
    )
  }
  if (!which('ditto')) die('ditto not found (required to zip the .app while preserving signatures)')

  syncNativeMarketingVersion(version)
  mkdirSync(outDir, { recursive: true })

  const derivedData = mkdtempSync(join(tmpdir(), 'metis-native-dd-'))
  const stage = mkdtempSync(join(tmpdir(), 'metis-native-stage-'))
  try {
    console.log(`[build-native-mac] sync version ${version}`)
    console.log('[build-native-mac] xcodegen generate')
    run('xcodegen', ['generate'], { cwd: NATIVE_ROOT })

    const project = join(NATIVE_ROOT, 'Metis.xcodeproj')
    if (!existsSync(project)) die(`xcodegen did not produce ${project}`)

    console.log('[build-native-mac] xcodebuild Release (macOS)')
    // generic/platform=macOS builds a runnable .app without needing a live Mac destination UUID.
    run(
      'xcodebuild',
      [
        '-project',
        project,
        '-scheme',
        'Metis',
        '-configuration',
        'Release',
        '-destination',
        'generic/platform=macOS',
        '-derivedDataPath',
        derivedData,
        'CODE_SIGN_IDENTITY=-',
        'CODE_SIGNING_ALLOWED=YES',
        'CODE_SIGNING_REQUIRED=NO',
        'ONLY_ACTIVE_ARCH=NO',
        'build'
      ],
      { cwd: NATIVE_ROOT }
    )

    const appPath = findBuiltAppSync(derivedData)
    console.log(`[build-native-mac] built ${appPath}`)

    // Stage as Metis.app (ASCII) so the zip always has a stable top-level name.
    const stagedApp = join(stage, 'Metis.app')
    cpSync(appPath, stagedApp, { recursive: true })

    const zipName = `Metis-Native-${version}.zip`
    const zipPath = join(outDir, zipName)
    if (existsSync(zipPath)) rmSync(zipPath)

    // ditto preserves code signature / xattrs better than `zip` for .app bundles.
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, zipPath])
    const size = readFileSync(zipPath).byteLength
    console.log(`[build-native-mac] wrote ${zipPath} (${size} bytes)`)
    return { zipPath, version, size }
  } finally {
    rmSync(derivedData, { recursive: true, force: true })
    rmSync(stage, { recursive: true, force: true })
  }
}

function main() {
  const { outDir } = parseArgs(process.argv.slice(2))
  buildNativeMac({ outDir })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main()
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }
}
