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
for (const argument of argv) {
  if (argument === '--post-sign') {
    postSign = true
  } else if (argument.startsWith('--executable=')) {
    executableName = argument.slice('--executable='.length)
    if (!executableName || basename(executableName) !== executableName) {
      throw new Error(`Executable name must be a filename, got: ${argument}`)
    }
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
    ? join(REPO_ROOT, 'release', 'mac-arm64', 'Metis.app', 'Contents', 'Resources')
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

function verifyMachOArm64(path) {
  const header = readAt(path, 0, 8)
  const magic = header.readUInt32LE(0)
  const cpuType = header.readUInt32LE(4)
  if (magic !== 0xfeedfacf || cpuType !== 0x0100000c) {
    throw new Error(
      `${path}: expected a thin 64-bit arm64 Mach-O (magic=0xfeedfacf cpu=0x0100000c), ` +
        `got magic=0x${magic.toString(16)} cpu=0x${cpuType.toString(16)}`
    )
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

for (const asset of LOCAL_MODEL_ASSETS) {
  await requireAsset(join(resourcesRoot, 'local-llm', 'models', 'qwen3.5-0.8b', asset.file), asset)
}
await requireAsset(join(resourcesRoot, 'local-llm', 'LICENSE.QWEN3.5-APACHE-2.0.txt'), LOCAL_MODEL_LICENSE)
requireExactInventory(
  join(resourcesRoot, 'local-llm'),
  inventoryFromFiles([
    'LICENSE.QWEN3.5-APACHE-2.0.txt',
    'models/qwen3.5-0.8b/model.gguf',
    'models/qwen3.5-0.8b/mmproj.gguf'
  ]),
  'Qwen local-model'
)

const LLAMA_ARCHIVE_PINS = {
  mac: { '.sha256': '7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f' },
  win: {
    'cpu/.sha256': '422ad9b46f5ab60f7fd2e83783233eba2d9383e6f17d7ee916c80f19eb070e79',
    'vulkan/.sha256': 'fcc0a8c0f0f3140122452ed2728cebb520c5fbc4fc921836ee3a45dd77e18c68'
  }
}

const platformConfig =
  target === 'mac'
    ? {
        llamaName: 'mac',
        ffmpegKey: 'darwin-arm64/ffmpeg',
        sherpaPackage: 'sherpa-onnx-darwin-arm64',
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
        ffmpegKey: 'win32-x64/ffmpeg.exe',
        sherpaPackage: 'sherpa-onnx-win-x64',
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
const ffmpegExpected = ffmpegManifest.binaries?.[platformConfig.ffmpegKey]
if (!ffmpegExpected?.sha256) throw new Error(`No reviewed FFmpeg manifest entry for ${platformConfig.ffmpegKey}`)
requireExactInventory(
  ffmpegPackagedRoot,
  inventoryFromFiles(['manifest.json', 'LICENSE.LGPL-2.1.txt', platformConfig.ffmpegKey]),
  'FFmpeg runtime'
)
await requireAsset(join(ffmpegPackagedRoot, platformConfig.ffmpegKey), ffmpegExpected, {
  verifyHash: !postSign
})

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
const sourceTargetSherpa = join(REPO_ROOT, 'node_modules', platformConfig.sherpaPackage)
const packagedGenericSherpa = join(unpackedModules, genericSherpa)
const packagedTargetSherpa = join(unpackedModules, platformConfig.sherpaPackage)
await requireDependencyTree(sourceGenericSherpa, packagedGenericSherpa, {
  expectedFiles: genericSherpaFiles,
  label: genericSherpa
})
await requireDependencyTree(sourceTargetSherpa, packagedTargetSherpa, {
  expectedFiles: ['index.js', 'package.json', ...platformConfig.sherpaNative],
  label: platformConfig.sherpaPackage,
  nativeFile: (entry) => /\.(?:node|dll|dylib)$/i.test(entry)
})
for (const native of platformConfig.sherpaNative) {
  requireRegularFile(join(packagedTargetSherpa, native))
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
  [platformConfig.sherpaPackage],
  'Exactly one target-specific Sherpa package must be unpacked'
)

if (target === 'mac') {
  const contentsDir = dirname(resourcesRoot)
  const appRoot = dirname(contentsDir)
  const macOsDir = join(contentsDir, 'MacOS')
  // Métis Light's productName is "Metis Light", so its executable lives at Contents/MacOS/Metis Light.
  // Accept the same --executable= override the win branch uses; default to full-Métis's "Metis".
  const macExecutable = executableName || 'Metis'
  requireExactInventory(macOsDir, [macExecutable], 'macOS executable directory')
  verifyMachOArm64(join(macOsDir, macExecutable))
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
