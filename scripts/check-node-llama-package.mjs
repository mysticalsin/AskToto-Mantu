#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { extractFile, listPackage } from '@electron/asar'
import { pathToFileURL } from 'node:url'

const TARGETS = {
  'darwin-arm64': {
    nativePackages: ['mac-arm64-metal'],
    sherpaPackages: ['sherpa-onnx-node', 'sherpa-onnx-darwin-arm64'],
    sherpaNativePackage: 'sherpa-onnx-darwin-arm64',
    resources: (app) => join(app, 'Contents', 'Resources')
  },
  'win32-x64': {
    nativePackages: ['win-x64', 'win-x64-vulkan'],
    sherpaPackages: ['sherpa-onnx-node', 'sherpa-onnx-win-x64'],
    sherpaNativePackage: 'sherpa-onnx-win-x64',
    resources: (app) => join(app, 'resources')
  }
}

const WORKER_FILES = ['index.mjs', 'native-runtime.mjs', 'network-deny.mjs']
const WORKER_IMPORTS = {
  'index.mjs': ['node:url', './native-runtime.mjs', './network-deny.mjs'],
  'native-runtime.mjs': ['node-llama-cpp', 'node:fs', 'node:path', 'node:url'],
  'network-deny.mjs': ['node:http', 'node:http2', 'node:https', 'node:net', 'node:tls']
}
const NETWORK_CORE_IMPORTS = new Set(['node:http', 'node:http2', 'node:https', 'node:net', 'node:tls'])
const VISION_COMPONENTS = [
  'config',
  'decoder-model',
  'embed-tokens',
  'generation-config',
  'preprocessor-config',
  'processor-config',
  'tokenizer',
  'tokenizer-config',
  'vision-encoder'
]
const FLORENCE_COMPONENTS = [
  'config',
  'decoder-model',
  'embed-tokens',
  'encoder-model',
  'generation-config',
  'preprocessor-config',
  'tokenizer',
  'tokenizer-config',
  'vision-encoder'
]
const SELECTED_VARIANTS = {
  'qwen3-1.7b-iq4-xs': {
    role: 'text',
    model: 'qwen3-1.7b',
    precision: 'IQ4_XS',
    runtime: 'node-llama-cpp',
    components: ['weights'],
    licenseId: 'qwen3-1.7b-apache-2.0'
  },
  'qwen3-1.7b-q4-k-m': {
    role: 'text',
    model: 'qwen3-1.7b',
    precision: 'Q4_K_M',
    runtime: 'node-llama-cpp',
    components: ['weights'],
    licenseId: 'qwen3-1.7b-apache-2.0'
  },
  'qwen3-0.6b-q8-0': {
    role: 'text',
    model: 'qwen3-0.6b',
    precision: 'Q8_0',
    runtime: 'node-llama-cpp',
    components: ['weights'],
    licenseId: 'qwen3-0.6b-apache-2.0'
  },
  'smolvlm-256m-instruct-q8': {
    role: 'vision',
    model: 'smolvlm-256m-instruct',
    precision: 'Q8',
    runtime: 'transformers.js',
    components: VISION_COMPONENTS,
    licenseId: 'smolvlm-apache-2.0'
  },
  'florence-2-base-ft-q4': {
    role: 'vision',
    model: 'florence-2-base-ft',
    precision: 'q4',
    runtime: 'transformers.js',
    components: FLORENCE_COMPONENTS,
    licenseId: 'florence-2-mit'
  }
}
const FORBIDDEN_LLAMA_DIRECTORIES = ['addon', 'cmake', 'gpuInfo', 'patches', 'profiles', 'toolchains', 'xpack']
const FORBIDDEN_LLAMA_FILES = new Set(['gitRelease.bundle', 'CMakeLists.txt', '.clang-format'])
const FORBIDDEN_WORKER_SOURCE = [
  ['remote URL', /https?:\/\//i],
  ['provider', /\bproviders?\b/i],
  ['auth', /\b(?:auth|authentication|authorization)\b/i],
  ['credentials', /\bcredentials?\b/i],
  ['socket', /\bsockets?\b/i],
  ['server', /\bservers?\b/i],
  ['resolveModelFile', /\bresolveModelFile\b/]
]

function fail(message) {
  throw new Error(`check-node-llama-package: ${message}`)
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, expected) {
  if (!plainRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function sameStrings(actual, expected) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== 'string')) return false
  const sorted = [...actual].sort()
  const wanted = [...expected].sort()
  return sorted.length === wanted.length && sorted.every((value, index) => value === wanted[index])
}

