import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { Tokenizer, TokenizerMode } from 'parse5'
import { Input as CssInput } from 'postcss'
import CssParser from 'postcss/lib/parser'
import cssTokenizer from 'postcss/lib/tokenize'

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 512 * 1024 * 1024
const OLD_KATEX_MARKERS = Object.freeze([
  Buffer.from('version = "0.16.47"'),
  Buffer.from('katex@0.16.47'),
  Buffer.from('katex-HNBAO5SE'),
  Buffer.from('katex-CZ4GXH2S')
])
const MAX_SOURCE_SCAN_BYTES = 32 * 1024 * 1024
const EMBEDDED_KATEX_SIGNATURE =
  /(?:katex@0\.16\.47|version\s*=\s*["']0\.16\.47["']|[A-Za-z_$][\w$]*\s*=\s*["']0\.16\.47["'])/iu

function fail(code) {
  throw new Error(`renderer-katex-build-evidence:${code}`)
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
function parseArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--') || !argv[index + 1] || args.has(token.slice(2))) fail('ARGUMENTS')
    args.set(token.slice(2), argv[++index])
  }
  if (!args.has('observe'))
    for (const key of ['ordinary', 'observed', 'graph', 'out']) if (!args.has(key)) fail('ARGUMENTS')
  if (!args.has('observe') && !args.has('katex-tarball')) fail('ARGUMENTS')
  return args
}
function hashFile(path, maxBytes = MAX_FILE_BYTES) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    fail(`FILE_TYPE_OR_SIZE:${relative(process.cwd(), path)}`)
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash({ bytes: stat.size, sha256: hash.digest('hex') }))
      .on('error', reject)
  })
}
export async function inventoryTree(root) {
  const absoluteRoot = resolve(root)
  const rootStat = lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('ROOT_NOT_DIRECTORY')
  // Keep the traversal synchronous for a stable tree, then hash file contents with bounded streams.
  const paths = []
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) fail(`SYMLINK:${relative(absoluteRoot, path)}`)
      if (stat.isDirectory()) collect(path)
      else if (stat.isFile()) paths.push(path)
      else fail(`SPECIAL_FILE:${relative(absoluteRoot, path)}`)
      if (paths.length > MAX_FILES) fail('FILE_COUNT_LIMIT')
    }
  }
  collect(absoluteRoot)
  const inventory = []
  for (const path of paths)
    inventory.push({ path: relative(absoluteRoot, path).split(sep).join('/'), ...(await hashFile(path)) })
  return inventory.sort((a, b) => a.path.localeCompare(b.path))
}
function normalizeInventory(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) fail('INVENTORY_SCHEMA')
  const seen = new Set()
  const normalized = value.map((entry) => {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      entry.path.startsWith('/') ||
      entry.path.includes('..') ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256 || '')
    )
      fail('INVENTORY_ENTRY')
    if (seen.has(entry.path)) fail('INVENTORY_DUPLICATE_PATH')
    seen.add(entry.path)
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }
  })
  return normalized.sort((a, b) => a.path.localeCompare(b.path))
}
export function compareInventories(ordinary, observed) {
  const left = normalizeInventory(ordinary)
  const right = normalizeInventory(observed)
  if (JSON.stringify(left) !== JSON.stringify(right)) fail('ORDINARY_OBSERVED_BYTES_DIFFER')
  return { fileCount: left.length, sha256: sha256(Buffer.from(JSON.stringify(left))) }
}
function normalizeModuleId(value) {
  return String(value).replaceAll('\\', '/').split('?')[0]
}
function isOldMermaidRuntimeModule(id) {
  const normalized = normalizeModuleId(id)
  return /\/node_modules\/mermaid\/dist\/(?:chunks\/mermaid\.esm(?:\.min)?\/|mermaid\.esm(?:\.min)?\.m?js$|mermaid(?:\.min)?\.js$)/u.test(
    normalized
  )
}
export async function validateGraph(graph, outputInventory, sourceRoot = process.cwd()) {
  if (
    !graph ||
    graph.schema !== 1 ||
    !Array.isArray(graph.appEntries) ||
    graph.appEntries.length === 0 ||
    !Array.isArray(graph.modules) ||
    !Array.isArray(graph.externalModules) ||
    !Array.isArray(graph.chunks) ||
    !Array.isArray(graph.assets) ||
    !Array.isArray(graph.workers)
  )
    fail('GRAPH_SCHEMA_OR_EMPTY_ENTRY')
  const moduleIds = new Set()
  for (const module of graph.modules) {
    if (
      !module ||
      typeof module.id !== 'string' ||
      !module.id ||
      moduleIds.has(module.id) ||
      !Array.isArray(module.imports) ||
      !Array.isArray(module.dynamicImports) ||
      !Array.isArray(module.chunks) ||
      !Number.isSafeInteger(module.renderedLength) ||
      module.renderedLength < 0
    )
      fail('GRAPH_MODULE')
    moduleIds.add(module.id)
  }
  const externalIds = new Set(graph.externalModules)
  if (
    externalIds.size !== graph.externalModules.length ||
    [...externalIds].some((id) => typeof id !== 'string' || !id) ||
    externalIds.size > 0
  )
    fail('GRAPH_EXTERNAL_EXECUTABLE_UNCLASSIFIED')
  for (const module of graph.modules) {
    if (isOldMermaidRuntimeModule(module.id) && module.renderedLength > 0)
      fail(`OLD_MERMAID_RUNTIME_MODULE:${normalizeModuleId(module.id)}`)
    for (const id of [...module.imports, ...module.dynamicImports])
      if (!moduleIds.has(id) && !externalIds.has(id)) fail('GRAPH_MODULE_EDGE')
  }
  const outputFiles = new Set(outputInventory.map((entry) => entry.path))
  const emitted = new Set()
  const chunksByName = new Map()
  for (const chunk of graph.chunks) {
    if (
      !chunk ||
      typeof chunk.fileName !== 'string' ||
      !chunk.fileName ||
      emitted.has(chunk.fileName) ||
      typeof chunk.isEntry !== 'boolean' ||
      !Array.isArray(chunk.imports) ||
      !Array.isArray(chunk.dynamicImports) ||
      !Array.isArray(chunk.generatedAssets) ||
      !Array.isArray(chunk.moduleIds) ||
      chunk.moduleIds.some((id) => !moduleIds.has(id)) ||
      !Array.isArray(chunk.renderedModules) ||
      chunk.renderedModules.some(
        (module) =>
          !module ||
          !moduleIds.has(module.id) ||
          !Number.isSafeInteger(module.renderedLength) ||
          module.renderedLength < 0 ||
          !Array.isArray(module.renderedExports)
      ) ||
      JSON.stringify([...chunk.moduleIds].sort()) !==
        JSON.stringify(chunk.renderedModules.map((module) => module.id).sort())
    )
      fail('GRAPH_CHUNK')
    if (!Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0 || !/^[a-f0-9]{64}$/u.test(chunk.sha256 || ''))
      fail('GRAPH_CHUNK_IDENTITY')
    const output = outputInventory.find((entry) => entry.path === chunk.fileName)
    if (!output) fail(`GRAPH_OUTPUT_MISSING:${chunk.fileName}`)
    if (output.bytes !== chunk.bytes || output.sha256 !== chunk.sha256) fail('GRAPH_CHUNK_IDENTITY')
    emitted.add(chunk.fileName)
    chunksByName.set(chunk.fileName, chunk)
  }
  const chunkNames = new Set(graph.chunks.map((chunk) => chunk.fileName))
  for (const chunk of graph.chunks)
    for (const target of [...chunk.imports, ...chunk.dynamicImports])
      if (!chunkNames.has(target) && !externalIds.has(target)) fail('GRAPH_CHUNK_EDGE')
  for (const asset of graph.assets) {
    if (
      !asset ||
      typeof asset.fileName !== 'string' ||
      emitted.has(asset.fileName) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256 || '')
    )
      fail('GRAPH_ASSET')
    const output = outputInventory.find((entry) => entry.path === asset.fileName)
    if (!output || output.bytes !== asset.bytes || output.sha256 !== asset.sha256) fail('GRAPH_ASSET_IDENTITY')
    if (
      asset.source === undefined &&
      (!Array.isArray(asset.generatorModules) ||
        !asset.generatorModules.length ||
        asset.generatorModules.some((id) => !moduleIds.has(id)) ||
        !Array.isArray(asset.generatorChunks) ||
        !asset.generatorChunks.length ||
        asset.generatorChunks.some((name) => {
          const chunk = chunksByName.get(name)
          return (
            !chunk ||
            (!chunk.generatedAssets.includes(asset.fileName) &&
              !(
                /\.html$/iu.test(asset.fileName) &&
                normalizeModuleId(chunk.facadeModuleId || '').endsWith(`src/renderer/${asset.fileName}`)
              )) ||
            asset.generatorModules.some((id) => !chunk.moduleIds.includes(id))
          )
        }))
    )
      fail(`GRAPH_ASSET_GENERATOR_MISSING:${asset.fileName}`)
    emitted.add(asset.fileName)
  }
  for (const worker of graph.workers) {
    const chunk = worker && chunksByName.get(worker.fileName)
    if (
      !worker ||
      typeof worker.fileName !== 'string' ||
      !moduleIds.has(worker.entryModuleId) ||
      !chunk ||
      !chunk.isEntry ||
      !chunk.moduleIds.includes(worker.entryModuleId) ||
      worker.sha256 !== chunk.sha256 ||
      worker.bytes !== chunk.bytes ||
      !Array.isArray(worker.chunks) ||
      worker.chunks.length === 0 ||
      worker.chunks.some((record) => {
        const actual = chunksByName.get(record.fileName)
        return (
          !actual ||
          actual.isWorkerOutput !== true ||
          actual.bytes !== record.bytes ||
          actual.sha256 !== record.sha256 ||
          JSON.stringify([...actual.moduleIds].sort()) !== JSON.stringify([...record.moduleIds].sort())
        )
      })
    )
      fail('GRAPH_WORKER')
  }
  if (
    !graph.workers.length ||
    !graph.workers.some((worker) =>
      /\/src\/renderer\/src\/lib\/whisper\.worker\.ts$/u.test(normalizeModuleId(worker.entryModuleId))
    )
  )
    fail('GRAPH_REQUIRED_WORKER_MISSING')
  const workerChunkNames = new Set(graph.workers.flatMap((worker) => worker.chunks.map((chunk) => chunk.fileName)))
  if (graph.chunks.some((chunk) => chunk.isWorkerOutput === true && !workerChunkNames.has(chunk.fileName)))
    fail('GRAPH_WORKER_CHUNK_UNMAPPED')
  const outputChunkNames = new Set(chunkNames)
  const emittedMembership = new Map()
  for (const chunk of graph.chunks)
    for (const rendered of chunk.renderedModules) {
      const matches = emittedMembership.get(rendered.id) || []
      matches.push({ chunk: chunk.fileName, length: rendered.renderedLength })
      emittedMembership.set(rendered.id, matches)
      if (isOldMermaidRuntimeModule(rendered.id) && rendered.renderedLength > 0)
        fail(`OLD_MERMAID_RUNTIME_MODULE:${normalizeModuleId(rendered.id)}`)
    }
  for (const module of graph.modules) {
    for (const chunk of module.chunks) if (!outputChunkNames.has(chunk)) fail('GRAPH_MODULE_CHUNK_EDGE')
    const actual = emittedMembership.get(module.id) || []
    if (
      JSON.stringify([...module.chunks].sort()) !== JSON.stringify(actual.map((entry) => entry.chunk).sort()) ||
      module.renderedLength !== Math.max(0, ...actual.map((entry) => entry.length))
    )
      fail(`GRAPH_MODULE_RENDERED_MEMBERSHIP:${module.id}`)
  }
  for (const file of emitted) if (!outputFiles.has(file)) fail('GRAPH_OUTPUT_MISSING')
  const publicFiles = new Set()
  for (const publicFile of graph.publicFiles || []) {
    if (
      !publicFile ||
      typeof publicFile.path !== 'string' ||
      typeof publicFile.source !== 'string' ||
      !publicFile.source.startsWith('src/renderer/public/') ||
      !Number.isSafeInteger(publicFile.bytes) ||
      !/^[a-f0-9]{64}$/u.test(publicFile.sha256 || '') ||
      publicFiles.has(publicFile.path)
    )
      fail('GRAPH_PUBLIC_FILE')
    const output = outputInventory.find((entry) => entry.path === publicFile.path)
    if (
      !output ||
      output.bytes !== publicFile.bytes ||
      output.sha256 !== publicFile.sha256 ||
      emitted.has(publicFile.path)
    )
      fail('GRAPH_PUBLIC_IDENTITY')
    emitted.add(publicFile.path)
    publicFiles.add(publicFile.path)
  }
  for (const file of outputFiles) if (!emitted.has(file)) fail(`OUTPUT_UNMAPPED:${file}`)
  for (const asset of graph.assets) {
    if (/\.(?:js|mjs|cjs)$/iu.test(asset.fileName)) fail('EXECUTABLE_ASSET_PROVENANCE_MISSING')
    if (/\.wasm$/iu.test(asset.fileName) && asset.source === undefined) fail('EXECUTABLE_ASSET_PROVENANCE_MISSING')
    if (asset.source !== undefined) {
      if (
        typeof asset.source !== 'string' ||
        !asset.source ||
        asset.source.startsWith('/') ||
        asset.source.split(/[\\/]/u).includes('..') ||
        (/\.wasm$/iu.test(asset.fileName) && !/^node_modules\/onnxruntime-web\/dist\/[^/]+\.wasm$/u.test(asset.source))
      )
        fail('EXECUTABLE_ASSET_PROVENANCE_MISSING')
      const source = await hashFile(resolve(sourceRoot, asset.source))
      if (source.bytes !== asset.bytes || source.sha256 !== asset.sha256) fail('EXECUTABLE_ASSET_SOURCE_MISMATCH')
    }
  }
  const expectedEntries = ['src/renderer/index.html', 'src/renderer/decoder.html']
  const normalizedEntries = graph.appEntries.map((entry) => normalizeModuleId(entry))
  if (
    JSON.stringify(normalizedEntries.map((entry) => entry.replace(/^.*(?=src\/renderer\/)/u, '')).sort()) !==
    JSON.stringify([...expectedEntries].sort())
  )
    fail('GRAPH_APP_ENTRY_SET')
  for (const entry of expectedEntries) {
    const module = graph.modules.find((candidate) => normalizeModuleId(candidate.id).endsWith(entry))
    if (
      !module ||
      !graph.chunks.some((chunk) => chunk.isEntry && normalizeModuleId(chunk.facadeModuleId || '').endsWith(entry))
    )
      fail(`GRAPH_APP_ENTRY_NOT_EMITTED:${entry}`)
  }
  const markdown = graph.modules.filter((module) =>
    /\/src\/renderer\/src\/components\/Markdown\.(tsx|ts)$/u.test(normalizeModuleId(module.id))
  )
  const streamdown = graph.modules.filter((module) =>
    /\/node_modules\/streamdown\//u.test(normalizeModuleId(module.id))
  )
  if (
    !markdown.some((module) => module.renderedLength > 0 && module.chunks.some((chunk) => chunkNames.has(chunk))) ||
    !streamdown.some((module) => module.renderedLength > 0 && module.chunks.some((chunk) => chunkNames.has(chunk)))
  )
    fail('PRODUCTION_MARKDOWN_MEMBERSHIP_MISSING')
  return {
    moduleCount: graph.modules.length,
    chunkCount: graph.chunks.length,
    assetCount: graph.assets.length,
    workerCount: graph.workers.length,
    publicFileCount: publicFiles.size,
    appEntries: graph.appEntries
  }
}

