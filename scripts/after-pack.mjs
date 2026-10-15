// electron-builder afterPack hook (runs after packing; BEFORE signing on macOS, AFTER it on Windows).
//
// This repo lives inside OneDrive (CloudStorage), which stamps com.apple.FinderInfo / resource-fork
// extended attributes on files. Anything copied into the .app (extraResources: bundled ASR models,
// ort runtime; build icons) carries them along, and codesign then rejects the bundle with
// "resource fork, Finder information, or similar detritus not allowed". Strip all xattrs from the
// packed output before the signing step. No-op on Windows/Linux and harmless on clean checkouts (CI).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeSync
} from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  electronFactoryArchivePath,
  electronFactoryArchiveMemberPath,
  electronFactoryTemplatePath,
  canonicalPrivateTemporaryRoot,
  captureElectronFactoryTemplate,
  ensureLeanPackageCoreDirectories,
  removeElectronDefaultAppTemplate,
  retainedElectronArchiveSource
} from './lib/lean-package-stage.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPTS_DIR, '..')
const electronArchiveTools = createRequire(import.meta.url)('app-builder-lib/out/util/electronGet.js')
const zipReader = createRequire(import.meta.url)('unzipper')

function sameFileVersion(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function pathIdentityChain(path) {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean)
  const entries = [{ path: root, stat: lstatSync(root, { bigint: true }) }]
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const stat = lstatSync(current, { bigint: true })
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error('Lean package factory path contains a link or non-directory')
    }
    entries.push({ path: current, stat })
  }
  return entries
}

function assertSamePathChain(expected) {
  for (const entry of expected) {
    const current = lstatSync(entry.path, { bigint: true })
    const sameDirectory =
      entry.stat.isDirectory() &&
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      entry.stat.dev === current.dev &&
      entry.stat.ino === current.ino &&
      entry.stat.mode === current.mode
    if (!(sameDirectory || sameFileVersion(entry.stat, current))) {
      throw new Error('Lean package factory path changed during verification')
    }
  }
}