async function hashFile(file) {
  const hash = createHash('sha256')
  await new Promise((resolveHash, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolveHash)
  })
  return hash.digest('hex')
}

function safeDestination(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false
  }
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

function validateFileRecord(record, expectedKeys, label) {
  if (
    !exactKeys(record, expectedKeys) ||
    typeof record.id !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(record.id) ||
    !safeDestination(record.destination) ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes <= 0 ||
    typeof record.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.sha256)
  ) {
    fail(`packaged manifest contains an invalid ${label} record`)
  }
}

export function validatePackagedManifest(manifest, { platform, allowEvaluation = false } = {}) {
  if (!Object.hasOwn(TARGETS, platform)) fail(`unsupported platform ${platform}`)
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'targetPlatform',
      'catalogSha256',
      'approval',
      'selected',
      'assets',
      'licenses',
      'notices'
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.targetPlatform !== platform
  ) {
    fail('packaged manifest target does not match the app')
  }
  if (typeof manifest.catalogSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.catalogSha256)) {
    fail('packaged manifest catalogSha256 is invalid')
  }
  if (!['evaluation', 'release'].includes(manifest.approval)) fail('packaged manifest approval is invalid')
  if (manifest.approval !== 'release' && !allowEvaluation) {
    fail('evaluation payload requires METIS_ALLOW_EVALUATION_PAYLOAD=1')
  }
  if (!exactKeys(manifest.selected, ['text', 'vision'])) fail('packaged selected model records are invalid')

  const selections = [
    ['text', manifest.selected.text],
    ['vision', manifest.selected.vision]
  ]
  const expectedLicenses = []
  for (const [role, selected] of selections) {
    if (!exactKeys(selected, ['id', 'model', 'precision', 'runtime'])) {
      fail('packaged selected model records are invalid')
    }
    const expected = SELECTED_VARIANTS[selected.id]
    if (
      !expected ||
      expected.role !== role ||
      selected.model !== expected.model ||
      selected.precision !== expected.precision ||
      selected.runtime !== expected.runtime
    ) {
      fail(`packaged selected ${role} model is not reviewed`)
    }
    expectedLicenses.push(expected.licenseId)
  }

  if (!Array.isArray(manifest.assets) || !Array.isArray(manifest.licenses) || !Array.isArray(manifest.notices)) {
    fail('packaged manifest record lists are invalid')
  }
  const destinations = new Set()
  const recordIds = new Set()
  for (const asset of manifest.assets) {
    validateFileRecord(
      asset,
      ['id', 'variantId', 'component', 'destination', 'bytes', 'sha256'],
      'asset'
    )
    if (
      typeof asset.variantId !== 'string' ||
      typeof asset.component !== 'string' ||
      ![manifest.selected.text.id, manifest.selected.vision.id].includes(asset.variantId)
    ) {
      fail('packaged manifest contains an asset for an unselected variant')
    }
    if (destinations.has(asset.destination) || recordIds.has(asset.id)) {
      fail('packaged manifest contains an invalid or duplicate asset record')
    }
    destinations.add(asset.destination)
    recordIds.add(asset.id)
  }

  for (const [role, selected] of selections) {
    const expected = SELECTED_VARIANTS[selected.id]
    const assets = manifest.assets.filter((asset) => asset.variantId === selected.id)
    const components = assets.map((asset) => asset.component)
    if (!sameStrings(components, expected.components) || new Set(components).size !== components.length) {
      fail(`packaged ${role} assets do not match the exact reviewed component set`)
    }
    const destinationPrefix = `${role}/${selected.id}/`
    if (assets.some((asset) => !asset.destination.startsWith(destinationPrefix))) {
      fail(`packaged ${role} asset destination does not match its selected variant`)
    }
    if (
      role === 'text' &&
      (assets.length !== 1 || assets[0].component !== 'weights' || !assets[0].destination.toLowerCase().endsWith('.gguf'))
    ) {
      fail('packaged text selection must contain exactly one GGUF weights asset')
    }
  }

  for (const license of manifest.licenses) {
    validateFileRecord(license, ['id', 'destination', 'bytes', 'sha256'], 'license')
    if (destinations.has(license.destination) || recordIds.has(license.id)) {
      fail('packaged manifest contains an invalid or duplicate file record')
    }
    destinations.add(license.destination)
    recordIds.add(license.id)
  }
  if (!sameStrings(manifest.licenses.map((record) => record.id), expectedLicenses)) {
    fail('packaged licenses do not exactly match the selected variants')
  }

  for (const notice of manifest.notices) {
    validateFileRecord(notice, ['id', 'kind', 'destination', 'bytes', 'sha256'], 'notice')
    if (typeof notice.kind !== 'string' || !notice.kind) fail('packaged manifest contains an invalid notice record')
    if (destinations.has(notice.destination) || recordIds.has(notice.id)) {
      fail('packaged manifest contains an invalid or duplicate file record')
    }
    destinations.add(notice.destination)
    recordIds.add(notice.id)
  }
  return manifest
}