const MAX_REFERENCE_INVENTORY_PATH_UNITS = 8 * 1024 * 1024
const MAX_REFERENCE_SELECTED_BYTES = 256 * 1024 * 1024
const MAX_REFERENCE_READ_WINDOW = 64 * 1024
const MAX_REFERENCE_HTML_CALLBACKS = 250_000
const MAX_REFERENCE_HTML_ATTRIBUTES_PER_TAG = 64
const MAX_REFERENCE_HTML_ATTRIBUTES = 250_000
const MAX_REFERENCE_HTML_ATTRIBUTE_UNITS = 65_536
const MAX_REFERENCE_HTML_DEPTH = 128
const MAX_REFERENCE_CSS_LINES = 262_144
const MAX_REFERENCE_CSS_OPERATIONS = 2_000_000
const MAX_REFERENCE_CSS_NODES = 250_000
const MAX_REFERENCE_CSS_DEPTH = 128
const MAX_REFERENCE_CSS_COMPONENTS = 1_000_000
const MAX_REFERENCE_CSS_FIELD_UNITS = 1024 * 1024
const MAX_REFERENCE_URL_UNITS = 16_384
const MAX_REFERENCE_RESULTS = 20_000
const MAX_REFERENCE_RESULT_UNITS = 8 * 1024 * 1024
const REFERENCE_SENTINEL = '/__renderer_root__/'
const REFERENCE_ORIGIN = 'http://renderer.invalid'
const CSS_FUNCTIONS = new Set(
  'var env calc min max clamp round mod rem sin cos tan asin acos atan atan2 pow sqrt hypot log exp abs sign rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark contrast-color device-cmyk matrix matrix3d translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d rotate rotatex rotatey rotatez rotate3d skew skewx skewy perspective linear-gradient repeating-linear-gradient radial-gradient repeating-radial-gradient conic-gradient repeating-conic-gradient blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia cubic-bezier steps linear minmax repeat fit-content inset circle ellipse polygon path rect xywh shape counter counters symbols local format tech selector style layer is where not has nth-child nth-last-child lang dir host host-context slotted part'.split(
    ' '
  )
)
const CSS_AT_RULES = new Set(
  'charset import media supports layer container font-face keyframes -webkit-keyframes property starting-style page scope counter-style font-palette-values'.split(
    ' '
  )
)
const HTML_TAGS = new Set(
  'html head body meta title script link style div span p main section article header footer aside nav h1 h2 h3 h4 h5 h6 button pre code ul ol li dl dt dd strong em b i small br hr img iframe object embed'.split(
    ' '
  )
)
const HTML_VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'embed'])
const HTML_GLOBAL_ATTRIBUTES = new Set(['id', 'class', 'title', 'style', 'lang', 'dir', 'role', 'hidden', 'tabindex'])
const HTML_TAG_ATTRIBUTES = new Map([
  ['meta', new Set(['charset', 'name', 'content', 'http-equiv'])],
  [
    'script',
    new Set([
      'src',
      'type',
      'async',
      'defer',
      'nomodule',
      'integrity',
      'crossorigin',
      'referrerpolicy',
      'fetchpriority',
      'nonce'
    ])
  ],
  [
    'link',
    new Set([
      'href',
      'rel',
      'as',
      'type',
      'media',
      'integrity',
      'crossorigin',
      'referrerpolicy',
      'fetchpriority',
      'disabled'
    ])
  ],
  ['style', new Set(['type', 'media', 'nonce'])],
  [
    'img',
    new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding', 'fetchpriority', 'crossorigin', 'referrerpolicy'])
  ],
  [
    'iframe',
    new Set(['src', 'width', 'height', 'loading', 'referrerpolicy', 'sandbox', 'allow', 'allowfullscreen', 'name'])
  ],
  ['object', new Set(['data', 'type', 'width', 'height', 'name'])],
  ['embed', new Set(['src', 'type', 'width', 'height'])],
  ['button', new Set(['type', 'disabled', 'name', 'value'])]
])

function referenceFailure(code, sourcePath) {
  fail(sourcePath === undefined ? code : code + ':' + sourcePath)
}

function isReferenceFailure(error) {
  return error instanceof Error && error.message.startsWith('renderer-katex-build-evidence:')
}

function asciiLower(value) {
  let lowered = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    lowered += String.fromCharCode(code >= 0x41 && code <= 0x5a ? code + 0x20 : code)
  }
  return lowered
}

function asciiEqualRange(value, start, end, expected) {
  if (end - start !== expected.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    let code = value.charCodeAt(start + index)
    if (code >= 0x41 && code <= 0x5a) code += 0x20
    if (code !== expected.charCodeAt(index)) return false
  }
  return true
}

function isAsciiWhitespaceCode(code) {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20
}

function isCssWhitespaceCode(code) {
  return isAsciiWhitespaceCode(code)
}

function isAsciiControlCode(code) {
  return code === 0 || (code < 0x20 && !isCssWhitespaceCode(code)) || code === 0x7f
}

function isForbiddenCssCodePoint(code) {
  return code === 0 || (code < 0x20 && !isCssWhitespaceCode(code)) || code === 0x7f
}

function createReferenceBudget() {
  return {
    selectedBytes: 0,
    htmlCallbacks: 0,
    htmlAttributes: 0,
    cssOperations: 0,
    cssNodes: 0,
    cssComponents: 0,
    resultCount: 0,
    resultUnits: 0
  }
}

function chargeHtmlCallback(budget, sourcePath) {
  budget.htmlCallbacks += 1
  if (budget.htmlCallbacks > MAX_REFERENCE_HTML_CALLBACKS) referenceFailure('HTML_REFERENCE_CALLBACK_LIMIT', sourcePath)
}

function chargeCssOperation(budget, sourcePath) {
  budget.cssOperations += 1
  if (budget.cssOperations > MAX_REFERENCE_CSS_OPERATIONS) referenceFailure('CSS_REFERENCE_TOKEN_LIMIT', sourcePath)
}

function chargeCssComponent(budget, sourcePath) {
  budget.cssComponents += 1
  if (budget.cssComponents > MAX_REFERENCE_CSS_COMPONENTS) referenceFailure('CSS_REFERENCE_COMPONENT_LIMIT', sourcePath)
}

function validateReferencePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 16_384 || path.startsWith('/'))
    referenceFailure('REFERENCE_SCAN_INVENTORY')
  let segmentStart = 0
  for (let index = 0; index <= path.length; index += 1) {
    if (index !== path.length && path[index] !== '/') continue
    const length = index - segmentStart
    if (
      length === 0 ||
      (length === 1 && path[segmentStart] === '.') ||
      (length === 2 && path.slice(segmentStart, index) === '..')
    )
      referenceFailure('REFERENCE_SCAN_INVENTORY')
    segmentStart = index + 1
  }
}

function sameReferenceStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function lstatReferenceSource(absoluteRoot, sourcePath) {
  try {
    const rootStat = lstatSync(absoluteRoot, { bigint: true })
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
    let absolutePath = absoluteRoot
    const segments = sourcePath.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      if (sep === '\\' && (segments[index].includes('\\') || segments[index].includes(':')))
        referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
      absolutePath = join(absolutePath, segments[index])
      const current = lstatSync(absolutePath, { bigint: true })
      if (current.isSymbolicLink()) referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
      if (index === segments.length - 1) {
        if (!current.isFile()) referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
      } else if (!current.isDirectory()) {
        referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
      }
      if (index === segments.length - 1) return { absolutePath, stat: current }
    }
  } catch (error) {
    if (isReferenceFailure(error)) throw error
    referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
  }
  referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
}

