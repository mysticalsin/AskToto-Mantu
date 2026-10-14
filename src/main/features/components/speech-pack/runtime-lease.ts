/**
 * Main-owned capability boundary for optional executable runtimes.
 *
 * Consumers receive a lease only after the configured catalog/store boundary has validated the complete
 * activated feature generation. Paths stay inside the main process and are never accepted from IPC.
 * A lease pins that generation until the corresponding child/worker has crossed its shutdown barrier.
 */
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { execFile } from 'node:child_process'
import { lstat, open, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { app } from 'electron'
import type { OptionalRuntimeTarget } from './runtime-components'
import { readBoundedAppAsarMember } from './runtime-app-asar'
import { assertRuntimeExecutionAuthority, runtimeExecutionAuthorityRevision } from './runtime-execution-authority'

export type RuntimeFeatureId = 'offline-asr' | 'speaker-embedding' | 'local-llm'
export type RuntimeEntryRole =
  | 'parakeet-host'
  | 'speaker-embedding-host'
  | 'whisper-import-host'
  | 'whisper-renderer-worker'
  | 'llama-server'
export type RuntimeModelId =
  | 'asr.parakeet-tdt-0.6b-v3-int8'
  | 'asr.whisper-base-q8'
  | 'speaker.embedding'
  | 'qwen3.5-0.8b'
  | 'qwen3.5-4b'

export interface VerifiedRuntimeModel {
  /** Relative model directory derived from its signed catalog mapping. */
  readonly root: string
  /** Exact member paths, relative to root, authenticated by the corresponding model inventory. */
  readonly members: readonly string[]
}

export interface VerifiedRuntimeResourcePin {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface VerifiedRuntimeGeneration {
  readonly generationIdentity: string
  readonly catalogIdentity: string
  readonly target: OptionalRuntimeTarget
  /** Absolute app-owned generation directory; provider must verify its canonical containment. */
  readonly rootDir: string
  readonly entries: Readonly<Partial<Record<RuntimeEntryRole, string>>>
  readonly models: Readonly<Partial<Record<RuntimeModelId, VerifiedRuntimeModel>>>
  /** Relative directories containing native code, all represented by the verified inventory. */
  readonly nativeLibraryDirs: readonly string[]
  /** Only paths represented in the reviewed runtime inventory may be served to an approved renderer. */
  readonly rendererFiles: Readonly<Record<string, string>>
  readonly rendererPins: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>
  /** Revalidates the complete physical inventory immediately before native or renderer execution. */
  readonly verifyCurrentBytes: () => Promise<void>
  /** Provider owns the store reference and releases it only after the last shared lease exits. */
  readonly release: () => void | Promise<void>
}

export interface RuntimeLeaseProvider {
  /** Must verify catalog trust, inventory membership, file hashes, target identity and selected closure. */
  acquire(input: {
    feature: RuntimeFeatureId
    target: OptionalRuntimeTarget
    selectedModelId?: RuntimeModelId
    signal?: AbortSignal
  }): Promise<VerifiedRuntimeGeneration | null>
}

export interface RuntimeFeatureLease {
  readonly feature: RuntimeFeatureId
  readonly generationIdentity: string
  readonly catalogIdentity: string
  readonly target: OptionalRuntimeTarget
  verifyCurrentBytes(): Promise<void>
  loaderDirectories(): readonly string[]
  entry(role: RuntimeEntryRole): string
  model(id: RuntimeModelId): string
  modelFile(id: RuntimeModelId, member: string): string
  rendererFile(relativePath: string): string
  rendererRolePath(role: RuntimeEntryRole): string
  rendererModelRoot(id: RuntimeModelId): string
  rendererResource(relativePath: string): VerifiedRuntimeResourcePin
  rendererResources(): ReadonlyMap<string, string>
  release(): Promise<void>
}

const CHILD_ENV_ALLOWLIST = [
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'TZ'
] as const

let configuredProvider: RuntimeLeaseProvider | null = null
const liveLeases = new WeakMap<object, { readonly feature: RuntimeFeatureId }>()
let windowsRoots: { readonly windowsRoot: string; readonly systemRoot: string } | null = null
let windowsRootsPromise: Promise<void> | null = null

async function readBoundedHelperFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    const same = (left: BigIntStats, right: BigIntStats): boolean =>
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.nlink === right.nlink &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(maxBytes) ||
      named.isSymbolicLink() ||
      !same(before, named)
    ) {
      throw new Error('WINDOWS_OS_ROOT_FILE_INVALID')
    }
    const chunks: Buffer[] = []
    let total = 0
    let position = 0
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
      if (!bytesRead) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    if (total > maxBytes || BigInt(total) !== before.size || !same(before, after) || !same(before, pathAfter)) {
      throw new Error('WINDOWS_OS_ROOT_FILE_CHANGED')
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Validate the app.asar manifest, helper bytes and actual Windows API result before any native launch. */
export async function initializeRuntimeHostEnvironment(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged || windowsRoots) return
  if (windowsRootsPromise) return windowsRootsPromise
  windowsRootsPromise = (async () => {
    const manifestPath = join(app.getAppPath(), 'out', 'main', 'win-os-roots.manifest.json')
    const helperPath = join(process.resourcesPath, 'win-os-roots', 'osroots.exe')
    const manifestBytes = await readBoundedAppAsarMember(manifestPath, WINDOWS_ROOT_MANIFEST_MAX_BYTES)
    const helperBytes = await readBoundedHelperFile(helperPath, WINDOWS_ROOT_HELPER_MAX_BYTES)
    let manifest: unknown
    try {
      manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as unknown
    } catch {
      throw new Error('WINDOWS_OS_ROOT_MANIFEST_INVALID')
    }
    if (
      !exactObject(manifest, ['bytes', 'helperVersion', 'path', 'schemaVersion', 'sha256']) ||
      manifest.schemaVersion !== 1 ||
      manifest.helperVersion !== 1 ||
      manifest.path !== 'win-os-roots/osroots.exe' ||
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes !== helperBytes.byteLength ||
      typeof manifest.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
      createHash('sha256').update(helperBytes).digest('hex') !== manifest.sha256 ||
      helperBytes.toString('ascii', 0, 2) !== 'MZ'
    ) {
      throw new Error('WINDOWS_OS_ROOT_HELPER_PIN_MISMATCH')
    }
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        execFile(
          helperPath,
          ['--json'],
          {
            encoding: 'utf8',
            maxBuffer: 2048,
            timeout: 3000,
            windowsHide: true,
            env: { PATH: '' }
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error('WINDOWS_OS_ROOT_HELPER_FAILED'))
              return
            }
            resolvePromise({ status: 0, stdout, stderr })
          }
        )
      }
    )
    const roots = parseWindowsSystemRootsResponse(result)
    for (const path of [roots.windowsRoot, roots.systemRoot]) {
      const directory = await stat(path)
      if (!directory.isDirectory()) throw new Error('WINDOWS_OS_ROOT_DIRECTORY_INVALID')
    }
    windowsRoots = roots
  })().catch((error: unknown) => {
    windowsRootsPromise = null
    throw error
  })
  return windowsRootsPromise
}

