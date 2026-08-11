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
  // Which architectures this package is allowed to carry. Normally just the one being packed — the
  // pruning below then strips any foreign native payload a reused checkout left behind.
  //
  // A universal mac build is different, and the difference is not optional: @electron/universal aborts
  // the lipo merge if any Mach-O exists in one sub-build and not the other, with no opt-out for files
  // outside the asar. So each sub-build (and the merged result) must carry BOTH arches of the Sherpa
  // addon and the FFmpeg sidecar. Pruning to context.arch there would delete exactly the files the
  // merge is about to compare, which is what the "number of mach-o files is not the same" abort was.
  // The mac chains in package.json set ASKTOTO_MAC_ARCHES=arm64,x64; without it nothing changes.
  const declaredArches = (process.env.ASKTOTO_MAC_ARCHES ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
  const packagedArches =
    isMac && declaredArches.length ? declaredArches : arch === 'universal' ? ['arm64', 'x64'] : [arch]
  const targetDirs = packagedArches.map((a) => `${isMac ? 'darwin' : context.electronPlatformName}-${a}`)
  // Derive the bundle name from the packager instead of hardcoding it — survives productName changes.
  const resourceDir = isMac
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const sidecarDir = join(resourceDir, 'ffmpeg')
  const binary = context.electronPlatformName === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  if (!arch) throw new Error('afterPack could not resolve the packaging architecture')
  for (const targetDir of targetDirs) {
    const targetBinary = join(sidecarDir, targetDir, binary)
    if (!existsSync(targetBinary)) {
      throw new Error(`Missing reviewed FFmpeg sidecar for ${targetDir}: ${targetBinary}`)
    }
  }
  for (const entry of readdirSync(sidecarDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !targetDirs.includes(entry.name)) {
      rmSync(join(sidecarDir, entry.name), { recursive: true, force: true })
    }
  }
  for (const targetDir of targetDirs) {
    for (const entry of readdirSync(join(sidecarDir, targetDir), { withFileTypes: true })) {
      if (entry.name !== binary) rmSync(join(sidecarDir, targetDir, entry.name), { recursive: true, force: true })
    }
  }

  // npm can retain optional native packages for multiple platforms in a reused checkout. Keep only
  // the reviewed target addon so a cross-build cannot silently ship an unused foreign executable.
  const unpackedModules = join(resourceDir, 'app.asar.unpacked', 'node_modules')
  const targetSherpas = packagedArches.map((a) => `sherpa-onnx-${isMac ? 'darwin' : 'win'}-${a}`)
  if (existsSync(unpackedModules)) {
    for (const entry of readdirSync(unpackedModules, { withFileTypes: true })) {
      if (
        entry.name.startsWith('sherpa-onnx-') &&
        entry.name !== 'sherpa-onnx-node' &&
        !targetSherpas.includes(entry.name)
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
  const runtimeCheckArgs = [
    join(SCRIPTS_DIR, 'check-packaged-runtime.mjs'),
    isMac ? 'mac' : 'win',
    resourceDir
  ]
  // electron-builder derives the Windows executable from appInfo.productFilename, which may differ from
  // the standard Metis.exe in an edition-specific config. Pass that same resolved filename into the
  // verifier so afterPack checks the binary electron-builder actually produced.
  if (isWin) runtimeCheckArgs.push(`--executable=${context.packager.appInfo.productFilename}.exe`)
  // Verify exactly the architectures this package is meant to carry — the same set the pruning above
  // enforced, so the guard and the pruning can never disagree about what "correct" means.
  if (isMac) {
    runtimeCheckArgs.push(`--arches=${packagedArches.join(',')}`)
    // The bundle executable is still thin in each sub-build and only becomes fat after the lipo merge,
    // so this tracks context.arch rather than the payload arch set.
    runtimeCheckArgs.push(`--macho-arches=${arch === 'universal' ? 'arm64,x64' : arch}`)
  }
  execFileSync(
    process.execPath,
    runtimeCheckArgs,
    { cwd: REPO_ROOT, stdio: 'inherit' }
  )

  // A local/CI macOS build intentionally has no Developer ID. Give it a complete ad-hoc signature
  // after the raw byte gate so the DMG/ZIP contains a coherently sealed, launchable app. Tagged
  // customer releases leave this unset and electron-builder performs real signing/notarization next.
  //
  // On a universal build this MUST wait for the merged bundle. Signing each arch sub-build rewrites
  // the _CodeSignature/CodeResources files inside Electron Framework, and @electron/universal then
  // aborts with "Expected all non-binary files to have identical SHAs" because the two halves no
  // longer match. Sign once, after lipo, when the bundle is actually final.
  const isUniversalSubBuild = isMac && packagedArches.length > 1 && arch !== 'universal'
  if (isUniversalSubBuild && process.env.ASKTOTO_ADHOC_SIGN === '1') {
    console.log(`  • afterPack: deferring ad-hoc signature to the merged universal bundle (${arch} sub-build)`)
  }
  if (isMac && !isUniversalSubBuild && process.env.ASKTOTO_ADHOC_SIGN === '1') {
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