function importSpecifiers(source) {
  const specifiers = []
  const importLines = source.match(/^\s*import\b.*$/gm) ?? []
  const pattern = /^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"\n]+)['"]\s*;?\s*$/gm
  for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  if (importLines.length !== specifiers.length) fail('worker contains an unreviewed import form')
  return specifiers
}

export function validateWorkerSources(sources) {
  if (!plainRecord(sources) || !sameStrings(Object.keys(sources), WORKER_FILES)) {
    fail('packaged worker source set is not exact')
  }
  for (const name of WORKER_FILES) {
    const source = sources[name]
    if (typeof source !== 'string' || !source) fail(`packaged worker source is invalid: ${name}`)
    if (/\bimport\s*\(/.test(source) || /\brequire\s*\(/.test(source)) {
      fail(`dynamic imports and require calls are forbidden in ${name}`)
    }
    for (const [label, pattern] of FORBIDDEN_WORKER_SOURCE) {
      if (pattern.test(source)) fail(`forbidden worker source token ${label} in ${name}`)
    }
    const specifiers = importSpecifiers(source)
    if (name !== 'network-deny.mjs' && specifiers.some((specifier) => NETWORK_CORE_IMPORTS.has(specifier))) {
      fail(`network imports are forbidden outside network-deny.mjs: ${name}`)
    }
    if (!sameStrings(specifiers, WORKER_IMPORTS[name])) {
      fail(`worker imports are not exact: ${name}`)
    }
  }
  return sources
}

export function validatePackagedAsarEntries(input, platform) {
  if (!Object.hasOwn(TARGETS, platform)) fail(`unsupported platform ${platform}`)
  if (!input || typeof input[Symbol.iterator] !== 'function') fail('ASAR entries are invalid')
  const values = [...input]
  if (values.some((entry) => typeof entry !== 'string' || !entry || entry.includes('\\'))) {
    fail('ASAR entries are invalid')
  }
  const entries = new Set(values)
  const expectedWorkers = new Set([
    'out/local-ai-worker',
    ...WORKER_FILES.map((name) => `out/local-ai-worker/${name}`)
  ])
  const actualWorkers = [...entries].filter(
    (entry) => entry === 'out/local-ai-worker' || entry.startsWith('out/local-ai-worker/')
  )
  if (!sameStrings(actualWorkers, [...expectedWorkers])) fail('packaged worker file set is not exact')

  requireAsarEntry(entries, 'node_modules/node-llama-cpp/dist/index.js')
  requireAsarEntry(entries, 'node_modules/node-llama-cpp/package.json')
  requireAsarEntry(entries, 'node_modules/node-llama-cpp/llama/binariesGithubRelease.json')
  requireAsarEntry(entries, 'node_modules/node-llama-cpp/llama/llama.cpp.info.json')
  requireAsarEntry(entries, 'node_modules/node-llama-cpp/llama/package.json')
  requireAsarEntry(entries, 'node_modules/lifecycle-utils/package.json')
  for (const name of TARGETS[platform].nativePackages) {
    requireAsarEntry(entries, `node_modules/@node-llama-cpp/${name}/dist/index.js`)
    requireAsarEntry(entries, `node_modules/@node-llama-cpp/${name}/package.json`)
  }

  const llamaRoot = 'node_modules/node-llama-cpp/llama/'
  for (const entry of entries) {
    if (entry.includes('/llama/localBuilds/')) fail('node-llama localBuilds are forbidden')
    if (entry.startsWith(llamaRoot)) {
      const llamaPath = entry.slice(llamaRoot.length)
      if (
        FORBIDDEN_LLAMA_FILES.has(llamaPath) ||
        FORBIDDEN_LLAMA_DIRECTORIES.some(
          (directory) => llamaPath === directory || llamaPath.startsWith(`${directory}/`)
        )
      ) {
        fail(`node-llama source/build path is forbidden: ${llamaPath}`)
      }
    }
    const match = /^node_modules\/@node-llama-cpp\/([^/]+)\//.exec(entry)
    if (match && !TARGETS[platform].nativePackages.includes(match[1])) {
      fail(`wrong native package is present: ${match[1]}`)
    }
  }
  return entries
}

export function validateSherpaPackages(platform, packages) {
  if (!Object.hasOwn(TARGETS, platform)) fail(`unsupported platform ${platform}`)
  if (!plainRecord(packages) || !sameStrings(Object.keys(packages), TARGETS[platform].sherpaPackages)) {
    fail(`packaged Sherpa package set is not exact for ${platform}`)
  }
  for (const [packageName, files] of Object.entries(packages)) {
    if (!Array.isArray(files) || files.length === 0) fail(`packaged Sherpa package is empty: ${packageName}`)
    const paths = new Set()
    for (const file of files) {
      if (
        !exactKeys(file, ['path', 'bytes', 'nlink']) ||
        !safeDestination(file.path) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes <= 0 ||
        file.nlink !== 1 ||
        paths.has(file.path)
      ) {
        if (plainRecord(file) && typeof file.path === 'string' && file.path.endsWith('.node')) {
          fail(`packaged Sherpa native addon is invalid: ${packageName}`)
        }
        fail(`packaged Sherpa file is invalid: ${packageName}`)
      }
      paths.add(file.path)
    }
  }
  const nativeFiles = packages[TARGETS[platform].sherpaNativePackage]
  const addons = nativeFiles.filter((file) => file.path === 'sherpa-onnx.node')
  if (addons.length !== 1 || addons[0].bytes <= 0 || addons[0].nlink !== 1) {
    fail(`packaged Sherpa native addon is invalid for ${platform}`)
  }
  return packages
}

async function walkFiles(root) {
  const files = []
  const visit = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const stats = await fs.lstat(absolute)
      if (stats.isSymbolicLink()) fail(`symlink is forbidden: ${relative(root, absolute)}`)
      if (stats.isDirectory()) await visit(absolute)
      else if (stats.isFile()) files.push({ absolute, relative: relative(root, absolute).split('\\').join('/'), stats })
      else fail(`non-regular package entry is forbidden: ${relative(root, absolute)}`)
    }
  }
  await visit(root)
  return files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
}

