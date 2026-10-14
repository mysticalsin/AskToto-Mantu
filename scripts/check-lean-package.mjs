#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { extractFile, listPackage } from '@electron/asar'
import { access, lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMacHelperSpeechUsage } from './lib/mac-helper-privacy.mjs'
import { isForbiddenInferencePath } from './lib/forbidden-inference-path.mjs'
import { assertMachOArchitectures } from './lib/macho-architecture.mjs'
import { parseLeanCheckerArgs } from './lib/lean-checker-args.mjs'
import { constants as fsConstants } from 'node:fs'
import { packageInventoryIdentity, validatePackageInventory } from './lib/package-inventory.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { target, resourcesArg, arch, executableName, platform } = parseLeanCheckerArgs(process.argv.slice(2))
const resourcesRoot = resolve(resourcesArg)
const appRoot = platform === 'darwin' ? dirname(dirname(resourcesRoot)) : dirname(resourcesRoot)
const asarPath = join(resourcesRoot, 'app.asar')
const HASH = /^[a-f0-9]{64}$/

async function requireFile(path, label, { allowEmpty = false } = {}) {
  let stat
  try {
    stat = await lstat(path)
  } catch {
    throw new Error(`Missing ${label}: ${path}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile() || (!allowEmpty && stat.size === 0)) {
    throw new Error(`${label} must be a ${allowEmpty ? 'regular' : 'non-empty regular'} file: ${path}`)
  }
  return stat
}

function normalizeEntry(entry) {
  return `/${entry.split('\\').join('/').replace(/^\/+/, '')}`
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${error.message}`)
  }
}

