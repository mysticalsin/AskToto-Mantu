import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OptionalRuntimeTarget } from './runtime-components'
import {
  assertRuntimeFileClosure,
  parseRuntimeCatalog,
  verifyWithCatalogIdentity,
  type RuntimeCatalogRow,
  type RuntimeInventoryV1
} from './runtime-provenance'
import { verifyPinnedRuntimeTrust } from './runtime-trust'
import type {
  RuntimeEntryRole,
  RuntimeFeatureId,
  RuntimeLeaseProvider,
  RuntimeModelId as LeaseModelId,
  VerifiedRuntimeGeneration
} from './runtime-lease'
import { hashPinnedArchive } from './runtime-archive'
import { extractRuntimeTarGzip } from './runtime-tar'

const MAX_POINTER_BYTES = 64 * 1024
const MAX_CATALOG_BYTES = 16 * 1024
const MAX_METADATA_BYTES = 20 * 1024 * 1024
const MAX_TRUST_ROOT_BYTES = 2 * 1024 * 1024
const MAX_PLAN_BYTES = 100_000_000_000
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0
const MODEL_IDS: readonly LeaseModelId[] = [
  'asr.parakeet-tdt-0.6b-v3-int8',
  'asr.whisper-base-q8',
  'speaker.embedding',
  'qwen3.5-0.8b',
  'qwen3.5-4b'
]

interface ActiveGenerationV1 {
  readonly schemaVersion: 1
  readonly feature: RuntimeFeatureId
  readonly selectedModelId: LeaseModelId | null
  readonly catalogIdentity: string
  readonly generationIdentity: string
  readonly target: OptionalRuntimeTarget
  readonly artifactIds: readonly string[]
}

export interface RuntimeGenerationProviderOptions {
  /** Packaged application resources; never a userData or renderer-selected root. */
  readonly resourcesRoot: string
  /** App-owned userData root containing immutable generations and the active pointer. */
  readonly storeRoot: string
}

export interface RuntimeGenerationProvider extends RuntimeLeaseProvider {
  /** Validate the packaged catalog, TUF root and acquisition receipt at the app-owned startup boundary. */
  initialize(): Promise<void>
  /** A frozen app-owned catalog snapshot for zero-transfer consent previews. */
  catalogSnapshot(): Promise<{ catalog: ReturnType<typeof parseRuntimeCatalog>; catalogIdentity: string }>
  /** Byte count of the currently active immutable generation retained across activation. */
  previousActiveBytes(feature: RuntimeFeatureId): Promise<number>
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = record(value)
  if (object) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9.-]{0,79}$/.test(value)
}

function sameTarget(a: unknown, b: OptionalRuntimeTarget): boolean {
  const value = record(a)
  return Boolean(
    value &&
      exactKeys(value, [
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
      ]) &&
      canonicalJson(value) === canonicalJson(b)
  )
}

function generationId(pointer: Omit<ActiveGenerationV1, 'generationIdentity'>): string {
  return sha256(
    canonicalJson({
      schemaVersion: pointer.schemaVersion,
      feature: pointer.feature,
      selectedModelId: pointer.selectedModelId,
      catalogIdentity: pointer.catalogIdentity,
      target: pointer.target,
      artifactIds: [...pointer.artifactIds].sort()
    })
  )
}

