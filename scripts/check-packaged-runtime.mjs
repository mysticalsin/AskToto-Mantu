#!/usr/bin/env node
/**
 * Verify the unpacked application contains exactly the reviewed offline payload.
 *
 * Raw mode (the default) runs from electron-builder's afterPack hook, before platform signing mutates
 * Mach-O/PE bytes. --post-sign rechecks exact inventories and immutable hashes, proves the executable
 * architecture, and verifies the macOS code signature without comparing signature-mutated native bytes.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { extractFile, getRawHeader, listPackage } from '@electron/asar'
import {
  closeSync,
  createReadStream,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { LOCAL_MODEL_ASSETS, LOCAL_MODEL_LICENSE, REPO_ROOT } from './local-model-assets.mjs'

const argv = process.argv.slice(2)
const target = argv.shift()
let resourcesArgument
let postSign = false
let executableName
// Two independent expectations, which are NOT the same during a universal build:
//   --arches       which per-arch payloads (FFmpeg sidecar, Sherpa addon) must be present. A universal
//                  package carries BOTH in every sub-build, because @electron/universal refuses to
//                  merge two bundles whose Mach-O file sets differ.
//   --macho-arches which slices the app's own executable must have. Still THIN in each sub-build, and
//                  only fat after lipo has merged them.
// Conflating the two would either demand a fat binary mid-build or accept a universal app whose
// executable silently lost a slice.
let packagedArches = ['arm64']
let machoArches = null
for (const argument of argv) {
  if (argument === '--post-sign') {
    postSign = true
  } else if (argument.startsWith('--executable=')) {
    executableName = argument.slice('--executable='.length)
    if (!executableName || basename(executableName) !== executableName) {
      throw new Error(`Executable name must be a filename, got: ${argument}`)
    }
  } else if (argument.startsWith('--arches=') || argument.startsWith('--macho-arches=')) {
    const isMacho = argument.startsWith('--macho-arches=')
    const raw = argument.slice(argument.indexOf('=') + 1)
    const parsed = raw
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
    if (!parsed.length || parsed.some((a) => !['arm64', 'x64'].includes(a))) {
      throw new Error(`${isMacho ? '--macho-arches' : '--arches'} must be a comma list of arm64/x64, got: ${argument}`)
    }
    if (isMacho) machoArches = parsed
    else packagedArches = parsed
  } else if (argument.startsWith('--')) {
    throw new Error(`Unknown option: ${argument}`)
  } else if (!resourcesArgument) {
    resourcesArgument = argument
  } else {
    throw new Error(
      'Usage: node scripts/check-packaged-runtime.mjs <mac|win> [resources-directory] [--post-sign]'
    )
  }
}
if (target !== 'mac' && target !== 'win') {
  throw new Error(
    'Usage: node scripts/check-packaged-runtime.mjs <mac|win> [resources-directory] [--post-sign]'
  )
}

const defaultRoot =
  target === 'mac'
    ? join(REPO_ROOT, 'release', 'mac-universal', 'Metis.app', 'Contents', 'Resources')
    : join(REPO_ROOT, 'release', 'win-unpacked', 'resources')
const resourcesRoot = resourcesArgument ? resolve(resourcesArgument) : defaultRoot

function slash(path) {
  return path.split('\\').join('/')
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected))) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}`)
  }
}

function requireDirectory(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error(`Packaged directory is missing: ${path}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Expected a real directory, not a symlink or special entry: ${path}`)
  }
}

function requireRegularFile(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error(`Packaged asset is missing: ${path}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Expected a regular self-contained file, not a symlink or special entry: ${path}`)
  }
  if (stat.size <= 0) throw new Error(`Packaged asset is empty: ${path}`)
  return stat
}

function verifyPackagedDependencyPruning() {
  const archive = join(resourcesRoot, 'app.asar')
  requireRegularFile(archive)
  // @electron/asar lists entries using the packing host's path separator — backslash on Windows,
  // forward slash on macOS/Linux — each with a leading separator. Normalize to a leading-slash POSIX
  // form so the reviewed prefix comparisons hold regardless of which OS produced the archive, and keep
  // a map back to each raw key for extractFile (which needs the archive's native-separator key with no
  // leading separator). Without this, a Windows-packed archive silently fails every check here.
  const rawEntries = listPackage(archive)
  const toPosix = (entry) => `/${entry.split('\\').join('/').replace(/^\/+/, '')}`
  const rawByPosix = new Map(rawEntries.map((entry) => [toPosix(entry), entry]))
  const forbiddenPrefixes = [
    '/node_modules/@dust-tt/client/node_modules/@modelcontextprotocol/sdk',
    '/node_modules/@dust-tt/client/node_modules/express-rate-limit',
    '/node_modules/@dust-tt/client/node_modules/ip-address'
  ]
  for (const prefix of forbiddenPrefixes) {
    if ([...rawByPosix.keys()].some((entry) => entry === prefix || entry.startsWith(`${prefix}/`))) {
      throw new Error(`Unused Dust MCP server dependency was packaged: ${prefix}`)
    }
  }

  // electron-builder flattens production dependencies into app.asar. Compare these two packages with
  // the reviewed root MCP SDK copies so Dust's stale bundled versions cannot silently replace them.
  for (const dependency of ['express-rate-limit', 'ip-address']) {
    const source = JSON.parse(
      readFileSync(join(REPO_ROOT, 'node_modules', dependency, 'package.json'), 'utf8')
    )
    const rawKey = rawByPosix.get(`/node_modules/${dependency}/package.json`)
    if (!rawKey) {
      throw new Error(`Packaged ${dependency}/package.json is missing from app.asar`)
    }
    const packaged = JSON.parse(
      extractFile(archive, rawKey.replace(/^[\\/]+/, '')).toString('utf8')
    )
    if (packaged.version !== source.version) {
      throw new Error(
        `Packaged ${dependency}@${packaged.version} does not match reviewed ${dependency}@${source.version}`
      )
    }
  }
}

verifyPackagedDependencyPruning()

function verifyAsarUnpackedReferences() {
  const archive = join(resourcesRoot, 'app.asar')
  const unpackedRoot = join(resourcesRoot, 'app.asar.unpacked')
  requireRegularFile(archive)
  const { header } = getRawHeader(archive)
  const missing = []
  function visit(node, prefix = '') {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const path = `${prefix}/${name}`
      if (entry.files) {
        visit(entry, path)
      } else if (entry.unpacked) {
        const unpackedPath = join(unpackedRoot, ...path.split('/').filter(Boolean))
        try {
          lstatSync(unpackedPath)
        } catch {
          missing.push(path)
        }
      }
    }
  }
  visit(header)
  if (missing.length) {
    throw new Error(
      `app.asar has ${missing.length} dangling unpacked reference(s); the platform package cannot be extracted:\n` +
        missing.slice(0, 20).join('\n')
    )
  }
}

verifyAsarUnpackedReferences()

function inventoryTree(root) {
  requireDirectory(root)
  const inventory = []
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`Symlink is forbidden in packaged runtime inventory: ${path}`)
      if (stat.isDirectory()) {
        inventory.push(`${rel}/`)
        visit(path, rel)
      } else if (stat.isFile()) {
        inventory.push(rel)
      } else {
        throw new Error(`Special filesystem entry is forbidden in packaged runtime inventory: ${path}`)
      }
    }
  }
  visit(root)
  return inventory.sort()
}

function inventoryFromFiles(files) {
  const entries = new Set()
  for (const raw of files) {
    const file = slash(raw).replace(/^\.\//, '')
    const parts = file.split('/')
    if (!file || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe path in reviewed inventory: ${raw}`)
    }
    for (let index = 1; index < parts.length; index++) {
      entries.add(`${parts.slice(0, index).join('/')}/`)
    }
    entries.add(file)
  }
  return [...entries].sort()
}

function requireExactInventory(root, expected, label) {
  const actual = inventoryTree(root)
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    const actualSet = new Set(actual)
    const wantedSet = new Set(wanted)
    const missing = wanted.filter((entry) => !actualSet.has(entry))
    const unexpected = actual.filter((entry) => !wantedSet.has(entry))
    throw new Error(
      `${label} inventory mismatch` +
        `${missing.length ? `\nMissing: ${missing.join(', ')}` : ''}` +
        `${unexpected.length ? `\nUnexpected: ${unexpected.join(', ')}` : ''}`
    )
  }
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function requireAsset(path, expected, { verifyHash = true } = {}) {
  const stat = requireRegularFile(path)
  if (!verifyHash) return
  if (expected.bytes !== undefined && stat.size !== expected.bytes) {
    throw new Error(`${path}: expected ${expected.bytes} bytes, got ${stat.size}`)
  }
  const sha256 = await hashFile(path)
  if (sha256 !== expected.sha256) {
    throw new Error(`${path}: SHA-256 mismatch (expected ${expected.sha256}, got ${sha256})`)
  }
}

async function requireSameFile(source, packaged, { verifyHash = true } = {}) {
  const sourceStat = requireRegularFile(source)
  await requireAsset(
    packaged,
    { bytes: sourceStat.size, sha256: verifyHash ? await hashFile(source) : undefined },
    { verifyHash }
  )
}

async function requireTreeMatches(sourceDir, packagedDir, { nativeFile = () => false, label }) {
  const sourceInventory = inventoryTree(sourceDir)
  requireExactInventory(packagedDir, sourceInventory, label)
  for (const entry of sourceInventory) {
    if (entry.endsWith('/')) continue
    const mutableNative = nativeFile(entry)
    await requireSameFile(join(sourceDir, entry), join(packagedDir, entry), {
      verifyHash: !(postSign && mutableNative)
    })
  }
}

function electronBuilderPackageJson(source) {
  const removedByElectronBuilder = new Set(['scripts', 'keywords', 'bugs'])
  return Object.fromEntries(Object.entries(source).filter(([key]) => !removedByElectronBuilder.has(key)))
}

async function requireDependencyTree(
  sourceDir,
  packagedDir,
  { expectedFiles, nativeFile = () => false, label }
) {
  const sourceFiles = inventoryTree(sourceDir).filter(
    (entry) => !entry.endsWith('/') && basename(entry).toLowerCase() !== 'readme.md'
  )
  if (expectedFiles) {
    assertEqual(sourceFiles.sort(), [...expectedFiles].sort(), `${label} source inventory is not reviewed`)
  }
  requireExactInventory(packagedDir, inventoryFromFiles(sourceFiles), label)

  for (const entry of sourceFiles) {
    const source = join(sourceDir, entry)
    const packaged = join(packagedDir, entry)
    if (basename(entry) === 'package.json') {
      requireRegularFile(packaged)
      const expected = electronBuilderPackageJson(JSON.parse(readFileSync(source, 'utf8')))
      const actual = JSON.parse(readFileSync(packaged, 'utf8'))
      assertEqual(actual, expected, `${label} package.json differs from electron-builder's reviewed projection`)
      continue
    }
    await requireSameFile(source, packaged, { verifyHash: !(postSign && nativeFile(entry)) })
  }
}

function readAt(path, offset, bytes) {
  requireRegularFile(path)
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, offset)
    if (read !== bytes) throw new Error(`Could not read ${bytes} bytes at offset ${offset} from ${path}`)
    return buffer
  } finally {
    closeSync(fd)
  }
}

const MACHO_CPU_TYPES = { arm64: 0x0100000c, x64: 0x01000007 }

/**
 * Assert `path` is a Mach-O carrying EXACTLY the expected architectures — a thin image for one, or a
 * fat/universal image for several. Reading the header directly (rather than shelling out to lipo)
 * keeps this a byte-level gate, and checking the set both ways catches the two failures that matter:
 * a slice missing (dead on that hardware) and an unexpected slice smuggled in.
 */