async function prepareVerifiedFactoryTemplate(context, temporaryRoot) {
  const config = context.packager.config
  const version = config.electronVersion
  const platform = context.electronPlatformName
  const arch = ARCH_NAMES[context.arch]
  const archiveName = `electron-v${version}-${platform}-${arch}.zip`
  const expectedHash = config.electronDownload?.checksums?.[archiveName]
  if (typeof version !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash ?? '')) {
    throw new Error('Selected Electron distribution has no reviewed checksum pin')
  }

  let archivePath
  if (typeof config.electronDist === 'string' && config.electronDist.trim()) {
    if (!context.electronPlatformName.startsWith('darwin') && !context.electronPlatformName.startsWith('mas')) {
      throw new Error('Lean Windows packaging must use electron-builder’s pinned Electron archive')
    }
    const selectedDist = resolve(REPO_ROOT, config.electronDist)
    const expectedDist = resolve(REPO_ROOT, 'resources', 'electron-dist')
    if (selectedDist !== expectedDist) throw new Error('Unexpected custom Electron distribution directory')
    archivePath = electronFactoryArchivePath(selectedDist, version, platform, arch)
  } else {
    archivePath = await electronArchiveTools.downloadElectronArtifactZip({
      electronDownload: config.electronDownload,
      artifactName: 'electron',
      platformName: platform,
      arch,
      version
    })
  }

  const sourceChain = pathIdentityChain(archivePath)
  const archiveBefore = lstatSync(archivePath, { bigint: true })
  if (
    !archiveBefore.isFile() ||
    archiveBefore.nlink !== 1n ||
    archiveBefore.size === 0n ||
    archiveBefore.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Selected Electron distribution archive is not a singly-linked regular file')
  }
  const archiveFd = openSync(archivePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  let privateArchiveFd
  let templateHandle
  let retainPrivateArchive = false
  try {
    const heldBefore = fstatSync(archiveFd, { bigint: true })
    if (!sameFileVersion(archiveBefore, heldBefore)) {
      throw new Error('Selected Electron distribution archive changed before it was opened')
    }
    const privateArchivePath = join(temporaryRoot, 'selected-electron.zip')
    privateArchiveFd = openSync(
      privateArchivePath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    )
    const digest = createHash('sha256')
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (BigInt(position) < archiveBefore.size) {
      const remaining = Number(archiveBefore.size - BigInt(position))
      const length = readSync(archiveFd, chunk, 0, Math.min(chunk.length, remaining), position)
      if (length === 0) throw new Error('Selected Electron distribution archive changed while copying')
      const bytes = chunk.subarray(0, length)
      digest.update(bytes)
      let written = 0
      while (written < length) {
        const count = writeSync(privateArchiveFd, bytes, written, length - written)
        if (count === 0) throw new Error('Could not write the verified Electron archive copy')
        written += count
      }
      position += length
    }
    const privateArchiveStat = fstatSync(privateArchiveFd, { bigint: true })
    const privateArchivePathStat = lstatSync(privateArchivePath, { bigint: true })
    if (
      digest.digest('hex') !== expectedHash ||
      !sameFileVersion(archiveBefore, fstatSync(archiveFd, { bigint: true })) ||
      !sameFileVersion(privateArchiveStat, privateArchivePathStat) ||
      privateArchiveStat.size !== archiveBefore.size
    ) {
      throw new Error('Selected Electron distribution archive failed its reviewed checksum or identity check')
    }
    assertSamePathChain(sourceChain)
    const privateArchiveRoot = lstatSync(temporaryRoot, { bigint: true })
    const privateArchiveStatAfterCopy = fstatSync(privateArchiveFd, { bigint: true })
    const privateArchivePathAfterCopy = lstatSync(privateArchivePath, { bigint: true })
    const archiveSize = Number(privateArchiveStat.size)
    const archive = await zipReader.Open.custom(retainedElectronArchiveSource(privateArchiveFd, archiveSize))
    const member = electronFactoryArchiveMemberPath(platform)
    const entry = archive.files.find((file) => file.path === member)
    if (!entry || entry.type !== 'File' || !Number.isSafeInteger(entry.uncompressedSize)) {
      throw new Error('Pinned Electron archive lacks its regular default_app.asar factory member')
    }
    const templateBytes = await entry.buffer()
    const templateDigest = createHash('sha256').update(templateBytes).digest('hex')
    if (templateBytes.length !== entry.uncompressedSize) {
      throw new Error('Pinned Electron factory member size differs from its archive record')
    }
    assertSamePathChain(sourceChain)
    const privateArchiveRootAfter = lstatSync(temporaryRoot, { bigint: true })
    if (
      !privateArchiveRootAfter.isDirectory() ||
      privateArchiveRootAfter.isSymbolicLink() ||
      privateArchiveRoot.dev !== privateArchiveRootAfter.dev ||
      privateArchiveRoot.ino !== privateArchiveRootAfter.ino ||
      privateArchiveRoot.mode !== privateArchiveRootAfter.mode ||
      !sameFileVersion(privateArchiveStatAfterCopy, fstatSync(privateArchiveFd, { bigint: true })) ||
      !sameFileVersion(privateArchivePathAfterCopy, lstatSync(privateArchivePath, { bigint: true }))
    ) {
      throw new Error('Private verified Electron archive changed during extraction')
    }
    const templatePath = electronFactoryTemplatePath(temporaryRoot, platform)
    mkdirSync(dirname(templatePath), { recursive: true, mode: 0o700 })
    templateHandle = await openFile(
      templatePath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    )
    let templateOffset = 0
    while (templateOffset < templateBytes.length) {
      const { bytesWritten } = await templateHandle.write(
        templateBytes,
        templateOffset,
        templateBytes.length - templateOffset,
        templateOffset
      )
      if (bytesWritten === 0) throw new Error('Could not write the pinned Electron factory member')
      templateOffset += bytesWritten
    }
    const templateTicket = await captureElectronFactoryTemplate(templatePath, templateHandle, templateDigest)
    const heldAfterExtract = fstatSync(archiveFd, { bigint: true })
    const pathAfterExtract = lstatSync(archivePath, { bigint: true })
    if (!sameFileVersion(archiveBefore, heldAfterExtract) || !sameFileVersion(archiveBefore, pathAfterExtract)) {
      throw new Error('Selected Electron distribution archive changed during factory extraction')
    }
    const verifySource = () => {
      const held = fstatSync(archiveFd, { bigint: true })
      const pathStat = lstatSync(archivePath, { bigint: true })
      assertSamePathChain(sourceChain)
      if (!sameFileVersion(archiveBefore, held) || !sameFileVersion(archiveBefore, pathStat)) {
        throw new Error('Selected Electron distribution archive changed before package cleanup')
      }
    }
    retainPrivateArchive = true
    return {
      template: templateTicket,
      verifySource,
      close: () => {
        closeSync(archiveFd)
        closeSync(privateArchiveFd)
        privateArchiveFd = undefined
      },
      closeTemplate: () => templateTicket.handle.close()
    }
  } catch (error) {
    if (templateHandle) await templateHandle.close()
    closeSync(archiveFd)
    throw error
  } finally {
    if (privateArchiveFd !== undefined && !retainPrivateArchive) closeSync(privateArchiveFd)
  }
}

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

  // macOS: nothing is signed yet — codesign runs from doSignAfterPack, after this hook — so every
  // reviewed native payload is compared byte-for-byte here.
  // Windows: electron-builder signs extraResources .exe INSIDE the copy that fills resources/
  // (app-builder-lib WinPackager.createTransformerForExtraFiles, consumed by PlatformPackager.doPack
  // before emitAfterPack), so llama-server.exe, ffmpeg.exe, node.exe and vc_redist.x64.exe are already
  // signtool-rewritten by the time this runs. There is no hook between that copy and afterPack, so the
  // packaged-but-unsigned bytes are observable to nothing: run --post-sign. signtool signs .exe only
  // (WinPackager.shouldSignFile), so every DLL and .node addon stays byte-verified.
  const leanProfile = process.env.METIS_PACKAGE_PROFILE === 'lean'
  const runtimeCheckArgs = [
    join(SCRIPTS_DIR, leanProfile ? 'check-lean-package.mjs' : 'check-packaged-runtime.mjs'),
    isMac ? 'mac' : 'win',
    resourceDir
  ]
  // electron-builder derives the Windows executable from appInfo.productFilename, which may differ from
  // the standard Metis.exe in an edition-specific config. Pass that same resolved filename into the
  // verifier so afterPack checks the binary electron-builder actually produced.
  if (isWin) {
    runtimeCheckArgs.push(`--executable=${context.packager.appInfo.productFilename}.exe`)
    // Lean candidates are explicitly unsigned. Compare all staged executable bytes, including the
    // reviewed FFmpeg sidecar, through the package boundary instead of using the signed-release skip.
    if (!leanProfile) runtimeCheckArgs.push('--post-sign')
  }
  // Verify exactly the architectures this package is meant to carry — the same set the pruning above
  // enforced, so the guard and the pruning can never disagree about what "correct" means.
  if (isMac && !leanProfile) {
    runtimeCheckArgs.push(`--arches=${packagedArches.join(',')}`)
    // The bundle executable is still thin in each sub-build and only becomes fat after the lipo merge,
    // so this tracks context.arch rather than the payload arch set.
    runtimeCheckArgs.push(`--macho-arches=${arch === 'universal' ? 'arm64,x64' : arch}`)
  }
  if (leanProfile) runtimeCheckArgs.push(`--arch=${arch}`)
  try {
    if (leanProfile) {
      await ensureLeanPackageCoreDirectories(resourceDir)
      const temporaryFactoryRoot = canonicalPrivateTemporaryRoot(
        mkdtempSync(join(tmpdir(), 'metis-electron-template-'))
      )
      let factoryTemplate
      try {
        factoryTemplate = await prepareVerifiedFactoryTemplate(context, temporaryFactoryRoot)
        await removeElectronDefaultAppTemplate(resourceDir, factoryTemplate.template, factoryTemplate.verifySource)
      } finally {
        await factoryTemplate?.closeTemplate()
        factoryTemplate?.close()
        rmSync(temporaryFactoryRoot, { recursive: true, force: true })
      }
    }
    execFileSync(process.execPath, runtimeCheckArgs, { cwd: REPO_ROOT, stdio: 'inherit' })
  } catch (error) {
    // A failed direct Electron Builder invocation otherwise leaves a launchable but incomplete app
    // directory behind. It must not look like a candidate someone could install or distribute.
    rmSync(context.appOutDir, { recursive: true, force: true })
    throw error
  }

  // ASKTOTO_ADHOC_SIGN=1 makes this hook — not electron-builder — sign the final bundle after the raw
  // byte gate, so the DMG/ZIP contains a coherently sealed, launchable app: ad-hoc, unless
  // ASKTOTO_MAC_SIGN_IDENTITY names a keychain identity (the QA candidate lane's stable QA certificate,
  // never a Developer ID — its designated requirement survives rebuilds, so TCC grants persist across
  // candidates). Tagged customer releases leave both variables unset and electron-builder performs real
  // signing/notarization next.
  //
  // On a universal build this MUST wait for the merged bundle. Signing each arch sub-build rewrites
  // the _CodeSignature/CodeResources files inside Electron Framework, and @electron/universal then
  // aborts with "Expected all non-binary files to have identical SHAs" because the two halves no
  // longer match. Sign once, after lipo, when the bundle is actually final.
  const isUniversalSubBuild = isMac && packagedArches.length > 1 && arch !== 'universal'
  if (isUniversalSubBuild && process.env.ASKTOTO_ADHOC_SIGN === '1') {
    console.log(`  • afterPack: deferring signature to the merged universal bundle (${arch} sub-build)`)
  }
  if (isMac && !isUniversalSubBuild && process.env.ASKTOTO_ADHOC_SIGN === '1') {
    const identity = process.env.ASKTOTO_MAC_SIGN_IDENTITY || '-'
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    console.log(`  • afterPack: applying complete ${identity === '-' ? 'ad-hoc' : 'QA identity'} signature to ${app}`)
    execFileSync(
      'codesign',
      [
        '--force',
        '--deep',
        '--sign',
        identity,
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