function parsePointer(bytes: Uint8Array, feature: RuntimeFeatureId): ActiveGenerationV1 {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_POINTER_BYTES) throw new Error('RUNTIME_POINTER_INVALID')
  let value: Record<string, unknown> | null
  try {
    value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
  } catch {
    throw new Error('RUNTIME_POINTER_INVALID')
  }
  if (
    !value ||
    !exactKeys(value, [
      'schemaVersion',
      'feature',
      'selectedModelId',
      'catalogIdentity',
      'generationIdentity',
      'target',
      'artifactIds'
    ]) ||
    value.schemaVersion !== 1 ||
    value.feature !== feature ||
    (value.selectedModelId !== null && !MODEL_IDS.includes(value.selectedModelId as LeaseModelId)) ||
    typeof value.catalogIdentity !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.catalogIdentity) ||
    typeof value.generationIdentity !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.generationIdentity) ||
    !Array.isArray(value.artifactIds) ||
    value.artifactIds.length < 1 ||
    value.artifactIds.length > 16 ||
    !value.artifactIds.every(safeId) ||
    new Set(value.artifactIds).size !== value.artifactIds.length
  ) {
    throw new Error('RUNTIME_POINTER_INVALID')
  }
  const pointer = value as unknown as ActiveGenerationV1
  const identity: Omit<ActiveGenerationV1, 'generationIdentity'> = {
    schemaVersion: pointer.schemaVersion,
    feature: pointer.feature,
    selectedModelId: pointer.selectedModelId,
    catalogIdentity: pointer.catalogIdentity,
    target: pointer.target,
    artifactIds: pointer.artifactIds
  }
  if (generationId(identity) !== pointer.generationIdentity) {
    throw new Error('RUNTIME_POINTER_IDENTITY_MISMATCH')
  }
  return Object.freeze({
    ...pointer,
    target: Object.freeze({ ...pointer.target }),
    artifactIds: Object.freeze([...pointer.artifactIds])
  })
}

async function readBoundedRegular(path: string, maxBytes: number): Promise<Buffer> {
  if (process.platform !== 'win32' && (!NOFOLLOW || !NONBLOCK)) {
    throw new Error('RUNTIME_SAFE_FILE_OPEN_UNAVAILABLE')
  }
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw new Error('RUNTIME_METADATA_SHAPE_INVALID')
    }
    const namedBefore = await lstat(path, { bigint: true })
    const sameVersion = (a: BigIntStats, b: BigIntStats): boolean =>
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.mode === b.mode &&
      a.nlink === b.nlink &&
      a.uid === b.uid &&
      a.gid === b.gid &&
      a.rdev === b.rdev &&
      a.size === b.size &&
      a.blocks === b.blocks &&
      a.mtimeNs === b.mtimeNs &&
      a.ctimeNs === b.ctimeNs &&
      a.birthtimeNs === b.birthtimeNs
    if (!namedBefore.isFile() || namedBefore.nlink !== 1n || !sameVersion(before, namedBefore)) {
      throw new Error('RUNTIME_METADATA_CHANGED')
    }
    const chunks: Buffer[] = []
    let total = 0
    let position = 0
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      position += bytesRead
    }
    if (total > maxBytes) throw new Error('RUNTIME_METADATA_TOO_LARGE')
    const bytes = Buffer.concat(chunks, total)
    const after = await handle.stat({ bigint: true })
    const atPath = await lstat(path, { bigint: true })
    if (
      BigInt(bytes.byteLength) !== before.size ||
      !sameVersion(before, after) ||
      !atPath.isFile() ||
      !sameVersion(before, atPath)
    ) {
      throw new Error('RUNTIME_METADATA_CHANGED')
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function assertOwnedDirectory(root: string): Promise<string> {
  const absolute = resolve(root)
  const stat = await lstat(absolute)
  const canonical = await realpath(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== absolute) {
    throw new Error('RUNTIME_GENERATION_ROOT_INVALID')
  }
  return canonical
}

async function assertFileRoot(root: string, relPath: string): Promise<string> {
  let current = root
  const parts = relPath.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    const item = await lstat(current)
    if (
      item.isSymbolicLink() ||
      (index === parts.length - 1 ? !item.isFile() || item.nlink !== 1 : !item.isDirectory())
    ) {
      throw new Error('RUNTIME_GENERATION_FILE_SHAPE_INVALID')
    }
  }
  const canonical = await realpath(current)
  const expected = resolve(root, ...parts)
  const rel = relative(root, canonical)
  if (canonical !== expected || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('RUNTIME_GENERATION_FILE_ESCAPE')
  }
  return canonical
}