async function treeFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Lean package contains a symbolic link: ${path}`)
    if (entry.isDirectory()) await treeFiles(path, output)
    else if (entry.isFile()) output.push(path)
    else throw new Error(`Lean package contains a non-regular entry: ${path}`)
  }
  return output
}

async function treeBytes(directory) {
  let bytes = 0
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() || entry.isSymbolicLink()) bytes += (await lstat(child)).size
      else throw new Error(`Application contains an unsupported filesystem entry: ${child}`)
    }
  }
  await walk(directory)
  return bytes
}

await requireFile(asarPath, 'Electron app.asar')
const profile = await readJson(join(resourcesRoot, 'speech-pack-profile.json'), 'speech-pack-profile.json')
if (
  !profile ||
  Array.isArray(profile) ||
  profile.schema !== 1 ||
  profile.profile !== 'lean' ||
  Object.keys(profile).sort().join(',') !== 'profile,schema'
) {
  throw new Error('Lean artifact requires exact package-owned speech profile {"schema":1,"profile":"lean"}')
}

const inventoryPath = join(resourcesRoot, 'package-inventory.json')
await requireFile(inventoryPath, 'package-inventory.json')
const inventory = validatePackageInventory(await readJson(inventoryPath, 'package-inventory.json'))
if (inventory.profile !== 'lean' || inventory.platform !== platform || inventory.arch !== arch) {
  throw new Error(`Package inventory target/profile mismatch: expected lean ${platform}/${arch}, got ${inventory.profile} ${inventory.platform}/${inventory.arch}`)
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
if (inventory.sourceCommit !== sourceCommit) throw new Error('Package inventory source commit differs from the checked-out build source')
const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'))
const electronVersion = lock.packages?.['node_modules/electron']?.version
if (inventory.appVersion !== packageJson.version || inventory.electronVersion !== electronVersion) {
  throw new Error('Package inventory application or locked Electron version differs from source')
}
if (packageInventoryIdentity(inventory) !== inventory.identity) throw new Error('Package inventory identity is invalid')

// The resource inventory covers the immutable staged core files it lists. Executables rewritten by
// platform signing are checked by their existing target-specific build gates and by the requirements
// below; this inventory does not claim to cover app.asar or the complete application directory.
for (const file of inventory.coreFiles) {
  const path = join(resourcesRoot, ...file.path.split('/'))
  await requireFile(path, `inventoried core resource ${file.path}`, { allowEmpty: true })
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== file.bytes || sha256 !== file.sha256) {
    throw new Error(`Inventoried core resource differs from package inventory: ${file.path}`)
  }
}

const archFolder = `${platform}-${arch}`
const managedNodeFolder = platform === 'win32' ? 'win-x64' : archFolder
const managedNodeBinary = platform === 'win32' ? 'node.exe' : 'bin/node'
const managedNodeManifest = JSON.parse(await readFile(join(ROOT, 'src/shared/managed-node-manifest.json'), 'utf8'))
const managedNodeSpec = managedNodeManifest.assets?.[platform === 'win32' ? 'win32-x64' : archFolder]
if (!managedNodeSpec?.nodeRelPath) throw new Error(`No reviewed managed Node entry exists for ${platform}/${arch}`)
const requiredResources = [
  ['ffmpeg/manifest.json', 'FFmpeg manifest'],
  ['ffmpeg/LICENSE.LGPL-2.1.txt', 'FFmpeg license'],
  [`ffmpeg/${archFolder}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`, 'target FFmpeg decoder'],
  [`managed-node/${managedNodeFolder}/${managedNodeSpec.nodeRelPath}`, 'target managed Node runtime'],
  ['intelligence/index.html', 'Mantu Intelligence entry'],
  ['skills/caveman/SKILL.md', 'locked conversation skills'],
  ['graphify_runner.py', 'Graphify runner'],
  ['THIRD_PARTY_NOTICES.md', 'third-party notices'],
  ['icon.png', 'application icon'],
  ['tray/tray.png', 'tray image'],
  ['speech-pack-fixtures/en.wav', 'speech-pack self-test fixture'],
  ['managed-config.example.json', 'managed config example'],
  ['managed-config.enterprise.example.json', 'enterprise config example']
]
if (platform === 'darwin') requiredResources.push(['mac-helper/metis-mac-helper', 'macOS capture helper'])
if (platform === 'win32') requiredResources.push(['vcredist/vc_redist.x64.exe', 'Windows VC++ runtime'])
for (const [relativePath, label] of requiredResources) {
  await requireFile(join(resourcesRoot, relativePath), label)
}
if (platform === 'darwin') {
  await access(join(resourcesRoot, 'ffmpeg', archFolder, 'ffmpeg'), fsConstants.X_OK)
}
for (const relativePath of ['operator', 'license-lease', 'cloudflare-embed', 'skills', 'intelligence']) {
  let stat
  try {
    stat = await lstat(join(resourcesRoot, relativePath))
  } catch {
    throw new Error(`Required core resource directory is missing: ${relativePath}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Required core resource directory is invalid: ${relativePath}`)
}

// The inventory must cover every staged regular file except the named executables whose bytes are
// rewritten or separately checked by the platform packaging gates. This catches an incomplete list,
// not just a changed hash for files that happened to be listed.
const inventoryPaths = new Set(inventory.coreFiles.map(({ path }) => path))
const signedPayloads = new Set([
  `ffmpeg/${archFolder}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`,
  `managed-node/${managedNodeFolder}/${managedNodeBinary}`,
  ...(platform === 'darwin' ? ['mac-helper/metis-mac-helper'] : ['vcredist/vc_redist.x64.exe'])
])
const builderGeneratedResources = new Set([
  'app-update.yml',
  ...(platform === 'darwin' ? ['icon.icns'] : ['elevate.exe'])
])
const packagedResourceFiles = await treeFiles(resourcesRoot)
const packagedResourcePaths = new Set()
for (const path of packagedResourceFiles) {
  const relativePath = path.slice(resourcesRoot.length + 1).split('\\').join('/')
  packagedResourcePaths.add(relativePath)
  if (
    relativePath === 'package-inventory.json' ||
    relativePath === 'app.asar' ||
    relativePath.startsWith('app.asar.unpacked/') ||
    builderGeneratedResources.has(relativePath) ||
    signedPayloads.has(relativePath)
  ) continue
  if (!inventoryPaths.has(relativePath)) throw new Error(`Core resource is omitted from package inventory: ${relativePath}`)
}
for (const path of inventoryPaths) {
  if (!packagedResourcePaths.has(path)) throw new Error(`Package inventory names a missing core resource: ${path}`)
}
for (const relativePath of signedPayloads) {
  const packagedBytes = await readFile(join(resourcesRoot, relativePath))
  const stagedBytes = await readFile(join(ROOT, 'build/lean-stage/resources', relativePath))
  if (createHash('sha256').update(packagedBytes).digest('hex') !== createHash('sha256').update(stagedBytes).digest('hex')) {
    throw new Error(`Unsigned packaged executable differs from its staged source: ${relativePath}`)
  }
}

const rawAsarEntries = listPackage(asarPath)
const asarEntries = rawAsarEntries.map(normalizeEntry)
const rendererScripts = rawAsarEntries.filter((entry) => {
  const normalized = normalizeEntry(entry)
  return normalized.startsWith('/out/renderer/') && /\.(?:js|mjs)$/.test(normalized)
})
const profileMarker = '/* metis-package-profile:lean */'
if (!rendererScripts.some((entry) => extractFile(asarPath, entry.replace(/^[\\/]+/, '')).subarray(0, 512).toString('utf8').includes(profileMarker))) {
  throw new Error('Compiled renderer bundle does not carry the lean build-profile marker')
}
for (const entry of asarEntries) {
  if (isForbiddenInferencePath(entry)) throw new Error(`Inference runtime/worker payload is present inside app.asar: ${entry}`)
}

const unpackedRoot = join(resourcesRoot, 'app.asar.unpacked')
let unpackedEntries = []
try {
  unpackedEntries = await treeFiles(unpackedRoot)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
for (const path of unpackedEntries) {
  const relativePath = path.slice(unpackedRoot.length + 1).split('\\').join('/')
  if (isForbiddenInferencePath(relativePath)) {
    throw new Error(`Inference runtime/weight payload is present in app.asar.unpacked: ${relativePath}`)
  }
}

for (const forbiddenRoot of ['asr', 'models', 'ort', 'llama', 'local-llm']) {
  const path = join(resourcesRoot, forbiddenRoot)
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await readdir(path)).length > 0) {
      throw new Error(`Lean package contains forbidden inference resource ${forbiddenRoot}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