function verifyMachOArches(path, expectedArches) {
  const expected = [...expectedArches].sort()
  const header = readAt(path, 0, 8)
  // A fat/universal header is stored BIG-endian (FAT_MAGIC 0xcafebabe / FAT_MAGIC_64 0xcafebabf), while
  // a thin 64-bit Mach-O stores MH_MAGIC_64 little-endian on both x86_64 and arm64. Read each with its
  // own endianness: reading the fat magic little-endian yields the byte-swapped 0xbebafeca and makes a
  // perfectly good universal binary look like garbage.
  const fatMagic = header.readUInt32BE(0)
  const thinMagic = header.readUInt32LE(0)

  let found
  if (fatMagic === 0xcafebabe || fatMagic === 0xcafebabf) {
    // Fat header: big-endian count, then one arch entry (cputype first) per slice.
    const count = readAt(path, 4, 4).readUInt32BE(0)
    if (count === 0 || count > 16) throw new Error(`${path}: implausible fat Mach-O slice count ${count}`)
    const entrySize = fatMagic === 0xcafebabe ? 20 : 32
    found = []
    for (let i = 0; i < count; i++) {
      const cpuType = readAt(path, 8 + i * entrySize, 4).readUInt32BE(0)
      const name = Object.keys(MACHO_CPU_TYPES).find((k) => MACHO_CPU_TYPES[k] === cpuType)
      found.push(name ?? `unknown(0x${cpuType.toString(16)})`)
    }
  } else if (thinMagic === 0xfeedfacf) {
    const cpuType = header.readUInt32LE(4)
    const name = Object.keys(MACHO_CPU_TYPES).find((k) => MACHO_CPU_TYPES[k] === cpuType)
    found = [name ?? `unknown(0x${cpuType.toString(16)})`]
  } else {
    throw new Error(`${path}: not a 64-bit Mach-O image (magic=0x${thinMagic.toString(16)})`)
  }

  found.sort()
  if (found.join(',') !== expected.join(',')) {
    throw new Error(`${path}: expected Mach-O arches [${expected.join(', ')}], got [${found.join(', ')}]`)
  }
}