async function assertEvidenceClosure(evidenceRoot: string): Promise<void> {
  const expected = ['bundle.json', 'inventory.json', 'payload.tar.gz']
  const actual = (await readdir(evidenceRoot)).sort()
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('RUNTIME_EVIDENCE_CLOSURE_MISMATCH')
  for (const name of expected) {
    const stat = await lstat(join(evidenceRoot, name), { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw new Error('RUNTIME_EVIDENCE_FILE_INVALID')
    }
  }
}

async function assertExactDirectories(root: string, names: readonly string[]): Promise<void> {
  const actual = (await readdir(root)).sort()
  const expected = [...names].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error('RUNTIME_GENERATION_DIRECTORY_CLOSURE_MISMATCH')
  }
}

async function assertInstalledClosure(
  root: string,
  inventory: RuntimeInventoryV1,
  signal?: AbortSignal
): Promise<Map<string, BigIntStats>> {
  const expected = new Map(inventory.files.map((file) => [file.path, file]))
  const expectedDirectories = new Set<string>()
  for (const path of expected.keys()) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) expectedDirectories.add(parts.slice(0, depth).join('/'))
  }
  const found = new Map<string, string>()
  const folded = new Set<string>()
  const visit = async (dir: string, prefix: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      if (signal?.aborted) throw signal.reason ?? new Error('RUNTIME_VERIFY_CANCELLED')
      const rel = prefix ? `${prefix}/${name}` : name
      const path = join(dir, name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new Error('RUNTIME_GENERATION_LINK_REJECTED')
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(rel)) throw new Error('RUNTIME_GENERATION_EXTRA_DIRECTORY')
        await visit(path, rel)
      } else if (stat.isFile() && stat.nlink === 1) {
        const key = rel.toLowerCase()
        if (!expected.has(rel) || folded.has(key)) throw new Error('RUNTIME_GENERATION_EXTRA_FILE')
        folded.add(key)
        found.set(rel, path)
      } else throw new Error('RUNTIME_GENERATION_SPECIAL_FILE')
    }
  }
  await visit(root, '')
  if (found.size !== expected.size) throw new Error('RUNTIME_GENERATION_FILE_CLOSURE_MISMATCH')
  const versions = new Map<string, BigIntStats>()
  for (const [rel, pin] of expected) {
    if (signal?.aborted) throw signal.reason ?? new Error('RUNTIME_VERIFY_CANCELLED')
    const path = await assertFileRoot(root, rel)
    const fileStat = await lstat(path, { bigint: true })
    if (
      path !== found.get(rel) ||
      fileStat.size !== BigInt(pin.bytes) ||
      ((fileStat.mode & 0o111n) !== 0n) !== pin.executable
    ) {
      throw new Error('RUNTIME_GENERATION_FILE_PIN_MISMATCH')
    }
    if (pin.bytes > 0 && (await hashPinnedArchive(path, pin.bytes)) !== pin.sha256) {
      throw new Error('RUNTIME_GENERATION_FILE_PIN_MISMATCH')
    }
    if (pin.bytes === 0 && sha256(Buffer.alloc(0)) !== pin.sha256) {
      throw new Error('RUNTIME_GENERATION_FILE_PIN_MISMATCH')
    }
    const afterHash = await lstat(path, { bigint: true })
    if (
      afterHash.dev !== fileStat.dev ||
      afterHash.ino !== fileStat.ino ||
      afterHash.mode !== fileStat.mode ||
      afterHash.nlink !== fileStat.nlink ||
      afterHash.uid !== fileStat.uid ||
      afterHash.gid !== fileStat.gid ||
      afterHash.rdev !== fileStat.rdev ||
      afterHash.size !== fileStat.size ||
      afterHash.blocks !== fileStat.blocks ||
      afterHash.mtimeNs !== fileStat.mtimeNs ||
      afterHash.ctimeNs !== fileStat.ctimeNs ||
      afterHash.birthtimeNs !== fileStat.birthtimeNs
    ) {
      throw new Error('RUNTIME_GENERATION_FILE_CHANGED')
    }
    versions.set(path, afterHash)
  }
  return versions
}