async function verifyPayload(payloadRoot, platform, allowEvaluation) {
  const rootStats = await fs.lstat(payloadRoot)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) fail('packaged local-ai root is invalid')
  const manifestPath = join(payloadRoot, 'manifest.json')
  const manifestStats = await fs.lstat(manifestPath)
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.nlink !== 1) {
    fail('packaged local-ai manifest is not a regular file')
  }
  if (manifestStats.size <= 0 || manifestStats.size > 8 * 1024 * 1024) fail('packaged manifest size is invalid')
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {
    fail('packaged manifest is invalid JSON')
  }
  validatePackagedManifest(manifest, { platform, allowEvaluation })
  const groups = [manifest.assets, manifest.licenses, manifest.notices]
  const records = groups.flat()
  const destinations = new Set(records.map((record) => record.destination))

  const files = await walkFiles(payloadRoot)
  const actual = files.map((file) => file.relative)
  const expected = ['manifest.json', ...destinations].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('packaged local-ai file set is not exact')
  const byRelative = new Map(files.map((file) => [file.relative, file]))
  for (const record of records) {
    const file = byRelative.get(record.destination)
    if (!file || file.stats.nlink !== 1) fail(`packaged payload file is missing or hardlinked: ${record.destination}`)
    if (file.stats.size !== record.bytes) fail(`packaged payload size mismatch: ${record.destination}`)
    if ((await hashFile(file.absolute)) !== record.sha256) fail(`packaged payload hash mismatch: ${record.destination}`)
  }
  return manifest
}

function asarEntries(asarPath) {
  return new Set(listPackage(asarPath).map((entry) => entry.replace(/^\/+/, '')))
}

function requireAsarEntry(entries, entry) {
  if (!entries.has(entry)) fail(`missing ASAR entry ${entry}`)
}

function readAsarJson(asarPath, entry) {
  try {
    return JSON.parse(extractFile(asarPath, entry).toString('utf8'))
  } catch {
    fail(`invalid ASAR JSON ${entry}`)
  }
}