function readReferenceSource(absoluteRoot, entry, budget) {
  const sourcePath = entry.path
  const admitted = lstatReferenceSource(absoluteRoot, sourcePath)
  const size = admitted.stat.size
  if (size > BigInt(MAX_SOURCE_SCAN_BYTES)) referenceFailure('REFERENCE_SCAN_SIZE', sourcePath)
  if (budget.selectedBytes + Number(size) > MAX_REFERENCE_SELECTED_BYTES)
    referenceFailure('REFERENCE_SCAN_TOTAL_SIZE', sourcePath)
  budget.selectedBytes += Number(size)

  const hasBytes = entry.bytes !== undefined
  const hasHash = entry.sha256 !== undefined
  if (
    hasBytes !== hasHash ||
    (hasBytes &&
      (!Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256)))
  )
    referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)

  let fd
  let bytes
  try {
    fd = openSync(admitted.absolutePath, 'r')
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || !sameReferenceStat(admitted.stat, before))
      referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
    if (hasBytes && BigInt(entry.bytes) !== before.size) referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)

    const admittedSize = Number(before.size)
    bytes = Buffer.allocUnsafe(admittedSize)
    let delivered = 0
    while (delivered < admittedSize) {
      const window = Math.min(MAX_REFERENCE_READ_WINDOW, admittedSize - delivered)
      const count = readSync(fd, bytes, delivered, window, delivered)
      if (count <= 0) referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
      delivered += count
    }
    const eofProbe = Buffer.allocUnsafe(1)
    if (readSync(fd, eofProbe, 0, 1, admittedSize) !== 0) referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)

    const after = fstatSync(fd, { bigint: true })
    const afterPath = lstatReferenceSource(absoluteRoot, sourcePath).stat
    if (!sameReferenceStat(before, after) || !sameReferenceStat(before, afterPath) || delivered !== admittedSize)
      referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
    if (hasHash && sha256(bytes) !== entry.sha256) referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
  } catch (error) {
    if (isReferenceFailure(error)) throw error
    referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        referenceFailure('REFERENCE_SCAN_CHANGED', sourcePath)
      }
    }
  }

  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    referenceFailure('REFERENCE_SCAN_UTF8', sourcePath)
  }
  bytes = undefined
  return source
}

function recordReferenceTarget(sourcePath, rawTarget, role, filePaths, references, budget) {
  if (typeof rawTarget !== 'string') referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  if (role !== 'source-map' && rawTarget.length > MAX_REFERENCE_URL_UNITS)
    referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  let target = rawTarget
  let start = 0
  let end = target.length
  while (start < end && target.charCodeAt(start) === 0x20) start += 1
  while (end > start && target.charCodeAt(end - 1) === 0x20) end -= 1
  target = target.slice(start, end)
  if (role !== 'source-map' && target.length > MAX_REFERENCE_URL_UNITS)
    referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  for (let index = 0; index < target.length; index += 1) {
    const code = target.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f || code === 0x5c) referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  }
  if (!target || target.startsWith('?')) referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  if (target.startsWith('#')) return

  const explicitScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
  const protocolRelative = target.startsWith('//')
  if (role === 'source-map' && (explicitScheme || protocolRelative)) return
  if (role === 'executable' && (explicitScheme || protocolRelative))
    referenceFailure('EXTERNAL_EXECUTABLE_REFERENCE', sourcePath)
  if (role === 'image' && (explicitScheme || protocolRelative)) {
    let remote
    try {
      remote = new URL(target, 'https://renderer.invalid/')
    } catch {
      referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
    }
    if (remote.protocol !== 'http:' && remote.protocol !== 'https:')
      referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
    return
  }

  const sourceSegments = sourcePath.split('/')
  sourceSegments.pop()
  let encodedDirectory
  try {
    encodedDirectory = sourceSegments.map((segment) => encodeURIComponent(segment)).join('/')
  } catch {
    referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  }
  const base = new URL(REFERENCE_ORIGIN + REFERENCE_SENTINEL + (encodedDirectory ? encodedDirectory + '/' : ''))
  const localInput = target.startsWith('/') ? REFERENCE_ORIGIN + REFERENCE_SENTINEL + target.slice(1) : target
  let resolved
  try {
    resolved = new URL(localInput, base)
  } catch {
    referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  }
  if (resolved.origin !== REFERENCE_ORIGIN || !resolved.pathname.startsWith(REFERENCE_SENTINEL))
    referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  if (/%(?:2f|5c)/iu.test(resolved.pathname)) referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)

  let decodedPath
  try {
    decodedPath = decodeURIComponent(resolved.pathname)
  } catch {
    referenceFailure('REFERENCE_ENCODING', sourcePath)
  }
  if (!decodedPath.startsWith(REFERENCE_SENTINEL)) referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  const resolvedTarget = decodedPath.slice(REFERENCE_SENTINEL.length)
  const targetSegments = resolvedTarget.split('/')
  if (
    resolvedTarget.length === 0 ||
    targetSegments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.includes('\\') ||
        /[\u0000-\u001f\u007f]/u.test(segment)
    )
  )
    referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  if (resolvedTarget.length > MAX_REFERENCE_URL_UNITS) referenceFailure('REFERENCE_URL_UNSUPPORTED', sourcePath)
  if (!filePaths.has(resolvedTarget)) fail('LOCAL_ASSET_TARGET_MISSING:' + sourcePath + ':' + resolvedTarget)

  const resultUnits = sourcePath.length + resolvedTarget.length
  if (budget.resultCount + 1 > MAX_REFERENCE_RESULTS || budget.resultUnits + resultUnits > MAX_REFERENCE_RESULT_UNITS)
    referenceFailure('REFERENCE_RESULT_LIMIT', sourcePath)
  budget.resultCount += 1
  budget.resultUnits += resultUnits
  references.push({ source: sourcePath, target: resolvedTarget })
}

function cssUnsupported(sourcePath) {
  referenceFailure('CSS_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
}

function readCssString(value, start, sourcePath) {
  const quote = value[start]
  if (quote !== '"' && quote !== "'") cssUnsupported(sourcePath)
  let index = start + 1
  let hadEscape = false
  while (index < value.length) {
    const character = value[index]
    const code = value.charCodeAt(index)
    if (character === quote) return { end: index + 1, contentStart: start + 1, contentEnd: index, hadEscape }
    if (code === 0 || character === '\n' || character === '\r' || character === '\f') cssUnsupported(sourcePath)
    if (character !== '\\') {
      index += 1
      continue
    }

    hadEscape = true
    index += 1
    if (index >= value.length) cssUnsupported(sourcePath)
    const escaped = value[index]
    const escapedCode = value.charCodeAt(index)
    if (escapedCode === 0) cssUnsupported(sourcePath)
    if (escaped === '\n' || escaped === '\f') {
      index += 1
      continue
    }
    if (escaped === '\r') {
      index += index + 1 < value.length && value[index + 1] === '\n' ? 2 : 1
      continue
    }
    if (/[0-9a-f]/iu.test(escaped)) {
      const hexStart = index
      let digits = 0
      while (index < value.length && digits < 6 && /[0-9a-f]/iu.test(value[index])) {
        index += 1
        digits += 1
      }
      if (isForbiddenCssCodePoint(Number.parseInt(value.slice(hexStart, index), 16))) cssUnsupported(sourcePath)
      if (index < value.length && isCssWhitespaceCode(value.charCodeAt(index))) {
        if (value[index] === '\r' && value[index + 1] === '\n') index += 2
        else index += 1
      }
      continue
    }
    index += 1
  }
  cssUnsupported(sourcePath)
}

function validateCssEscapes(value, sourcePath) {
  let index = 0
  while (index < value.length) {
    if (value[index] !== '\\') {
      index += 1
      continue
    }
    index += 1
    if (index >= value.length) cssUnsupported(sourcePath)
    const next = value[index]
    const code = value.charCodeAt(index)
    if (code === 0 || next === '\n' || next === '\r' || next === '\f') cssUnsupported(sourcePath)
    if (/[0-9a-f]/iu.test(next)) {
      const hexStart = index
      let digits = 0
      while (index < value.length && digits < 6 && /[0-9a-f]/iu.test(value[index])) {
        index += 1
        digits += 1
      }
      if (isForbiddenCssCodePoint(Number.parseInt(value.slice(hexStart, index), 16))) cssUnsupported(sourcePath)
      if (index < value.length && isCssWhitespaceCode(value.charCodeAt(index))) {
        if (value[index] === '\r' && value[index + 1] === '\n') index += 2
        else index += 1
      }
    } else {
      index += 1
    }
  }
}

function countCssLines(css, sourcePath) {
  let lines = 1
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === '\r' || css[index] === '\n' || css[index] === '\f') {
      lines += 1
      if (lines > MAX_REFERENCE_CSS_LINES) referenceFailure('CSS_REFERENCE_LINE_LIMIT', sourcePath)
      if (css[index] === '\r' && css[index + 1] === '\n') index += 1
    }
    const code = css.charCodeAt(index)
    if (isAsciiControlCode(code)) cssUnsupported(sourcePath)
  }
}

function validateCollapsedCssBrackets(tokenValue, sourcePath) {
  if (tokenValue.length < 2 || tokenValue[0] !== '(' || tokenValue[tokenValue.length - 1] !== ')')
    cssUnsupported(sourcePath)
  for (let index = 1; index < tokenValue.length - 1; index += 1) {
    const character = tokenValue[index]
    if (
      character === '"' ||
      character === "'" ||
      character === '\\' ||
      character === '\n' ||
      character === '\r' ||
      character === '\f' ||
      (character === '/' && tokenValue[index + 1] === '*') ||
      character === '('
    )
      cssUnsupported(sourcePath)
  }
}

function preflightCss(input, sourcePath, budget) {
  const tokenizer = cssTokenizer(input)
  const delimiters = []
  try {
    while (!tokenizer.endOfFile()) {
      chargeCssOperation(budget, sourcePath)
      const token = tokenizer.nextToken()
      if (!token || typeof token[0] !== 'string' || typeof token[1] !== 'string') cssUnsupported(sourcePath)
      const type = token[0]
      const value = token[1]
      if (type === 'string') {
        const string = readCssString(value, 0, sourcePath)
        if (string.end !== value.length) cssUnsupported(sourcePath)
      } else if (type === 'comment') {
        if (!value.startsWith('/*') || !value.endsWith('*/')) cssUnsupported(sourcePath)
      } else if (type === 'brackets') {
        validateCollapsedCssBrackets(value, sourcePath)
        if (delimiters.length + 1 > MAX_REFERENCE_CSS_DEPTH) referenceFailure('CSS_REFERENCE_DEPTH_LIMIT', sourcePath)
        const nested = []
        for (let index = 1; index < value.length - 1; index += 1) {
          const character = value[index]
          if (character === '[' || character === '{') {
            if (delimiters.length + nested.length + 2 > MAX_REFERENCE_CSS_DEPTH)
              referenceFailure('CSS_REFERENCE_DEPTH_LIMIT', sourcePath)
            nested.push(character === '[' ? ']' : '}')
          } else if (character === ']' || character === '}') {
            if (nested.pop() !== character) cssUnsupported(sourcePath)
          }
        }
        if (nested.length !== 0) cssUnsupported(sourcePath)
      } else if (type === '(' || type === '[' || type === '{') {
        if (delimiters.length + 1 > MAX_REFERENCE_CSS_DEPTH) referenceFailure('CSS_REFERENCE_DEPTH_LIMIT', sourcePath)
        delimiters.push(type === '(' ? ')' : type === '[' ? ']' : '}')
      } else if (type === ')' || type === ']' || type === '}') {
        if (delimiters.pop() !== type) cssUnsupported(sourcePath)
      } else if (type === 'word' || type === 'at-word') {
        if (value.includes('\\')) validateCssEscapes(value, sourcePath)
      } else if (type !== 'space' && type !== ',' && type !== ':' && type !== ';') {
        cssUnsupported(sourcePath)
      }
    }
  } catch (error) {
    if (isReferenceFailure(error)) throw error
    cssUnsupported(sourcePath)
  }
  if (delimiters.length !== 0) cssUnsupported(sourcePath)
}

function isCssWhitespace(value, index) {
  return isCssWhitespaceCode(value.charCodeAt(index))
}

