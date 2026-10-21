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
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
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
import {
  assertSpeechPackActivationAuthorized,
  assertSpeechPackTransferAuthorized,
  authorizePriorPackRestore,
  priorPackRestoreStillCurrent,
  rollbackSpeechPackActivation
} from './activation-authority'
import {
  hasUnsafeSpeechPackMarkerVersion,
  parseSpeechPackActivationMarker,
  type SpeechPackActivationMarker,
  type SpeechPackMarkerSnapshot
} from './marker'
import { createSpeechPackStateEvents, type SpeechPackState, type SpeechPackStateEvent } from './state-events'
import { SpeechPackOperationQueue } from './operation-queue'

export const DISK_HEADROOM_BYTES = 512 * 1024 * 1024
export const EMIT_INTERVAL_MS = 250
const MAX_MARKER_BYTES = 4096

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
  /** Test seam: opens the partial download file, so a test can fail a write the way a full disk would. */
  openFile?: DownloadDeps['openFile']
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

export function createSpeechPackEngine(options: SpeechPackEngineOptions): SpeechPackEngine {
  const components = options.components ?? SPEECH_PACK_COMPONENTS
  const byId = new Map(components.map((c) => [c.id, c]))
  const deps: DownloadDeps = {
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options.random ?? Math.random,
    timing: { ...DEFAULT_TIMING, ...options.timing },
    openFile: options.openFile
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
  const jobs = new SpeechPackOperationQueue<SpeechPackComponentId>((job) => run(job, forcedRepairs.delete(job.id)))

  // --- paths ---
  const stagingDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id, c.version)
  const workDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id, 'work')
  const finalDir = (c: SpeechPackComponent): string => join(rootDir, c.id, c.version)
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

  async function writeMarker(c: SpeechPackComponent, signal: AbortSignal): Promise<void> {
    await assertActivationAuthorized(c, signal)
    const marker: SpeechPackActivationMarker = {
      schema: 2,
      component: c.id,
      version: c.version,
      manifestIdentity: componentManifestIdentity(c)
    }
    await mkdir(dirname(markerPath(c)), { recursive: true })
    await writeFile(`${markerPath(c)}.tmp`, JSON.stringify(marker))
    await activationStep('marker-tmp-written')
    await assertActivationAuthorized(c, signal)
    assertAuthorized(c, signal)
    await rename(`${markerPath(c)}.tmp`, markerPath(c))
    await activationStep('marker-written')
  }

  async function readMarkerSnapshot(
    c: SpeechPackComponent,
    discardUnsafeVersion = false
  ): Promise<SpeechPackMarkerSnapshot | null> {
    try {
      const componentDir = await lstat(join(rootDir, c.id))
      if (!componentDir.isDirectory()) return null
      const markerFile = markerPath(c)
      const markerStat = await lstat(markerFile)
      if (!markerStat.isFile() || markerStat.nlink !== 1 || markerStat.size > MAX_MARKER_BYTES) return null
      const handle = await open(markerFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      try {
        const opened = await handle.stat()
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.size > MAX_MARKER_BYTES ||
          opened.dev !== markerStat.dev ||
          opened.ino !== markerStat.ino
        )
          return null
        bytes = await handle.readFile()
      } finally {
        await handle.close()
      }
      const marker = parseSpeechPackActivationMarker(bytes, c.id)
      if (!marker) {
        // Initialization may invalidate this owned receipt, but never follows its unsafe version path.
        if (discardUnsafeVersion && hasUnsafeSpeechPackMarkerVersion(bytes, c.id)) await rm(markerFile, { force: true })
        return null
      }
      const versionDir = await lstat(join(rootDir, c.id, marker.version))
      if (!versionDir.isDirectory()) return null
      return { marker, bytes }
    } catch {
      return null
    }
  }

  async function hasMarker(c: SpeechPackComponent): Promise<boolean> {
    const marker = (await readMarkerSnapshot(c))?.marker
    return marker?.version === c.version && marker.manifestIdentity === componentManifestIdentity(c)
  }

  async function restoreMarkerSnapshot(
    c: SpeechPackComponent,
    snapshot: SpeechPackMarkerSnapshot,
    transaction: symbol
  ): Promise<boolean> {
    try {
      const componentDir = await lstat(join(rootDir, c.id))
      if (!componentDir.isDirectory()) return false
      const versionDir = await lstat(join(rootDir, c.id, snapshot.marker.version))
      if (!versionDir.isDirectory()) return false
      const markerFile = markerPath(c)
      const temp = `${markerFile}.restore.tmp`
      await writeFile(temp, snapshot.bytes)
      if (
        !(await authorizePriorPackRestore(
          c.id,
          snapshot.marker,
          options.authorizeRollback,
          options.authorizeRollbackCurrent,
          transaction
        ))
      )
        return false
      if (!priorPackRestoreStillCurrent(c.id, snapshot.marker, options.authorizeRollbackCurrent, transaction))
        return false
      await rename(temp, markerFile)
      return true
    } catch {
      return false
    }
  }

  /** Pack directories renamed aside by an activation that did not get to delete them. */
  async function removeAsideDirs(c: SpeechPackComponent): Promise<void> {
    let names: string[] = []
    try {
      names = await readdir(join(rootDir, c.id))
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith(`${c.version}.old-`)) await rm(join(rootDir, c.id, name), { recursive: true, force: true })
    }
  }

  async function verifiedAsideDirs(c: SpeechPackComponent): Promise<string[]> {
    let names: string[] = []
    try {
      names = await readdir(join(rootDir, c.id))
    } catch {
      return []
    }
    const candidates = names
      .filter((name) => name.startsWith(`${c.version}.old-`))
      .sort((a, b) => Number(b.slice(`${c.version}.old-`.length)) - Number(a.slice(`${c.version}.old-`.length)))
    const verified: string[] = []
    for (const name of candidates) {
      const path = join(rootDir, c.id, name)
      if (await dirVerified(c, path)) verified.push(path)
    }
    return verified
  }

  /** Restore the latest complete old directory after a kill or a cancel during activation. */
  async function restoreAside(
    c: SpeechPackComponent,
    previousMarker: SpeechPackMarkerSnapshot | null,
    transaction: symbol
  ): Promise<boolean> {
    const candidates = await verifiedAsideDirs(c)
    if (candidates.length === 0) return false
    const dest = finalDir(c)
    if (await exists(dest)) return false
    if (
      !(await authorizePriorPackRestore(
        c.id,
        previousMarker?.marker ?? null,
        options.authorizeRollback,
        options.authorizeRollbackCurrent,
        transaction
      ))
    )
      return false
    if (
      !priorPackRestoreStillCurrent(c.id, previousMarker?.marker ?? null, options.authorizeRollbackCurrent, transaction)
    )
      return false
    await rename(candidates[0], dest)
    return true
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
      let marker = await readMarkerSnapshot(c, true)
      if (!(await exists(dir))) {
        continue
      }
      if (!(await dirVerified(c, dir))) continue
      const alreadyActivated =
        marker?.marker.version === c.version && marker.marker.manifestIdentity === componentManifestIdentity(c)
      if (!alreadyActivated) continue
      set(c.id, { status: 'ready' }, !alreadyActivated)
      // Keep the old complete directory until a verified current directory and its marker both exist.
      await removeAsideDirs(c)
    }
  }

  // A cancel that lands after its pack is already active must still win: the pack is taken back out.
  async function deactivate(
    c: SpeechPackComponent,
    previousMarker: SpeechPackMarkerSnapshot | null,
    transaction: symbol
  ): Promise<void> {
    await rollbackSpeechPackActivation({
      currentVersion: c.version,
      previousMarker,
      authorize: () =>
        authorizePriorPackRestore(
          c.id,
          previousMarker?.marker ?? null,
          options.authorizeRollback,
          options.authorizeRollbackCurrent,
          transaction
        ),
      stillCurrent: () =>
        priorPackRestoreStillCurrent(
          c.id,
          previousMarker?.marker ?? null,
          options.authorizeRollbackCurrent,
          transaction
        ),
      restoreMarker: () => restoreMarkerSnapshot(c, previousMarker as SpeechPackMarkerSnapshot, transaction),
      removeCurrent: () => rm(finalDir(c), { recursive: true, force: true }),
      restoreAside: () => restoreAside(c, previousMarker, transaction),
      removeMarker: () => rm(markerPath(c), { force: true })
    })
  }

  // --- one install ---
  async function install(
    c: SpeechPackComponent,
    signal: AbortSignal,
    forceRepair: boolean,
    transaction: symbol
  ): Promise<void> {
    await assertExistingOwnedPaths(c)
    if (!forceRepair && (await hasMarker(c)) && (await exists(finalDir(c)))) {
      if (await dirVerified(c, finalDir(c))) {
        set(c.id, { status: 'ready' })
        return
      }
      // The old activated directory remains in place until its verified replacement is ready to swap in.
    }
    const staging = stagingDir(c)
    const work = workDir(c)
    const source = c.source
    const archiveDest = join(work, 'archive.download')
    const reusableDirs = (await exists(finalDir(c))) && (await dirVerified(c, finalDir(c))) ? [finalDir(c)] : []
    reusableDirs.push(...(await verifiedAsideDirs(c)))
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
    await prepareComponentPaths(c)

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
      set(c.id, { status: 'verifying' })
      const extractDir = join(work, 'extract')
      await rm(extractDir, { recursive: true, force: true })
      await mkdir(extractDir, { recursive: true })
      await (options.extractArchive as ExtractArchive)(
        archiveDest,
        createArchiveSink(extractDir, source.extractCapBytes),
        signal
      )
      await adoptExtracted(extractDir, source.entryPrefix, c.files, staging, source.extractCapBytes)
    }
    await rm(work, { recursive: true, force: true })

    set(c.id, { status: 'verifying' })
    for (const file of c.files) {
      const path = fileAt(staging, file.path)
      if (!(await filePathIsRegular(staging, file.path))) throw new SpeechPackError('tamper', 'staged path is unsafe')
      if ((await sizeOf(path)) !== file.bytes || (await sha256File(path)) !== file.sha256) {
        await rm(path, { force: true })
        throw new SpeechPackError('tamper', 'staged file does not match its pin')
      }
    }
    await activationStep('staged-verified')

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
    // A verified set that cannot decode the fixture is not a usable pack.
    if (decoded.trim() === '') throw new SpeechPackError('tamper', 'self-test decoded no text')
    await activationStep('self-tested')

    await assertActivationAuthorized(c, signal)
    const dest = finalDir(c)
    const aside = `${dest}.old-${Date.now()}`
    const previousMarker = await readMarkerSnapshot(c)
    let movedAside = false
    let promoted = false
    try {
      await mkdir(dirname(dest), { recursive: true })
      if (!previousMarker) await rm(markerPath(c), { force: true })
      // An existing pack is renamed aside, never deleted first, so the swap has no moment without a whole directory.
      if (await exists(dest)) {
        await assertActivationAuthorized(c, signal)
        assertAuthorized(c, signal)
        await rename(dest, aside)
        movedAside = true
        await activationStep('old-moved-aside')
        await assertActivationAuthorized(c, signal)
      }
      await assertActivationAuthorized(c, signal)
      assertAuthorized(c, signal)
      await rename(staging, dest)
      promoted = true
      await activationStep('renamed')
      await writeMarker(c, signal)
      // Every failure after the first activation rename restores the exact prior marker and complete directory.
      await assertActivationAuthorized(c, signal)
      await activationStep('ready-check')
      await assertActivationAuthorized(c, signal)
      assertAuthorized(c, signal)
      set(c.id, { status: 'ready' }, true)
      // A synchronous ready listener can still cancel; settlement follows only after this check and rollback.
      if (signal.aborted && signal.reason === 'cancel') throw signal.reason
    } catch (error) {
      if (error instanceof SimulatedActivationProcessStop) throw error
      if (movedAside || promoted) await deactivate(c, previousMarker, transaction)
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
      if (controller.signal.aborted) {
        if (controller.signal.reason === 'cancel') {
          await rm(join(rootDir, '.staging', c.id), { recursive: true, force: true })
          set(id, { status: 'error', kind: 'cancelled' })
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
          rm(join(rootDir, '.staging', id), { recursive: true, force: true }).catch(() => undefined)
        )
        set(id, { status: 'error', kind: 'cancelled' })
        if (job) options.onTransactionSettled?.(id, job.transaction)
      }
    },
    whenIdle: () => jobs.whenIdle()
  }
}