/** Install the trusted main-process store/provider once, before speech or LLM consumers can run. */
export function configureRuntimeLeaseProvider(provider: RuntimeLeaseProvider): void {
  if (configuredProvider && configuredProvider !== provider) {
    throw new Error('Optional runtime lease provider is already configured.')
  }
  configuredProvider = provider
}

/** Native optional hosts receive only owned library roots, system libraries, and basic OS process state. */
export function runtimeHostEnvironment(lease: RuntimeFeatureLease): NodeJS.ProcessEnv {
  assertLiveLease(lease)
  const env: NodeJS.ProcessEnv = {}
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (key === 'SystemRoot' || key === 'SYSTEMROOT' || key === 'WINDIR') continue
    const value = process.env[key]
    if (typeof value === 'string' && value.length <= 4096 && !value.includes('\0')) env[key] = value
  }
  const ownedRoots = lease.loaderDirectories()
  let systemRoots: string[]
  if (process.platform === 'win32') {
    const { windowsRoot, systemRoot } =
      windowsRoots ??
      (() => {
        throw new Error('WINDOWS_OS_ROOTS_NOT_INITIALIZED')
      })()
    env.SystemRoot = windowsRoot
    env.SYSTEMROOT = windowsRoot
    env.WINDIR = windowsRoot
    systemRoots = [windowsRoot, systemRoot]
  } else {
    systemRoots =
      process.platform === 'darwin'
        ? ['/usr/lib', '/System/Library/Frameworks']
        : ['/lib', '/usr/lib', '/lib64', '/usr/lib64']
  }
  const loaderRoots = [...ownedRoots, ...systemRoots]
  if (process.platform === 'linux') {
    env.PATH = loaderRoots.join(delimiter)
    env.LD_LIBRARY_PATH = loaderRoots.join(delimiter)
  }
  if (process.platform === 'darwin') {
    env.PATH = loaderRoots.join(delimiter)
    env.DYLD_LIBRARY_PATH = loaderRoots.join(delimiter)
  }
  return env
}

