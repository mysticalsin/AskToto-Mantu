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
import { checkNodeLlamaPackage } from './check-node-llama-package.mjs'

const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal'
}

export function resolveAfterPackTarget(context) {
  const arch = ARCH_NAMES[context.arch]
  const electronPlatform = context.electronPlatformName

  if (electronPlatform === 'mas' || electronPlatform === 'mas-dev') {
    if (arch !== 'arm64') {
      throw new Error(`Unsupported MAS package target: ${electronPlatform}-${arch ?? 'unknown'}`)
    }
    return { kind: 'mas', isMac: true, targetDir: 'darwin-arm64' }
  }
  if (electronPlatform === 'darwin' && arch === 'arm64') {
    return { kind: 'direct', isMac: true, platform: 'darwin-arm64', targetDir: 'darwin-arm64' }
  }
  if (electronPlatform === 'win32' && arch === 'x64') {
    return { kind: 'direct', isMac: false, platform: 'win32-x64', targetDir: 'win32-x64' }
  }
  throw new Error(`Unsupported direct package target: ${electronPlatform}-${arch ?? 'unknown'}`)
}

const DEFAULT_DEPENDENCIES = {
  existsSync,
  readdirSync,
  rmSync,
  execFileSync,
  checkNodeLlamaPackage
}

export default async function afterPack(context, overrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const target = resolveAfterPackTarget(context)
  // Derive the bundle name from the packager instead of hardcoding it — survives productName changes.
  const resourceDir = target.isMac
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const sidecarDir = join(resourceDir, 'ffmpeg')
  const binary = context.electronPlatformName === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const targetBinary = join(sidecarDir, target.targetDir, binary)

  if (!dependencies.existsSync(targetBinary)) {
    throw new Error(`Missing reviewed FFmpeg sidecar for ${target.targetDir}: ${targetBinary}`)
  }
  for (const entry of dependencies.readdirSync(sidecarDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== target.targetDir) {
      dependencies.rmSync(join(sidecarDir, entry.name), { recursive: true, force: true })
    }
  }

  if (target.kind === 'mas') {
    // The first local tier is direct-distribution only. App Sandbox/RUN_AS_NODE is not approved here.
    dependencies.rmSync(join(resourceDir, 'local-ai'), { recursive: true, force: true })
    dependencies.rmSync(join(resourceDir, 'app.asar.unpacked', 'node_modules', '@node-llama-cpp'), {
      recursive: true,
      force: true
    })
  } else {
    const appRoot = target.isMac
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : context.appOutDir
    await dependencies.checkNodeLlamaPackage({
      app: appRoot,
      platform: target.platform,
      allowEvaluation: process.env.METIS_ALLOW_EVALUATION_PAYLOAD === '1'
    })
    console.log(`  • afterPack: verified packaged local AI for ${target.platform}`)
  }

  if (target.isMac) {
    console.log(`  • afterPack: stripping xattrs (OneDrive detritus) from ${context.appOutDir}`)
    dependencies.execFileSync('xattr', ['-cr', context.appOutDir], { stdio: 'inherit' })
  }
}
