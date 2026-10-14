/**
 * engine.ts — the on-device speech-pack engine (M2-0475).
 *
 * Layout under `rootDir` (userData/speech-packs):
 *
 *   .staging/<id>/<version>/   files land here, each verified before it gets its real name
 *   .staging/<id>/work/        archive download and extraction scratch (removed before activation)
 *   <id>/<version>/            the activated pack — appears by ONE rename of the staging directory
 *   <id>/active.json           written last, via a temporary file and a rename
 *
 * ACTIVATION ORDER, AND WHY IT IS SAFE TO KILL THE PROCESS BETWEEN ANY TWO STEPS
 *
 *   1. every file in staging re-verified (length + sha256)
 *   2. the injected self-test decodes the pinned fixture to non-empty text
 *   3. an existing <id>/<version> is renamed aside to <version>.old-<ts>   (never deleted first)
 *   4. rename staging -> <id>/<version>      (atomic: the directory is whole or absent)
 *   5. write active.json.tmp, rename to active.json, and retain the aside until a verified later startup
 *
 * A marker exists only after step 4 completed, and step 4 only runs on a fully verified, self-tested set,
 * so no crash can leave a marker without a complete directory or a half-filled directory behind a marker.
 * A crash between 4 and 5 leaves a complete but unmarked directory; startup never activates it. An explicit
 * repair/resume plan must verify and self-test it again before promotion.
 * Cancel is checked before the self-test, before activation, after the marker switch and before 'ready'.
 *
 * State and events carry component ids, byte counts and error kinds only — no path, transcript, audio or
 * user text ever enters a state, an event or a log line.
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { adoptExtracted, createArchiveSink, type ExtractArchive } from './archive'
import {
  DEFAULT_TIMING,
  availableBytesAtPath,
  downloadVerified,
  nearestExistingPath,
  pathExists as exists,
  reuseVerifiedFiles,
  sha256File,
  sizeOf,
  type DownloadDeps,
  type DownloadTiming
} from './download'
import { SpeechPackError } from './errors'
import {
  SELF_TEST_FIXTURE,
  SPEECH_PACK_COMPONENTS,
  componentBytes,
  speechPackFileUrl,
  type SpeechPackComponent,
  type SpeechPackComponentId
} from './manifest'
import { componentManifestIdentity } from './resolver'
import { runPinnedSpeechPackSelfTest } from './self-test'
import { assertSpeechPackActivationAuthorized, assertSpeechPackTransferAuthorized } from './activation-authority'
import type { SpeechPackActivationMarker } from './marker'
import { createSpeechPackStateEvents, type SpeechPackState, type SpeechPackStateEvent } from './state-events'
import { SpeechPackOperationQueue } from './operation-queue'
import {
  createSpeechPackActivationRollback,
  type InstallDirectoryOwners,
  type RollbackOwnership
} from './activation-rollback'

export const DISK_HEADROOM_BYTES = 512 * 1024 * 1024
export const EMIT_INTERVAL_MS = 250
export type { SpeechPackState } from './state-events'

export type ActivationStep =
  | 'staged-verified'
  | 'self-tested'
  | 'old-moved-aside'
  | 'renamed'
  | 'marker-tmp-written'
  | 'marker-written'
  | 'ready-check'

export interface SpeechPackEngineOptions {
  rootDir: string
  /** The pinned en.wav the self-test decodes. */
  fixtureWavPath: string
  /** Length and digest `fixtureWavPath` must match; defaults to SELF_TEST_FIXTURE. */
  fixture?: { readonly bytes: number; readonly sha256: string }
  /** Decodes the wav with the staged pack and returns the text. Must not log or persist it. */
  selfTest: (input: {
    componentId: SpeechPackComponentId
    packDir: string
    wavPath: string
    signal: AbortSignal
  }) => Promise<string>
  components?: readonly SpeechPackComponent[]
  /** Required for archive-sourced components. */
  extractArchive?: ExtractArchive
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  timing?: Partial<DownloadTiming>
  freeBytes?: (path: string) => number | Promise<number>
  emitIntervalMs?: number
  /** Test seam: called after each activation step, so a test can stop the process there. */
  onActivationStep?: (step: ActivationStep) => void | Promise<void>
  /** Called once the operation has either committed or completed its rollback path. */
  onTransactionSettled?: (componentId: SpeechPackComponentId, transaction: symbol) => void
  /** Rechecked between streamed chunks to stop after a consent or local-policy change. */
  authorizeTransfer?: (componentId: SpeechPackComponentId) => boolean
  /** Forced trust refresh at the reviewed activation boundary; status and chunk polls never call this. */
  authorizeActivation?: (componentId: SpeechPackComponentId) => boolean | Promise<boolean>
  /** Trust refresh for rollback-only renames that restore the previously active verified generation. */
  authorizeRollback?: (
    componentId: SpeechPackComponentId,
    marker: Pick<SpeechPackActivationMarker, 'version' | 'manifestIdentity'> | null,
    transaction: symbol
  ) => boolean | Promise<boolean>
  /** Synchronous identity/policy fence run immediately before a rollback rename. */
  authorizeRollbackCurrent?: (
    componentId: SpeechPackComponentId,
    marker: Pick<SpeechPackActivationMarker, 'version' | 'manifestIdentity'> | null,
    transaction: symbol
  ) => boolean
  /** Distinguishes an in-process pause/resume from stale partial data left by a prior launch. */
  resumeScope?: string
}