function requiredClosure(
  feature: RuntimeFeatureId,
  selectedModelId?: LeaseModelId
): {
  roles: readonly RuntimeEntryRole[]
  models: readonly LeaseModelId[]
} {
  if (feature === 'offline-asr') {
    return {
      roles: ['parakeet-host', 'whisper-import-host', 'whisper-renderer-worker'],
      models: ['asr.parakeet-tdt-0.6b-v3-int8', 'asr.whisper-base-q8']
    }
  }
  if (feature === 'speaker-embedding') return { roles: ['speaker-embedding-host'], models: ['speaker.embedding'] }
  if (!selectedModelId || !selectedModelId.startsWith('qwen3.5-')) throw new Error('RUNTIME_MODEL_NOT_SELECTED')
  return { roles: ['llama-server'], models: [selectedModelId] }
}

function runtimeMatchesTarget(row: RuntimeCatalogRow, target: OptionalRuntimeTarget): boolean {
  return Boolean(
    row.kind === 'runtime' &&
      row.runtime &&
      row.target.platform === target.packagePlatform &&
      row.target.arch === target.packageArch &&
      target.packagePlatform === target.runningPlatform &&
      target.packageArch === target.runningArch &&
      row.runtime.electronVersion === target.electronVersion &&
      row.runtime.nodeAbi === target.nodeAbi &&
      row.runtime.napi === target.napiVersion &&
      row.runtime.chromiumVersion === target.chromiumVersion
  )
}

export function resolveRuntimeArtifactIds(
  rows: readonly RuntimeCatalogRow[],
  feature: RuntimeFeatureId,
  target: OptionalRuntimeTarget,
  selectedModelId?: LeaseModelId
): readonly string[] | null {
  const closure = requiredClosure(feature, selectedModelId)
  const selected = new Set<string>()
  for (const role of closure.roles) {
    const matches = rows.filter(
      (row) => row.kind === 'runtime' && runtimeMatchesTarget(row, target) && role in row.entrypoints
    )
    if (matches.length !== 1) return null
    selected.add(matches[0].artifactId)
  }
  for (const modelId of closure.models) {
    const matches = rows.filter(
      (row) =>
        row.kind === 'model' &&
        row.target.platform === 'any' &&
        row.target.arch === 'any' &&
        row.models.some((model) => model.id === modelId)
    )
    if (matches.length !== 1) return null
    selected.add(matches[0].artifactId)
  }
  return Object.freeze([...selected].sort())
}

export interface RuntimeInstallRequirements {
  readonly artifactIds: readonly string[]
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly peakScratchBytes: number
}

/** Calculate a zero-transfer preview from reviewed catalog pins and the already installed generation size. */
export function calculateRuntimeInstallRequirements(input: {
  rows: readonly RuntimeCatalogRow[]
  feature: RuntimeFeatureId
  target: OptionalRuntimeTarget
  selectedModelId?: LeaseModelId
  previousActiveBytes: number
}): RuntimeInstallRequirements | null {
  if (!Number.isSafeInteger(input.previousActiveBytes) || input.previousActiveBytes < 0) return null
  const artifactIds = resolveRuntimeArtifactIds(input.rows, input.feature, input.target, input.selectedModelId)
  if (!artifactIds) return null
  const rows = artifactIds.map((id) => input.rows.find((row) => row.artifactId === id))
  if (rows.some((row) => !row)) return null
  const downloadBytes = rows.reduce(
    (total, row) => total + (row?.archive.bytes ?? 0) + (row?.inventory.bytes ?? 0) + (row?.bundle.bytes ?? 0),
    0
  )
  const payloadBytes = rows.reduce((total, row) => total + (row?.payloadBytes ?? 0), 0)
  const installedBytes = downloadBytes + payloadBytes
  const peakScratchBytes = input.previousActiveBytes + installedBytes
  if (
    !Number.isSafeInteger(downloadBytes) ||
    !Number.isSafeInteger(payloadBytes) ||
    !Number.isSafeInteger(installedBytes) ||
    !Number.isSafeInteger(peakScratchBytes) ||
    downloadBytes < 1 ||
    payloadBytes < 1 ||
    installedBytes > MAX_PLAN_BYTES ||
    peakScratchBytes > MAX_PLAN_BYTES
  ) {
    return null
  }
  return Object.freeze({ artifactIds, downloadBytes, installedBytes, peakScratchBytes })
}

