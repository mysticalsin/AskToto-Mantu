import { randomBytes, createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEFAULT_TIMING, downloadVerified } from './download'
import { verifyWithCatalogIdentity, type RuntimeCatalogRow, type RuntimeInventoryV1 } from './runtime-provenance'
import { assertRuntimeFileClosure } from './runtime-provenance'
import { hashPinnedArchive } from './runtime-archive'
import { extractRuntimeTarGzip } from './runtime-tar'
import {
  createRuntimePointerSnapshotGuards,
  sameFileOwnerAfterRename,
  sameFileVersion
} from './runtime-pointer-snapshot'
import { verifyStagedPayloads } from './runtime-staged-verifier'
import {
  directoryIdentity,
  ensureOwnedDirectory,
  fileVersion,
  freezeTree,
  makeParents,
  readPinnedFile,
  sameDirectoryIdentity,
  SAFE_FLAGS,
  syncDirectory,
  writeBytesAtomic,
  writeExclusive
} from './runtime-install-files'
import {
  removeRuntimeFileAfterAdmission,
  retainRuntimeTreeIfOwnershipIsUnproven,
  renameRuntimeDirectorySyncAfterAdmission,
  renameRuntimeFileAfterAdmission
} from '../../../infra/storage/runtime-owned-files'
import {
  calculateRuntimeInstallRequirements,
  resolveRuntimeArtifactIds,
  type RuntimeGenerationProvider
} from './runtime-generation-provider'
import type { OptionalRuntimeTarget } from './runtime-components'
import type { RuntimeFeatureId, RuntimeModelId } from './runtime-lease'

const MAX_METADATA_BYTES = 20 * 1024 * 1024
function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
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

