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
 *   5. write active.json.tmp, rename to active.json, then delete the aside directory
 *
 * A marker exists only after step 4 completed, and step 4 only runs on a fully verified, self-tested set,
 * so no crash can leave a marker without a complete directory or a half-filled directory behind a marker.
 * A crash between 4 and 5 leaves a complete but unmarked directory; the next start re-verifies it and
 * writes the marker, or removes it. initialise() deletes any aside directory a crash left behind.
 * Cancel is checked before the self-test and again before step 3, so a cancelled pack never ends 'ready'.
 *
 * State and events carry component ids, byte counts and error kinds only — no path, transcript, audio or
 * user text ever enters a state, an event or a log line.
 */
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { adoptExtracted, createArchiveSink, type ExtractArchive } from './archive'
import { DEFAULT_TIMING, downloadVerified, sha256File, sizeOf, type DownloadDeps, type DownloadTiming } from './download'
import { SpeechPackError, type SpeechPackErrorKind } from './errors'
import {
  SELF_TEST_FIXTURE,
  SPEECH_PACK_COMPONENTS,
  componentBytes,
  speechPackFileUrl,
  type SpeechPackComponent,
  type SpeechPackComponentId
} from './manifest'

export const DISK_HEADROOM_BYTES = 512 * 1024 * 1024
export const EMIT_INTERVAL_MS = 250

export type SpeechPackState =
  | { status: 'not-installed' }
  | { status: 'queued' }
  | { status: 'downloading'; bytesDone: number; bytesTotal: number }
  | { status: 'verifying' }
  | { status: 'self-testing' }
  | { status: 'ready' }
  | { status: 'paused' }
  | { status: 'error'; kind: SpeechPackErrorKind; requiredBytes?: number; freeBytes?: number }

export type ActivationStep =
  | 'staged-verified'
  | 'self-tested'
  | 'old-moved-aside'
  | 'renamed'
  | 'marker-tmp-written'
  | 'marker-written'

export interface SpeechPackEngineOptions {
  rootDir: string
  /** The pinned en.wav the self-test decodes. */
  fixtureWavPath: string
  /** Length and digest `fixtureWavPath` must match; defaults to SELF_TEST_FIXTURE. */
  fixture?: { readonly bytes: number; readonly sha256: string }
  /** Decodes the wav with the staged pack and returns the text. Must not log or persist it. */
  selfTest: (input: { componentId: SpeechPackComponentId; packDir: string; wavPath: string }) => Promise<string>
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
}

export interface SpeechPackEngine {
  /** Adopt packs already on disk (and finish an activation that was interrupted before its marker). */
  initialise(): Promise<void>
  getState(id: SpeechPackComponentId): SpeechPackState
  states(): Record<SpeechPackComponentId, SpeechPackState>
  subscribe(listener: (event: { id: SpeechPackComponentId; state: SpeechPackState }) => void): () => void
  /** Queue installs; `selected` (the engine chosen for this machine) goes first. */
  enqueue(ids: readonly SpeechPackComponentId[], selected?: SpeechPackComponentId): void
  pause(id: SpeechPackComponentId): void
  cancel(id: SpeechPackComponentId): void
  /** Resolves when nothing is queued or running. */
  whenIdle(): Promise<void>
}