for (const path of await treeFiles(resourcesRoot)) {
  const relativePath = path.slice(resourcesRoot.length + 1).split('\\').join('/')
  if (isForbiddenInferencePath(relativePath)) {
    throw new Error(`Lean package contains an inference runtime/weight outside app.asar: ${relativePath}`)
  }
}

const appAsarPackageKey = asarEntries.find((entry) => entry === '/package.json')
if (!appAsarPackageKey) throw new Error('app.asar package.json is missing')
const rawPackageEntry = rawAsarEntries.find((entry) => normalizeEntry(entry) === appAsarPackageKey)
const packagedAppPackage = JSON.parse(extractFile(asarPath, rawPackageEntry.replace(/^[\\/]+/, '')).toString('utf8'))
if (packagedAppPackage.metisPackageProfile !== 'lean' || packagedAppPackage.version !== inventory.appVersion) {
  throw new Error('app.asar package metadata does not match the compiled lean profile inventory')
}
if (!asarEntries.includes('/node_modules/@dust-tt/client/package.json')) {
  throw new Error('The managed Dust client package is missing from app.asar')
}
const ffmpegManifest = await readJson(join(ROOT, 'resources/ffmpeg/manifest.json'), 'reviewed FFmpeg source manifest')
const ffmpegRel = `${archFolder}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`
const ffmpegPin = ffmpegManifest.binaries?.[`${platform}-${arch}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`]?.sha256
if (!HASH.test(ffmpegPin ?? '')) throw new Error(`No reviewed FFmpeg hash exists for ${platform}/${arch}`)
const ffmpegBytes = await readFile(join(resourcesRoot, 'ffmpeg', ffmpegRel))
if (createHash('sha256').update(ffmpegBytes).digest('hex') !== ffmpegPin) {
  throw new Error(`Packaged FFmpeg bytes differ from the reviewed ${platform}/${arch} manifest entry`)
}
if (platform === 'darwin') {
  const infoPlistPath = join(dirname(resourcesRoot), 'Info.plist')
  const bundleIdentifier = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlistPath], {
    encoding: 'utf8'
  }).trim()
  if (bundleIdentifier !== 'com.mantu.asktoto') {
    throw new Error(`macOS bundle identifier must remain com.mantu.asktoto, got ${JSON.stringify(bundleIdentifier)}`)
  }
  const expectedAppArch = arch === 'x64' ? 'x64' : 'arm64'
  const appExecutable = join(appRoot, 'Contents', 'MacOS', 'Metis')
  assertMachOArchitectures(await readFile(appExecutable), [expectedAppArch], 'Metis application executable')
  const electronFramework = join(
    appRoot,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework'
  )
  await requireFile(electronFramework, 'Electron Framework executable')
  assertMachOArchitectures(await readFile(electronFramework), [expectedAppArch], 'Electron Framework executable')
  const helperPath = join(resourcesRoot, 'mac-helper', 'metis-mac-helper')
  const helperArches = execFileSync('lipo', ['-archs', helperPath], { encoding: 'utf8' }).trim().split(/\s+/)
  const expectedHelperArches = ['arm64', 'x86_64']
  if (expectedHelperArches.some((expected) => !helperArches.includes(expected))) {
    throw new Error(`Packaged macOS capture helper must retain both architectures; got ${helperArches.join(', ')}`)
  }
  assertMacHelperSpeechUsage(helperPath, expectedHelperArches)
} else {
  if (executableName !== 'Metis.exe') throw new Error(`Unexpected Windows executable identity: ${executableName}`)
  const exePath = join(appRoot, executableName)
  const exeBytes = await readFile(exePath)
  if (exeBytes[0] !== 0x4d || exeBytes[1] !== 0x5a) throw new Error('Windows application executable is missing its PE header')
  const peOffset = exeBytes.readUInt32LE(0x3c)
  if (exeBytes.readUInt32LE(peOffset) !== 0x00004550 || exeBytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error('Windows application executable is not an x64 PE image')
  }
  const fullBuilderConfig = await readFile(join(ROOT, 'electron-builder.yml'), 'utf8')
  const winBuilderConfig = await readFile(join(ROOT, 'electron-builder.win.yml'), 'utf8')
  if (!fullBuilderConfig.includes('appId: com.mantu.asktoto') || !winBuilderConfig.includes('productName: Métis')) {
    throw new Error('Windows package source identity differs from the established application identity')
  }
}

const appBytes = await treeBytes(appRoot)
const asarBytes = (await lstat(asarPath)).size
const unpackedBytes = (await Promise.all(unpackedEntries.map((path) => lstat(path)))).reduce((sum, stat) => sum + stat.size, 0)
console.log(`[check-lean-package] PASS profile=lean platform=${platform} arch=${arch} source=${inventory.sourceCommit}`)
console.log(`[check-lean-package] inventory=${inventory.identity} coreFiles=${inventory.coreFiles.length}; inventory scope excludes signed executables, app.asar and the complete app tree`)
console.log(`[check-lean-package] measured appTreeBytes=${appBytes} appAsarBytes=${asarBytes} appAsarUnpackedBytes=${unpackedBytes}`)
