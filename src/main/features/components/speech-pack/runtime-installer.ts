import { randomBytes, createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, statfs } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { DEFAULT_TIMING, downloadVerified } from './download'
import { verifyWithCatalogIdentity, type RuntimeCatalogRow, type RuntimeInventoryV1 } from './runtime-provenance'
import { hashPinnedArchive } from './runtime-archive'
import { extractRuntimeTarGzip } from './runtime-tar'
import { assertRuntimeFileClosure } from './runtime-provenance'
import {
  calculateRuntimeInstallRequirements,
  resolveRuntimeArtifactIds,
  type RuntimeGenerationProvider
} from './runtime-generation-provider'
import type { OptionalRuntimeTarget } from './runtime-components'
import type { RuntimeFeatureId, RuntimeModelId } from './runtime-lease'

const MAX_METADATA_BYTES = 20 * 1024 * 1024
const SAFE_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameFileVersion(a: BigIntStats | null, b: BigIntStats | null): boolean {
  return a === null || b === null
    ? a === b
    : a.dev === b.dev &&
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
}

async function fileVersion(path: string): Promise<BigIntStats | null> {
  try {
    const value = await lstat(path, { bigint: true })
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n) {
      throw new Error('RUNTIME_INSTALL_POINTER_INVALID')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

type DirectoryIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const value = await lstat(path, { bigint: true })
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('RUNTIME_INSTALL_DIRECTORY_INVALID')
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs }
}

function sameDirectoryIdentity(expected: DirectoryIdentity, actual: BigIntStats): boolean {
  return (
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeNs === actual.birthtimeNs
  )
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function generationIdentity(input: {
  feature: RuntimeFeatureId
  selectedModelId: RuntimeModelId | null
  catalogIdentity: string
  target: OptionalRuntimeTarget
  artifactIds: readonly string[]
}): string {
  return sha256(canonicalJson({ schemaVersion: 1, ...input, artifactIds: [...input.artifactIds].sort() }))
}

async function ensureOwnedDirectory(path: string): Promise<string> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await lstat(path)
  const canonical = await realpath(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolve(path)) {
    throw new Error('RUNTIME_INSTALL_DIRECTORY_INVALID')
  }
  return canonical
}

async function readPinnedFile(path: string, max: number): Promise<Buffer> {
  if (process.platform !== 'win32' && (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)) {
    throw new Error('RUNTIME_SAFE_FILE_OPEN_UNAVAILABLE')
  }
  const handle = await open(path, constants.O_RDONLY | SAFE_FLAGS)
  try {
    const before = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
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
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(max) ||
      !named.isFile() ||
      named.nlink !== 1n ||
      !sameVersion(before, named)
    ) {
      throw new Error('RUNTIME_INSTALL_FILE_INVALID')
    }
    const chunks: Buffer[] = []
    let total = 0
    let position = 0
    while (total <= max) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      position += bytesRead
    }
    if (total > max) throw new Error('RUNTIME_INSTALL_FILE_TOO_LARGE')
    const bytes = Buffer.concat(chunks, total)
    const after = await handle.stat({ bigint: true })
    const namedAfter = await lstat(path, { bigint: true })
    if (BigInt(bytes.byteLength) !== before.size || !sameVersion(before, after) || !sameVersion(before, namedAfter)) {
      throw new Error('RUNTIME_INSTALL_FILE_CHANGED')
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function makeParents(root: string, relPath: string): Promise<string> {
  let current = root
  const pieces = relPath.split('/')
  for (const piece of pieces.slice(0, -1)) {
    current = join(current, piece)
    await ensureOwnedDirectory(current)
  }
  const rootPath = await realpath(root)
  const rel = relative(rootPath, resolve(current))
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(current) !== realpathSyncFree(rootPath, rel)) {
    throw new Error('RUNTIME_INSTALL_PATH_ESCAPE')
  }
  return join(current, pieces.at(-1) as string)
}

function realpathSyncFree(root: string, rel: string): string {
  return rel ? resolve(root, rel) : root
}

