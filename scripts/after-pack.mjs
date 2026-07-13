// electron-builder afterPack hook (runs after packing, BEFORE signing).
//
// This repo lives inside OneDrive (CloudStorage), which stamps com.apple.FinderInfo / resource-fork
// extended attributes on files. Anything copied into the .app (extraResources: bundled ASR models,
// ort runtime; build icons) carries them along, and codesign then rejects the bundle with
// "resource fork, Finder information, or similar detritus not allowed". Strip all xattrs from the
// packed output before the signing step. No-op on Windows/Linux and harmless on clean checkouts (CI).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPTS_DIR, '..')

const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal'
}

export default async function afterPack(context) {
  const arch = ARCH_NAMES[context.arch]
  // electron-builder reports 'mas' / 'mas-dev' (Mac App Store) as well as 'darwin' for mac targets —
  // all three ship the same .app layout and the same darwin-* ffmpeg sidecar.
  const isMac = context.electronPlatformName === 'darwin' || context.electronPlatformName.startsWith('mas')
  const isWin = context.electronPlatformName === 'win32'
  if (!isMac && !isWin) {
    throw new Error(`Métis packaging supports macOS and Windows only, got ${context.electronPlatformName}`)
  }
  const targetDir = `${isMac ? 'darwin' : context.electronPlatformName}-${arch}`
  // Derive the bundle name from the packager instead of hardcoding it — survives productName changes.
  const resourceDir = isMac
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const sidecarDir = join(resourceDir, 'ffmpeg')
  const binary = context.electronPlatformName === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const targetBinary = join(sidecarDir, targetDir, binary)

  if (!arch || !existsSync(targetBinary)) {
    throw new Error(`Missing reviewed FFmpeg sidecar for ${targetDir}: ${targetBinary}`)
  }
  for (const entry of readdirSync(sidecarDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== targetDir) rmSync(join(sidecarDir, entry.name), { recursive: true, force: true })
  }
  for (const entry of readdirSync(join(sidecarDir, targetDir), { withFileTypes: true })) {
    if (entry.name !== binary) rmSync(join(sidecarDir, targetDir, entry.name), { recursive: true, force: true })
  }

  // npm can retain optional native packages for multiple platforms in a reused checkout. Keep only
  // the reviewed target addon so a cross-build cannot silently ship an unused foreign executable.
  const unpackedModules = join(resourceDir, 'app.asar.unpacked', 'node_modules')
  const targetSherpa = `sherpa-onnx-${isMac ? 'darwin' : 'win'}-${arch}`
  if (existsSync(unpackedModules)) {
    for (const entry of readdirSync(unpackedModules, { withFileTypes: true })) {
      if (
        entry.name.startsWith('sherpa-onnx-') &&
        entry.name !== 'sherpa-onnx-node' &&
        entry.name !== targetSherpa
      ) {
        rmSync(join(unpackedModules, entry.name), { recursive: true, force: true })
      }
    }
  }

  if (isMac) {
    console.log(`  • afterPack: stripping xattrs (OneDrive detritus) from ${context.appOutDir}`)
    execFileSync('xattr', ['-cr', context.appOutDir], { stdio: 'inherit' })
  }

  // This is the only point where the final unpacked resource tree exists but platform signing has not
  // yet changed Mach-O/PE bytes. Verify every reviewed native payload now; the later CLI invocation uses
  // --post-sign and verifies inventory, immutable assets, architecture, and signatures instead.
  execFileSync(
    process.execPath,
    [join(SCRIPTS_DIR, 'check-packaged-runtime.mjs'), isMac ? 'mac' : 'win', resourceDir],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  )

  // A local/CI macOS build intentionally has no Developer ID. Give it a complete ad-hoc signature
  // after the raw byte gate so the DMG/ZIP contains a coherently sealed, launchable app. Tagged
  // customer releases leave this unset and electron-builder performs real signing/notarization next.
  if (isMac && process.env.ASKTOTO_ADHOC_SIGN === '1') {
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    console.log(`  • afterPack: applying complete ad-hoc signature to ${app}`)
    execFileSync(
      'codesign',
      [
        '--force',
        '--deep',
        '--sign',
        '-',
        '--timestamp=none',
        '--options',
        'runtime',
        '--entitlements',
        join(REPO_ROOT, 'build', 'entitlements.mac.plist'),
        app
      ],
      { stdio: 'inherit' }
    )
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
      stdio: 'inherit'
    })
  }
}