function skipCssSeparators(value, start, budget, sourcePath) {
  let index = start
  while (index < value.length) {
    if (isCssWhitespace(value, index)) {
      chargeCssComponent(budget, sourcePath)
      do {
        index += 1
      } while (index < value.length && isCssWhitespace(value, index))
      continue
    }
    if (value[index] === '/' && value[index + 1] === '*') {
      chargeCssComponent(budget, sourcePath)
      const end = value.indexOf('*/', index + 2)
      if (end === -1) cssUnsupported(sourcePath)
      index = end + 2
      continue
    }
    break
  }
  return index
}

function nextAfterCssSeparators(value, start, sourcePath) {
  let index = start
  while (index < value.length) {
    if (isCssWhitespace(value, index)) {
      index += 1
      continue
    }
    if (value[index] === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2)
      if (end === -1) cssUnsupported(sourcePath)
      index = end + 2
      continue
    }
    break
  }
  return index
}

function parseCssUrlFunction(value, openIndex, sourcePath, budget, onUrl) {
  chargeCssComponent(budget, sourcePath)
  let index = openIndex + 1
  while (index < value.length && isCssWhitespace(value, index)) {
    chargeCssComponent(budget, sourcePath)
    do {
      index += 1
    } while (index < value.length && isCssWhitespace(value, index))
  }
  if (index >= value.length || (value[index] === '/' && value[index + 1] === '*')) cssUnsupported(sourcePath)

  let targetStart
  let targetEnd
  if (value[index] === '"' || value[index] === "'") {
    chargeCssComponent(budget, sourcePath)
    const string = readCssString(value, index, sourcePath)
    if (string.hadEscape) cssUnsupported(sourcePath)
    targetStart = string.contentStart
    targetEnd = string.contentEnd
    index = string.end
    while (index < value.length && isCssWhitespace(value, index)) {
      chargeCssComponent(budget, sourcePath)
      do {
        index += 1
      } while (index < value.length && isCssWhitespace(value, index))
    }
    if (index >= value.length || value[index] !== ')') cssUnsupported(sourcePath)
  } else {
    targetStart = index
    while (index < value.length && value[index] !== ')') {
      const character = value[index]
      const code = value.charCodeAt(index)
      if (isCssWhitespaceCode(code)) break
      if (
        code === 0 ||
        code < 0x20 ||
        code === 0x7f ||
        character === '\\' ||
        character === '"' ||
        character === "'" ||
        character === '(' ||
        (character === '/' && value[index + 1] === '*')
      )
        cssUnsupported(sourcePath)
      index += 1
    }
    targetEnd = index
    if (targetEnd === targetStart) cssUnsupported(sourcePath)
    while (index < value.length && isCssWhitespace(value, index)) {
      chargeCssComponent(budget, sourcePath)
      do {
        index += 1
      } while (index < value.length && isCssWhitespace(value, index))
    }
    if (index >= value.length || value[index] !== ')') cssUnsupported(sourcePath)
  }
  if (targetEnd - targetStart > MAX_REFERENCE_URL_UNITS) cssUnsupported(sourcePath)
  chargeCssComponent(budget, sourcePath)
  const target = value.slice(targetStart, targetEnd)
  if (!target) cssUnsupported(sourcePath)
  onUrl(target)
  chargeCssComponent(budget, sourcePath)
  return index + 1
}

function isCssDigit(value, index) {
  const code = value.charCodeAt(index)
  return code >= 0x30 && code <= 0x39
}

function isCssNameStart(value, index) {
  const code = value.charCodeAt(index)
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code >= 0x80
}

function isCssNameCharacter(value, index) {
  return isCssNameStart(value, index) || isCssDigit(value, index) || value[index] === '-'
}

function startsCssIdentifier(value, index) {
  return value[index] === '-'
    ? isCssNameStart(value, index + 1) || value[index + 1] === '-'
    : isCssNameStart(value, index)
}

function startsCssNumber(value, index) {
  if (value[index] === '+' || value[index] === '-') index += 1
  return isCssDigit(value, index) || (value[index] === '.' && isCssDigit(value, index + 1))
}

function consumeCssNumber(value, index) {
  if (value[index] === '+' || value[index] === '-') index += 1
  while (isCssDigit(value, index)) index += 1
  if (value[index] === '.' && isCssDigit(value, index + 1)) {
    index += 1
    while (isCssDigit(value, index)) index += 1
  }
  if (value[index] === 'e' || value[index] === 'E') {
    let exponent = index + 1
    if (value[exponent] === '+' || value[exponent] === '-') exponent += 1
    if (isCssDigit(value, exponent)) {
      index = exponent + 1
      while (isCssDigit(value, index)) index += 1
    }
  }
  if (value[index] === '%') index += 1
  else if (startsCssIdentifier(value, index)) {
    do {
      index += 1
    } while (isCssNameCharacter(value, index))
  }
  return index
}

function scanCssComponents(value, sourcePath, budget, onUrl) {
  if (typeof value !== 'string' || value.length > MAX_REFERENCE_CSS_FIELD_UNITS)
    referenceFailure('CSS_REFERENCE_COMPONENT_LIMIT', sourcePath)
  const delimiters = []
  let index = 0
  while (index < value.length) {
    const character = value[index]
    const code = value.charCodeAt(index)
    if (isAsciiControlCode(code)) cssUnsupported(sourcePath)
    if (isCssWhitespaceCode(code)) {
      chargeCssComponent(budget, sourcePath)
      do {
        index += 1
      } while (index < value.length && isCssWhitespace(value, index))
      continue
    }
    if (character === '/' && value[index + 1] === '*') {
      chargeCssComponent(budget, sourcePath)
      const end = value.indexOf('*/', index + 2)
      if (end === -1) cssUnsupported(sourcePath)
      index = end + 2
      continue
    }
    if (character === '"' || character === "'") {
      chargeCssComponent(budget, sourcePath)
      index = readCssString(value, index, sourcePath).end
      continue
    }
    if (character === '(' || character === '[' || character === '{') {
      chargeCssComponent(budget, sourcePath)
      if (delimiters.length + 1 > MAX_REFERENCE_CSS_DEPTH) referenceFailure('CSS_REFERENCE_DEPTH_LIMIT', sourcePath)
      delimiters.push(character === '(' ? ')' : character === '[' ? ']' : '}')
      index += 1
      continue
    }
    if (character === ')' || character === ']' || character === '}') {
      chargeCssComponent(budget, sourcePath)
      if (delimiters.pop() !== character) cssUnsupported(sourcePath)
      index += 1
      continue
    }
    if (character === '\\') cssUnsupported(sourcePath)
    if (startsCssNumber(value, index)) {
      chargeCssComponent(budget, sourcePath)
      index = consumeCssNumber(value, index)
      if (value[index] === '(') cssUnsupported(sourcePath)
      continue
    }
    if (startsCssIdentifier(value, index)) {
      chargeCssComponent(budget, sourcePath)
      const nameStart = index
      do {
        index += 1
      } while (isCssNameCharacter(value, index))
      const name = asciiLower(value.slice(nameStart, index))
      if (value[index] === '(') {
        if (name === 'url') {
          index = parseCssUrlFunction(value, index, sourcePath, budget, onUrl)
          continue
        }
        if (!CSS_FUNCTIONS.has(name)) cssUnsupported(sourcePath)
      } else if (name === 'url') {
        const next = nextAfterCssSeparators(value, index, sourcePath)
        if (value[next] === '(') cssUnsupported(sourcePath)
      }
      continue
    }
    if (character === '#' && isCssNameCharacter(value, index + 1)) {
      chargeCssComponent(budget, sourcePath)
      index += 1
      do {
        index += 1
      } while (isCssNameCharacter(value, index))
      if (value[index] === '(') cssUnsupported(sourcePath)
      continue
    }
    if ('!#$%&*+-./:;<=>?@^|~,'.includes(character)) {
      chargeCssComponent(budget, sourcePath)
      index += 1
      continue
    }
    cssUnsupported(sourcePath)
  }
  if (delimiters.length !== 0) cssUnsupported(sourcePath)
}

function scanCssSeparators(value, sourcePath) {
  let index = 0
  while (index < value.length) {
    if (isCssWhitespace(value, index)) {
      index += 1
      continue
    }
    if (value[index] === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2)
      if (end === -1) cssUnsupported(sourcePath)
      index = end + 2
      continue
    }
    cssUnsupported(sourcePath)
  }
}

function combineCssAtRuleFields(node, sourcePath) {
  const afterName = typeof node.raws.afterName === 'string' ? node.raws.afterName : ''
  const rawParams = typeof node.raws.params?.raw === 'string' ? node.raws.params.raw : node.params
  const between = typeof node.raws.between === 'string' ? node.raws.between : ''
  if (
    typeof rawParams !== 'string' ||
    afterName.length > MAX_REFERENCE_CSS_FIELD_UNITS ||
    rawParams.length > MAX_REFERENCE_CSS_FIELD_UNITS ||
    between.length > MAX_REFERENCE_CSS_FIELD_UNITS ||
    afterName.length + rawParams.length + between.length > MAX_REFERENCE_CSS_FIELD_UNITS
  )
    referenceFailure('CSS_REFERENCE_COMPONENT_LIMIT', sourcePath)
  scanCssSeparators(afterName, sourcePath)
  scanCssSeparators(between, sourcePath)
  return { rawParams, complete: afterName + rawParams + between }
}

function parseCssImportTarget(value, sourcePath, budget, onUrl) {
  let index = skipCssSeparators(value, 0, budget, sourcePath)
  if (index >= value.length) cssUnsupported(sourcePath)
  if (value[index] === '"' || value[index] === "'") {
    chargeCssComponent(budget, sourcePath)
    const string = readCssString(value, index, sourcePath)
    if (string.hadEscape || string.contentEnd - string.contentStart > MAX_REFERENCE_URL_UNITS)
      cssUnsupported(sourcePath)
    chargeCssComponent(budget, sourcePath)
    onUrl(value.slice(string.contentStart, string.contentEnd))
    index = string.end
  } else {
    const start = index
    while (index < value.length && /[A-Za-z0-9_-]/u.test(value[index])) index += 1
    if (!asciiEqualRange(value, start, index, 'url') || value[index] !== '(') cssUnsupported(sourcePath)
    chargeCssComponent(budget, sourcePath)
    index = parseCssUrlFunction(value, index, sourcePath, budget, onUrl)
  }
  index = skipCssSeparators(value, index, budget, sourcePath)
  if (index !== value.length) cssUnsupported(sourcePath)
}

function parseCssCharset(value, sourcePath, budget) {
  let index = skipCssSeparators(value, 0, budget, sourcePath)
  if (index >= value.length || (value[index] !== '"' && value[index] !== "'")) cssUnsupported(sourcePath)
  chargeCssComponent(budget, sourcePath)
  const string = readCssString(value, index, sourcePath)
  if (string.hadEscape) cssUnsupported(sourcePath)
  const encoding = asciiLower(value.slice(string.contentStart, string.contentEnd))
  if (encoding !== 'utf-8' && encoding !== 'utf8') cssUnsupported(sourcePath)
  index = skipCssSeparators(value, string.end, budget, sourcePath)
  if (index !== value.length) cssUnsupported(sourcePath)
}

function rawCssDeclarationValue(node, sourcePath) {
  const raw = typeof node.raws.value?.raw === 'string' ? node.raws.value.raw : node.value
  if (typeof raw !== 'string' || raw.length > MAX_REFERENCE_CSS_FIELD_UNITS)
    referenceFailure('CSS_REFERENCE_COMPONENT_LIMIT', sourcePath)
  return raw
}

