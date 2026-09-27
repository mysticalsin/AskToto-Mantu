/**
 * Storage gateway: how main-process code reaches the meetings root — the synced folder (OneDrive or
 * Documents) that holds the meetings and `.brain` — for every reader that has been migrated onto it.
 *
 * Reading a cloud-only (dataless) file makes the OS download it and blocks the reading thread until the
 * provider answers, for minutes when offline; on the main thread that froze the whole app. Async fs moves
 * the wait onto a libuv pool thread, but the pool is small (UV_THREADPOOL_SIZE, 4 by default) and every
 * async fs call, dns.lookup and async crypto call in the process shares it, so blocked reads must never
 * fill it.
 *
 * Invariants:
 *   - Async only. Every method resolves, never rejects, and settles by its deadline (2 s for list,
 *     classify and noteWritten, 5 s for read) whatever the fs or the probe does.
 *   - At most `poolSize - 2` (at least 1) fs calls run at once across every gateway of one Storage
 *     (admission.ts), so two pool threads stay free. Create one Storage per process (meetings-storage.ts)
 *     and reach each folder through `at(root)`.
 *   - A deadline or an abort releases the caller; the fs call keeps its permit until it settles.
 *   - Content is read only after the dataless detector says the bytes are on this device, or after this
 *     process wrote that exact version (noteWritten). 'dataless' and 'unknown' files are never opened, and
 *     at most one detector probe runs at a time.
 *   - Paths are relative to the gateway's root and never leave it. A read resolves symlinks only after
 *     classification (on Windows, resolving a path opens the file) and reads the resolved path only if it
 *     lies inside the resolved root.
 *   - Only ENOENT and ENOTDIR are 'missing'. 'unavailable', 'timeout' and 'degraded' say nothing about
 *     whether a file exists; callers must never treat them as a deletion.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { createAdmission, type Lane } from './admission'
import { createDatalessDetector, type ContentPresence, type DatalessDetector, type FileVersion } from './dataless'

/** Threads libuv starts when UV_THREADPOOL_SIZE is unset, and the most it accepts (libuv src/threadpool.c). */
const DEFAULT_POOL_SIZE = 4
const MAX_POOL_SIZE = 1024
/** Pool threads meetings-root calls never occupy, so async userData writes, dns.lookup and async crypto
 *  always find one free (ADR-021). */
const RESERVED_POOL_THREADS = 2
/** stat, readdir and realpath answer from local metadata in microseconds. Also History's degraded-view budget. */
const METADATA_DEADLINE_MS = 2_000
/** A local meeting or `.brain` file (a few MB at most) reads in milliseconds. */
const CONTENT_DEADLINE_MS = 5_000
/** How long a read that returned no content is answered from memory, without touching the file. */
const FAILURE_TTL_MS = 60_000
/** Abort reason of a request's own deadline, which tells it apart from the caller's abort. */
const DEADLINE = Symbol('storage deadline')

/** Why no content or class came back. Only 'missing' says the file does not exist. */
export type StorageFailure =
  | { status: 'missing' }
  | { status: 'unavailable'; code: string }
  | { status: 'timeout' }
  | { status: 'degraded' }
  | { status: 'aborted' }

/** mtime, ctime and size: the version identity the detector keys on (FileVersion in dataless.ts). */
export type ContentVersion = Omit<FileVersion, 'path'>

/** 'ok': the bytes are on this device. 'dataless' | 'unknown': they may not be, so nothing reads them. */
export type FileClass = { status: 'ok' | 'dataless' | 'unknown'; version: ContentVersion } | StorageFailure

export type ReadResult =
  | { status: 'ok'; version: ContentVersion; bytes: Buffer }
  | { status: 'dataless' | 'unknown'; version: ContentVersion }
  | StorageFailure

export type ListResult = { status: 'ok'; names: string[] } | StorageFailure

export interface RequestOptions {
  /** Aborting answers 'aborted' at once; work still waiting for a permit never starts. */
  signal?: AbortSignal
}

export interface StorageGateway {
  /** The entry names of a directory under the root. */
  list(relDir: string, options?: RequestOptions): Promise<ListResult>
  /** Each file's version and class, with one detector probe for the whole batch. Classify a listing before
   *  reading its files, so each read finds its verdict cached. */
  classify(relPaths: readonly string[], options?: RequestOptions): Promise<Map<string, FileClass>>
  /** A file's bytes, read only when they are on this device. Concurrent reads of one version share one fs
   *  call and one buffer: treat it as read-only. */
  read(relPath: string, options?: RequestOptions): Promise<ReadResult>
  /** Records that this process has just written `relPath`: its current version counts as local, so reading
   *  it back needs no probe, and any remembered read failure for it is forgotten. */
  noteWritten(relPath: string, options?: RequestOptions): Promise<{ status: 'ok'; version: ContentVersion } | StorageFailure>
}