function verifyPeX64(path) {
  const dos = readAt(path, 0, 64)
  if (dos[0] !== 0x4d || dos[1] !== 0x5a) throw new Error(`${path}: missing PE MZ header`)
  const peOffset = dos.readUInt32LE(0x3c)
  const pe = readAt(path, peOffset, 6)
  if (pe.readUInt32LE(0) !== 0x00004550) throw new Error(`${path}: missing PE signature`)
  const machine = pe.readUInt16LE(4)
  if (machine !== 0x8664) {
    throw new Error(`${path}: expected PE x64 machine 0x8664, got 0x${machine.toString(16)}`)
  }
}

requireDirectory(resourcesRoot)

// The manifest itself is tracked and copied, so both the runtime evidence and every listed asset must
// survive packaging byte-for-byte. Inventories are derived from the manifest, not from mutable folders.
const runtimeManifestSource = join(REPO_ROOT, 'resources', 'runtime-assets-manifest.json')
await requireSameFile(runtimeManifestSource, join(resourcesRoot, 'runtime-assets-manifest.json'))
const runtimeManifest = JSON.parse(readFileSync(runtimeManifestSource, 'utf8'))
if (runtimeManifest.schemaVersion !== 1 || !runtimeManifest.assets || typeof runtimeManifest.assets !== 'object') {
  throw new Error(`Invalid reviewed runtime manifest: ${runtimeManifestSource}`)
}