async function writeExclusive(path: string, data: Uint8Array, mode: number): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | SAFE_FLAGS, mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeBytesAtomic(
  path: string,
  bytes: Uint8Array,
  beforeRename: () => Promise<void> | void
): Promise<void> {
  const temp = `${path}.${randomBytes(16).toString('hex')}.tmp`
  await writeExclusive(temp, bytes, 0o600)
  try {
    await beforeRename()
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function removeOwnedTree(root: string, path: string, expectedRoot: DirectoryIdentity): Promise<void> {
  const canonicalRoot = await realpath(root)
  const canonical = await realpath(path)
  const rel = relative(canonicalRoot, canonical)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(path) !== canonical) {
    throw new Error('RUNTIME_INSTALL_CLEANUP_ESCAPE')
  }
  const makeWritable = async (directory: string, expected: DirectoryIdentity): Promise<void> => {
    if (!sameDirectoryIdentity(expected, await lstat(directory, { bigint: true }))) {
      throw new Error('RUNTIME_INSTALL_CLEANUP_OWNER_CHANGED')
    }
    await chmod(directory, 0o700)
    for (const name of await readdir(directory)) {
      const child = join(directory, name)
      const item = await lstat(child, { bigint: true })
      if (item.isSymbolicLink()) throw new Error('RUNTIME_INSTALL_LINK_REJECTED')
      if (item.isDirectory()) {
        await makeWritable(child, { dev: item.dev, ino: item.ino, birthtimeNs: item.birthtimeNs })
      } else if (item.isFile() && item.nlink === 1n) {
        const current = await lstat(child, { bigint: true })
        if (!sameFileVersion(item, current)) throw new Error('RUNTIME_INSTALL_CLEANUP_OWNER_CHANGED')
        await chmod(child, 0o600)
      } else throw new Error('RUNTIME_INSTALL_SPECIAL_FILE')
    }
  }
  await makeWritable(canonical, expectedRoot)
  if (!sameDirectoryIdentity(expectedRoot, await lstat(canonical, { bigint: true }))) {
    throw new Error('RUNTIME_INSTALL_CLEANUP_OWNER_CHANGED')
  }
  await rm(canonical, { recursive: true, force: true })
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function freezeTree(root: string, check: () => Promise<void>): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      await check()
      const path = join(directory, name)
      const item = await lstat(path)
      if (item.isSymbolicLink()) throw new Error('RUNTIME_INSTALL_LINK_REJECTED')
      if (item.isDirectory()) {
        await visit(path)
        await chmod(path, 0o500)
        await check()
      } else if (item.isFile() && item.nlink === 1) {
        await chmod(path, (item.mode & 0o111) !== 0 ? 0o500 : 0o400)
        await check()
      } else throw new Error('RUNTIME_INSTALL_SPECIAL_FILE')
    }
  }
  await visit(root)
  await check()
  await chmod(root, 0o500)
  await check()
}

export async function verifyStagedPayloads(
  stage: string,
  inventories: readonly RuntimeInventoryV1[],
  check: () => Promise<void>
): Promise<void> {
  for (const inventory of inventories) {
    const root = join(stage, 'artifacts', inventory.artifactId)
    const expected = new Map(inventory.files.map((file) => [file.path, file]))
    const directories = new Set<string>()
    for (const path of expected.keys()) {
      const pieces = path.split('/')
      for (let index = 1; index < pieces.length; index++) directories.add(pieces.slice(0, index).join('/'))
    }
    const found = new Set<string>()
    const folded = new Set<string>()
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        await check()
        const path = prefix ? `${prefix}/${name}` : name
        const full = join(directory, name)
        const stat = await lstat(full)
        if (stat.isSymbolicLink()) throw new Error('RUNTIME_STAGED_LINK_REJECTED')
        if (stat.isDirectory()) {
          if (!directories.has(path)) throw new Error('RUNTIME_STAGED_EXTRA_DIRECTORY')
          await visit(full, path)
          continue
        }
        const pin = expected.get(path)
        const key = path.toLowerCase()
        if (!stat.isFile() || stat.nlink !== 1 || !pin || folded.has(key)) {
          throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
        }
        folded.add(key)
        found.add(path)
        if (stat.size !== pin.bytes || ((stat.mode & 0o111) !== 0) !== pin.executable) {
          throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
        }
        const digest = pin.bytes === 0 ? sha256(Buffer.alloc(0)) : await hashPinnedArchive(full, pin.bytes)
        if (digest !== pin.sha256) throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
      }
    }
    await visit(root, '')
    if (found.size !== expected.size) throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  }
}

