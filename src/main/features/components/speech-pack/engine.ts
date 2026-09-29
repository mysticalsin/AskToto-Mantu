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
 *   3. rename staging -> <id>/<version>      (atomic: the directory is whole or absent)
 *   4. write active.json.tmp, rename to active.json
 *
 * A marker exists only after step 3 completed, and step 3 only runs on a fully verified, self-tested set,
 * so no crash can leave a marker without a complete directory or a half-filled directory behind a marker.
 * A crash between 3 and 4 leaves a complete but unmarked directory; the next start re-verifies it and
 * writes the marker, or removes it.
 *
 * State and events carry component ids, byte counts and error kinds only — no path, transcript, audio or
 * user text ever enters a state, an event or a log line.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { adoptExtracted, type ExtractArchive } from './archive'
import { DEFAULT_TIMING, downloadVerified, sha256File, type DownloadDeps, type DownloadTiming } from './download'
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

export type ActivationStep = 'staged-verified' | 'self-tested' | 'renamed' | 'marker-tmp-written' | 'marker-written'

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
  freeBytes?: (path: string) => number
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

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function nearestExisting(path: string): string {
  let current = path
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current)
  return current
}

function defaultFreeBytes(path: string): number {
  const fs = statfsSync(path)
  return fs.bavail * fs.bsize
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
      if (sizeOf(path) !== file.bytes || (await sha256File(path)) !== file.sha256) return false
    }
    return true
  }

  async function writeMarker(c: SpeechPackComponent): Promise<void> {
    const marker: Marker = { schema: 1, component: c.id, version: c.version }
    mkdirSync(dirname(markerPath(c)), { recursive: true })
    writeFileSync(`${markerPath(c)}.tmp`, JSON.stringify(marker))
    await options.onActivationStep?.('marker-tmp-written')
    renameSync(`${markerPath(c)}.tmp`, markerPath(c))
    await options.onActivationStep?.('marker-written')
  }

  function hasMarker(c: SpeechPackComponent): boolean {
    try {
      const marker = JSON.parse(readFileSync(markerPath(c), 'utf8')) as Partial<Marker>
      return marker.schema === 1 && marker.component === c.id && marker.version === c.version
    } catch {
      return false
    }
  }

  async function initialise(): Promise<void> {
    for (const c of components) {
      const dir = finalDir(c)
      if (!existsSync(dir)) continue
      if (!(await dirVerified(c, dir))) {
        rmSync(markerPath(c), { force: true })
        rmSync(dir, { recursive: true, force: true })
        continue
      }
      if (!hasMarker(c)) await writeMarker(c)
      set(c.id, { status: 'ready' })
    }
  }

  // --- one install ---
  async function install(c: SpeechPackComponent, signal: AbortSignal): Promise<void> {
    if (hasMarker(c) && existsSync(finalDir(c))) {
      set(c.id, { status: 'ready' })
      return
    }
    const staging = stagingDir(c)
    const work = workDir(c)
    const source = c.source
    const archiveDest = join(work, 'archive.download')
    const missing = c.files.filter((f) => sizeOf(fileAt(staging, f.path)) !== f.bytes)

    // Everything below the disk check writes to disk; nothing above it does.
    let bytesTotal = 0
    let required = DISK_HEADROOM_BYTES
    if (missing.length > 0) {
      if (source.kind === 'files') {
        if (source.baseUrl === null) throw new SpeechPackError('http', 'source is not pinned')
        bytesTotal = componentBytes(c)
        required += missing.reduce((n, f) => n + Math.max(0, f.bytes - sizeOf(`${fileAt(staging, f.path)}.partial`)), 0)
      } else {
        if (source.archive === null) throw new SpeechPackError('http', 'source is not pinned')
        if (!options.extractArchive) throw new SpeechPackError('http', 'no archive extractor available')
        bytesTotal = source.archive.bytes
        const held = sizeOf(archiveDest) === source.archive.bytes ? source.archive.bytes : sizeOf(`${archiveDest}.partial`)
        // Download remainder, plus the extracted files while the archive still exists.
        required += Math.max(0, source.archive.bytes - held) + componentBytes(c)
      }
      const free = freeBytes(nearestExisting(staging))
      if (free < required) throw new SpeechPackError('disk', 'not enough free disk space', required, free)
    }

    if (missing.length > 0 && source.kind === 'files') {
      let done = c.files.reduce((n, f) => n + (sizeOf(fileAt(staging, f.path)) === f.bytes ? f.bytes : 0), 0)
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
      rmSync(extractDir, { recursive: true, force: true })
      mkdirSync(extractDir, { recursive: true })
      await (options.extractArchive as ExtractArchive)(archiveDest, extractDir)
      await adoptExtracted(extractDir, source.entryPrefix, c.files, staging, source.extractCapBytes)
    }
    rmSync(work, { recursive: true, force: true })

    set(c.id, { status: 'verifying' })
    for (const file of c.files) {
      const path = fileAt(staging, file.path)
      if (sizeOf(path) !== file.bytes || (await sha256File(path)) !== file.sha256) {
        rmSync(path, { force: true })
        throw new SpeechPackError('tamper', 'staged file does not match its pin')
      }
    }
    await options.onActivationStep?.('staged-verified')

    set(c.id, { status: 'self-testing' })
    if (sizeOf(options.fixtureWavPath) !== fixture.bytes || (await sha256File(options.fixtureWavPath)) !== fixture.sha256) {
      throw new SpeechPackError('tamper', 'self-test fixture does not match its pin')
    }
    let decoded = ''
    try {
      decoded = await options.selfTest({ componentId: c.id, packDir: staging, wavPath: options.fixtureWavPath })
    } catch {
      decoded = ''
    }
    // A verified set that cannot decode the fixture is not a usable pack.
    if (decoded.trim() === '') throw new SpeechPackError('tamper', 'self-test decoded no text')
    await options.onActivationStep?.('self-tested')

    const dest = finalDir(c)
    mkdirSync(dirname(dest), { recursive: true })
    rmSync(markerPath(c), { force: true })
    rmSync(dest, { recursive: true, force: true })
    renameSync(staging, dest)
    await options.onActivationStep?.('renamed')
    await writeMarker(c)
    set(c.id, { status: 'ready' })
  }

  async function run(id: SpeechPackComponentId): Promise<void> {
    const c = byId.get(id) as SpeechPackComponent
    const controller = new AbortController()
    controllers.set(id, controller)
    set(id, { status: 'downloading', bytesDone: 0, bytesTotal: componentBytes(c) })
    try {
      await install(c, controller.signal)
    } catch (err) {
      if (controller.signal.aborted) {
        if (controller.signal.reason === 'cancel') {
          rmSync(join(rootDir, '.staging', c.id), { recursive: true, force: true })
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
        rmSync(join(rootDir, '.staging', id), { recursive: true, force: true })
        set(id, { status: 'error', kind: 'cancelled' })
      }
    },
    whenIdle: () => (running || queue.length > 0 ? new Promise<void>((resolve) => idleWaiters.push(resolve)) : Promise.resolve())
  }
}