interface Marker {
  schema: 1
  component: SpeechPackComponentId
  version: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function nearestExisting(path: string): Promise<string> {
  let current = path
  while (!(await exists(current)) && dirname(current) !== current) current = dirname(current)
  return current
}

async function defaultFreeBytes(path: string): Promise<number> {
  const fs = await statfs(path)
  return fs.bavail * fs.bsize
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason
}

export function createSpeechPackEngine(options: SpeechPackEngineOptions): SpeechPackEngine {
  const components = options.components ?? SPEECH_PACK_COMPONENTS
  const byId = new Map(components.map((c) => [c.id, c]))
  const deps: DownloadDeps = {
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options.random ?? Math.random,
    timing: { ...DEFAULT_TIMING, ...options.timing }
  }
  const freeBytes = options.freeBytes ?? defaultFreeBytes
  const interval = options.emitIntervalMs ?? EMIT_INTERVAL_MS
  const { rootDir } = options
  const fixture = options.fixture ?? SELF_TEST_FIXTURE

  const states = new Map<SpeechPackComponentId, SpeechPackState>(components.map((c) => [c.id, { status: 'not-installed' }]))
  const listeners = new Set<(event: { id: SpeechPackComponentId; state: SpeechPackState }) => void>()
  const queue: SpeechPackComponentId[] = []
  const controllers = new Map<SpeechPackComponentId, AbortController>()
  const cleanups = new Map<SpeechPackComponentId, Promise<void>>()
  let running: SpeechPackComponentId | null = null
  let idleWaiters: Array<() => void> = []

  // --- events: per component, at most one delivery per interval, always ending on the latest state ---
  const lastSent = new Map<SpeechPackComponentId, number>()
  const timers = new Map<SpeechPackComponentId, ReturnType<typeof setTimeout>>()
  const deliver = (id: SpeechPackComponentId): void => {
    lastSent.set(id, Date.now())
    const state = states.get(id) as SpeechPackState
    for (const listener of listeners) listener({ id, state })
  }
  const schedule = (id: SpeechPackComponentId): void => {
    if (timers.has(id)) return
    const wait = (lastSent.get(id) ?? -Infinity) + interval - Date.now()
    if (wait <= 0) return deliver(id)
    const timer = setTimeout(() => {
      timers.delete(id)
      deliver(id)
    }, wait)
    timer.unref?.()
    timers.set(id, timer)
  }
  const set = (id: SpeechPackComponentId, state: SpeechPackState): void => {
    states.set(id, state)
    schedule(id)
  }

  // --- paths ---
  const stagingDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id, c.version)
  const workDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id, 'work')
  const finalDir = (c: SpeechPackComponent): string => join(rootDir, c.id, c.version)
  const markerPath = (c: SpeechPackComponent): string => join(rootDir, c.id, 'active.json')
  const fileAt = (dir: string, path: string): string => join(dir, ...path.split('/'))

  async function dirVerified(c: SpeechPackComponent, dir: string): Promise<boolean> {
    for (const file of c.files) {
      const path = fileAt(dir, file.path)
      if ((await sizeOf(path)) !== file.bytes || (await sha256File(path)) !== file.sha256) return false
    }
    return true
  }

  async function writeMarker(c: SpeechPackComponent): Promise<void> {
    const marker: Marker = { schema: 1, component: c.id, version: c.version }
    await mkdir(dirname(markerPath(c)), { recursive: true })
    await writeFile(`${markerPath(c)}.tmp`, JSON.stringify(marker))
    await options.onActivationStep?.('marker-tmp-written')
    await rename(`${markerPath(c)}.tmp`, markerPath(c))
    await options.onActivationStep?.('marker-written')
  }

  async function hasMarker(c: SpeechPackComponent): Promise<boolean> {
    try {
      const marker = JSON.parse(await readFile(markerPath(c), 'utf8')) as Partial<Marker>
      return marker.schema === 1 && marker.component === c.id && marker.version === c.version
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

  async function initialise(): Promise<void> {
    for (const c of components) {
      await removeAsideDirs(c)
      const dir = finalDir(c)
      if (!(await exists(dir))) continue
      if (!(await dirVerified(c, dir))) {
        await rm(markerPath(c), { force: true })
        await rm(dir, { recursive: true, force: true })
        continue
      }
      if (!(await hasMarker(c))) await writeMarker(c)
      set(c.id, { status: 'ready' })
    }
  }

  // A cancel that lands after its pack is already active must still win: the pack is taken back out.
  async function deactivate(c: SpeechPackComponent): Promise<void> {
    await rm(markerPath(c), { force: true })
    await rm(finalDir(c), { recursive: true, force: true })
  }

  // --- one install ---
  async function install(c: SpeechPackComponent, signal: AbortSignal): Promise<void> {
    if ((await hasMarker(c)) && (await exists(finalDir(c)))) {
      set(c.id, { status: 'ready' })
      return
    }
    const staging = stagingDir(c)
    const work = workDir(c)
    const source = c.source
    const archiveDest = join(work, 'archive.download')
    const missing: SpeechPackComponent['files'][number][] = []
    for (const f of c.files) if ((await sizeOf(fileAt(staging, f.path))) !== f.bytes) missing.push(f)

    // Everything below the disk check writes to disk; nothing above it does.
    let bytesTotal = 0
    let required = DISK_HEADROOM_BYTES
    if (missing.length > 0) {
      if (source.kind === 'files') {
        if (source.baseUrl === null) throw new SpeechPackError('http', 'source is not pinned')
        bytesTotal = componentBytes(c)
        for (const f of missing) required += Math.max(0, f.bytes - (await sizeOf(`${fileAt(staging, f.path)}.partial`)))
      } else {
        if (source.archive === null) throw new SpeechPackError('http', 'source is not pinned')
        if (!options.extractArchive) throw new SpeechPackError('http', 'no archive extractor available')
        bytesTotal = source.archive.bytes
        const held = (await sizeOf(archiveDest)) === source.archive.bytes ? source.archive.bytes : await sizeOf(`${archiveDest}.partial`)
        // Download remainder, plus the extraction cap (the archive holds files beyond the pinned ones) while the archive still exists.
        required += Math.max(0, source.archive.bytes - held) + source.extractCapBytes
      }
      const free = await freeBytes(await nearestExisting(staging))
      if (free < required) throw new SpeechPackError('disk', 'not enough free disk space', required, free)
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
          onProgress: (onDisk) => set(c.id, { status: 'downloading', bytesDone: onDisk, bytesTotal })
        },
        deps
      )
      set(c.id, { status: 'verifying' })
      const extractDir = join(work, 'extract')
      await rm(extractDir, { recursive: true, force: true })
      await mkdir(extractDir, { recursive: true })
      await (options.extractArchive as ExtractArchive)(archiveDest, createArchiveSink(extractDir, source.extractCapBytes), signal)
      await adoptExtracted(extractDir, source.entryPrefix, c.files, staging, source.extractCapBytes)
    }
    await rm(work, { recursive: true, force: true })

    set(c.id, { status: 'verifying' })
    for (const file of c.files) {
      const path = fileAt(staging, file.path)
      if ((await sizeOf(path)) !== file.bytes || (await sha256File(path)) !== file.sha256) {
        await rm(path, { force: true })
        throw new SpeechPackError('tamper', 'staged file does not match its pin')
      }
    }
    await options.onActivationStep?.('staged-verified')

    // Cancel wins at every step: it is checked again before the self-test and before the activation rename.
    throwIfAborted(signal)
    set(c.id, { status: 'self-testing' })
    if ((await sizeOf(options.fixtureWavPath)) !== fixture.bytes || (await sha256File(options.fixtureWavPath)) !== fixture.sha256) {
      throw new SpeechPackError('tamper', 'self-test fixture does not match its pin')
    }
    let decoded = ''
    try {
      decoded = await options.selfTest({ componentId: c.id, packDir: staging, wavPath: options.fixtureWavPath })
    } catch {
      decoded = ''
    }
    throwIfAborted(signal)
    // A verified set that cannot decode the fixture is not a usable pack.
    if (decoded.trim() === '') throw new SpeechPackError('tamper', 'self-test decoded no text')
    await options.onActivationStep?.('self-tested')

    throwIfAborted(signal)
    const dest = finalDir(c)
    const aside = `${dest}.old-${Date.now()}`
    await mkdir(dirname(dest), { recursive: true })
    await rm(markerPath(c), { force: true })
    // An existing pack is renamed aside, never deleted first, so the swap has no moment without a whole directory.
    if (await exists(dest)) {
      await rename(dest, aside)
      await options.onActivationStep?.('old-moved-aside')
    }
    await rename(staging, dest)
    await options.onActivationStep?.('renamed')
    await writeMarker(c)
    await removeAsideDirs(c)
    // A cancel that arrived after the last check above has no step left to stop, so it takes the pack back out.
    if (signal.aborted && signal.reason === 'cancel') {
      await deactivate(c)
      throw signal.reason
    }
    set(c.id, { status: 'ready' })
  }

  async function run(id: SpeechPackComponentId): Promise<void> {
    const c = byId.get(id) as SpeechPackComponent
    const controller = new AbortController()
    controllers.set(id, controller)
    set(id, { status: 'downloading', bytesDone: 0, bytesTotal: componentBytes(c) })
    try {
      // A cancel of this pack's previous run may still be deleting its staging directory.
      await cleanups.get(id)
      await install(c, controller.signal)
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
    }
  }

  function pump(): void {
    if (running) return
    const next = queue.shift()
    if (!next) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const resolve of waiters) resolve()
      return
    }
    running = next
    void run(next).finally(() => {
      running = null
      pump()
    })
  }

  const dequeue = (id: SpeechPackComponentId): void => {
    const at = queue.indexOf(id)
    if (at >= 0) queue.splice(at, 1)
  }

  return {
    initialise,
    getState: (id) => states.get(id) as SpeechPackState,
    states: () => Object.fromEntries(states) as Record<SpeechPackComponentId, SpeechPackState>,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    enqueue(ids, selected) {
      const ordered = selected && ids.includes(selected) ? [selected, ...ids.filter((id) => id !== selected)] : [...ids]
      for (const id of ordered) {
        const status = states.get(id)?.status
        // One install per component at a time; a pack that is ready or already moving is left alone.
        if (!status || status === 'ready' || id === running) continue
        if (status === 'queued' && id !== selected) continue
        dequeue(id)
        if (id === selected) queue.unshift(id)
        else queue.push(id)
        set(id, { status: 'queued' })
      }
      pump()
    },
    pause(id) {
      const status = states.get(id)?.status
      if (status === 'queued') {
        dequeue(id)
        set(id, { status: 'paused' })
      } else if (id === running) controllers.get(id)?.abort('pause')
    },
    cancel(id) {
      const status = states.get(id)?.status
      if (id === running) controllers.get(id)?.abort('cancel')
      else if (status === 'queued' || status === 'paused') {
        dequeue(id)
        cleanups.set(
          id,
          rm(join(rootDir, '.staging', id), { recursive: true, force: true }).catch(() => undefined)
        )
        set(id, { status: 'error', kind: 'cancelled' })
      }
    },
    whenIdle: () => (running || queue.length > 0 ? new Promise<void>((resolve) => idleWaiters.push(resolve)) : Promise.resolve())
  }
}