function rowsFor(rowIds: readonly string[], rows: readonly RuntimeCatalogRow[]): RuntimeCatalogRow[] {
  const selected = rowIds.map((id) => rows.find((row) => row.artifactId === id))
  if (selected.some((row) => !row)) throw new Error('RUNTIME_PLAN_CATALOG_CHANGED')
  return selected as RuntimeCatalogRow[]
}

function retainedExecutionSettlement(error: unknown): Promise<void> | null {
  if (!error || typeof error !== 'object' || !('settled' in error)) return null
  const settled = (error as { settled?: unknown }).settled
  return settled instanceof Promise ? settled : null
}

export interface RuntimeInstallTransactionInput {
  readonly feature: RuntimeFeatureId
  readonly selectedModelId: RuntimeModelId | null
  readonly target: OptionalRuntimeTarget
  readonly artifactIds: readonly string[]
  readonly catalogIdentity: string
  readonly signal: AbortSignal
  /** The plan book binds this to fresh authority, selected model, target and catalog identity. */
  readonly assertCurrent: () => Promise<void>
  /** Synchronous live owner/authority token check for atomic publication boundaries. */
  readonly assertCurrentSync: () => void
}

export interface RuntimeInstallSelfTest {
  (input: {
    readonly feature: RuntimeFeatureId
    readonly selectedModelId: RuntimeModelId | null
    readonly target: OptionalRuntimeTarget
    readonly generationIdentity: string
    readonly catalogIdentity: string
    readonly stagedRoot: string
    readonly inventories: readonly RuntimeInventoryV1[]
    readonly signal: AbortSignal
    readonly assertCurrent: () => Promise<void>
  }): Promise<void>
}

/**
 * Installs only the complete feature closure in a consumed affirmative plan. No URL, path, model row,
 * or artifact list can enter through IPC; these values are re-derived from the app-owned catalog.
 */