function scanCssReferences(css, sourcePath, mode, budget, onUrl) {
  if (typeof css !== 'string') cssUnsupported(sourcePath)
  if (mode !== 'stylesheet' && mode !== 'declarations') cssUnsupported(sourcePath)
  countCssLines(css, sourcePath)
  let input
  try {
    input = new CssInput(css, { from: sourcePath, map: false })
  } catch (error) {
    if (isReferenceFailure(error)) throw error
    cssUnsupported(sourcePath)
  }
  preflightCss(input, sourcePath, budget)

  const depths = new WeakMap()
  const nodeBudget = { count: 1 }
  budget.cssNodes += 1
  if (budget.cssNodes > MAX_REFERENCE_CSS_NODES) referenceFailure('CSS_REFERENCE_NODE_LIMIT', sourcePath)
  class BoundedCssParser extends CssParser {
    createTokenizer() {
      const tokenizer = cssTokenizer(this.input)
      depths.set(this.root, 0)
      this.tokenizer = {
        back: (token) => {
          chargeCssOperation(budget, sourcePath)
          tokenizer.back(token)
        },
        endOfFile: () => tokenizer.endOfFile(),
        nextToken: (options) => {
          chargeCssOperation(budget, sourcePath)
          return tokenizer.nextToken(options)
        },
        position: () => tokenizer.position()
      }
    }

    init(node, offset) {
      const parentDepth = depths.get(this.current)
      if (parentDepth === undefined) cssUnsupported(sourcePath)
      if (nodeBudget.count + 1 > MAX_REFERENCE_CSS_NODES || budget.cssNodes + 1 > MAX_REFERENCE_CSS_NODES)
        referenceFailure('CSS_REFERENCE_NODE_LIMIT', sourcePath)
      if (parentDepth + 1 > MAX_REFERENCE_CSS_DEPTH) referenceFailure('CSS_REFERENCE_DEPTH_LIMIT', sourcePath)
      nodeBudget.count += 1
      budget.cssNodes += 1
      super.init(node, offset)
      depths.set(node, parentDepth + 1)
    }
  }

  let parser
  try {
    parser = new BoundedCssParser(input)
    parser.parse()
  } catch (error) {
    if (isReferenceFailure(error)) throw error
    cssUnsupported(sourcePath)
  }

  const work = []
  const pushWork = (node) => {
    if (work.length + 1 > MAX_REFERENCE_CSS_NODES) referenceFailure('CSS_REFERENCE_NODE_LIMIT', sourcePath)
    work.push(node)
  }
  pushWork(parser.root)
  let visited = 0
  while (work.length > 0) {
    const node = work.pop()
    visited += 1
    if (visited > nodeBudget.count) referenceFailure('CSS_REFERENCE_NODE_LIMIT', sourcePath)
    const depth = depths.get(node)
    if (depth === undefined || depth > MAX_REFERENCE_CSS_DEPTH)
      referenceFailure('CSS_REFERENCE_DEPTH_LIMIT', sourcePath)

    if (node.type === 'decl') {
      if (mode === 'declarations' && depth !== 1) cssUnsupported(sourcePath)
      if (node.nodes) cssUnsupported(sourcePath)
      if (
        typeof node.prop !== 'string' ||
        node.prop.length > MAX_REFERENCE_CSS_FIELD_UNITS ||
        !/^(?:[A-Za-z_][A-Za-z0-9_-]*|-?[A-Za-z_][A-Za-z0-9_-]*|--[A-Za-z0-9_-]+)$/u.test(node.prop)
      )
        cssUnsupported(sourcePath)
      scanCssComponents(rawCssDeclarationValue(node, sourcePath), sourcePath, budget, onUrl)
      continue
    }

    if (node.type === 'atrule') {
      if (mode === 'declarations') cssUnsupported(sourcePath)
      if (typeof node.name !== 'string' || !/^-?[A-Za-z][A-Za-z0-9-]*$/u.test(node.name)) cssUnsupported(sourcePath)
      const name = asciiLower(node.name)
      if (!CSS_AT_RULES.has(name)) cssUnsupported(sourcePath)
      const fields = combineCssAtRuleFields(node, sourcePath)
      if (name === 'charset') {
        if (node.nodes) cssUnsupported(sourcePath)
        parseCssCharset(fields.complete, sourcePath, budget)
      } else if (name === 'import') {
        if (node.nodes) cssUnsupported(sourcePath)
        parseCssImportTarget(fields.complete, sourcePath, budget, onUrl)
      } else {
        scanCssComponents(node.raws.afterName || '', sourcePath, budget, onUrl)
        scanCssComponents(fields.rawParams, sourcePath, budget, onUrl)
        scanCssComponents(node.raws.between || '', sourcePath, budget, onUrl)
      }
    } else if (node.type === 'rule') {
      if (mode === 'declarations') cssUnsupported(sourcePath)
      if (typeof node.selector !== 'string') cssUnsupported(sourcePath)
    } else if (node.type !== 'root' && node.type !== 'comment') {
      cssUnsupported(sourcePath)
    }

    if (node.nodes !== undefined) {
      if (!Array.isArray(node.nodes)) cssUnsupported(sourcePath)
      if (
        mode === 'declarations' &&
        node.type === 'root' &&
        node.nodes.some((child) => child.type !== 'decl' && child.type !== 'comment')
      )
        cssUnsupported(sourcePath)
      for (let index = node.nodes.length - 1; index >= 0; index -= 1) pushWork(node.nodes[index])
    }
  }
}

function asciiWhitespaceTokenEquals(value, expected) {
  let index = 0
  let tokenCount = 0
  let matched = false
  while (index < value.length) {
    while (index < value.length && isAsciiWhitespaceCode(value.charCodeAt(index))) index += 1
    if (index >= value.length) break
    const start = index
    while (index < value.length && !isAsciiWhitespaceCode(value.charCodeAt(index))) index += 1
    tokenCount += 1
    if (tokenCount > 1) return false
    matched = asciiEqualRange(value, start, index, expected)
  }
  return tokenCount === 1 && matched
}

function htmlAttributeAllowed(tagName, attributeName) {
  if (HTML_GLOBAL_ATTRIBUTES.has(attributeName)) return true
  if (/^(?:aria|data)-[a-z0-9-]+$/u.test(attributeName)) return true
  const tagAttributes = HTML_TAG_ATTRIBUTES.get(tagName)
  return tagAttributes ? tagAttributes.has(attributeName) : false
}

function isAsciiWhitespaceText(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (!isAsciiWhitespaceCode(value.charCodeAt(index))) return false
  }
  return true
}

function scanHtmlReferences(source, sourcePath, absoluteSourcePath, budget, recordTarget) {
  const stack = []
  let tokenizer
  let doctypeSeen = false
  let startTagSeen = false
  let styleUnits = 0
  const activeRawContext = () => (stack.length > 0 ? stack[stack.length - 1].tag : undefined)
  const handleText = (token) => {
    const chars = token.chars
    if (typeof chars !== 'string') referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
    const rawTag = activeRawContext()
    if (rawTag === 'style') {
      styleUnits += chars.length
      if (styleUnits > MAX_SOURCE_SCAN_BYTES) referenceFailure('HTML_REFERENCE_STYLE_LIMIT', sourcePath)
      stack[stack.length - 1].styleParts.push(chars)
    } else if ((rawTag === 'script' || rawTag === 'iframe') && !isAsciiWhitespaceText(chars)) {
      referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
    }
  }
  const handler = {
    onCharacter(token) {
      chargeHtmlCallback(budget, sourcePath)
      handleText(token)
    },
    onComment() {
      chargeHtmlCallback(budget, sourcePath)
    },
    onDoctype(token) {
      chargeHtmlCallback(budget, sourcePath)
      if (doctypeSeen || startTagSeen || asciiLower(token.name || '') !== 'html' || token.publicId || token.systemId)
        referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
      doctypeSeen = true
    },
    onEndTag(token) {
      chargeHtmlCallback(budget, sourcePath)
      const tagName = token.tagName
      if (typeof tagName !== 'string' || !HTML_TAGS.has(tagName) || tagName.includes(':'))
        referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
      const frame = stack[stack.length - 1]
      if (!frame || frame.tag !== tagName || HTML_VOID_TAGS.has(tagName))
        referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
      if (tagName === 'style')
        scanCssReferences(frame.styleParts.join(''), absoluteSourcePath, 'stylesheet', budget, (target) =>
          recordTarget(sourcePath, target, 'executable')
        )
      stack.pop()
      if (tagName === 'title' || tagName === 'style' || tagName === 'script' || tagName === 'iframe')
        tokenizer.state = TokenizerMode.DATA
    },
    onEof() {
      chargeHtmlCallback(budget, sourcePath)
      if (stack.length > 1 || (stack.length === 1 && stack[0].tag !== 'html'))
        referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
    },
    onNullCharacter() {
      chargeHtmlCallback(budget, sourcePath)
      referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
    },
    onParseError(error) {
      chargeHtmlCallback(budget, sourcePath)
      if (error.code !== 'missing-semicolon-after-character-reference')
        referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
    },
    onStartTag(token) {
      chargeHtmlCallback(budget, sourcePath)
      const tagName = token.tagName
      if (typeof tagName !== 'string' || !HTML_TAGS.has(tagName) || tagName.includes(':'))
        referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
      startTagSeen = true
      const isVoid = HTML_VOID_TAGS.has(tagName)
      if (!isVoid && token.selfClosing) referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
      const attrs = Array.isArray(token.attrs) ? token.attrs : []
      if (attrs.length > MAX_REFERENCE_HTML_ATTRIBUTES_PER_TAG)
        referenceFailure('HTML_REFERENCE_ATTRIBUTE_LIMIT', sourcePath)
      budget.htmlAttributes += attrs.length
      if (budget.htmlAttributes > MAX_REFERENCE_HTML_ATTRIBUTES)
        referenceFailure('HTML_REFERENCE_ATTRIBUTE_LIMIT', sourcePath)
      const values = new Map()
      for (const attribute of attrs) {
        if (
          !attribute ||
          typeof attribute.name !== 'string' ||
          typeof attribute.value !== 'string' ||
          attribute.name.length > MAX_REFERENCE_HTML_ATTRIBUTE_UNITS ||
          attribute.value.length > MAX_REFERENCE_HTML_ATTRIBUTE_UNITS ||
          attribute.prefix ||
          attribute.namespace
        )
          referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
        const name = asciiLower(attribute.name)
        if (name.includes(':') || values.has(name) || !htmlAttributeAllowed(tagName, name))
          referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
        values.set(name, attribute.value)
      }

      const charset = values.get('charset')
      if (
        tagName === 'meta' &&
        charset !== undefined &&
        !asciiEqualRange(charset, 0, charset.length, 'utf-8') &&
        !asciiEqualRange(charset, 0, charset.length, 'utf8')
      )
        referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
      const httpEquiv = values.get('http-equiv')
      if (
        tagName === 'meta' &&
        httpEquiv !== undefined &&
        !asciiEqualRange(httpEquiv, 0, httpEquiv.length, 'content-security-policy')
      )
        referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)

      const styleAttribute = values.get('style')
      if (styleAttribute !== undefined)
        scanCssReferences(styleAttribute, absoluteSourcePath, 'declarations', budget, (target) =>
          recordTarget(sourcePath, target, 'executable')
        )

      let targetAttribute
      let role
      if (tagName === 'script' || tagName === 'iframe' || tagName === 'embed') {
        targetAttribute = 'src'
        role = 'executable'
      } else if (tagName === 'object') {
        targetAttribute = 'data'
        role = 'executable'
      } else if (tagName === 'img') {
        targetAttribute = 'src'
        role = 'image'
      } else if (tagName === 'link') {
        targetAttribute = 'href'
        role =
          asciiWhitespaceTokenEquals(values.get('rel') || '', 'preload') &&
          asciiWhitespaceTokenEquals(values.get('as') || '', 'image')
            ? 'image'
            : 'executable'
      }
      if (targetAttribute !== undefined && values.has(targetAttribute))
        recordTarget(sourcePath, values.get(targetAttribute), role)

      if (!isVoid) {
        if (stack.length + 1 > MAX_REFERENCE_HTML_DEPTH) referenceFailure('HTML_REFERENCE_DEPTH_LIMIT', sourcePath)
        stack.push({ tag: tagName, styleParts: tagName === 'style' ? [] : undefined })
        if (tagName === 'title') tokenizer.state = TokenizerMode.RCDATA
        else if (tagName === 'style' || tagName === 'iframe') tokenizer.state = TokenizerMode.RAWTEXT
        else if (tagName === 'script') tokenizer.state = TokenizerMode.SCRIPT_DATA
      }
    },
    onWhitespaceCharacter(token) {
      chargeHtmlCallback(budget, sourcePath)
      handleText(token)
    }
  }

  try {
    tokenizer = new Tokenizer({ sourceCodeLocationInfo: false }, handler)
    if (source.length === 0) {
      tokenizer.write('', true)
    } else {
      let offset = 0
      while (offset < source.length) {
        const end = Math.min(offset + MAX_REFERENCE_READ_WINDOW, source.length)
        const chunk = source.slice(offset, end)
        tokenizer.write(chunk, end === source.length)
        offset = end
      }
    }
  } catch (error) {
    if (isReferenceFailure(error)) throw error
    referenceFailure('HTML_REFERENCE_GRAMMAR_UNSUPPORTED', sourcePath)
  }
}