const WINDOWS_ROOT_MANIFEST_MAX_BYTES = 4096
const WINDOWS_ROOT_HELPER_MAX_BYTES = 2_000_000

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  )
}

/** Strictly parse the helper's bounded API response before any result enters a child loader path. */
export function parseWindowsSystemRootsResponse(input: {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}): { readonly windowsRoot: string; readonly systemRoot: string } {
  if (input.status !== 0 || input.stderr !== '' || input.stdout.length < 2 || input.stdout.length > 2048) {
    throw new Error('WINDOWS_OS_ROOT_HELPER_FAILED')
  }
  const lines = input.stdout.split('\n')
  if (lines.length !== 2 || lines[1] !== '' || lines[0].includes('\r')) {
    throw new Error('WINDOWS_OS_ROOT_RESPONSE_INVALID')
  }
  let value: unknown
  try {
    value = JSON.parse(lines[0]) as unknown
  } catch {
    throw new Error('WINDOWS_OS_ROOT_RESPONSE_INVALID')
  }
  if (
    !exactObject(value, ['systemRoot', 'version', 'windowsRoot']) ||
    value.version !== 1 ||
    typeof value.windowsRoot !== 'string' ||
    typeof value.systemRoot !== 'string'
  ) {
    throw new Error('WINDOWS_OS_ROOT_RESPONSE_INVALID')
  }
  const [windowsRoot, expectedSystemRoot] = windowsSystemLoaderRoots(value.windowsRoot)
  if (value.windowsRoot !== windowsRoot || value.systemRoot.toLowerCase() !== expectedSystemRoot.toLowerCase()) {
    throw new Error('WINDOWS_OS_ROOT_RESPONSE_INVALID')
  }
  return Object.freeze({ windowsRoot, systemRoot: expectedSystemRoot })
}

export function windowsSystemLoaderRoots(value: string | undefined): readonly [string, string] {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > 260 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes(';') ||
    !win32.isAbsolute(value) ||
    !/^[A-Za-z]:\\/.test(value) ||
    value.split(/[\\/]+/).some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Windows system loader root is invalid.')
  }
  const root = win32.resolve(value)
  return [root, win32.join(root, 'System32')]
}

/** A lease object is a main-only capability; plain objects from IPC or callers cannot imitate one. */
function assertLiveLease(lease: RuntimeFeatureLease): void {
  if (!lease || typeof lease !== 'object' || !liveLeases.has(lease as object)) {
    throw new Error('Optional runtime capability is invalid.')
  }
}

function validIdentity(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value) &&
    !/[. ](?:\/|$)/.test(value) &&
    !/(?:^|\/)(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])(?:\.|\/|$)/iu.test(value) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  )
}

function absoluteOwnedPath(rootDir: string, relativePath: string): string {
  const root = resolve(rootDir)
  const target = resolve(root, ...relativePath.split('/'))
  const rel = relative(root, target)
  if (!isAbsolute(rootDir) || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Optional runtime provider returned a path outside its owned generation.')
  }
  return target
}

function exactPathMap<T extends string>(
  source: Readonly<Partial<Record<T, string>>>,
  allowed: readonly T[],
  required: readonly T[]
): Readonly<Partial<Record<T, string>>> {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key as T)) throw new Error('Optional runtime provider returned an unknown role.')
  }
  for (const key of required) {
    if (!safeRelativePath(source[key] ?? '')) throw new Error('Optional runtime provider omitted a required entry.')
  }
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || !safeRelativePath(value))
      throw new Error('Optional runtime provider returned an invalid path.')
    if (!allowed.includes(key as T)) throw new Error('Optional runtime provider returned an unknown role.')
  }
  return Object.freeze({ ...source })
}