export function createRuntimeInstaller(options: {
  readonly provider: RuntimeGenerationProvider
  readonly resourcesRoot: string
  readonly storeRoot: string
  readonly selfTest: RuntimeInstallSelfTest
}) {
  const resourcesRoot = resolve(options.resourcesRoot)
  const storeRoot = resolve(options.storeRoot)

  const installing = new Set<RuntimeFeatureId>()
  const installOnce = async (
    input: RuntimeInstallTransactionInput
  ): Promise<{ generationIdentity: string; installedBytes: number }> => {
    const check = async (): Promise<void> => {
      if (input.signal.aborted) throw input.signal.reason ?? new Error('RUNTIME_INSTALL_CANCELLED')
      input.assertCurrentSync()
      await input.assertCurrent()
      if (input.signal.aborted) throw input.signal.reason ?? new Error('RUNTIME_INSTALL_CANCELLED')
      input.assertCurrentSync()
    }
    await check()
    const catalogSnapshot = await options.provider.catalogSnapshot()
    await check()
    if (catalogSnapshot.catalogIdentity !== input.catalogIdentity || !catalogSnapshot.catalog.trustRoot) {
      throw new Error('RUNTIME_PLAN_CATALOG_CHANGED')
    }
    const derivedIds = resolveRuntimeArtifactIds(
      catalogSnapshot.catalog.targets,
      input.feature,
      input.target,
      input.selectedModelId ?? undefined
    )
    if (!derivedIds || canonicalJson(derivedIds) !== canonicalJson(input.artifactIds)) {
      throw new Error('RUNTIME_PLAN_CLOSURE_CHANGED')
    }
    const selectedRows = rowsFor(derivedIds, catalogSnapshot.catalog.targets)
    const previousActiveBytes = await options.provider.previousActiveBytes(input.feature)
    await check()
    const requirements = calculateRuntimeInstallRequirements({
      rows: catalogSnapshot.catalog.targets,
      feature: input.feature,
      target: input.target,
      selectedModelId: input.selectedModelId ?? undefined,
      previousActiveBytes
    })
    if (!requirements || canonicalJson(requirements.artifactIds) !== canonicalJson(derivedIds)) {
      throw new Error('RUNTIME_PLAN_UNAVAILABLE')
    }
    await ensureOwnedDirectory(storeRoot)
    await check()
    const disk = await statfs(storeRoot, { bigint: true })
    if (disk.bavail * disk.bsize < BigInt(requirements.installedBytes)) {
      throw new Error('RUNTIME_INSTALL_SPACE_UNAVAILABLE')
    }
    await check()
    const generationsRoot = await ensureOwnedDirectory(join(storeRoot, 'generations'))
    await check()
    const stagingRoot = await ensureOwnedDirectory(join(storeRoot, 'staging'))
    await check()
    const activeRoot = await ensureOwnedDirectory(join(storeRoot, 'active'))
    await check()
    const generation = generationIdentity({
      feature: input.feature,
      selectedModelId: input.selectedModelId,
      catalogIdentity: input.catalogIdentity,
      target: input.target,
      artifactIds: derivedIds
    })
    const stage = join(stagingRoot, randomBytes(24).toString('hex'))
    await mkdir(stage)
    const stageIdentity = await directoryIdentity(stage)
    const stageCanonical = await realpath(stage)
    if (stageCanonical !== stage) throw new Error('RUNTIME_INSTALL_DIRECTORY_INVALID')
    await check()
    const inventories: RuntimeInventoryV1[] = []
    let complete = false
    let retainStaging = false
    const retainedExecution: { settlement: Promise<void> | null } = { settlement: null }
    let retainPublishedGeneration = false
    let publishedGeneration: string | null = null
    let temporaryPointer: string | null = null
    const priorPointerPath = join(activeRoot, `${input.feature}.json`)
    let priorPointer: Buffer | null = null
    let priorPointerVersion: BigIntStats | null = null
    let finalPointerVersion: BigIntStats | null = null
    let finalPointerBytes: Buffer | null = null
    try {
      const trustRoot = await readPinnedFile(
        join(resourcesRoot, catalogSnapshot.catalog.trustRoot.path),
        2 * 1024 * 1024
      )
      await check()
      const trustReceipt = await readPinnedFile(
        join(resourcesRoot, catalogSnapshot.catalog.trustRoot.receipt.path),
        64 * 1024
      )
      await check()
      const fetchDeps = {
        fetch,
        sleep: (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)),
        random: Math.random,
        timing: { ...DEFAULT_TIMING }
      }
      for (const row of selectedRows) {
        await check()
        const evidenceRoot = join(stage, 'evidence', row.artifactId)
        const artifactRoot = join(stage, 'artifacts', row.artifactId)
        await ensureOwnedDirectory(evidenceRoot)
        await check()
        await ensureOwnedDirectory(artifactRoot)
        await check()
        const archivePath = join(evidenceRoot, 'payload.tar.gz')
        const inventoryPath = join(evidenceRoot, 'inventory.json')
        const bundlePath = join(evidenceRoot, 'bundle.json')
        const download = async (pin: RuntimeCatalogRow['archive'], dest: string): Promise<void> => {
          await downloadVerified(
            {
              url: pin.url,
              dest,
              bytes: pin.bytes,
              sha256: pin.sha256,
              signal: input.signal,
              trustedRoot: stage,
              authorize: () => !input.signal.aborted,
              authorizeSync: () => {
                if (input.signal.aborted) throw input.signal.reason ?? new Error('RUNTIME_INSTALL_CANCELLED')
                input.assertCurrentSync()
              },
              authorizeAsync: check,
              resumeScope: randomBytes(16).toString('hex'),
              onProgress: () => undefined
            },
            fetchDeps
          )
          await check()
        }
        await download(row.archive, archivePath)
        await download(row.inventory, inventoryPath)
        await download(row.bundle, bundlePath)
        const inventoryBytes = await readPinnedFile(inventoryPath, MAX_METADATA_BYTES)
        await check()
        const bundleBytes = await readPinnedFile(bundlePath, MAX_METADATA_BYTES)
        await check()
        const archiveDigest = await hashPinnedArchive(archivePath, row.archive.bytes)
        await check()
        if (
          inventoryBytes.byteLength !== row.inventory.bytes ||
          sha256(inventoryBytes) !== row.inventory.sha256 ||
          bundleBytes.byteLength !== row.bundle.bytes ||
          sha256(bundleBytes) !== row.bundle.sha256 ||
          archiveDigest !== row.archive.sha256
        ) {
          throw new Error('RUNTIME_DOWNLOAD_PIN_MISMATCH')
        }
        await check()
        const verified = await verifyWithCatalogIdentity({
          row,
          trustRootPin: catalogSnapshot.catalog.trustRoot,
          trustedRootJson: trustRoot,
          trustedRootReceiptJson: trustReceipt,
          bundleBytes,
          archivePath,
          inventoryBytes
        })
        const inventory = verified.inventory
        inventories.push(inventory)
        if (inventory.files.reduce((total, file) => total + file.bytes, 0) !== row.payloadBytes) {
          throw new Error('RUNTIME_PAYLOAD_SIZE_MISMATCH')
        }
        await check()
        const extracted = await extractRuntimeTarGzip(
          archivePath,
          {
            async addFile(relPath, chunks): Promise<void> {
              await check()
              const destination = await makeParents(artifactRoot, relPath)
              await check()
              const file = await open(
                destination,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | SAFE_FLAGS,
                0o600
              )
              let written = 0
              try {
                await check()
                for await (const chunk of chunks) {
                  await check()
                  written += chunk.byteLength
                  await file.writeFile(chunk)
                }
                if (written === 0 && inventory.files.find((item) => item.path === relPath)?.bytes !== 0) {
                  throw new Error('RUNTIME_EXTRACTED_FILE_SIZE_MISMATCH')
                }
                const expected = inventory.files.find((item) => item.path === relPath)
                if (!expected || written !== expected.bytes) throw new Error('RUNTIME_EXTRACTED_FILE_SIZE_MISMATCH')
                await file.chmod(expected.executable ? 0o700 : 0o600)
                await file.sync()
              } finally {
                await file.close()
              }
              await check()
            }
          },
          input.signal
        )
        assertRuntimeFileClosure(inventory, extracted)
        await check()
      }
      await check()
      const targetGeneration = join(generationsRoot, generation)
      await freezeTree(stage, check)
      await verifyStagedPayloads(stage, inventories, check)
      try {
        await options.selfTest({
          feature: input.feature,
          selectedModelId: input.selectedModelId,
          target: input.target,
          generationIdentity: generation,
          catalogIdentity: input.catalogIdentity,
          stagedRoot: stage,
          inventories: Object.freeze(inventories),
          signal: input.signal,
          assertCurrent: check
        })
      } catch (error) {
        if (error && typeof error === 'object' && 'retainStaging' in error && error.retainStaging === true) {
          retainStaging = true
          retainedExecution.settlement = retainedExecutionSettlement(error) ?? new Promise<void>(() => undefined)
        }
        throw error
      }
      await check()
      priorPointerVersion = await fileVersion(priorPointerPath)
      try {
        priorPointer = await readPinnedFile(priorPointerPath, 64 * 1024)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (
        (priorPointer === null) !== (priorPointerVersion === null) ||
        !sameFileVersion(priorPointerVersion, await fileVersion(priorPointerPath))
      ) {
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
      }
      const finalGeneration = {
        schemaVersion: 1,
        feature: input.feature,
        selectedModelId: input.selectedModelId,
        catalogIdentity: input.catalogIdentity,
        generationIdentity: generation,
        target: input.target,
        artifactIds: derivedIds
      }
      const finalPointer = Buffer.from(`${canonicalJson(finalGeneration)}\n`)
      finalPointerBytes = finalPointer
      if (
        await lstat(targetGeneration).then(
          () => true,
          () => false
        )
      ) {
        throw new Error('RUNTIME_GENERATION_ALREADY_EXISTS')
      }
      await check()
      input.assertCurrentSync()
      await rename(stage, targetGeneration)
      publishedGeneration = targetGeneration
      await syncDirectory(generationsRoot)
      await check()
      temporaryPointer = `${priorPointerPath}.${randomBytes(16).toString('hex')}.tmp`
      await writeExclusive(temporaryPointer, finalPointer, 0o600)
      await check()
      input.assertCurrentSync()
      if (!sameFileVersion(priorPointerVersion, await fileVersion(priorPointerPath))) {
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
      }
      await rename(temporaryPointer, priorPointerPath)
      temporaryPointer = null
      finalPointerVersion = await fileVersion(priorPointerPath)
      if (!finalPointerVersion) throw new Error('RUNTIME_INSTALL_POINTER_PUBLISH_FAILED')
      try {
        await syncDirectory(activeRoot)
        await check()
      } catch (error) {
        let current: Buffer | null
        try {
          current = await readPinnedFile(priorPointerPath, 64 * 1024)
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT' && priorPointer === null) current = null
          else {
            retainPublishedGeneration = true
            throw error
          }
        }
        const pointerVersion = await fileVersion(priorPointerPath)
        if (current?.equals(finalPointer) && sameFileVersion(finalPointerVersion, pointerVersion)) {
          const assertPublishedPointerStillOwned = async (): Promise<void> => {
            const bytes = await readPinnedFile(priorPointerPath, 64 * 1024)
            const version = await fileVersion(priorPointerPath)
            if (!bytes.equals(finalPointer) || !sameFileVersion(finalPointerVersion, version)) {
              throw new Error('RUNTIME_INSTALL_ROLLBACK_POINTER_CHANGED')
            }
          }
          if (priorPointer) {
            await writeBytesAtomic(priorPointerPath, priorPointer, assertPublishedPointerStillOwned)
          } else {
            await assertPublishedPointerStillOwned()
            await rm(priorPointerPath, { force: true })
          }
          await syncDirectory(activeRoot)
        } else if (!(priorPointer ? current?.equals(priorPointer) : current === null)) {
          retainPublishedGeneration = true
        }
        throw error
      }
      complete = true
      return { generationIdentity: generation, installedBytes: requirements.installedBytes }
    } finally {
      if (!complete) {
        if (temporaryPointer) await rm(temporaryPointer, { force: true }).catch(() => undefined)
        if (!retainStaging) await removeOwnedTree(stagingRoot, stage, stageIdentity).catch(() => undefined)
        else if (retainedExecution.settlement) {
          void retainedExecution.settlement
            .then(() => removeOwnedTree(stagingRoot, stage, stageIdentity))
            .catch(() => undefined)
        }
        if (publishedGeneration && !retainPublishedGeneration && finalPointerBytes) {
          try {
            const current = await readPinnedFile(join(activeRoot, `${input.feature}.json`), 64 * 1024)
            if (current.equals(finalPointerBytes)) retainPublishedGeneration = true
            else if (!(priorPointer ? current.equals(priorPointer) : false)) retainPublishedGeneration = true
          } catch (error) {
            if (!((error as NodeJS.ErrnoException).code === 'ENOENT' && priorPointer === null)) {
              retainPublishedGeneration = true
            }
          }
          if (!retainPublishedGeneration)
            await removeOwnedTree(generationsRoot, publishedGeneration, stageIdentity).catch(() => undefined)
        }
      }
    }
  }
  return Object.freeze({
    async install(input: RuntimeInstallTransactionInput) {
      if (installing.has(input.feature)) throw new Error('RUNTIME_INSTALL_ALREADY_ACTIVE')
      installing.add(input.feature)
      let retainSlot = false
      try {
        return await installOnce(input)
      } catch (error) {
        const settled = retainedExecutionSettlement(error)
        if (settled) {
          retainSlot = true
          void settled.then(() => installing.delete(input.feature)).catch(() => undefined)
        }
        throw error
      } finally {
        if (!retainSlot) installing.delete(input.feature)
      }
    }
  })
}