export interface SpeechPackEngine {
  /** Adopt only directories with an existing valid activation marker; never activate at startup. */
  initialise(): Promise<void>
  getState(id: SpeechPackComponentId): SpeechPackState
  states(): Record<SpeechPackComponentId, SpeechPackState>
  subscribe(listener: (event: SpeechPackStateEvent) => void): () => void
  /** Queue installs; `selected` (the engine chosen for this machine) goes first. */
  enqueue(ids: readonly SpeechPackComponentId[], selected?: SpeechPackComponentId, transaction?: symbol): void
  /** Force a fresh staged transfer, hash verification and isolated self-test before promotion. */
  repair(id: SpeechPackComponentId, transaction?: symbol): void
  pause(id: SpeechPackComponentId): void
  cancel(id: SpeechPackComponentId): void
  /** Resolves when nothing is queued or running. */
  whenIdle(): Promise<void>
}

/** The activation seam models process death, where JavaScript rollback code cannot run. */
class SimulatedActivationProcessStop extends Error {}
class SpeechPackRollbackIncomplete extends Error {}

export function createSpeechPackEngine(options: SpeechPackEngineOptions): SpeechPackEngine {
  const components = options.components ?? SPEECH_PACK_COMPONENTS
  const byId = new Map(components.map((c) => [c.id, c]))
  const deps: DownloadDeps = {
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options.random ?? Math.random,
    timing: { ...DEFAULT_TIMING, ...options.timing }
  }
  const freeBytes = options.freeBytes ?? availableBytesAtPath
  const interval = options.emitIntervalMs ?? EMIT_INTERVAL_MS
  const { rootDir } = options
  const fixture = options.fixture ?? SELF_TEST_FIXTURE

  const assertAuthorized = (c: SpeechPackComponent, signal: AbortSignal): void =>
    assertSpeechPackTransferAuthorized(c.id, signal, options.authorizeTransfer)
  const assertActivationAuthorized = (c: SpeechPackComponent, signal: AbortSignal): Promise<void> =>
    assertSpeechPackActivationAuthorized(c.id, signal, options.authorizeTransfer, options.authorizeActivation)

  const stateEvents = createSpeechPackStateEvents(
    components.map((component) => component.id),
    interval
  )
  const { states, set } = stateEvents
  const forcedRepairs = new Set<SpeechPackComponentId>()
  const controllers = new Map<SpeechPackComponentId, AbortController>()
  const cleanups = new Map<SpeechPackComponentId, Promise<void>>()
  const cleanupOwners = new Map<SpeechPackComponentId, InstallDirectoryOwners>()
  const jobs = new SpeechPackOperationQueue<SpeechPackComponentId>((job) => run(job, forcedRepairs.delete(job.id)))

  // --- paths ---
  const stagingDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id, c.version)
  const workDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id, 'work')
  const finalDir = (c: SpeechPackComponent): string => join(rootDir, c.id, c.version)
  const componentDir = (c: SpeechPackComponent): string => join(rootDir, c.id)
  const markerPath = (c: SpeechPackComponent): string => join(rootDir, c.id, 'active.json')
  const fileAt = (dir: string, path: string): string => join(dir, ...path.split('/'))

  async function dirVerified(c: SpeechPackComponent, dir: string): Promise<boolean> {
    if (
      !(await lstat(dir).then(
        (item) => item.isDirectory(),
        () => false
      ))
    )
      return false
    for (const file of c.files) {
      const path = fileAt(dir, file.path)
      if (!(await filePathIsRegular(dir, file.path))) return false
      if ((await sizeOf(path)) !== file.bytes || (await sha256File(path)) !== file.sha256) return false
    }
    return true
  }

  async function filePathIsRegular(dir: string, relativePath: string): Promise<boolean> {
    let current = dir
    const parts = relativePath.split('/')
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index])
      try {
        const item = await lstat(current)
        if (item.isSymbolicLink()) return false
        if (index === parts.length - 1) {
          if (!item.isFile() || item.nlink !== 1) return false
        } else if (!item.isDirectory()) return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
        throw error
      }
    }
    return true
  }

  const rollbackFiles = createSpeechPackActivationRollback({
    rootDir,
    authorizeActivation: assertActivationAuthorized,
    authorizeRollback: (id, marker, transaction) => options.authorizeRollback?.(id, marker, transaction) !== false,
    authorizeRollbackCurrent: (id, marker, transaction) =>
      options.authorizeRollbackCurrent?.(id, marker, transaction) !== false,
    assertTransferAuthorized: assertAuthorized,
    dirVerified,
    activationStep: async (step) => activationStep(step)
  })
  const {
    captureInstallDirectories,
    prepareOwnedInstallDirectories,
    requiredOwner,
    installDirectoriesCurrent,
    optionalDirectoryOwnerMatches,
    readMarkerSnapshot,
    markerFileMatches,
    writeMarker,
    rollbackOwnershipCurrent,
    cleanupAfterVerifiedInitialize,
    cleanupStaging: cleanupOwnedStaging,
    deactivate,
    removeOwnedWork,
    captureOwnedExtract,
    recordOwnedAside,
    capturePhysicalPathVersion,
    physicalPathVersionMatches,
    physicalOwnerMatches
  } = rollbackFiles

  async function hasMarker(c: SpeechPackComponent): Promise<boolean> {
    const marker = (await rollbackFiles.readMarkerSnapshot(c))?.marker
    return marker?.version === c.version && marker.manifestIdentity === componentManifestIdentity(c)
  }

  async function ensureOwnedDirectory(path: string, create: boolean): Promise<void> {
    if (create) {
      try {
        await mkdir(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const item = await lstat(path)
    if (!item.isDirectory() || item.isSymbolicLink()) throw new SpeechPackError('tamper', 'pack directory is unsafe')
  }

  async function assertExistingOwnedPaths(c: SpeechPackComponent): Promise<void> {
    const paths = [
      rootDir,
      join(rootDir, '.staging'),
      join(rootDir, '.staging', c.id),
      join(rootDir, c.id),
      stagingDir(c),
      workDir(c),
      finalDir(c)
    ]
    for (const path of paths) {
      try {
        const item = await lstat(path)
        if (!item.isDirectory() || item.isSymbolicLink())
          throw new SpeechPackError('tamper', 'pack directory is unsafe')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
  }

  async function activationStep(step: ActivationStep): Promise<void> {
    try {
      await options.onActivationStep?.(step)
    } catch {
      // This test seam represents abrupt process death. Do not run the rollback a real process could not run.
      throw new SimulatedActivationProcessStop()
    }
  }

  async function prepareComponentPaths(c: SpeechPackComponent): Promise<void> {
    await ensureOwnedDirectory(rootDir, true)
    await ensureOwnedDirectory(join(rootDir, '.staging'), true)
    await ensureOwnedDirectory(join(rootDir, '.staging', c.id), true)
    await ensureOwnedDirectory(join(rootDir, c.id), true)
    await ensureOwnedDirectory(stagingDir(c), true)
    await ensureOwnedDirectory(workDir(c), true)
  }

  async function initialise(): Promise<void> {
    for (const c of components) {
      try {
        await prepareComponentPaths(c)
      } catch {
        continue
      }
      const dir = finalDir(c)
      const marker = await readMarkerSnapshot(c, true)
      if (!(await exists(dir))) {
        continue
      }
      if (!(await dirVerified(c, dir))) continue
      const alreadyActivated =
        marker?.marker.version === c.version && marker.marker.manifestIdentity === componentManifestIdentity(c)
      if (!alreadyActivated) continue
      if (!(await cleanupAfterVerifiedInitialize(c, marker))) continue
      set(c.id, { status: 'ready' }, !alreadyActivated)
      // Keep the old complete directory until a verified current directory and its marker both exist.
    }
  }

  // A cancel that lands after its pack is already active must still win: the pack is taken back out.
  // --- one install ---
  async function install(
    c: SpeechPackComponent,
    signal: AbortSignal,
    forceRepair: boolean,
    transaction: symbol
  ): Promise<void> {
    const initialDirectories = await captureInstallDirectories(c)
    await assertExistingOwnedPaths(c)
    const previousMarker = await readMarkerSnapshot(c)
    const markerWasPresent = await exists(markerPath(c))
    if (markerWasPresent && !previousMarker) throw new SpeechPackError('tamper', 'active marker is not owned')
    const previousMarkerTarget = previousMarker
      ? await requiredOwner(join(componentDir(c), previousMarker.marker.version), 'directory')
      : null
    const destinationBefore = await capturePhysicalPathVersion(finalDir(c), 'directory')
    if (!destinationBefore && (await exists(finalDir(c))))
      throw new SpeechPackError('tamper', 'active directory is unsafe')
    if (!forceRepair && (await hasMarker(c)) && (await exists(finalDir(c)))) {
      if (await dirVerified(c, finalDir(c))) {
        set(c.id, { status: 'ready' })
        return
      }
      // The old activated directory remains in place until its verified replacement is ready to swap in.
    }
    const staging = stagingDir(c)
    const work = workDir(c)
    if (
      (destinationBefore && !(await physicalPathVersionMatches(finalDir(c), destinationBefore))) ||
      (!destinationBefore && (await exists(finalDir(c))))
    )
      throw new SpeechPackError('tamper', 'active directory ownership changed')
    const source = c.source
    let extractedSnapshot: Awaited<ReturnType<typeof captureOwnedExtract>> = null
    const archiveDest = join(work, 'archive.download')
    const reusableDirs = (await exists(finalDir(c))) && (await dirVerified(c, finalDir(c))) ? [finalDir(c)] : []
    let missing: SpeechPackComponent['files'][number][] = []
    for (const f of c.files) {
      const path = fileAt(staging, f.path)
      if (!(await filePathIsRegular(staging, f.path))) throw new SpeechPackError('tamper', 'staged path is unsafe')
      if ((await sizeOf(path)) !== f.bytes || (await sha256File(path)) !== f.sha256) missing.push(f)
    }

    // Everything below the disk check writes to disk; nothing above it does.
    let bytesTotal = 0
    let required = DISK_HEADROOM_BYTES
    if (reusableDirs.length > 0) required += missing.reduce((total, file) => total + file.bytes, 0)
    if (missing.length > 0) {
      if (source.kind === 'files') {
        if (source.baseUrl === null) throw new SpeechPackError('http', 'source is not pinned')
        bytesTotal = componentBytes(c)
        for (const f of missing) required += Math.max(0, f.bytes - (await sizeOf(`${fileAt(staging, f.path)}.partial`)))
      } else {
        if (source.archive === null) throw new SpeechPackError('http', 'source is not pinned')
        if (!options.extractArchive) throw new SpeechPackError('http', 'no archive extractor available')
        bytesTotal = source.archive.bytes
        const archiveSize = await sizeOf(archiveDest)
        let archiveVerified = false
        if (archiveSize === source.archive.bytes) {
          try {
            archiveVerified = (await sha256File(archiveDest)) === source.archive.sha256
          } catch {
            // A failed read cannot count as trusted space already held for the pinned archive.
          }
        }
        const held = archiveVerified
          ? source.archive.bytes
          : Math.min(source.archive.bytes, await sizeOf(`${archiveDest}.partial`))
        // Download remainder, plus the extraction cap (the archive holds files beyond the pinned ones) while the archive still exists.
        required += Math.max(0, source.archive.bytes - held) + source.extractCapBytes
      }
      const free = await freeBytes(await nearestExistingPath(staging))
      if (free < required) throw new SpeechPackError('disk', 'not enough free disk space', required, free)
    }

    // Preflight above is read-only. Create owned directories only after pins, source and available space pass.
    const directories = await prepareOwnedInstallDirectories(c, initialDirectories)
    cleanupOwners.set(c.id, directories)
    if (
      !(await installDirectoriesCurrent(c, directories)) ||
      !(await markerFileMatches(c, previousMarker)) ||
      (destinationBefore && !(await physicalPathVersionMatches(finalDir(c), destinationBefore))) ||
      (!destinationBefore && (await exists(finalDir(c))))
    )
      throw new SpeechPackError('tamper', 'activation inputs changed')

    if (
      reusableDirs.length > 0 &&
      !(await reuseVerifiedFiles({
        candidates: reusableDirs,
        destination: staging,
        files: missing,
        authorize: async () => {
          await assertActivationAuthorized(c, signal)
          return true
        },
        validateCurrent: () => {
          assertAuthorized(c, signal)
          return true
        }
      }))
    )
      throw new SpeechPackError('policy', 'verified pack reuse was interrupted or changed')
    if (!(await installDirectoriesCurrent(c, directories)))
      throw new SpeechPackError('tamper', 'pack directory ownership changed')
    if (reusableDirs.length > 0) {
      missing = []
      for (const file of c.files) {
        const path = fileAt(staging, file.path)
        if (!(await filePathIsRegular(staging, file.path)))
          throw new SpeechPackError('tamper', 'reused staged path is unsafe')
        if ((await sizeOf(path)) !== file.bytes || (await sha256File(path)) !== file.sha256) missing.push(file)
      }
    }

    if (missing.length > 0 && source.kind === 'files') {
      let done = c.files.reduce((n, f) => n + (missing.includes(f) ? 0 : f.bytes), 0)
      for (const file of missing) {
        const url = speechPackFileUrl(c, file) as string
        await downloadVerified(
          {
            url,
            dest: fileAt(staging, file.path),
            bytes: file.bytes,
            sha256: file.sha256,
            signal,
            resumeScope: options.resumeScope,
            trustedRoot: rootDir,
            authorize: () => options.authorizeTransfer?.(c.id) !== false,
            onProgress: (onDisk) => set(c.id, { status: 'downloading', bytesDone: done + onDisk, bytesTotal })
          },
          deps
        )
        if (!(await installDirectoriesCurrent(c, directories)))
          throw new SpeechPackError('tamper', 'pack directory ownership changed during transfer')
        done += file.bytes
        set(c.id, { status: 'downloading', bytesDone: done, bytesTotal })
      }
    } else if (missing.length > 0 && source.kind === 'archive' && source.archive) {
      const archive = source.archive
      await downloadVerified(
        {
          url: archive.url,
          dest: archiveDest,
          bytes: archive.bytes,
          sha256: archive.sha256,
          signal,
          resumeScope: options.resumeScope,
          trustedRoot: rootDir,
          authorize: () => options.authorizeTransfer?.(c.id) !== false,
          onProgress: (onDisk) => set(c.id, { status: 'downloading', bytesDone: onDisk, bytesTotal })
        },
        deps
      )
      if (!(await installDirectoriesCurrent(c, directories)))
        throw new SpeechPackError('tamper', 'pack directory ownership changed during transfer')
      set(c.id, { status: 'verifying' })
      const extractDir = join(work, 'extract')
      if (await exists(extractDir)) throw new SpeechPackError('tamper', 'previous extraction work is not owned')
      await mkdir(extractDir)
      await (options.extractArchive as ExtractArchive)(
        archiveDest,
        createArchiveSink(extractDir, source.extractCapBytes),
        signal
      )
      if (!(await installDirectoriesCurrent(c, directories)))
        throw new SpeechPackError('tamper', 'pack directory ownership changed during extraction')
      extractedSnapshot = await captureOwnedExtract(extractDir, c)
      if (!extractedSnapshot) throw new SpeechPackError('tamper', 'extracted work ownership changed')
      await adoptExtracted(extractDir, source.entryPrefix, c.files, staging, source.extractCapBytes)
      if (!(await installDirectoriesCurrent(c, directories)))
        throw new SpeechPackError('tamper', 'pack directory ownership changed during adoption')
    }
    if (
      !(await installDirectoriesCurrent(c, directories)) ||
      !(await physicalOwnerMatches(work, directories.work, 'directory'))
    )
      throw new SpeechPackError('tamper', 'pack work directory ownership changed')
    if (!(await removeOwnedWork(c, directories, extractedSnapshot ?? undefined)))
      throw new SpeechPackError('tamper', 'pack work contains an unowned path')

    set(c.id, { status: 'verifying' })
    for (const file of c.files) {
      const path = fileAt(staging, file.path)
      if (!(await filePathIsRegular(staging, file.path))) throw new SpeechPackError('tamper', 'staged path is unsafe')
      if ((await sizeOf(path)) !== file.bytes || (await sha256File(path)) !== file.sha256) {
        throw new SpeechPackError('tamper', 'staged file does not match its pin')
      }
    }
    const stagingVersion = await capturePhysicalPathVersion(staging, 'directory')
    if (
      !stagingVersion ||
      stagingVersion.dev !== directories.staging.dev ||
      stagingVersion.ino !== directories.staging.ino
    )
      throw new SpeechPackError('tamper', 'staging directory ownership changed')
    await activationStep('staged-verified')
    if (
      !(await installDirectoriesCurrent(c, directories)) ||
      !(await physicalPathVersionMatches(staging, stagingVersion)) ||
      !(await markerFileMatches(c, previousMarker))
    )
      throw new SpeechPackError('tamper', 'activation inputs changed')

    // Cancel wins at every step: it is checked again before the self-test and before the activation rename.
    assertAuthorized(c, signal)
    set(c.id, { status: 'self-testing' })
    let decoded = ''
    try {
      decoded = (
        await runPinnedSpeechPackSelfTest({
          componentId: c.id,
          packDir: staging,
          wavPath: options.fixtureWavPath,
          signal,
          fixture,
          selfTest: options.selfTest
        })
      ).trim()
    } catch {
      decoded = ''
    }
    assertAuthorized(c, signal)
    if (
      !(await installDirectoriesCurrent(c, directories)) ||
      !(await physicalPathVersionMatches(staging, stagingVersion)) ||
      !(await markerFileMatches(c, previousMarker))
    )
      throw new SpeechPackError('tamper', 'activation inputs changed')
    // A verified set that cannot decode the fixture is not a usable pack.
    if (decoded.trim() === '') throw new SpeechPackError('tamper', 'self-test decoded no text')
    await activationStep('self-tested')
    const dest = finalDir(c)
    const aside = `${dest}.old-${Date.now()}-${randomUUID()}`
    const ownership: RollbackOwnership = {
      directories,
      staging: stagingVersion,
      destinationBefore,
      aside: null,
      promoted: null,
      previousMarker,
      promotedMarker: null,
      previousMarkerTarget
    }
    try {
      await assertActivationAuthorized(c, signal)
      if (
        !(await installDirectoriesCurrent(c, directories)) ||
        !(await physicalPathVersionMatches(staging, stagingVersion)) ||
        !(await markerFileMatches(c, previousMarker)) ||
        !(await optionalDirectoryOwnerMatches(
          dest,
          destinationBefore ? { dev: destinationBefore.dev, ino: destinationBefore.ino } : null
        ))
      )
        throw new SpeechPackError('tamper', 'activation ownership changed')
      // An existing pack is renamed aside, never deleted first, so the swap has no moment without a whole directory.
      if (destinationBefore) {
        const verified = await dirVerified(c, dest)
        if (
          !(await physicalPathVersionMatches(dest, destinationBefore)) ||
          !(await installDirectoriesCurrent(c, directories)) ||
          !(await markerFileMatches(c, previousMarker))
        )
          throw new SpeechPackError('tamper', 'previous pack ownership changed')
        await assertActivationAuthorized(c, signal)
        if (
          !(await physicalPathVersionMatches(dest, destinationBefore)) ||
          !(await installDirectoriesCurrent(c, directories)) ||
          !(await markerFileMatches(c, previousMarker))
        )
          throw new SpeechPackError('tamper', 'previous pack ownership changed')
        await rename(dest, aside)
        ownership.aside = {
          path: aside,
          version: destinationBefore,
          verified,
          postRenameVersionPending: true
        }
        recordOwnedAside(c, aside, destinationBefore)
        await activationStep('old-moved-aside')
        const asideVersion = await capturePhysicalPathVersion(aside, 'directory')
        if (
          !asideVersion ||
          asideVersion.dev !== destinationBefore.dev ||
          asideVersion.ino !== destinationBefore.ino ||
          !(await installDirectoriesCurrent(c, directories)) ||
          (await exists(dest))
        )
          throw new SpeechPackError('tamper', 'previous pack move lost ownership')
        ownership.aside.version = asideVersion
        ownership.aside.postRenameVersionPending = false
        await assertActivationAuthorized(c, signal)
        if (
          !(await installDirectoriesCurrent(c, directories)) ||
          !(await physicalPathVersionMatches(aside, asideVersion)) ||
          !(await physicalPathVersionMatches(staging, stagingVersion)) ||
          !(await markerFileMatches(c, previousMarker))
        )
          throw new SpeechPackError('tamper', 'activation ownership changed')
      }
      await assertActivationAuthorized(c, signal)
      if (
        !(await installDirectoriesCurrent(c, directories)) ||
        !(await physicalPathVersionMatches(staging, stagingVersion)) ||
        (await exists(dest)) ||
        !(await markerFileMatches(c, previousMarker))
      )
        throw new SpeechPackError('tamper', 'activation ownership changed')
      await rename(staging, dest)
      ownership.promoted = { path: dest, version: stagingVersion, verified: true, postRenameVersionPending: true }
      await activationStep('renamed')
      const promotedVersion = await capturePhysicalPathVersion(dest, 'directory')
      if (
        !promotedVersion ||
        promotedVersion.dev !== stagingVersion.dev ||
        promotedVersion.ino !== stagingVersion.ino ||
        !(await installDirectoriesCurrent(c, directories)) ||
        !(await dirVerified(c, dest))
      )
        throw new SpeechPackError('tamper', 'promoted pack ownership changed')
      ownership.promoted.version = promotedVersion
      ownership.promoted.postRenameVersionPending = false
      await assertActivationAuthorized(c, signal)
      if (!(await rollbackOwnershipCurrent(c, ownership)))
        throw new SpeechPackError('tamper', 'activation ownership changed')
      await writeMarker(c, signal, ownership)
      // Every failure after the first activation rename restores the exact prior marker and complete directory.
      await assertActivationAuthorized(c, signal)
      await activationStep('ready-check')
      await assertActivationAuthorized(c, signal)
      if (!(await rollbackOwnershipCurrent(c, ownership)))
        throw new SpeechPackError('tamper', 'activation ownership changed')
      assertAuthorized(c, signal)
      set(c.id, { status: 'ready' }, true)
      // A synchronous ready listener can still cancel; settlement follows only after this check and rollback.
      if (signal.aborted && signal.reason === 'cancel') throw signal.reason
    } catch (error) {
      if (error instanceof SimulatedActivationProcessStop) throw error
      if ((ownership.aside || ownership.promoted) && !(await deactivate(c, ownership, transaction)))
        throw new SpeechPackRollbackIncomplete()
      throw error
    }
  }

  async function run(job: { id: SpeechPackComponentId; transaction: symbol }, forceRepair: boolean): Promise<void> {
    const { id, transaction } = job
    const c = byId.get(id) as SpeechPackComponent
    const controller = new AbortController()
    controllers.set(id, controller)
    set(id, { status: 'downloading', bytesDone: 0, bytesTotal: componentBytes(c) })
    try {
      // A cancel of this pack's previous run may still be deleting its staging directory.
      await cleanups.get(id)
      await install(c, controller.signal, forceRepair, transaction)
    } catch (err) {
      if (err instanceof SpeechPackRollbackIncomplete) {
        set(id, { status: 'error', kind: 'tamper' })
      } else if (controller.signal.aborted) {
        if (controller.signal.reason === 'cancel') {
          const owners = cleanupOwners.get(id)
          const cleaned = !owners || (await cleanupOwnedStaging(c, owners))
          set(id, cleaned ? { status: 'error', kind: 'cancelled' } : { status: 'error', kind: 'tamper' })
        } else {
          set(id, { status: 'paused' })
        }
      } else if (err instanceof SpeechPackError) {
        set(id, { status: 'error', kind: err.kind, requiredBytes: err.requiredBytes, freeBytes: err.freeBytes })
      } else {
        set(id, { status: 'error', kind: 'http' })
      }
    } finally {
      controllers.delete(id)
      cleanupOwners.delete(id)
      try {
        options.onTransactionSettled?.(id, transaction)
      } catch {
        // Transaction cleanup cannot change the terminal engine result.
      }
    }
  }

  return {
    initialise,
    getState: (id) => states.get(id) as SpeechPackState,
    states: () => Object.fromEntries(states) as Record<SpeechPackComponentId, SpeechPackState>,
    subscribe: stateEvents.subscribe,
    enqueue(ids, selected, transaction = Symbol('speech-pack-transaction')) {
      const ordered = selected && ids.includes(selected) ? [selected, ...ids.filter((id) => id !== selected)] : [...ids]
      for (const id of ordered) {
        const status = states.get(id)?.status
        // One install per component at a time; a pack that is ready or already moving is left alone.
        if (!status || status === 'ready' || jobs.isRunning(id)) continue
        if (status === 'queued' && id !== selected) continue
        jobs.remove(id)
        forcedRepairs.delete(id)
        const job = { id, transaction }
        set(id, { status: 'queued' })
        jobs.enqueue(job, id === selected)
      }
    },
    repair(id, transaction = Symbol('speech-pack-repair')) {
      const status = states.get(id)?.status
      if (!status || jobs.isRunning(id) || status === 'queued') return
      jobs.remove(id)
      forcedRepairs.add(id)
      set(id, { status: 'queued' })
      jobs.enqueue({ id, transaction }, true)
    },
    pause(id) {
      const status = states.get(id)?.status
      if (status === 'queued') {
        const job = jobs.remove(id)
        set(id, { status: 'paused' })
        if (job) options.onTransactionSettled?.(id, job.transaction)
      } else if (jobs.isRunning(id)) controllers.get(id)?.abort('pause')
    },
    cancel(id) {
      const status = states.get(id)?.status
      if (jobs.isRunning(id)) controllers.get(id)?.abort('cancel')
      else if (status === 'queued' || status === 'paused') {
        const job = jobs.remove(id)
        cleanups.set(
          id,
          cleanupOwners.get(id)
            ? cleanupOwnedStaging(
                byId.get(id) as SpeechPackComponent,
                cleanupOwners.get(id) as InstallDirectoryOwners
              ).then(() => undefined)
            : Promise.resolve()
        )
        set(id, { status: 'error', kind: 'cancelled' })
        if (job) options.onTransactionSettled?.(id, job.transaction)
      }
    },
    whenIdle: () => jobs.whenIdle()
  }
}
