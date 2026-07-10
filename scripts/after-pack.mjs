// electron-builder afterPack hook (runs after packing, BEFORE signing).
//
// This repo lives inside OneDrive (CloudStorage), which stamps com.apple.FinderInfo / resource-fork
// extended attributes on files. Anything copied into the .app (extraResources: bundled ASR models,
// ort runtime; build icons) carries them along, and codesign then rejects the bundle with
// "resource fork, Finder information, or similar detritus not allowed". Strip all xattrs from the
// packed output before the signing step. No-op on Windows/Linux and harmless on clean checkouts (CI).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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

  if (isMac) {
    console.log(`  • afterPack: stripping xattrs (OneDrive detritus) from ${context.appOutDir}`)
    execFileSync('xattr', ['-cr', context.appOutDir], { stdio: 'inherit' })
  }
}