/** The fs calls the gateway makes; each is one libuv pool request. Injectable so tests can hold a call
 *  open the way a kernel-blocked hydration does. */
export interface StorageFs {
  readdir(path: string): Promise<string[]>
  readFile(path: string): Promise<Buffer>
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ mtimeMs: number; ctimeMs: number; size: number }>
}

export interface Storage {
  /** The gateway over `root`, an absolute folder. Every gateway of one Storage shares its admission cap,
   *  probe queue, running reads and failure memory; asking for a root again returns the same gateway. */
  at(root: string): StorageGateway
}

type Settled<T> = { status: 'ok'; value: T } | StorageFailure
type Unread = Exclude<ReadResult, { status: 'ok' }>
type PresenceOf = (files: readonly FileVersion[]) => Promise<Map<string, ContentPresence>>

export interface StorageOptions {
  detector?: DatalessDetector
  fs?: StorageFs
  /** The libuv pool size; this process's by default. */
  poolSize?: number
}

/** Read outcomes that describe the file itself: repeating the read inside the TTL would only pin another
 *  pool thread or spawn another probe. */
const REMEMBERED: ReadonlySet<ReadResult['status']> = new Set<ReadResult['status']>(['dataless', 'unknown', 'unavailable', 'timeout'])

/** The libuv pool size for a UV_THREADPOOL_SIZE value, never above libuv's own reading of it (libuv reads
 *  a negative value as a huge unsigned one; here it counts as 1). */
export function threadpoolSize(value: string | undefined): number {
  if (value === undefined) return DEFAULT_POOL_SIZE
  const size = Number.parseInt(value, 10)
  return size > 0 ? Math.min(size, MAX_POOL_SIZE) : 1
}

function outsideRoot(): StorageFailure {
  return { status: 'unavailable', code: 'OUTSIDE_ROOT' }
}

/** Whether a path relative to some base climbs out of it. */
function leavesBase(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/** `relPath` joined under `root`, or null unless it is a plain relative path that stays inside. */
function underRoot(root: string, relPath: string): string | null {
  const normal = normalize(relPath)
  return relPath.includes('\0') || leavesBase(normal) ? null : join(root, normal)
}

function failureOf(error: unknown): StorageFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' }
  return { status: 'unavailable', code: code ?? 'UNKNOWN' }
}

function settle<T>(pending: Promise<T>): Promise<Settled<T>> {
  return pending.then((value): Settled<T> => ({ status: 'ok', value }), failureOf)
}

function versionOf({ mtimeMs, ctimeMs, size }: FileVersion): ContentVersion {
  return { mtimeMs, ctimeMs, size }
}

/** One gateway call: its deadline and the caller's signal, combined. */
interface Request {
  readonly signal: AbortSignal
  /** What the request answers once its signal has aborted, by where it was: waiting (for a permit or the
   *  probe) or running an fs call. */
  ended(phase: 'waiting' | 'running'): StorageFailure
  close(): void
}

function openRequest(deadlineMs: number, caller: AbortSignal | undefined): Request {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(DEADLINE), deadlineMs)
  const signal = caller ? AbortSignal.any([deadline.signal, caller]) : deadline.signal
  return {
    signal,
    ended(phase) {
      if (signal.reason !== DEADLINE) return { status: 'aborted' }
      return phase === 'running' ? { status: 'timeout' } : { status: 'degraded' }
    },
    close: () => clearTimeout(timer)
  }
}

/** `pending` (which never rejects), unless the request ends first; the work runs on either way. */
function untilEnded<T>(pending: Promise<T>, request: Request, phase: 'waiting' | 'running'): Promise<T | StorageFailure> {
  if (request.signal.aborted) return Promise.resolve(request.ended(phase))
  return new Promise((resolve) => {
    function end(): void {
      resolve(request.ended(phase))
    }
    request.signal.addEventListener('abort', end, { once: true })
    void pending.then((value) => {
      request.signal.removeEventListener('abort', end)
      resolve(value)
    })
  })
}

/** At most one detector probe runs at a time. Files asked about meanwhile share the next probe, so a burst
 *  of reads of uncached files costs two probes, not one process per file. */