export function createRuntimeGenerationProvider(options: RuntimeGenerationProviderOptions): RuntimeGenerationProvider {
  const resourcesRoot = resolve(options.resourcesRoot)
  const storeRoot = resolve(options.storeRoot)
  const references = new Map<string, number>()
  let initialized: Promise<{
    catalogBytes: Buffer
    catalog: ReturnType<typeof parseRuntimeCatalog>
    catalogIdentity: string
    trustRoot: Buffer
    trustReceipt: Buffer
  }> | null = null

  const initialize = async (): Promise<NonNullable<typeof initialized> extends Promise<infer T> ? T : never> => {
    if (!initialized) {
      initialized = (async () => {
        await assertOwnedDirectory(resourcesRoot)
        const catalogBytes = await readBoundedRegular(join(resourcesRoot, 'runtime-catalog.json'), MAX_CATALOG_BYTES)
        const catalog = parseRuntimeCatalog(catalogBytes)
        if (!catalog.trustRoot) throw new Error('RUNTIME_TRUST_ROOT_UNAVAILABLE')
        const trustRoot = await readBoundedRegular(join(resourcesRoot, catalog.trustRoot.path), MAX_TRUST_ROOT_BYTES)
        const trustReceipt = await readBoundedRegular(
          join(resourcesRoot, catalog.trustRoot.receipt.path),
          MAX_METADATA_BYTES
        )
        verifyPinnedRuntimeTrust(catalog.trustRoot, trustRoot, trustReceipt)
        return {
          catalogBytes,
          catalog,
          catalogIdentity: sha256(catalogBytes),
          trustRoot,
          trustReceipt
        }
      })().catch((error: unknown) => {
        initialized = null
        throw error
      })
    }
    return initialized
  }

  return {
    initialize: async (): Promise<void> => {
      await initialize()
    },
    async catalogSnapshot() {
      const current = await initialize()
      const bytes = await readBoundedRegular(join(resourcesRoot, 'runtime-catalog.json'), MAX_CATALOG_BYTES)
      if (!bytes.equals(current.catalogBytes)) throw new Error('RUNTIME_CATALOG_CHANGED')
      return Object.freeze({ catalog: current.catalog, catalogIdentity: current.catalogIdentity })
    },
    async previousActiveBytes(feature: RuntimeFeatureId): Promise<number> {
      try {
        const activeRoot = await assertOwnedDirectory(join(storeRoot, 'active'))
        const pointerBytes = await readBoundedRegular(join(activeRoot, `${feature}.json`), MAX_POINTER_BYTES)
        const pointer = parsePointer(pointerBytes, feature)
        const generationRoot = await assertOwnedDirectory(join(storeRoot, 'generations', pointer.generationIdentity))
        let total = pointerBytes.byteLength
        const visit = async (directory: string): Promise<void> => {
          for (const name of await readdir(directory)) {
            const path = join(directory, name)
            const item = await lstat(path, { bigint: true })
            if (item.isSymbolicLink()) throw new Error('RUNTIME_GENERATION_LINK_REJECTED')
            if (item.isDirectory()) await visit(path)
            else if (item.isFile() && item.nlink === 1n) {
              if (item.size > BigInt(MAX_PLAN_BYTES) - BigInt(total)) throw new Error('RUNTIME_PLAN_SIZE_LIMIT')
              total += Number(item.size)
            } else throw new Error('RUNTIME_GENERATION_SPECIAL_FILE')
          }
        }
        await visit(generationRoot)
        return total
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      }
    },
    async acquire({ feature, target, selectedModelId, signal }): Promise<VerifiedRuntimeGeneration | null> {
      if (signal?.aborted) throw signal.reason ?? new Error('RUNTIME_VERIFY_CANCELLED')
      const trust = await initialize()
      const { catalogBytes, catalog, catalogIdentity, trustRoot, trustReceipt } = trust
      const currentCatalog = await readBoundedRegular(join(resourcesRoot, 'runtime-catalog.json'), MAX_CATALOG_BYTES)
      if (!currentCatalog.equals(catalogBytes)) throw new Error('RUNTIME_CATALOG_CHANGED')
      if (!catalog.trustRoot || catalog.targets.length === 0) return null
      const closure = requiredClosure(feature, selectedModelId)
      try {
        await assertOwnedDirectory(storeRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      let activeRoot: string
      try {
        activeRoot = await assertOwnedDirectory(join(storeRoot, 'active'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      let pointerBytes: Buffer
      try {
        pointerBytes = await readBoundedRegular(join(activeRoot, `${feature}.json`), MAX_POINTER_BYTES)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      const pointer = parsePointer(pointerBytes, feature)
      if (
        pointer.catalogIdentity !== catalogIdentity ||
        pointer.selectedModelId !== (selectedModelId ?? null) ||
        !sameTarget(pointer.target, target) ||
        canonicalJson(pointer.artifactIds) !==
          canonicalJson(resolveRuntimeArtifactIds(catalog.targets, feature, target, selectedModelId))
      )
        return null
      const generationRoot = await assertOwnedDirectory(join(storeRoot, 'generations', pointer.generationIdentity))
      const artifactParent = await assertOwnedDirectory(join(generationRoot, 'artifacts'))
      const evidenceParent = await assertOwnedDirectory(join(generationRoot, 'evidence'))
      await assertExactDirectories(artifactParent, pointer.artifactIds)
      await assertExactDirectories(evidenceParent, pointer.artifactIds)
      const entries: Partial<Record<RuntimeEntryRole, string>> = {}
      const models: Partial<Record<LeaseModelId, { root: string; members: string[] }>> = {}
      const nativeDirectories = new Set<string>()
      const rendererFiles: Record<string, string> = {}
      const rendererPins: Record<string, { bytes: number; sha256: string }> = {}
      const physicalClosures: Array<{ root: string; evidenceRoot: string; inventory: RuntimeInventoryV1 }> = []
      const seenRoles = new Set<string>()
      const seenModels = new Set<string>()
      const addRendererFile = (
        urlPath: string,
        ownedPath: string,
        pin: { readonly bytes: number; readonly sha256: string }
      ): void => {
        if (rendererFiles[urlPath]) throw new Error('RUNTIME_RENDERER_PATH_COLLISION')
        rendererFiles[urlPath] = ownedPath
        rendererPins[urlPath] = { bytes: pin.bytes, sha256: pin.sha256 }
      }
      for (const artifactId of pointer.artifactIds) {
        if (signal?.aborted) throw signal.reason ?? new Error('RUNTIME_VERIFY_CANCELLED')
        const row = catalog.targets.find((candidate) => candidate.artifactId === artifactId)
        if (!row || (row.kind === 'runtime' && !runtimeMatchesTarget(row, target))) return null
        if (row.kind === 'model' && (row.target.platform !== 'any' || row.target.arch !== 'any')) return null
        const artifactRoot = join(generationRoot, 'artifacts', artifactId)
        const evidenceRoot = join(generationRoot, 'evidence', artifactId)
        await assertOwnedDirectory(artifactRoot)
        await assertOwnedDirectory(evidenceRoot)
        await assertEvidenceClosure(evidenceRoot)
        const inventoryBytes = await readBoundedRegular(join(evidenceRoot, 'inventory.json'), MAX_METADATA_BYTES)
        const bundleBytes = await readBoundedRegular(join(evidenceRoot, 'bundle.json'), MAX_METADATA_BYTES)
        const archivePath = join(evidenceRoot, 'payload.tar.gz')
        const verified = await verifyWithCatalogIdentity({
          row,
          trustRootPin: catalog.trustRoot,
          trustedRootJson: trustRoot,
          trustedRootReceiptJson: trustReceipt,
          bundleBytes,
          archivePath,
          inventoryBytes
        })
        const inventory = verified.inventory
        const extracted = await extractRuntimeTarGzip(
          archivePath,
          {
            async addFile(_path, data): Promise<void> {
              for await (const _chunk of data) {
                if (signal?.aborted) throw signal.reason ?? new Error('RUNTIME_VERIFY_CANCELLED')
              }
            }
          },
          signal ?? new AbortController().signal
        )
        assertRuntimeFileClosure(inventory, extracted)
        await assertInstalledClosure(artifactRoot, inventory, signal)
        physicalClosures.push({ root: artifactRoot, evidenceRoot, inventory })
        for (const [role, rel] of Object.entries(inventory.entrypoints)) {
          if (!closure.roles.includes(role as RuntimeEntryRole)) continue
          if (seenRoles.has(role)) throw new Error('RUNTIME_FEATURE_ROLE_COLLISION')
          seenRoles.add(role)
          entries[role as RuntimeEntryRole] = `artifacts/${artifactId}/${rel}`
        }
        for (const model of inventory.models) {
          if (!closure.models.includes(model.id)) continue
          if (seenModels.has(model.id)) throw new Error('RUNTIME_FEATURE_MODEL_COLLISION')
          seenModels.add(model.id)
          models[model.id] = {
            root: `artifacts/${artifactId}/${model.root}`,
            members: model.members.map((member) => member.slice(model.root.length + 1))
          }
          if (feature === 'offline-asr' && model.id === 'asr.whisper-base-q8') {
            for (const member of model.members) {
              const inventoryPath = member
              const urlPath = `artifacts/${artifactId}/${inventoryPath}`
              const pin = inventory.files.find((file) => file.path === inventoryPath)
              if (!pin) throw new Error('RUNTIME_RENDERER_FILE_MISSING')
              addRendererFile(urlPath, `artifacts/${artifactId}/${inventoryPath}`, pin)
            }
          }
        }
        const workerPath = inventory.entrypoints['whisper-renderer-worker']
        if (feature === 'offline-asr' && workerPath) {
          const pin = inventory.files.find((file) => file.path === workerPath)
          if (!pin) throw new Error('RUNTIME_RENDERER_FILE_MISSING')
          addRendererFile(`artifacts/${artifactId}/${workerPath}`, `artifacts/${artifactId}/${workerPath}`, pin)
        }
        if (feature === 'offline-asr' && inventory.directories['whisper-ort-wasm']) {
          for (const path of inventory.directories['whisper-ort-wasm'].members) {
            const pin = inventory.files.find((file) => file.path === path)
            if (!pin) throw new Error('RUNTIME_RENDERER_FILE_MISSING')
            addRendererFile(`artifacts/${artifactId}/${path}`, `artifacts/${artifactId}/${path}`, pin)
          }
        }
        if (
          row.kind === 'runtime' &&
          Object.keys(inventory.entrypoints).some((role) => closure.roles.includes(role as RuntimeEntryRole))
        ) {
          for (const file of inventory.files) {
            if (/\.(?:node|dll|so|dylib)$/i.test(file.path))
              nativeDirectories.add(dirname(`artifacts/${artifactId}/${file.path}`).replaceAll('\\', '/'))
          }
        }
      }
      if (
        closure.roles.some((role) => !seenRoles.has(role)) ||
        closure.models.some((id) => !seenModels.has(id)) ||
        seenRoles.size !== closure.roles.length ||
        seenModels.size !== closure.models.length
      )
        return null
      const latestPointer = await readBoundedRegular(join(activeRoot, `${feature}.json`), MAX_POINTER_BYTES)
      if (
        !latestPointer.equals(pointerBytes) ||
        (await assertOwnedDirectory(join(storeRoot, 'active'))) !== activeRoot ||
        (await assertOwnedDirectory(join(storeRoot, 'generations', pointer.generationIdentity))) !== generationRoot
      )
        return null
      const verifyCurrentBytes = async (): Promise<void> => {
        if (
          (await assertOwnedDirectory(join(storeRoot, 'active'))) !== activeRoot ||
          (await assertOwnedDirectory(join(storeRoot, 'generations', pointer.generationIdentity))) !== generationRoot ||
          (await assertOwnedDirectory(join(generationRoot, 'artifacts'))) !== artifactParent ||
          (await assertOwnedDirectory(join(generationRoot, 'evidence'))) !== evidenceParent
        ) {
          throw new Error('RUNTIME_GENERATION_ROOT_CHANGED')
        }
        await assertExactDirectories(artifactParent, pointer.artifactIds)
        await assertExactDirectories(evidenceParent, pointer.artifactIds)
        const currentPointer = await readBoundedRegular(join(activeRoot, `${feature}.json`), MAX_POINTER_BYTES)
        if (!currentPointer.equals(pointerBytes)) throw new Error('RUNTIME_ACTIVE_POINTER_CHANGED')
        const verifiedVersions: Array<Map<string, BigIntStats>> = []
        for (const closure of physicalClosures) {
          verifiedVersions.push(await assertInstalledClosure(closure.root, closure.inventory))
          await assertEvidenceClosure(closure.evidenceRoot)
        }
        // Recheck the physical versions after every metadata/pointer await. Launch callers perform
        // this as their final async admission step, so changed earlier members cannot hide behind a
        // later pointer read or a hash of another member.
        for (const versions of verifiedVersions) {
          for (const [path, verified] of versions) {
            const current = await lstat(path, { bigint: true })
            if (
              current.dev !== verified.dev ||
              current.ino !== verified.ino ||
              current.mode !== verified.mode ||
              current.nlink !== verified.nlink ||
              current.uid !== verified.uid ||
              current.gid !== verified.gid ||
              current.rdev !== verified.rdev ||
              current.size !== verified.size ||
              current.blocks !== verified.blocks ||
              current.mtimeNs !== verified.mtimeNs ||
              current.ctimeNs !== verified.ctimeNs ||
              current.birthtimeNs !== verified.birthtimeNs
            ) {
              throw new Error('RUNTIME_GENERATION_FILE_CHANGED')
            }
          }
        }
      }
      references.set(pointer.generationIdentity, (references.get(pointer.generationIdentity) ?? 0) + 1)
      let released = false
      return Object.freeze({
        generationIdentity: pointer.generationIdentity,
        catalogIdentity,
        target: Object.freeze({ ...target }),
        rootDir: generationRoot,
        verifyCurrentBytes,
        entries: Object.freeze(entries),
        models: Object.freeze(models),
        nativeLibraryDirs: Object.freeze([...nativeDirectories]),
        rendererFiles: Object.freeze(rendererFiles),
        rendererPins: Object.freeze(rendererPins),
        release: () => {
          if (released) return
          released = true
          const current = references.get(pointer.generationIdentity) ?? 0
          if (current <= 1) references.delete(pointer.generationIdentity)
          else references.set(pointer.generationIdentity, current - 1)
        }
      })
    }
  }
}