function exactRuntimeTarget(actual: OptionalRuntimeTarget, expected: OptionalRuntimeTarget): boolean {
  const keys = [
    'packageProfileIdentity',
    'packagePlatform',
    'packageArch',
    'runningPlatform',
    'runningArch',
    'appVersion',
    'electronVersion',
    'nodeAbi',
    'napiVersion',
    'chromiumVersion'
  ] as const
  if (!actual || typeof actual !== 'object' || Object.keys(actual).sort().join(',') !== [...keys].sort().join(','))
    return false
  return keys.every((key) => actual[key] === expected[key])
}

function snapshotGeneration(generation: VerifiedRuntimeGeneration): VerifiedRuntimeGeneration {
  const models = Object.fromEntries(
    Object.entries(generation.models).map(([id, model]) => [
      id,
      Object.freeze({ root: model.root, members: Object.freeze([...model.members]) })
    ])
  )
  return Object.freeze({
    ...generation,
    target: Object.freeze({ ...generation.target }),
    entries: Object.freeze({ ...generation.entries }),
    models: Object.freeze(models),
    nativeLibraryDirs: Object.freeze([...generation.nativeLibraryDirs]),
    rendererFiles: Object.freeze({ ...generation.rendererFiles }),
    rendererPins: Object.freeze(
      Object.fromEntries(Object.entries(generation.rendererPins).map(([key, pin]) => [key, Object.freeze({ ...pin })]))
    ),
    release: generation.release.bind(generation)
  })
}

function validateGeneration(
  feature: RuntimeFeatureId,
  generation: VerifiedRuntimeGeneration,
  expectedTarget: OptionalRuntimeTarget,
  selectedModelId?: RuntimeModelId
): void {
  if (
    !validIdentity(generation.generationIdentity) ||
    !validIdentity(generation.catalogIdentity) ||
    !exactRuntimeTarget(generation.target, expectedTarget) ||
    typeof generation.rootDir !== 'string' ||
    !isAbsolute(generation.rootDir) ||
    typeof generation.release !== 'function' ||
    typeof generation.verifyCurrentBytes !== 'function' ||
    !generation.entries ||
    !generation.models ||
    !Array.isArray(generation.nativeLibraryDirs) ||
    generation.nativeLibraryDirs.length > 32 ||
    !generation.rendererFiles ||
    !generation.rendererPins ||
    typeof generation.rendererFiles !== 'object' ||
    Array.isArray(generation.rendererFiles)
  ) {
    throw new Error('Optional runtime provider returned an invalid generation.')
  }
  const requiredEntries: RuntimeEntryRole[] =
    feature === 'offline-asr'
      ? ['parakeet-host', 'whisper-import-host', 'whisper-renderer-worker']
      : feature === 'speaker-embedding'
        ? ['speaker-embedding-host']
        : ['llama-server']
  exactPathMap(generation.entries, requiredEntries, requiredEntries)
  if (Object.keys(generation.entries).length !== requiredEntries.length) {
    throw new Error('Optional runtime provider returned an incomplete or unexpected entry closure.')
  }
  const modelKeys = Object.keys(generation.models)
  const allowedModels: readonly RuntimeModelId[] = [
    'asr.parakeet-tdt-0.6b-v3-int8',
    'asr.whisper-base-q8',
    'speaker.embedding',
    'qwen3.5-0.8b',
    'qwen3.5-4b'
  ]
  for (const key of modelKeys) {
    const model = generation.models[key as RuntimeModelId]
    if (
      !allowedModels.includes(key as RuntimeModelId) ||
      !model ||
      typeof model !== 'object' ||
      !safeRelativePath(model.root) ||
      !Array.isArray(model.members) ||
      model.members.length < 1 ||
      model.members.length > 100_000
    )
      throw new Error('Optional runtime provider returned an invalid model root.')
    const members = new Set<string>()
    const foldedMembers = new Set<string>()
    for (const member of model.members) {
      if (!safeRelativePath(member) || members.has(member) || foldedMembers.has(member.toLowerCase())) {
        throw new Error('Optional runtime provider returned an invalid model member.')
      }
      members.add(member)
      foldedMembers.add(member.toLowerCase())
    }
  }
  const requiredModels: readonly RuntimeModelId[] =
    feature === 'offline-asr'
      ? ['asr.parakeet-tdt-0.6b-v3-int8', 'asr.whisper-base-q8']
      : feature === 'speaker-embedding'
        ? ['speaker.embedding']
        : selectedModelId
          ? [selectedModelId]
          : []
  if (modelKeys.length !== requiredModels.length || requiredModels.some((id) => !modelKeys.includes(id))) {
    throw new Error('Optional runtime provider returned a partial or unexpected model closure.')
  }
  const requiredMembers: Partial<Record<RuntimeModelId, readonly string[]>> = {
    'asr.parakeet-tdt-0.6b-v3-int8': ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    'asr.whisper-base-q8': [
      'Xenova/whisper-base/config.json',
      'Xenova/whisper-base/generation_config.json',
      'Xenova/whisper-base/merges.txt',
      'Xenova/whisper-base/normalizer.json',
      'Xenova/whisper-base/onnx/decoder_model_merged_quantized.onnx',
      'Xenova/whisper-base/onnx/encoder_model_quantized.onnx',
      'Xenova/whisper-base/preprocessor_config.json',
      'Xenova/whisper-base/special_tokens_map.json',
      'Xenova/whisper-base/tokenizer.json',
      'Xenova/whisper-base/tokenizer_config.json',
      'Xenova/whisper-base/vocab.json'
    ],
    'speaker.embedding': ['speaker/embedding.onnx'],
    'qwen3.5-0.8b': ['model.gguf', 'mmproj.gguf'],
    'qwen3.5-4b': ['model.gguf', 'mmproj.gguf']
  }
  for (const id of requiredModels) {
    const model = generation.models[id]
    const required = requiredMembers[id] ?? []
    if (
      !model ||
      !safeRelativePath(model.root) ||
      required.length !== model.members.length ||
      required.some((member) => !model.members.includes(member))
    ) {
      throw new Error('Optional runtime provider omitted a required model member.')
    }
  }
  for (const path of generation.nativeLibraryDirs) {
    if (!safeRelativePath(path))
      throw new Error('Optional runtime provider returned an invalid native library directory.')
  }
  if (
    feature === 'local-llm' &&
    (!selectedModelId ||
      !generation.models[selectedModelId] ||
      !safeRelativePath(generation.models[selectedModelId]?.root ?? ''))
  ) {
    throw new Error('Optional runtime provider omitted the selected LLM model root.')
  }
  const rendererPaths = Object.keys(generation.rendererFiles)
  if (Object.keys(generation.rendererPins).sort().join(',') !== rendererPaths.sort().join(',')) {
    throw new Error('Optional runtime renderer pins do not match its exact resource map.')
  }
  if ((feature === 'offline-asr' && rendererPaths.length === 0) || rendererPaths.length > 4096) {
    throw new Error('Optional runtime renderer inventory is incomplete or too large.')
  }
  for (const rel of rendererPaths) {
    const pin = generation.rendererPins[rel]
    if (
      !safeRelativePath(rel) ||
      !safeRelativePath(generation.rendererFiles[rel] ?? '') ||
      !pin ||
      !Number.isSafeInteger(pin.bytes) ||
      pin.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(pin.sha256)
    ) {
      throw new Error('Optional runtime renderer inventory contains an invalid path.')
    }
  }
}