const runtimeByRoot = new Map([
  ['asr', []],
  ['models', []],
  ['ort', []]
])
for (const [sourcePath, expected] of Object.entries(runtimeManifest.assets)) {
  const relativePath = slash(sourcePath).replace(/^resources\//, '')
  const root = relativePath.split('/')[0]
  if (!runtimeByRoot.has(root) || relativePath.includes('../')) {
    throw new Error(`Runtime manifest path is outside reviewed roots: ${sourcePath}`)
  }
  runtimeByRoot.get(root).push(relativePath.slice(root.length + 1))
  await requireAsset(join(resourcesRoot, relativePath), expected)
}
for (const [root, files] of runtimeByRoot) {
  requireExactInventory(join(resourcesRoot, root), inventoryFromFiles(files), `${root} runtime`)
}

// The Qwen weights are NOT packaged — local-model-download.ts fetches them on first run (see the
// extraResources note in electron-builder.yml). The exact-inventory assertion below is the load-bearing
// half of that: it fails if a stale checkout or a future config change smuggles a ~728 MB model.gguf
// back into the installer, which is what would silently push the release asset past GitHub's 2 GB cap.
// The licence text still ships and is still byte-verified.
await requireAsset(join(resourcesRoot, 'local-llm', 'LICENSE.QWEN3.5-APACHE-2.0.txt'), LOCAL_MODEL_LICENSE)
requireExactInventory(
  join(resourcesRoot, 'local-llm'),
  inventoryFromFiles(['LICENSE.QWEN3.5-APACHE-2.0.txt']),
  'Qwen local-model'
)

const LLAMA_ARCHIVE_PINS = {
  // Both mac arches ship in every mac package (the .app is universal and selects at spawn time by
  // process.arch), so both markers are pinned and both are verified regardless of which sub-build
  // this run is inspecting.
  mac: {
    'arm64/.sha256': '7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f',
    'x64/.sha256': 'f03f6669c7e34c2768ca4a318dd13e105dec46e1f87a2165d2be7fd6a0ee4716'
  },
  win: {
    'cpu/.sha256': '422ad9b46f5ab60f7fd2e83783233eba2d9383e6f17d7ee916c80f19eb070e79',
    'vulkan/.sha256': 'fcc0a8c0f0f3140122452ed2728cebb520c5fbc4fc921836ee3a45dd77e18c68'
  }
}

const macArches = packagedArches
const expectedMachoArches = machoArches ?? macArches

const platformConfig =
  target === 'mac'
    ? {
        llamaName: 'mac',
        // Per-arch: after-pack prunes the foreign FFmpeg arch, and electron-builder's files
        // allowlist admits only the packaging arch's Sherpa addon (see electron-builder.yml). The
        // merged universal app is the union of both sub-builds, so it carries both of each.
        ffmpegKeys: macArches.map((a) => `darwin-${a}/ffmpeg`),
        sherpaPackages: macArches.map((a) => `sherpa-onnx-darwin-${a}`),
        sherpaNative: [
          'libonnxruntime.1.24.4.dylib',
          'libonnxruntime.dylib',
          'libsherpa-onnx-c-api.dylib',
          'libsherpa-onnx-cxx-api.dylib',
          'sherpa-onnx.node'
        ]
      }
    : {
        llamaName: 'win',
        ffmpegKeys: ['win32-x64/ffmpeg.exe'],
        sherpaPackages: ['sherpa-onnx-win-x64'],
        sherpaNative: [
          'onnxruntime.dll',
          'onnxruntime_providers_shared.dll',
          'sherpa-onnx-c-api.dll',
          'sherpa-onnx-cxx-api.dll',
          'sherpa-onnx.node'
        ]
      }

const llamaSource = join(REPO_ROOT, 'resources', 'llama', platformConfig.llamaName)
const llamaPackaged = join(resourcesRoot, 'llama', platformConfig.llamaName)
await requireTreeMatches(llamaSource, llamaPackaged, {
  label: `${target} llama runtime`,
  nativeFile: (entry) => !entry.endsWith('.sha256')
})
const llamaRootExpected = inventoryTree(llamaSource).map((entry) => `${platformConfig.llamaName}/${entry}`)
llamaRootExpected.unshift(`${platformConfig.llamaName}/`)
requireExactInventory(join(resourcesRoot, 'llama'), llamaRootExpected, 'llama platform root')
for (const [marker, pin] of Object.entries(LLAMA_ARCHIVE_PINS[platformConfig.llamaName])) {
  const sourceMarker = join(llamaSource, marker)
  const packagedMarker = join(llamaPackaged, marker)
  requireRegularFile(sourceMarker)
  requireRegularFile(packagedMarker)
  if (readFileSync(sourceMarker, 'utf8').trim() !== pin || readFileSync(packagedMarker, 'utf8').trim() !== pin) {
    throw new Error(`llama archive marker does not match its hardcoded pin: ${marker}`)
  }
}

const ffmpegSourceRoot = join(REPO_ROOT, 'resources', 'ffmpeg')
const ffmpegPackagedRoot = join(resourcesRoot, 'ffmpeg')
const ffmpegManifestSource = join(ffmpegSourceRoot, 'manifest.json')
const ffmpegLicenseSource = join(ffmpegSourceRoot, 'LICENSE.LGPL-2.1.txt')
await requireSameFile(ffmpegManifestSource, join(ffmpegPackagedRoot, 'manifest.json'))
await requireSameFile(ffmpegLicenseSource, join(ffmpegPackagedRoot, 'LICENSE.LGPL-2.1.txt'))
const ffmpegManifest = JSON.parse(readFileSync(ffmpegManifestSource, 'utf8'))
requireExactInventory(
  ffmpegPackagedRoot,
  inventoryFromFiles(['manifest.json', 'LICENSE.LGPL-2.1.txt', ...platformConfig.ffmpegKeys]),
  'FFmpeg runtime'
)
for (const ffmpegKey of platformConfig.ffmpegKeys) {
  const ffmpegExpected = ffmpegManifest.binaries?.[ffmpegKey]
  if (!ffmpegExpected?.sha256) throw new Error(`No reviewed FFmpeg manifest entry for ${ffmpegKey}`)
  await requireAsset(join(ffmpegPackagedRoot, ffmpegKey), ffmpegExpected, {
    verifyHash: !postSign
  })
}

const unpackedModules = join(resourcesRoot, 'app.asar.unpacked', 'node_modules')
const genericSherpa = 'sherpa-onnx-node'
const genericSherpaFiles = [
  'addon-static-import.js',
  'addon.js',
  'audio-tagg.js',
  'keyword-spotter.js',
  'non-streaming-asr.js',
  'non-streaming-speaker-diarization.js',
  'non-streaming-speech-denoiser.js',
  'non-streaming-tts.js',
  'online-speech-denoiser.js',
  'package.json',
  'punctuation.js',
  'resampler.js',
  'sherpa-onnx.js',
  'speaker-identification.js',
  'spoken-language-identification.js',
  'streaming-asr.js',
  'types.js',
  'vad.js'
]
const sourceGenericSherpa = join(REPO_ROOT, 'node_modules', genericSherpa)
const packagedGenericSherpa = join(unpackedModules, genericSherpa)
await requireDependencyTree(sourceGenericSherpa, packagedGenericSherpa, {
  expectedFiles: genericSherpaFiles,
  label: genericSherpa
})
for (const sherpaPackage of platformConfig.sherpaPackages) {
  const sourceTargetSherpa = join(REPO_ROOT, 'node_modules', sherpaPackage)
  const packagedTargetSherpa = join(unpackedModules, sherpaPackage)
  await requireDependencyTree(sourceTargetSherpa, packagedTargetSherpa, {
    expectedFiles: ['index.js', 'package.json', ...platformConfig.sherpaNative],
    label: sherpaPackage,
    nativeFile: (entry) => /\.(?:node|dll|dylib)$/i.test(entry)
  })
  for (const native of platformConfig.sherpaNative) {
    requireRegularFile(join(packagedTargetSherpa, native))
  }
}
const packagedSherpaPlatforms = []
for (const entry of readdirSync(unpackedModules, { withFileTypes: true })) {
  if (!entry.name.startsWith('sherpa-onnx-') || entry.name === genericSherpa) continue
  const path = join(unpackedModules, entry.name)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Sherpa platform payload must be a real directory: ${path}`)
  }
  packagedSherpaPlatforms.push(entry.name)
}
packagedSherpaPlatforms.sort()
assertEqual(
  packagedSherpaPlatforms,
  [...platformConfig.sherpaPackages].sort(),
  'Exactly the target architectures’ Sherpa packages must be unpacked'
)

// MQA-240: a universal macOS package must carry PLAIN JavaScript as its main process, never V8 bytecode.
//
// V8's cached-data tag mixes the V8 version, the flag set and the host's CPU features, so a .jsc is only
// loadable by the architecture that produced it. electron-vite emits exactly ONE out/main/index.jsc — the
// build host's — and --universal merges both sub-builds into a single app.asar, so the other slice is
// handed bytecode it cannot load and dies at bytecode-loader.cjs before any Metis code runs. That is the
// 1.6.0 DMG: dead on arrival on every Intel Mac.
//
// electron.vite.config.ts turns bytecode off for that target via ASKTOTO_MAC_UNIVERSAL=1, and package.json
// sets it on the three --universal chains. This asserts the OUTCOME rather than the flag, because the flag
// is a thing a person can forget and the artifact is the thing users run. Cheap, and it is the check whose
// absence let a signed, notarised, unlaunchable installer ship.
if (target === 'mac') {
  const mainEntries = listPackage(join(resourcesRoot, 'app.asar')).filter((entry) =>
    /^[\/]out[\/]main[\/]/.test(entry)
  )
  if (!mainEntries.length) throw new Error('app.asar contains no out/main entries — the main process is missing')
  const bytecode = mainEntries.filter((entry) => entry.toLowerCase().endsWith('.jsc'))
  if (bytecode.length) {
    throw new Error(
      `Universal macOS package carries ${bytecode.length} V8 bytecode file(s) — the non-host slice cannot ` +
        `load them and will die on launch with cachedDataRejected: ${bytecode.join(', ')}.
` +
        '  Build the --universal chains with ASKTOTO_MAC_UNIVERSAL=1 (see electron.vite.config.ts) and rebuild from a clean out/.'
    )
  }
  // A bytecode build also leaves index.js as a ~72-byte require() shim, so size is a second, independent
  // signal that the real bundle is present rather than a loader pointing at a .jsc that was stripped.
  const loader = mainEntries.find((entry) => /[\/]index\.js$/.test(entry))
  if (!loader) throw new Error('app.asar has no out/main/index.js — the main-process entry is missing')
  const mainBytes = extractFile(join(resourcesRoot, 'app.asar'), loader.replace(/^[\/]+/, '')).length
  if (mainBytes < 50_000) {
    throw new Error(
      `out/main/index.js is only ${mainBytes} bytes — that is a bytecode loader shim, not the main-process ` +
        'bundle. See the bytecode note above.'
    )
  }
  console.log(`[check:packaged-runtime] OK mac main process is plain JavaScript (${mainBytes} bytes, 0 .jsc)`)
}

if (target === 'mac') {
  const contentsDir = dirname(resourcesRoot)
  const appRoot = dirname(contentsDir)
  const macOsDir = join(contentsDir, 'MacOS')
  requireExactInventory(macOsDir, ['Metis'], 'macOS executable directory')
  // Thin during an arch sub-build, fat once lipo has merged them — assert exactly the slices this
  // stage is supposed to have, so a universal package missing a slice fails here rather than on a
  // user's machine.
  verifyMachOArches(join(macOsDir, 'Metis'), expectedMachoArches)
  if (postSign) {
    if (process.platform !== 'darwin') throw new Error('macOS post-sign verification must run on macOS')
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appRoot], { stdio: 'inherit' })
  }
} else {
  verifyPeX64(join(resourcesRoot, '..', executableName || 'Metis.exe'))
}

console.log(
  `[check:packaged-runtime] OK ${target} (${postSign ? 'post-sign' : 'pre-sign'}) — exact reviewed ` +
    'Qwen, ASR/ORT, llama-server, FFmpeg, Sherpa, and executable architecture'
)