async function verifyNativeLayout(resources, asarPath, entries, platform) {
  const allowed = TARGETS[platform].nativePackages
  validatePackagedAsarEntries(entries, platform)
  validateWorkerSources(
    Object.fromEntries(
      WORKER_FILES.map((name) => [
        name,
        extractFile(asarPath, `out/local-ai-worker/${name}`).toString('utf8')
      ])
    )
  )
  if (readAsarJson(asarPath, 'node_modules/node-llama-cpp/package.json').version !== '3.19.0') {
    fail('node-llama-cpp must be exactly 3.19.0')
  }
  for (const name of allowed) {
    const base = `node_modules/@node-llama-cpp/${name}`
    if (readAsarJson(asarPath, `${base}/package.json`).version !== '3.19.0') {
      fail(`native package ${name} must be exactly 3.19.0`)
    }
  }

  const unpacked = `${asarPath}.unpacked`
  const forbiddenUnpacked = [
    join(unpacked, 'out', 'local-ai-worker'),
    join(unpacked, 'node_modules', 'node-llama-cpp', 'dist'),
    join(unpacked, 'node_modules', 'lifecycle-utils')
  ]
  for (const path of forbiddenUnpacked) {
    if (await fs.lstat(path).then(() => true, () => false)) fail(`JavaScript must remain in ASAR: ${relative(unpacked, path)}`)
  }

  const nativeRoot = join(unpacked, 'node_modules', '@node-llama-cpp')
  const nativeFiles = await walkFiles(nativeRoot)
  for (const file of nativeFiles) {
    const [packageName, firstDirectory] = file.relative.split('/')
    if (!allowed.includes(packageName) || firstDirectory !== 'bins') {
      fail(`unexpected unpacked node-llama file: ${file.relative}`)
    }
    if (file.stats.size <= 0 || file.stats.nlink !== 1) fail(`invalid unpacked native file: ${file.relative}`)
  }
  for (const name of allowed) {
    const names = new Set(nativeFiles.filter((file) => file.relative.startsWith(`${name}/bins/`)).map((file) => file.relative))
    if (![...names].some((name) => name.endsWith('/llama-addon.node'))) fail(`missing native addon for ${name}`)
    if (![...names].some((name) => name.endsWith('/_nlcBuildMetadata.json'))) fail(`missing native metadata for ${name}`)
  }

  const unpackedNodeModules = join(unpacked, 'node_modules')
  let packageEntries
  try {
    packageEntries = await fs.readdir(unpackedNodeModules, { withFileTypes: true })
  } catch {
    fail('unpacked node_modules is missing')
  }
  const sherpaPackages = Object.create(null)
  for (const entry of packageEntries.filter((candidate) => candidate.name.startsWith('sherpa-onnx'))) {
    const packageRoot = join(unpackedNodeModules, entry.name)
    const stats = await fs.lstat(packageRoot)
    if (!entry.isDirectory() || stats.isSymbolicLink()) fail(`packaged Sherpa package is invalid: ${entry.name}`)
    sherpaPackages[entry.name] = (await walkFiles(packageRoot)).map((file) => ({
      path: file.relative,
      bytes: file.stats.size,
      nlink: file.stats.nlink
    }))
  }
  validateSherpaPackages(platform, sherpaPackages)
}

export async function checkNodeLlamaPackage({ app, platform, allowEvaluation = false }) {
  if (!isAbsolute(app)) fail('--app must be absolute')
  if (!Object.hasOwn(TARGETS, platform)) fail(`unsupported platform ${platform}`)
  const appRoot = resolve(app)
  const appStats = await fs.lstat(appRoot)
  if (!appStats.isDirectory() || appStats.isSymbolicLink()) fail('app must be a real directory')
  const resources = TARGETS[platform].resources(appRoot)
  const asarPath = join(resources, 'app.asar')
  const asarStats = await fs.lstat(asarPath)
  if (!asarStats.isFile() || asarStats.isSymbolicLink() || asarStats.size <= 0) fail('app.asar is invalid')
  const entries = asarEntries(asarPath)
  await verifyNativeLayout(resources, asarPath, entries, platform)
  const manifest = await verifyPayload(join(resources, 'local-ai'), platform, allowEvaluation)
  return {
    app: appRoot,
    platform,
    textModel: manifest.selected.text.id,
    visionModel: manifest.selected.vision.id,
    nativePackages: TARGETS[platform].nativePackages
  }
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help') return { help: true }
    if (arg !== '--app' && arg !== '--platform') fail(`unknown argument ${arg}`)
    const value = args[++index]
    if (!value || value.startsWith('--') || options[arg.slice(2)]) fail(`${arg} requires one value`)
    options[arg.slice(2)] = value
  }
  return options
}

export async function runCheckNodeLlamaPackageCli(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  if (options.help) {
    console.log('Usage: node scripts/check-node-llama-package.mjs --platform <darwin-arm64|win32-x64> --app <absolute-app-path>')
    return
  }
  if (!options.app || !options.platform) fail('--app and --platform are required')
  const result = await checkNodeLlamaPackage({
    ...options,
    allowEvaluation: process.env.METIS_ALLOW_EVALUATION_PAYLOAD === '1'
  })
  console.log(`[check-node-llama-package] verified ${result.platform} ${result.textModel} + ${result.visionModel}`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCheckNodeLlamaPackageCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