/** Internal constructor for the installer self-test, whose inputs are built only from verified staged inventory. */
export async function createRuntimeFeatureLeaseForVerifiedGeneration(
  feature: RuntimeFeatureId,
  target: OptionalRuntimeTarget,
  generationInput: VerifiedRuntimeGeneration,
  selectedModelId?: RuntimeModelId
): Promise<RuntimeFeatureLease> {
  let generation: VerifiedRuntimeGeneration
  const authorityRevision = runtimeExecutionAuthorityRevision()
  try {
    generation = snapshotGeneration(generationInput)
    validateGeneration(feature, generation, target, selectedModelId)
    await assertRuntimeExecutionAuthority(feature, selectedModelId)
    if (runtimeExecutionAuthorityRevision() !== authorityRevision)
      throw new Error('Optional runtime execution authority was revoked.')
  } catch (error) {
    await generationInput.release()
    throw error
  }
  let released = false
  const getPath = <K extends RuntimeEntryRole | RuntimeModelId>(
    map: Readonly<Partial<Record<K, string>>>,
    key: K
  ): string => {
    if (released) throw new Error('Optional runtime lease has been released.')
    const path = map[key]
    if (!path) throw new Error('Optional runtime entry is not part of this lease.')
    return absoluteOwnedPath(generation.rootDir, path)
  }
  const getModelPath = (id: RuntimeModelId): string => {
    if (released) throw new Error('Optional runtime lease has been released.')
    const model = generation.models[id]
    if (!model) throw new Error('Optional runtime model is not part of this lease.')
    return absoluteOwnedPath(generation.rootDir, model.root)
  }
  const lease: RuntimeFeatureLease = Object.freeze({
    feature,
    generationIdentity: generation.generationIdentity,
    catalogIdentity: generation.catalogIdentity,
    target: Object.freeze({ ...generation.target }),
    verifyCurrentBytes: async () => {
      if (released) throw new Error('Optional runtime lease has been released.')
      await assertRuntimeExecutionAuthority(feature, selectedModelId)
      await generation.verifyCurrentBytes()
      if (released || runtimeExecutionAuthorityRevision() !== authorityRevision) {
        throw new Error('Optional runtime execution authority was revoked.')
      }
    },
    loaderDirectories: () => {
      if (released) throw new Error('Optional runtime lease has been released.')
      return Object.freeze(generation.nativeLibraryDirs.map((path) => absoluteOwnedPath(generation.rootDir, path)))
    },
    entry: (role: RuntimeEntryRole) => getPath(generation.entries, role),
    model: (id: RuntimeModelId) => getModelPath(id),
    modelFile(id: RuntimeModelId, member: string): string {
      if (released || !safeRelativePath(member)) throw new Error('Optional runtime model file is not available.')
      const model = generation.models[id]
      if (!model || !model.members.includes(member))
        throw new Error('Optional runtime model file is not in the verified inventory.')
      return absoluteOwnedPath(generation.rootDir, `${model.root}/${member}`)
    },
    rendererFile(relativePath: string): string {
      if (released || !safeRelativePath(relativePath)) throw new Error('Optional runtime file is not available.')
      const path = generation.rendererFiles[relativePath]
      if (!path) throw new Error('Optional runtime file is not in the verified inventory.')
      return absoluteOwnedPath(generation.rootDir, path)
    },
    rendererRolePath(role: RuntimeEntryRole): string {
      const entry = getPath(generation.entries, role)
      const matches = Object.entries(generation.rendererFiles).filter(
        ([, path]) => absoluteOwnedPath(generation.rootDir, path) === entry
      )
      if (matches.length !== 1) throw new Error('Optional runtime role is not a verified renderer resource.')
      return matches[0][0]
    },
    rendererModelRoot(id: RuntimeModelId): string {
      if (released) throw new Error('Optional runtime lease has been released.')
      const model = generation.models[id]
      if (!model || model.members.some((member) => !generation.rendererFiles[`${model.root}/${member}`]))
        throw new Error('Optional runtime model is not a verified renderer closure.')
      return model.root
    },
    rendererResource(relativePath: string): VerifiedRuntimeResourcePin {
      if (released || !safeRelativePath(relativePath)) throw new Error('Optional runtime file is not available.')
      const path = generation.rendererFiles[relativePath]
      const pin = generation.rendererPins[relativePath]
      if (!path || !pin) throw new Error('Optional runtime file is not in the verified inventory.')
      return Object.freeze({ path: absoluteOwnedPath(generation.rootDir, path), ...pin })
    },
    rendererResources(): ReadonlyMap<string, string> {
      if (released) throw new Error('Optional runtime lease has been released.')
      return new Map(
        Object.entries(generation.rendererFiles).map(([name, path]) => [
          name,
          absoluteOwnedPath(generation.rootDir, path)
        ])
      )
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      await generation.release()
    }
  })
  liveLeases.set(lease as object, { feature })
  return lease
}