function createPresenceQueue(detector: DatalessDetector): PresenceOf {
  let waiting: Array<{ files: readonly FileVersion[]; resolve: (verdicts: Map<string, ContentPresence>) => void }> = []
  let probing = false

  async function drain(): Promise<void> {
    probing = true
    while (waiting.length > 0) {
      const batch = waiting
      waiting = []
      // classify never rejects (dataless.ts INV-3); wrapping the call in a fresh Promise keeps this
      // module's never-rejects invariant independent of the injected detector even when it throws
      // SYNCHRONOUSLY, which a bare `.catch()` on its return value would miss (leaving `probing` stuck
      // true forever). A file with no verdict counts as unknown.
      const verdicts = await new Promise<Map<string, ContentPresence>>((resolve) =>
        resolve(detector.classify(batch.flatMap((entry) => entry.files)))
      ).catch(() => new Map<string, ContentPresence>())
      for (const entry of batch) entry.resolve(verdicts)
    }
    probing = false
  }

  return (files) =>
    new Promise((resolve) => {
      waiting.push({ files, resolve })
      if (!probing) void drain()
    })
}

export function createStorage({
  detector = createDatalessDetector(),
  fs = { readdir, readFile, realpath, stat },
  poolSize = threadpoolSize(process.env.UV_THREADPOOL_SIZE)
}: StorageOptions = {}): Storage {
  const admission = createAdmission(Math.max(1, poolSize - RESERVED_POOL_THREADS))
  const presenceOf = createPresenceQueue(detector)
  /** Running content reads, by resolved path and version — shared by every gateway of this Storage. */
  const reads = new Map<string, Promise<Settled<Buffer>>>()
  /** Recent reads that returned no content, by path. The TTL is constant, so insertion order is expiry order. */
  const failures = new Map<string, { result: Unread; expiresAt: number }>()
  /** Per-path write generation, bumped by noteWritten and expiring like a remembered failure. */
  const writeGenerations = new Map<string, { generation: number; expiresAt: number }>()

  function currentGeneration(path: string): number {
    const entry = writeGenerations.get(path)
    return entry && entry.expiresAt > performance.now() ? entry.generation : 0
  }

  function bumpGeneration(path: string): void {
    const now = performance.now()
    for (const [key, entry] of writeGenerations) {
      if (entry.expiresAt > now) break
      writeGenerations.delete(key)
    }
    const generation = currentGeneration(path) + 1
    writeGenerations.delete(path)
    writeGenerations.set(path, { generation, expiresAt: now + FAILURE_TTL_MS })
  }

  /** null once the request holds a permit, else why it got none. */
  async function admit(lane: Lane, request: Request): Promise<StorageFailure | null> {
    const acquired = await admission.acquire(lane, request.signal)
    if (acquired === 'refused') return { status: 'degraded' }
    if (acquired === 'ended') return request.ended('waiting')
    if (!request.signal.aborted) return null
    admission.release()
    return request.ended('waiting')
  }

  /** One fs call under admission. */
  async function call<T>(lane: Lane, request: Request, fsCall: () => Promise<T>): Promise<Settled<T>> {
    const refused = await admit(lane, request)
    if (refused) return refused
    return untilEnded(settle(admission.run(fsCall)), request, 'running')
  }

  async function statFile(path: string, request: Request): Promise<Settled<FileVersion>> {
    const stats = await call('metadata', request, () => fs.stat(path))
    if (stats.status !== 'ok') return stats
    const { mtimeMs, ctimeMs, size } = stats.value
    return { status: 'ok', value: { path, mtimeMs, ctimeMs, size } }
  }

  /** The detector's verdicts, or none (every file then counts as unknown) when the request ends first. The
   *  probe runs on, and the detector caches its answer for the next call. */
  async function presenceWithin(files: readonly FileVersion[], request: Request): Promise<Map<string, ContentPresence>> {
    const verdicts = await untilEnded(presenceOf(files), request, 'waiting')
    return verdicts instanceof Map ? verdicts : new Map<string, ContentPresence>()
  }

  /** Reads `real` once per version, however many callers ask while that read runs. */
  async function readShared(real: string, version: ContentVersion, request: Request): Promise<Settled<Buffer>> {
    const key = [real, version.mtimeMs, version.ctimeMs, version.size].join('\0')
    const running = reads.get(key)
    if (running) return untilEnded(running, request, 'running')
    const refused = await admit('content', request)
    if (refused) return refused
    const started = reads.get(key) // another caller started this read while this one waited
    if (started) {
      admission.release()
      return untilEnded(started, request, 'running')
    }
    const reading = settle(admission.run(() => fs.readFile(real))).finally(() => reads.delete(key))
    reads.set(key, reading)
    return untilEnded(reading, request, 'running')
  }

  function remember(path: string, result: Unread): void {
    const now = performance.now()
    for (const [key, entry] of failures) {
      if (entry.expiresAt > now) break
      failures.delete(key)
    }
    failures.delete(path)
    failures.set(path, { result, expiresAt: now + FAILURE_TTL_MS })
  }

  function gatewayAt(base: string): StorageGateway {
    let realRoot: string | undefined

    async function resolveRoot(request: Request): Promise<Settled<string>> {
      if (realRoot !== undefined) return { status: 'ok', value: realRoot }
      const real = await call('metadata', request, () => fs.realpath(base))
      if (real.status === 'ok') realRoot = real.value
      return real
    }

    /** The symlink-free path of `path`, if it lies inside the symlink-free root. */
    async function resolveInside(path: string, request: Request): Promise<Settled<string>> {
      const realBase = await resolveRoot(request)
      if (realBase.status !== 'ok') return realBase
      const real = await call('metadata', request, () => fs.realpath(path))
      if (real.status !== 'ok') return real
      return leavesBase(relative(realBase.value, real.value)) ? outsideRoot() : real
    }

    async function readLocal(path: string, request: Request): Promise<ReadResult> {
      const file = await statFile(path, request)
      if (file.status !== 'ok') return file
      const version = versionOf(file.value)
      const presence = (await presenceWithin([file.value], request)).get(path)
      if (request.signal.aborted) return request.ended('waiting')
      if (presence !== 'local') return { status: presence ?? 'unknown', version }
      const real = await resolveInside(path, request)
      if (real.status !== 'ok') return real
      const bytes = await readShared(real.value, version, request)
      return bytes.status === 'ok' ? { status: 'ok', version, bytes: bytes.value } : bytes
    }

    return {
      async list(relDir, { signal } = {}) {
        const dir = underRoot(base, relDir)
        if (!dir) return outsideRoot()
        const request = openRequest(METADATA_DEADLINE_MS, signal)
        try {
          const names = await call('metadata', request, () => fs.readdir(dir))
          return names.status === 'ok' ? { status: 'ok', names: names.value } : names
        } finally {
          request.close()
        }
      },

      async classify(relPaths, { signal } = {}) {
        const request = openRequest(METADATA_DEADLINE_MS, signal)
        try {
          const stats = await Promise.all(
            relPaths.map(async (rel): Promise<[string, Settled<FileVersion>]> => {
              const path = underRoot(base, rel)
              return [rel, path ? await statFile(path, request) : outsideRoot()]
            })
          )
          const files = stats.flatMap(([, file]) => (file.status === 'ok' ? [file.value] : []))
          const presence = files.length > 0 ? await presenceWithin(files, request) : new Map<string, ContentPresence>()
          return new Map(
            stats.map(([rel, file]): [string, FileClass] => {
              if (file.status !== 'ok') return [rel, file]
              const verdict = presence.get(file.value.path)
              return [rel, { status: verdict === 'local' ? 'ok' : (verdict ?? 'unknown'), version: versionOf(file.value) }]
            })
          )
        } finally {
          request.close()
        }
      },

      async read(relPath, { signal } = {}) {
        const path = underRoot(base, relPath)
        if (!path) return outsideRoot()
        const remembered = failures.get(path)
        if (remembered && remembered.expiresAt > performance.now()) return remembered.result
        const generation = currentGeneration(path)
        const request = openRequest(CONTENT_DEADLINE_MS, signal)
        try {
          const result = await readLocal(path, request)
          if (result.status !== 'ok' && REMEMBERED.has(result.status) && currentGeneration(path) === generation) remember(path, result)
          return result
        } finally {
          request.close()
        }
      },

      async noteWritten(relPath, { signal } = {}) {
        const path = underRoot(base, relPath)
        if (!path) return outsideRoot()
        failures.delete(path)
        bumpGeneration(path)
        const request = openRequest(METADATA_DEADLINE_MS, signal)
        try {
          const file = await statFile(path, request)
          if (file.status !== 'ok') return file
          detector.markLocal([file.value])
          return { status: 'ok', version: versionOf(file.value) }
        } finally {
          request.close()
        }
      }
    }
  }

  const gateways = new Map<string, StorageGateway>()
  return {
    at(root) {
      let gateway = gateways.get(root)
      if (!gateway) {
        gateway = gatewayAt(root)
        gateways.set(root, gateway)
      }
      return gateway
    }
  }
}