export function validateLocalAssetReferences(outputRoot, inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0 || inventory.length > MAX_FILES)
    fail('REFERENCE_SCAN_INVENTORY')
  let inventoryPathUnits = 0
  for (const entry of inventory) {
    if (!entry || typeof entry.path !== 'string') fail('REFERENCE_SCAN_INVENTORY')
    validateReferencePath(entry.path)
    inventoryPathUnits += entry.path.length
    if (inventoryPathUnits > MAX_REFERENCE_INVENTORY_PATH_UNITS) fail('REFERENCE_SCAN_INVENTORY')
  }
  const filePaths = new Set()
  for (const entry of inventory) {
    if (filePaths.has(entry.path)) fail('REFERENCE_SCAN_INVENTORY')
    filePaths.add(entry.path)
  }

  const absoluteRoot = resolve(outputRoot)
  const references = []
  const budget = createReferenceBudget()
  const sourceMapPattern = /sourceMappingURL=([^\s*]+)/gu
  const recordTarget = (sourcePath, target, role) =>
    recordReferenceTarget(sourcePath, target, role, filePaths, references, budget)
  let scannedFileCount = 0
  for (const entry of inventory) {
    const html = /\.html$/iu.test(entry.path)
    const css = /\.css$/iu.test(entry.path)
    const javascript = /\.(?:js|mjs|cjs)$/iu.test(entry.path)
    if (!html && !css && !javascript) continue
    scannedFileCount += 1
    let source = readReferenceSource(absoluteRoot, entry, budget)
    const absoluteSourcePath = join(absoluteRoot, ...entry.path.split('/'))
    if (html) {
      scanHtmlReferences(source, entry.path, absoluteSourcePath, budget, recordTarget)
    } else if (css) {
      scanCssReferences(source, absoluteSourcePath, 'stylesheet', budget, (target) =>
        recordTarget(entry.path, target, 'executable')
      )
    } else {
      for (const match of source.matchAll(sourceMapPattern)) recordTarget(entry.path, match[1], 'source-map')
    }
    source = undefined
  }
  return {
    scannedFileCount,
    localReferenceCount: references.length,
    references
  }
}
async function validatePublicSourceInventory(root, graph, outputInventory) {
  const sourceRoot = resolve(root, 'src/renderer/public')
  const sources = await inventoryTree(sourceRoot)
  const expected = sources.map((entry) => ({
    path: entry.path,
    source: `src/renderer/public/${entry.path}`,
    bytes: entry.bytes,
    sha256: entry.sha256
  }))
  const actual = (graph.publicFiles || [])
    .map((entry) => ({ path: entry.path, source: entry.source, bytes: entry.bytes, sha256: entry.sha256 }))
    .sort((a, b) => a.source.localeCompare(b.source))
  if (!expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) fail('PUBLIC_SOURCE_INVENTORY_MISMATCH')
  const outputPaths = new Set(outputInventory.map((entry) => entry.path))
  for (const source of expected) if (!outputPaths.has(source.path)) fail(`PUBLIC_OUTPUT_MISSING:${source.path}`)
  return {
    sourceRoot: 'src/renderer/public',
    files: expected.length,
    sha256: sha256(Buffer.from(JSON.stringify(expected)))
  }
}
let workerObservationSequence = 0
export function createViteObserverPlugin(reportPath, { worker = false, outerConfig } = {}) {
  const reportFile = reportPath.startsWith('file:') ? fileURLToPath(reportPath) : resolve(reportPath)
  let root = process.cwd()
  let appEntries = []
  let workerEntryIds = []
  let resolvedConfig
  let configEvidence
  const captureBundle = (context, bundle) => {
    const moduleIds = [...context.getModuleIds()]
    const externalModules = new Set()
    const modules = moduleIds
      .filter((id) => {
        const info = context.getModuleInfo(id)
        if (!info) fail('OBSERVER_MODULE_INFO_MISSING')
        if (info.isExternal) {
          externalModules.add(id)
          return false
        }
        return true
      })
      .map((id) => {
        const info = context.getModuleInfo(id)
        if (!info) fail('OBSERVER_MODULE_INFO_MISSING')
        for (const imported of [...info.importedIds, ...info.dynamicallyImportedIds]) {
          if (context.getModuleInfo(imported)?.isExternal) externalModules.add(imported)
        }
        const chunks = Object.values(bundle)
          .filter((output) => output.type === 'chunk' && Object.hasOwn(output.modules, id))
          .map((output) => output.fileName)
        const renderedLength = Math.max(
          0,
          ...Object.values(bundle)
            .filter((output) => output.type === 'chunk')
            .map((output) => output.modules[id]?.renderedLength ?? 0)
        )
        return { id, imports: info.importedIds, dynamicImports: info.dynamicallyImportedIds, chunks, renderedLength }
      })
    return { moduleIds, externalModules, modules }
  }
  return {
    name: worker ? 'renderer-katex-worker-observer' : 'renderer-katex-production-observer',
    apply: 'build',
    configResolved(config) {
      resolvedConfig = config
      root = config.root
      const configFiles = [
        ...new Set([config.configFile, ...(config.configFileDependencies || [])].filter(Boolean))
      ].sort()
      configEvidence = {
        outerConfig: outerConfig && {
          path: relative(process.cwd(), resolve(outerConfig.path)).split(sep).join('/'),
          files: [...new Set([outerConfig.path, ...outerConfig.dependencies])].sort().map((path) => ({
            path: relative(process.cwd(), resolve(path)).split(sep).join('/'),
            sha256: sha256(readFileSync(path))
          }))
        },
        configFiles: configFiles.map((path) => ({
          path: relative(process.cwd(), resolve(path)).split(sep).join('/'),
          sha256: sha256(readFileSync(path))
        })),
        pluginNames: config.plugins.map((plugin) => plugin.name).filter((name) => typeof name === 'string'),
        command: config.command,
        mode: config.mode,
        root: relative(process.cwd(), resolve(config.root)).split(sep).join('/'),
        publicDir: config.publicDir ? relative(process.cwd(), resolve(config.publicDir)).split(sep).join('/') : null,
        build: {
          outDir: relative(process.cwd(), resolve(config.root, config.build.outDir)).split(sep).join('/'),
          target: config.build.target,
          sourcemap: config.build.sourcemap,
          minify: config.build.minify,
          cssCodeSplit: config.build.cssCodeSplit,
          manifest: config.build.manifest,
          rollupInputs: config.build.rollupOptions?.input
        }
      }
      if (
        !worker &&
        (config.command !== 'build' ||
          config.mode !== 'production' ||
          resolve(root) !== resolve(process.cwd(), 'src/renderer'))
      )
        fail('OBSERVER_NOT_PRODUCTION_RENDERER_CONFIG')
      const inputs = config.build.rollupOptions?.input
      if (Array.isArray(inputs)) workerEntryIds = inputs.map((entry) => resolve(root, entry))
      else if (typeof inputs === 'string') workerEntryIds = [resolve(root, inputs)]
      else if (inputs && typeof inputs === 'object')
        workerEntryIds = Object.values(inputs)
          .filter((entry) => typeof entry === 'string')
          .map((entry) => resolve(root, entry))
      if (!worker) appEntries = workerEntryIds.map((entry) => relative(process.cwd(), entry).split(sep).join('/'))
    },
    async generateBundle(_output, bundle) {
      if (worker) await observeBundle(this, bundle)
    },
    async writeBundle(_output, bundle) {
      if (!worker) await observeBundle(this, bundle)
    }
  }
  async function observeBundle(context, bundle) {
    const { moduleIds, externalModules, modules } = await captureBundle(context, bundle)
    const chunks = Object.values(bundle)
      .filter((output) => output.type === 'chunk')
      .map((output) => ({
        fileName: output.fileName,
        isWorkerOutput: worker,
        isEntry: output.isEntry,
        imports: output.imports,
        dynamicImports: output.dynamicImports,
        generatedAssets: [
          ...(output.viteMetadata?.importedCss || []),
          ...(output.viteMetadata?.importedAssets || [])
        ].sort(),
        bytes: Buffer.byteLength(output.code),
        sha256: sha256(Buffer.from(output.code)),
        facadeModuleId: output.facadeModuleId,
        moduleIds: Object.keys(output.modules),
        renderedModules: Object.entries(output.modules).map(([id, value]) => ({
          id,
          renderedLength: value.renderedLength,
          renderedExports: value.renderedExports
        }))
      }))
    const assets = await Promise.all(
      Object.values(bundle)
        .filter((output) => output.type === 'asset')
        .map(async (output) => {
          const bytes = Buffer.isBuffer(output.source) ? output.source : Buffer.from(output.source)
          const identity = sha256(bytes)
          const wasmSources = []
          if (/\.wasm$/iu.test(output.fileName))
            for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.wasm']) {
              const path = `node_modules/onnxruntime-web/dist/${name}`
              if (existsSync(resolve(process.cwd(), path))) {
                const source = await hashFile(resolve(process.cwd(), path))
                if (source.bytes === bytes.byteLength && source.sha256 === identity) wasmSources.push(path)
              }
            }
          const originalFiles = [
            ...new Set(
              (output.originalFileNames || []).flatMap((name) => [resolve(root, name), resolve(process.cwd(), name)])
            )
          ]
          const sourceMatches = []
          for (const path of originalFiles) {
            if (existsSync(path)) {
              const original = await hashFile(path)
              if (original.bytes === bytes.byteLength && original.sha256 === identity)
                sourceMatches.push(relative(process.cwd(), path).split(sep).join('/'))
            }
          }
          const generatorChunks = chunks.filter(
            (chunk) =>
              chunk.generatedAssets.includes(output.fileName) ||
              (/\.html$/iu.test(output.fileName) &&
                normalizeModuleId(chunk.facadeModuleId || '').endsWith(`src/renderer/${output.fileName}`))
          )
          const generator = generatorChunks.find((chunk) => chunk.moduleIds.length > 0)
          const generatorModules = generator?.moduleIds || []
          if (/\.wasm$/iu.test(output.fileName) && wasmSources.length !== 1)
            fail(`EXECUTABLE_ASSET_PROVENANCE_MISSING:${output.fileName}`)
          return {
            fileName: output.fileName,
            bytes: bytes.byteLength,
            sha256: identity,
            ...(wasmSources.length === 1
              ? { source: wasmSources[0] }
              : sourceMatches.length === 1
                ? { source: sourceMatches[0] }
                : { generatorChunks: generator ? [generator.fileName] : [], generatorModules })
          }
        })
    )
    const entryIds = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.facadeModuleId)
    const workerOutputs = worker
      ? chunks
          .filter((chunk) => chunk.isEntry)
          .map((chunk) => ({
            fileName: chunk.fileName,
            entryModuleId: chunk.facadeModuleId,
            bytes: chunk.bytes,
            sha256: chunk.sha256,
            chunks: chunks.map(({ fileName, bytes, sha256, moduleIds, isEntry }) => ({
              fileName,
              bytes,
              sha256,
              moduleIds,
              isEntry
            }))
          }))
      : []
    const outputRoot = resolve(root, resolvedConfig.build.outDir)
    const publicRoot =
      resolvedConfig.publicDir && resolvedConfig.publicDir !== false ? resolve(root, resolvedConfig.publicDir) : null
    const publicFiles = []
    if (!worker && publicRoot && existsSync(publicRoot)) {
      const publicInventory = await inventoryTree(publicRoot)
      for (const entry of publicInventory) {
        const outputPath = relative(outputRoot, resolve(outputRoot, entry.path)).split(sep).join('/')
        if (outputPath.startsWith('../')) fail('OBSERVER_PUBLIC_OUTPUT_ESCAPE')
        publicFiles.push({
          path: outputPath,
          source: relative(process.cwd(), resolve(publicRoot, entry.path)).split(sep).join('/'),
          bytes: entry.bytes,
          sha256: entry.sha256
        })
      }
    }
    const evidence = {
      schema: 1,
      worker,
      appEntries,
      modules,
      externalModules: [...externalModules].sort(),
      chunks,
      assets,
      workers: workerOutputs,
      publicFiles,
      config: configEvidence
    }
    mkdirSync(dirname(reportFile), { recursive: true })
    const target = worker
      ? `${reportFile}.${sha256(Buffer.from(JSON.stringify(entryIds))).slice(0, 12)}.${++workerObservationSequence}.json`
      : reportFile
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
  }
}
export function findEmbeddedOldKaTeX(relativePath, bytes) {
  const path = relativePath.replaceAll('\\', '/').replace(/^\/+/, '')
  if (
    /^node_modules\/mermaid\/dist\/chunks\/mermaid\.esm(?:\.min)?\/katex-(?:HNBAO5SE|CZ4GXH2S)\.mjs(?:\.map)?$/u.test(
      path
    )
  )
    return true
  if (path.endsWith('/package.json')) {
    let metadata
    try {
      metadata = JSON.parse(bytes.toString('utf8'))
    } catch {
      fail(`PACKAGE_METADATA_JSON:${path}`)
    }
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      typeof metadata.name !== 'string' ||
      typeof metadata.version !== 'string'
    )
      fail(`PACKAGE_METADATA_SCHEMA:${path}`)
    const { dependencies, optionalDependencies, peerDependencies, devDependencies, overrides, ...other } = metadata
    if (EMBEDDED_KATEX_SIGNATURE.test(JSON.stringify(other))) return true
    const descriptors = [dependencies, optionalDependencies, peerDependencies, devDependencies, overrides]
    if (descriptors.some((value) => value !== undefined && (typeof value !== 'object' || Array.isArray(value))))
      fail(`PACKAGE_METADATA_DEPENDENCIES:${path}`)
    return false
  }
  if (bytes.length > MAX_SOURCE_SCAN_BYTES) fail(`OLD_SOURCE_SCAN_SIZE:${path}`)
  if (/\.map$/iu.test(path) || bytes.subarray(0, Math.min(bytes.length, 2048)).includes(Buffer.from('"sources"'))) {
    let map
    try {
      map = JSON.parse(bytes.toString('utf8'))
    } catch {
      fail(`SOURCE_MAP_JSON:${path}`)
    }
    if (!Array.isArray(map.sources) || (map.sourcesContent !== undefined && !Array.isArray(map.sourcesContent)))
      fail(`SOURCE_MAP_SCHEMA:${path}`)
    const sourceTexts = [...map.sources, ...(map.sourcesContent || [])].filter((entry) => typeof entry === 'string')
    if (sourceTexts.some((entry) => EMBEDDED_KATEX_SIGNATURE.test(entry))) return true
  }
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return false
  for (const match of text.matchAll(/sourceMappingURL=(data:[^\s*]+)/gu)) {
    const uri = match[1]
    const separator = uri.indexOf(',')
    if (
      separator < 0 ||
      !/^data:application\/(?:json|octet-stream)(?:;charset=utf-8)?(?:;base64)?$/iu.test(uri.slice(0, separator))
    )
      fail(`INLINE_SOURCE_MAP_ENCODING:${path}`)
    const payload = uri.slice(separator + 1)
    let mapBytes
    if (uri.slice(0, separator).endsWith(';base64')) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) fail(`INLINE_SOURCE_MAP_ENCODING:${path}`)
      mapBytes = Buffer.from(payload, 'base64')
    } else {
      try {
        mapBytes = Buffer.from(decodeURIComponent(payload), 'utf8')
      } catch {
        fail(`INLINE_SOURCE_MAP_ENCODING:${path}`)
      }
    }
    if (mapBytes.length > MAX_SOURCE_SCAN_BYTES) fail(`INLINE_SOURCE_MAP_SIZE:${path}`)
    if (findEmbeddedOldKaTeX(`${path}.map`, mapBytes)) return true
  }
  return OLD_KATEX_MARKERS.some((marker) => bytes.includes(marker)) || EMBEDDED_KATEX_SIGNATURE.test(text)
}
export async function validateKaTeXArchive({ root, tarball, graph }) {
  const archiveBytes = readFileSync(tarball)
  if (archiveBytes.length === 0 || archiveBytes.length > 32 * 1024 * 1024) fail('KATEX_TARBALL_SIZE')
  const archiveIntegrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`
  const expectedIntegrity =
    'sha512-3snve4y0SXTMequLim1FMiPvLGElySam0blN5xQZBqEY3lOJz1TnuaaiugnBZBqHzlSAGmFTYL7MCQkORuLKCA=='
  if (archiveIntegrity !== expectedIntegrity) fail('KATEX_TARBALL_SRI')
  let tar
  try {
    tar = gunzipSync(archiveBytes, { maxOutputLength: 128 * 1024 * 1024 })
  } catch {
    fail('KATEX_TARBALL_GZIP')
  }
  const members = new Map()
  let offset = 0
  let zeroBlocks = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1
      offset += 512
      if (zeroBlocks === 2) break
      continue
    }
    zeroBlocks = 0
    const storedChecksum = Number.parseInt(header.toString('ascii', 148, 156).replaceAll('\0', '').trim(), 8)
    let checksum = 0
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index]
    if (!Number.isInteger(storedChecksum) || checksum !== storedChecksum) fail('KATEX_TARBALL_HEADER_CHECKSUM')
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/su, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/su, '')
    const path = `${prefix ? `${prefix}/` : ''}${name}`
    const sizeText = header.toString('ascii', 124, 136).replace(/\0.*$/su, '').trim()
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0
    const type = header.toString('ascii', 156, 157)
    if (
      !path ||
      path.startsWith('/') ||
      path.split('/').some((part) => part === '..') ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      fail('KATEX_TARBALL_MEMBER_HEADER')
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) fail('KATEX_TARBALL_MEMBER_TRUNCATED')
    if (type === '0' || type === '\0') {
      if (!path.startsWith('package/') || members.has(path)) fail('KATEX_TARBALL_MEMBER_PATH')
      const bytes = tar.subarray(dataStart, dataEnd)
      members.set(path, { bytes: size, sha256: sha256(bytes) })
    } else if (type !== '5') fail('KATEX_TARBALL_UNSUPPORTED_MEMBER_TYPE')
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  if (zeroBlocks < 2 || members.size === 0) fail('KATEX_TARBALL_TERMINATOR')
  const installedTree = await inventoryTree(resolve(root, 'node_modules/katex'))
  const installed = installedTree.filter((entry) => !entry.path.startsWith('node_modules/'))
  const nestedCommander = installedTree.filter((entry) => entry.path.startsWith('node_modules/commander/'))
  if (
    !nestedCommander.length ||
    JSON.parse(readFileSync(resolve(root, 'node_modules/katex/node_modules/commander/package.json'), 'utf8'))
      .version !== '8.3.0'
  )
    fail('KATEX_NESTED_COMMANDER_IDENTITY')
  if (installed.length !== members.size) fail('KATEX_INSTALLED_MEMBER_COUNT')
  for (const entry of installed) {
    const archived = members.get(`package/${entry.path}`)
    if (!archived || archived.bytes !== entry.bytes || archived.sha256 !== entry.sha256)
      fail(`KATEX_INSTALLED_MEMBER_BYTES:${entry.path}`)
  }
  const modulePaths = graph.modules
    .map((module) => module.id.replaceAll('\\', '/').split('?')[0])
    .filter((id) => /\/node_modules\/katex\//u.test(id))
    .map((id) => id.slice(id.lastIndexOf('/node_modules/katex/') + '/node_modules/katex/'.length))
  for (const path of modulePaths)
    if (!members.has(`package/${path}`)) fail(`KATEX_GRAPH_MODULE_NOT_IN_SRI_TARBALL:${path}`)
  return {
    version: '0.18.2',
    resolved: 'https://registry.npmjs.org/katex/-/katex-0.18.2.tgz',
    integrity: archiveIntegrity,
    archiveBytes: archiveBytes.length,
    archiveSha256: sha256(archiveBytes),
    packageMemberCount: members.size,
    installedMemberManifestSha256: sha256(Buffer.from(JSON.stringify(installed))),
    productionKaTeXModuleCount: modulePaths.length,
    installedPackageBytesMatchSRIArchive: true
  }
}
async function scanMermaidResidue(root, ordinary, graph) {
  const mermaidRoot = resolve(root, 'node_modules/mermaid/dist')
  const files = await inventoryTree(mermaidRoot)
  const byPath = new Map(files.map((entry) => [`node_modules/mermaid/dist/${entry.path}`, entry]))
  const oldFiles = []
  for (const [path, identity] of byPath) {
    const bytes = readFileSync(resolve(root, path))
    if (findEmbeddedOldKaTeX(path, bytes))
      oldFiles.push({
        path,
        member: identity.path,
        bytes: identity.bytes,
        sha256: identity.sha256,
        version: '0.16.47',
        classification: { installed: 'present', ordinaryBuild: 'absent', shipped: 'UNKNOWN' }
      })
  }
  const ordinaryByHash = new Map(ordinary.map((entry) => [entry.sha256, entry.path]))
  for (const residue of oldFiles) if (ordinaryByHash.has(residue.sha256)) fail('OLD_ALTERNATE_DISTRIBUTION_IN_BUILD')
  const sourceTextMarkers = []
  for (const entry of ordinary) {
    const bytes = readFileSync(resolve(root, 'out/renderer', entry.path))
    if (findEmbeddedOldKaTeX(entry.path, bytes)) sourceTextMarkers.push(entry.path)
  }
  if (sourceTextMarkers.length) fail('OLD_KATEX_SOURCE_IN_BUILD')
  const moduleMatches = graph.modules
    .filter((module) => module.renderedLength > 0 && isOldMermaidRuntimeModule(module.id))
    .map((module) => ({ id: module.id, renderedLength: module.renderedLength, chunks: module.chunks }))
  if (moduleMatches.length) fail('OLD_MERMAID_MODULE_IN_BUILD')
  return {
    installedMermaidVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/mermaid/package.json'), 'utf8'))
      .version,
    scannedFileCount: files.length,
    knownEmbeddedOldKaTeX: oldFiles,
    embeddedComponentAddendum: {
      schema: 1,
      component: 'KaTeX 0.16.47 embedded in Mermaid 11.17.0 alternate ESM/IIFE distributions',
      advisory: 'GHSA-238p-pmpm-9mq7 / CVE-2026-103923',
      installedMembers: oldFiles,
      ordinaryBuildStatus: 'scanned complete UTF-8 outputs, parsed source maps, and checked emitted module provenance',
      shippedStatus: 'UNKNOWN: no same-final-SHA packaged candidate was supplied'
    },
    buildResidueModuleMatches: moduleMatches,
    buildResidueMatches: [],
    classification: 'installed alternate ESM/IIFE residue retained; ordinary output scan found none'
  }
}
export async function validateBuildEvidence({
  ordinary,
  observed,
  graph,
  root = process.cwd(),
  observedRoot = resolve(root, 'out/renderer'),
  katexTarball
}) {
  const equality = compareInventories(ordinary, observed)
  const normalized = normalizeInventory(ordinary)
  const graphSummary = await validateGraph(graph, normalized, root)
  const publicSources = await validatePublicSourceInventory(root, graph, normalized)
  const localReferences = validateLocalAssetReferences(observedRoot, normalized)
  const katexArchive = await validateKaTeXArchive({ root, tarball: katexTarball, graph })
  const residue = await scanMermaidResidue(root, normalized, graph)
  const configFiles = [
    'electron.vite.config.ts',
    'package.json',
    'package-lock.json',
    'electron-builder.yml',
    'electron-builder.win.yml',
    'scripts/before-pack.mjs',
    'scripts/design/renderer-inputs.ts'
  ]
  const configurationHashes = Object.fromEntries(
    configFiles.map((path) => [path, sha256(readFileSync(resolve(root, path)))])
  )
  const run = graph.buildRun
  if (
    !run ||
    run.schema !== 1 ||
    run.sourceCommit !== process.env.GITHUB_SHA ||
    run.runId !== process.env.GITHUB_RUN_ID ||
    run.runAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
    run.job !== process.env.GITHUB_JOB ||
    run.runnerOs !== process.env.RUNNER_OS ||
    run.runnerPlatform !== process.platform ||
    run.runnerArch !== process.arch ||
    run.profile !== (process.env.METIS_PACKAGE_PROFILE || 'full') ||
    run.packageTarget !== process.env.RENDERER_PACKAGE_TARGET ||
    run.macUniversal !== (process.env.ASKTOTO_MAC_UNIVERSAL || '0') ||
    (run.packageTarget === 'mac-universal' && run.macUniversal !== '1') ||
    run.ordinaryBuildExitCode !== 0 ||
    run.observedBuildExitCode !== 0 ||
    JSON.stringify(run.configurationHashes) !== JSON.stringify(configurationHashes) ||
    !graph.config ||
    graph.config.command !== 'build' ||
    graph.config.mode !== 'production' ||
    graph.config.outerConfig?.path !== 'electron.vite.config.ts' ||
    !Array.isArray(graph.config.outerConfig.files) ||
    graph.config.outerConfig.files.length === 0 ||
    !graph.config.outerConfig.files.some((entry) => entry.path === 'scripts/design/renderer-inputs.ts') ||
    graph.config.outerConfig.files.some(
      (entry) =>
        typeof entry.path !== 'string' ||
        !entry.path ||
        entry.path.startsWith('/') ||
        entry.path.split('/').includes('..') ||
        sha256(readFileSync(resolve(root, entry.path))) !== entry.sha256
    ) ||
    !Array.isArray(graph.config.configFiles) ||
    graph.config.configFiles.some(
      (entry) => typeof entry.path !== 'string' || sha256(readFileSync(resolve(root, entry.path))) !== entry.sha256
    )
  )
    fail('BUILD_RUN_IDENTITY_OR_CONFIG')
  return {
    schema: 2,
    evidence: 'PRODUCTION_RENDERER_GRAPH_AND_BYTES_VERIFIED',
    profile: process.env.METIS_PACKAGE_PROFILE || 'full',
    buildRun: run,
    ordinaryObservedByteEquality: equality,
    graph: graphSummary,
    publicSources,
    localReferences,
    katexArchive,
    mermaidResidue: residue
  }
}
async function runObservedBuild(reportPath) {
  const root = process.cwd()
  const scratch = mkdtempSync(join(tmpdir(), 'renderer-katex-observer-'))
  const mainGraphPath = resolve(reportPath)
  const workerGraphPrefix = `${mainGraphPath}.worker`
  const configPath = join(scratch, 'renderer-observer.config.ts')
  const configUrl = resolve(root, 'electron.vite.config.ts')
  const helperUrl = resolve(root, 'scripts/ci/renderer-katex-build-evidence.mjs')
  const { resolveConfig: resolveElectronConfig } = await import('electron-vite')
  const outer = await resolveElectronConfig({ configFile: configUrl, root }, 'build', 'production')
  if (resolve(outer.configFile || '') !== configUrl || !outer.configFileDependencies?.length)
    fail('OUTER_ELECTRON_CONFIG_DEPENDENCIES_MISSING')
  const outerConfig = { path: outer.configFile, dependencies: outer.configFileDependencies }
  const mainUrl = pathToFileURL(mainGraphPath).href
  const workerUrl = pathToFileURL(workerGraphPrefix).href
  const wrapper = [
    `import electronConfig from ${JSON.stringify(configUrl)}`,
    `import { createViteObserverPlugin } from ${JSON.stringify(helperUrl)}`,
    `const outerConfig = ${JSON.stringify(outerConfig)}`,
    `electronConfig.renderer.plugins = [...(electronConfig.renderer.plugins || []), createViteObserverPlugin(${JSON.stringify(mainUrl)}, { outerConfig })]`,
    `const originalWorkerPlugins = electronConfig.renderer.worker?.plugins`,
    `electronConfig.renderer.worker = { ...(electronConfig.renderer.worker || {}), plugins: (...args) => { const existing = typeof originalWorkerPlugins === 'function' ? originalWorkerPlugins(...args) : originalWorkerPlugins || []; return [...existing, createViteObserverPlugin(${JSON.stringify(workerUrl)}, { worker: true, outerConfig })] } }`,
    'export default electronConfig'
  ].join('\n')
  writeFileSync(configPath, `${wrapper}\n`, { flag: 'wx' })
  const cli = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js')
  const child = spawnSync(process.execPath, [cli, 'build', '--config', configPath], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024
  })
  const output = `${child.stdout || ''}${child.stderr || ''}`
  writeFileSync(join(dirname(resolve(reportPath)), 'observed-build.log'), output.slice(0, 8 * 1024 * 1024), {
    flag: 'wx'
  })
  if (child.error || child.status !== 0) {
    rmSync(scratch, { recursive: true, force: true })
    fail(`OBSERVED_BUILD_FAILED:${child.status ?? 'spawn'}`)
  }
  const graph = JSON.parse(readFileSync(mainGraphPath, 'utf8'))
  if (
    !process.env.GITHUB_SHA ||
    !process.env.GITHUB_RUN_ID ||
    !process.env.GITHUB_RUN_ATTEMPT ||
    !process.env.GITHUB_JOB ||
    !process.env.RENDERER_PACKAGE_TARGET ||
    !['full', 'lean'].includes(process.env.METIS_PACKAGE_PROFILE || 'full')
  )
    fail('BUILD_RUN_IDENTITY_MISSING')
  const configFiles = [
    'electron.vite.config.ts',
    'package.json',
    'package-lock.json',
    'electron-builder.yml',
    'electron-builder.win.yml',
    'scripts/before-pack.mjs',
    'scripts/design/renderer-inputs.ts'
  ]
  graph.buildRun = {
    schema: 1,
    sourceCommit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    job: process.env.GITHUB_JOB,
    runnerOs: process.env.RUNNER_OS,
    runnerPlatform: process.platform,
    runnerArch: process.arch,
    profile: process.env.METIS_PACKAGE_PROFILE || 'full',
    packageTarget: process.env.RENDERER_PACKAGE_TARGET,
    macUniversal: process.env.ASKTOTO_MAC_UNIVERSAL || '0',
    ordinaryBuildExitCode: Number(process.env.RENDERER_ORDINARY_BUILD_EXIT),
    observedBuildExitCode: child.status,
    configurationHashes: Object.fromEntries(
      configFiles.map((path) => [path, sha256(readFileSync(resolve(root, path)))])
    )
  }
  if (graph.buildRun.ordinaryBuildExitCode !== 0) fail('ORDINARY_BUILD_EXIT_NOT_BOUND')
  const workerReports = readdirSync(dirname(mainGraphPath))
    .filter(
      (name) => name.startsWith(`${relative(dirname(mainGraphPath), workerGraphPrefix)}.`) && name.endsWith('.json')
    )
    .sort()
  for (const name of workerReports) {
    const worker = JSON.parse(readFileSync(join(dirname(mainGraphPath), name), 'utf8'))
    if (worker.worker !== true) fail('WORKER_OBSERVER_IDENTITY')
    graph.modules.push(...worker.modules)
    graph.externalModules.push(...worker.externalModules)
    graph.chunks.push(...worker.chunks)
    graph.assets.push(...worker.assets)
    graph.workers.push(...worker.workers)
  }
  const workerChunks = new Map(graph.chunks.map((chunk) => [chunk.fileName, chunk]))
  const parentAssets = new Map()
  for (const asset of graph.assets) {
    const previous = parentAssets.get(asset.fileName)
    if (previous && (previous.bytes !== asset.bytes || previous.sha256 !== asset.sha256))
      fail('WORKER_ASSET_OUTPUT_DIVERGENCE')
    if (!previous) parentAssets.set(asset.fileName, asset)
  }
  for (const chunk of graph.chunks.filter((candidate) => candidate.isWorkerOutput === true)) {
    const parent = parentAssets.get(chunk.fileName)
    if (parent && (parent.bytes !== chunk.bytes || parent.sha256 !== chunk.sha256))
      fail('WORKER_PARENT_OUTPUT_DIVERGENCE')
    if (parent) parentAssets.delete(chunk.fileName)
  }
  graph.assets = [...parentAssets.values()]
  for (const worker of graph.workers) {
    const chunk = workerChunks.get(worker.fileName)
    if (!chunk || chunk.sha256 !== worker.sha256 || chunk.bytes !== worker.bytes) fail('WORKER_ENTRY_GRAPH_DIVERGENCE')
  }
  const mergedModules = new Map()
  for (const module of graph.modules) {
    const current = mergedModules.get(module.id)
    if (!current) mergedModules.set(module.id, module)
    else {
      if (
        JSON.stringify(current.imports) !== JSON.stringify(module.imports) ||
        JSON.stringify(current.dynamicImports) !== JSON.stringify(module.dynamicImports)
      )
        fail('WORKER_MODULE_GRAPH_DIVERGENCE')
      current.chunks = [...new Set([...current.chunks, ...module.chunks])]
      current.renderedLength = Math.max(current.renderedLength, module.renderedLength)
    }
  }
  graph.modules = [...mergedModules.values()]
  graph.externalModules = [...new Set(graph.externalModules)].sort()
  writeFileSync(mainGraphPath, `${JSON.stringify(graph, null, 2)}\n`)
  rmSync(scratch, { recursive: true, force: true })
  return graph
}
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.has('observe')) return runObservedBuild(args.get('observe'))
  const ordinary = await inventoryTree(resolve(args.get('ordinary')))
  const observed = await inventoryTree(resolve(args.get('observed')))
  const graphBytes = readFileSync(resolve(args.get('graph')))
  if (graphBytes.byteLength > 64 * 1024 * 1024) fail('GRAPH_SIZE')
  let graph
  try {
    graph = JSON.parse(graphBytes.toString('utf8'))
  } catch {
    fail('GRAPH_JSON')
  }
  const evidence = await validateBuildEvidence({
    ordinary,
    observed,
    graph,
    observedRoot: resolve(args.get('observed')),
    katexTarball: args.get('katex-tarball')
  })
  evidence.sourceCommit = process.env.GITHUB_SHA || null
  evidence.graphSha256 = sha256(graphBytes)
  evidence.ordinaryInventory = ordinary
  evidence.observedInventory = observed
  const output = resolve(args.get('out'))
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
  console.log('renderer-katex-build-evidence:ORDINARY_OBSERVED_MATCH')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'renderer-katex-build-evidence:UNKNOWN')
    process.exitCode = 1
  })
}