/** Acquire and pin one whole feature generation. Missing or unconfigured runtimes fail closed. */
export async function acquireFeatureRuntime(
  feature: RuntimeFeatureId,
  target: OptionalRuntimeTarget,
  selectedModelId?: RuntimeModelId,
  signal?: AbortSignal
): Promise<RuntimeFeatureLease> {
  if (signal?.aborted) throw signal.reason ?? new Error('Optional runtime admission was cancelled.')
  if (!configuredProvider) throw new Error('Optional runtimes are not configured for this package.')
  const acquiredGeneration = await configuredProvider.acquire({ feature, target, selectedModelId, signal })
  if (!acquiredGeneration) throw new Error('The required offline runtime is not installed or is not trusted.')
  let generation = acquiredGeneration
  const authorityRevision = runtimeExecutionAuthorityRevision()
  try {
    generation = snapshotGeneration(acquiredGeneration)
    validateGeneration(feature, generation, target, selectedModelId)
    if (signal?.aborted) throw signal.reason ?? new Error('Optional runtime admission was cancelled.')
    await assertRuntimeExecutionAuthority(feature, selectedModelId)
    if (runtimeExecutionAuthorityRevision() !== authorityRevision)
      throw new Error('Optional runtime execution authority was revoked.')
  } catch (error) {
    await acquiredGeneration.release()
    throw error
  }
  let released = false
  const getPath = <K extends RuntimeEntryRole | RuntimeModelId>(
    map: Readonly<Partial<Record<K, string>>>,
    key: K
  ): string => {
    if (released) throw new Error('Optional runtime lease has been released.')
    const path = map[key]
    if (!path) throw new Error('Optional runtime entry is not part of this lease.')
    return absoluteOwnedPath(generation.rootDir, path)
  }
  const getModelPath = (id: RuntimeModelId): string => {
    if (released) throw new Error('Optional runtime lease has been released.')
    const model = generation.models[id]
    if (!model) throw new Error('Optional runtime model is not part of this lease.')
    return absoluteOwnedPath(generation.rootDir, model.root)
  }
  const lease: RuntimeFeatureLease = Object.freeze({
    feature,
    generationIdentity: generation.generationIdentity,
    catalogIdentity: generation.catalogIdentity,
    target: Object.freeze({ ...generation.target }),
    verifyCurrentBytes: async () => {
      if (released) throw new Error('Optional runtime lease has been released.')
      await assertRuntimeExecutionAuthority(feature, selectedModelId)
      await generation.verifyCurrentBytes()
      if (released || runtimeExecutionAuthorityRevision() !== authorityRevision) {
        throw new Error('Optional runtime execution authority was revoked.')
      }
    },
    loaderDirectories: () => {
      if (released) throw new Error('Optional runtime lease has been released.')
      return Object.freeze(generation.nativeLibraryDirs.map((path) => absoluteOwnedPath(generation.rootDir, path)))
    },
    entry: (role: RuntimeEntryRole) => getPath(generation.entries, role),
    model: (id: RuntimeModelId) => getModelPath(id),
    modelFile(id: RuntimeModelId, member: string): string {
      if (released || !safeRelativePath(member)) throw new Error('Optional runtime model file is not available.')
      const model = generation.models[id]
      if (!model || !model.members.includes(member))
        throw new Error('Optional runtime model file is not in the verified inventory.')
      return absoluteOwnedPath(generation.rootDir, `${model.root}/${member}`)
    },
    rendererFile(relativePath: string): string {
      if (released || !safeRelativePath(relativePath)) throw new Error('Optional runtime file is not available.')
      const path = generation.rendererFiles[relativePath]
      if (!path) throw new Error('Optional runtime file is not in the verified inventory.')
      return absoluteOwnedPath(generation.rootDir, path)
    },
    rendererRolePath(role: RuntimeEntryRole): string {
      const entry = getPath(generation.entries, role)
      const matches = Object.entries(generation.rendererFiles).filter(
        ([, path]) => absoluteOwnedPath(generation.rootDir, path) === entry
      )
      if (matches.length !== 1) throw new Error('Optional runtime role is not a verified renderer resource.')
      return matches[0][0]
    },
    rendererModelRoot(id: RuntimeModelId): string {
      if (released) throw new Error('Optional runtime lease has been released.')
      const model = generation.models[id]
      if (!model || model.members.some((member) => !generation.rendererFiles[`${model.root}/${member}`])) {
        throw new Error('Optional runtime model is not a verified renderer closure.')
      }
      return model.root
    },
    rendererResource(relativePath: string): VerifiedRuntimeResourcePin {
      if (released || !safeRelativePath(relativePath)) throw new Error('Optional runtime file is not available.')
      const path = generation.rendererFiles[relativePath]
      const pin = generation.rendererPins[relativePath]
      if (!path || !pin) throw new Error('Optional runtime file is not in the verified inventory.')
      return Object.freeze({ path: absoluteOwnedPath(generation.rootDir, path), ...pin })
    },
    rendererResources(): ReadonlyMap<string, string> {
      if (released) throw new Error('Optional runtime lease has been released.')
      return new Map(
        Object.entries(generation.rendererFiles).map(([name, path]) => [
          name,
          absoluteOwnedPath(generation.rootDir, path)
        ])
      )
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      await generation.release()
    }
  })
  liveLeases.set(lease as object, { feature })
  return lease
}