export { verifyStagedPayloads }

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
    readonly assertCurrentSync: () => void
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
    await ensureOwnedDirectory(storeRoot)
    const storeRootIdentity = await directoryIdentity(storeRoot)
    const previousActiveBytes = await options.provider.previousActiveBytes(input.feature)
    if (
      (await realpath(storeRoot)) !== storeRoot ||
      !sameDirectoryIdentity(storeRootIdentity, await lstat(storeRoot, { bigint: true }))
    ) {
      throw new Error('RUNTIME_INSTALL_STORE_ROOT_CHANGED')
    }
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
    await check()
    const disk = await statfs(storeRoot, { bigint: true })
    if (disk.bavail * disk.bsize < BigInt(requirements.installedBytes)) {
      throw new Error('RUNTIME_INSTALL_SPACE_UNAVAILABLE')
    }
    await check()
    const generationsRoot = await ensureOwnedDirectory(join(storeRoot, 'generations'))
    const generationsRootIdentity = await directoryIdentity(generationsRoot)
    await check()
    const stagingRoot = await ensureOwnedDirectory(join(storeRoot, 'staging'))
    const stagingRootIdentity = await directoryIdentity(stagingRoot)
    await check()
    const activeRoot = await ensureOwnedDirectory(join(storeRoot, 'active'))
    const activeRootIdentity = await directoryIdentity(activeRoot)
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
    let cleanupRetained = false
    let installResult: { generationIdentity: string; installedBytes: number } | null = null
    let retainStaging = false
    const retainedExecution: { settlement: Promise<void> | null } = { settlement: null }
    let retainPublishedGeneration = false
    let publishedGeneration: string | null = null
    let temporaryPointer: string | null = null
    let temporaryPointerVersion: BigIntStats | null = null
    let publishedPointerOwnerVersion: BigIntStats | null = null
    const priorPointerPath = join(activeRoot, `${input.feature}.json`)
    let priorPointer: Buffer | null = null
    let priorPointerVersion: BigIntStats | null = null
    let finalPointerVersion: BigIntStats | null = null
    let finalPointerBytes: Buffer | null = null
    const assertActiveRootOwned = async (): Promise<void> => {
      const path = join(storeRoot, 'active')
      const [parentStat, parentCanonical, stat, canonical] = await Promise.all([
        lstat(storeRoot, { bigint: true }),
        realpath(storeRoot),
        lstat(path, { bigint: true }),
        realpath(path)
      ])
      if (
        parentCanonical !== storeRoot ||
        !sameDirectoryIdentity(storeRootIdentity, parentStat) ||
        canonical !== activeRoot ||
        !sameDirectoryIdentity(activeRootIdentity, stat)
      ) {
        throw new Error('RUNTIME_INSTALL_ACTIVE_ROOT_CHANGED')
      }
    }
    const { assertActiveRootOwnedSync } = createRuntimePointerSnapshotGuards({
      storeRoot,
      activeRoot,
      storeRootIdentity,
      activeRootIdentity,
      sameFileVersion
    })
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
      const initialStageAdmission = await verifyStagedPayloads(stage, inventories, check)
      try {
        initialStageAdmission.assertCurrentSync()
      } finally {
        await initialStageAdmission.dispose()
      }
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
          assertCurrent: check,
          assertCurrentSync: input.assertCurrentSync
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
      const moveAdmission = await verifyStagedPayloads(stage, inventories, check, {
        roots: [{ path: generationsRoot, identity: generationsRootIdentity }],
        absentPaths: [targetGeneration]
      })
      try {
        renameRuntimeDirectorySyncAfterAdmission({
          admission: moveAdmission,
          source: stage,
          destination: targetGeneration,
          assertCallerCurrentSync: input.assertCurrentSync
        })
      } finally {
        await moveAdmission.dispose()
      }
      publishedGeneration = targetGeneration
      await syncDirectory(generationsRoot)
      await check()
      temporaryPointer = `${priorPointerPath}.${randomBytes(16).toString('hex')}.tmp`
      temporaryPointerVersion = await writeExclusive(temporaryPointer, finalPointer, 0o600)
      await check()
      if (!sameFileVersion(priorPointerVersion, await fileVersion(priorPointerPath))) {
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
      }
      await assertActiveRootOwned()
      if (!sameFileVersion(priorPointerVersion, await fileVersion(priorPointerPath))) {
        throw new Error('RUNTIME_INSTALL_POINTER_CHANGED')
      }
      const [tempVersionBeforePublish, tempBytesBeforePublish] = await Promise.all([
        fileVersion(temporaryPointer),
        readPinnedFile(temporaryPointer, finalPointer.byteLength)
      ])
      if (
        !sameFileVersion(temporaryPointerVersion, tempVersionBeforePublish) ||
        !tempBytesBeforePublish.equals(finalPointer)
      ) {
        throw new Error('RUNTIME_INSTALL_TEMP_OWNER_CHANGED')
      }
      publishedPointerOwnerVersion = temporaryPointerVersion
      await renameRuntimeFileAfterAdmission({
        source: temporaryPointer,
        destination: priorPointerPath,
        sourceVersion: temporaryPointerVersion,
        sourceBytes: finalPointer,
        destinationVersion: priorPointerVersion,
        destinationBytes: priorPointer,
        awaitAdmission: async () => {
          await assertActiveRootOwned()
        },
        assertDestinationSync: assertActiveRootOwnedSync,
        assertCallerCurrentSync: input.assertCurrentSync
      })
      temporaryPointer = null
      temporaryPointerVersion = null
      try {
        const publishedVersion = await fileVersion(priorPointerPath)
        if (!publishedVersion) throw new Error('RUNTIME_INSTALL_POINTER_PUBLISH_FAILED')
        const publishedBytes = await readPinnedFile(priorPointerPath, finalPointer.byteLength)
        if (
          !sameFileOwnerAfterRename(publishedPointerOwnerVersion, publishedVersion) ||
          !publishedBytes.equals(finalPointer)
        ) {
          throw new Error('RUNTIME_INSTALL_POINTER_PUBLISH_FAILED')
        }
        finalPointerVersion = publishedVersion
        await syncDirectory(activeRoot)
        await check()
      } catch (error) {
        await assertActiveRootOwned()
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
        let pointerVersion = await fileVersion(priorPointerPath)
        if (
          current?.equals(finalPointer) &&
          finalPointerVersion === null &&
          sameFileOwnerAfterRename(publishedPointerOwnerVersion, pointerVersion)
        ) {
          // Only recover metadata for the inode captured from our own pointer temporary.
          // Equal bytes in another inode are not evidence of our publication.
          finalPointerVersion = pointerVersion
        }
        if (current?.equals(finalPointer) && sameFileVersion(finalPointerVersion, pointerVersion)) {
          const assertPublishedPointerStillOwned = async (): Promise<() => void> => {
            await assertActiveRootOwned()
            const bytes = await readPinnedFile(priorPointerPath, 64 * 1024)
            pointerVersion = await fileVersion(priorPointerPath)
            if (!bytes.equals(finalPointer) || !sameFileVersion(finalPointerVersion, pointerVersion)) {
              throw new Error('RUNTIME_INSTALL_ROLLBACK_POINTER_CHANGED')
            }
            await assertActiveRootOwned()
            return assertActiveRootOwnedSync
          }
          if (priorPointer) {
            await writeBytesAtomic(
              priorPointerPath,
              priorPointer,
              assertPublishedPointerStillOwned,
              pointerVersion,
              finalPointer
            )
          } else {
            const rollbackPath = `${priorPointerPath}.${randomBytes(16).toString('hex')}.rollback`
            if (!pointerVersion) throw new Error('RUNTIME_INSTALL_ROLLBACK_POINTER_CHANGED')
            await renameRuntimeFileAfterAdmission({
              source: priorPointerPath,
              destination: rollbackPath,
              sourceVersion: pointerVersion,
              sourceBytes: finalPointer,
              destinationVersion: null,
              destinationBytes: null,
              awaitAdmission: assertPublishedPointerStillOwned,
              assertDestinationSync: assertActiveRootOwnedSync,
              assertCallerCurrentSync: input.assertCurrentSync
            })
            retainPublishedGeneration = true
            const movedBytes = await readPinnedFile(rollbackPath, 64 * 1024)
            const movedVersion = await fileVersion(rollbackPath)
            if (!movedBytes.equals(finalPointer) || !sameFileOwnerAfterRename(finalPointerVersion, movedVersion)) {
              retainPublishedGeneration = true
              throw new Error('RUNTIME_INSTALL_ROLLBACK_POINTER_CHANGED')
            }
            finalPointerVersion = movedVersion
            await assertActiveRootOwned()
            const [removeVersion, removeBytes] = await Promise.all([
              fileVersion(rollbackPath),
              readPinnedFile(rollbackPath, 64 * 1024)
            ])
            if (!sameFileVersion(finalPointerVersion, removeVersion) || !removeBytes.equals(finalPointer)) {
              throw new Error('RUNTIME_INSTALL_ROLLBACK_POINTER_CHANGED')
            }
            if (!finalPointerVersion) throw new Error('RUNTIME_INSTALL_ROLLBACK_POINTER_CHANGED')
            assertActiveRootOwnedSync()
            await removeRuntimeFileAfterAdmission(
              rollbackPath,
              finalPointerVersion,
              finalPointer,
              assertActiveRootOwnedSync
            )
            await syncDirectory(activeRoot)
            retainPublishedGeneration = false
          }
          await syncDirectory(activeRoot)
        } else if (!(priorPointer ? current?.equals(priorPointer) : current === null)) {
          retainPublishedGeneration = true
        }
        throw error
      }
      complete = true
      installResult = { generationIdentity: generation, installedBytes: requirements.installedBytes }
    } finally {
      if (!complete) {
        if (temporaryPointer && temporaryPointerVersion) {
          if (finalPointerBytes) {
            await removeRuntimeFileAfterAdmission(temporaryPointer, temporaryPointerVersion, finalPointerBytes)
          }
        }
        if (!retainStaging) {
          cleanupRetained = await retainRuntimeTreeIfOwnershipIsUnproven({
            root: stagingRoot,
            rootExpected: stagingRootIdentity,
            path: stage,
            expected: stageIdentity
          })
        } else if (retainedExecution.settlement) {
          await retainedExecution.settlement
          cleanupRetained = await retainRuntimeTreeIfOwnershipIsUnproven({
            root: stagingRoot,
            rootExpected: stagingRootIdentity,
            path: stage,
            expected: stageIdentity
          })
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
          if (
            !retainPublishedGeneration &&
            (await retainRuntimeTreeIfOwnershipIsUnproven({
              root: generationsRoot,
              rootExpected: generationsRootIdentity,
              path: publishedGeneration,
              expected: stageIdentity
            }))
          ) {
            cleanupRetained = true
          }
        }
      }
    }
    if (cleanupRetained) throw new Error('RUNTIME_INSTALL_CLEANUP_RETAINED')
    if (!installResult) throw new Error('RUNTIME_INSTALL_RESULT_UNAVAILABLE')
    return installResult
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
