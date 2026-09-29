/**
 * Storage gateway: the only way the verified-stall path (brainStatus IPC, the boot block's backfill/
 * intelligence-catch-up/consolidation resume, History-open backfill, extraction and draft recovery — the
 * readers M2-0031 moved) reads the meetings root, the synced folder (OneDrive or Documents) that holds the
 * meetings and `.brain`. Other meetings-root readers are migrating file by file; the sync node:fs call
 * sites still outside the gateway are enumerated and ratcheted down in sync-fs-meetings-root.contract.test.ts
 * (tracked for M2-0047 — do not treat this comment as claiming full coverage).
 *
 * Reading a cloud-only (dataless) file makes the OS download it and blocks the reading thread until the
 * provider answers, for minutes when offline; on the main thread that froze the whole app. Async fs moves
 * the wait onto a libuv pool thread, but the pool is small (UV_THREADPOOL_SIZE, 4 by default) and every
 * async fs call, dns.lookup and async crypto call in the process shares it, so blocked reads must never
 * fill it.
 *
 * Invariants:
 *   - Async only. Every method resolves, never rejects, and settles by its deadline (2 s for list and
 *     classify, 5 s for read) whatever the fs or the probe does.
 *   - At most `poolSize - 2` (at least 1) meetings-root fs calls run at once (admission.ts), so two pool
 *     threads stay free. The cap belongs to the admission, and every gateway in the process shares one
 *     (meetings-storage.ts): gateways over different roots still run on the same pool.
 *   - A deadline or an abort releases the caller; the fs call keeps its permit until it settles.
 *   - Content is read only after the dataless detector says the bytes are on this device. 'dataless' and
 *     'unknown' files are never opened, and at most one detector probe runs at a time. The one exception is
 *     a `hydrate` read: the user's explicit open of a single file, under a content permit. A `hydrate`
 *     read refuses a non-regular file (FIFO, socket, device).
 *   - Paths are relative to the injected root and never leave it. A read resolves symlinks only after
 *     classification (on Windows, resolving a path opens the file) and reads the resolved path only if it
 *     lies inside the resolved root.
 *   - Only ENOENT and ENOTDIR are 'missing'. 'unavailable', 'timeout' and 'degraded' say nothing about
 *     whether a file exists; callers must never treat them as a deletion.
 */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { createAdmission, type Admission, type Lane } from './admission'
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
/** An explicit open of one cloud-only file waits for the provider's download this long. */
const HYDRATE_DEADLINE_MS = 60_000
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

/** 'ok': the bytes are on this device. 'dataless' | 'unknown': they may not be, so nothing reads them.
 *  `isSymlink` is the directory entry's own type, never the target's — a caller that treats a name as
 *  identity (e.g. promoting a draft-named file into History) must reject `isSymlink: true` rather than
 *  read through it, even though `read()` itself still follows in-root symlinks. `isRegular` is the stat of
 *  the target: a FIFO, socket or device is not a file to read, and a `hydrate` read refuses one. */
export type FileClass =
  | { status: 'ok' | 'dataless' | 'unknown'; version: ContentVersion; isSymlink: boolean; isRegular: boolean }
  | StorageFailure

export type ReadResult =
  | { status: 'ok'; version: ContentVersion; bytes: Buffer }
  | { status: 'dataless' | 'unknown'; version: ContentVersion }
  | StorageFailure

export type ListResult = { status: 'ok'; names: string[] } | StorageFailure

export interface RequestOptions {
  /** Aborting answers 'aborted' at once; work still waiting for a permit never starts. */
  signal?: AbortSignal
}

/** What an explicit open reports while one cloud-only file downloads. */
export type HydrationProgress = { state: 'hydrating' } | { state: 'done'; bytes: number }

export interface ReadOptions extends RequestOptions {
  /** A user-initiated open of this one file: skips the dataless check and reads it under a content permit,
   *  waiting for the download for up to a minute. Never for a listing or a search. */
  hydrate?: boolean
  /** Called (never throwing into the gateway) as a `hydrate` read starts and ends. */
  onProgress?: (progress: HydrationProgress) => void
}

export interface StorageGateway {
  /** The entry names of a directory under the root. */
  list(relDir: string, options?: RequestOptions): Promise<ListResult>
  /** Each file's version and class, with one detector probe for the whole batch. Classify a listing before
   *  reading its files, so each read finds its verdict cached. */
  classify(relPaths: readonly string[], options?: RequestOptions): Promise<Map<string, FileClass>>
  /** A file's bytes, read only when they are on this device. Concurrent reads of one version share one fs
   *  call and one buffer: treat it as read-only. */
  read(relPath: string, options?: ReadOptions): Promise<ReadResult>
}

/** The fs calls the gateway makes; each is one libuv pool request. Injectable so tests can hold a call
 *  open the way a kernel-blocked hydration does. */
export interface StorageFs {
  readdir(path: string): Promise<string[]>
  readFile(path: string): Promise<Buffer>
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ mtimeMs: number; ctimeMs: number; size: number; isFile?: () => boolean }>
  /** Unlike `stat`, never follows the final path component: the only way to tell a plain file apart
   *  from a symlink wearing its name (e.g. a symlink planted with a draft-shaped name that points at
   *  another meeting already inside the root — `stat`/`realpath`'s in-root check alone would not catch
   *  that, since the *target* is still inside the root). */
  lstat(path: string): Promise<{ isSymbolicLink: boolean }>
}

export interface StorageGatewayOptions {
  /** The meetings root, called on every request because Settings can move it (infra/storage/paths.ts).
   *  Must not throw: list/classify/read call it unguarded, and a throw there would reject the method,
   *  breaking the never-rejects invariant. */
  root: () => string
  detector?: DatalessDetector
  fs?: StorageFs
  /** The libuv pool size; this process's by default. */
  poolSize?: number
  /** The cap this gateway's fs calls run under; its own `poolAdmission(poolSize)` by default. Pass one
   *  admission to every gateway of a process, or blocked reads under several roots can fill the pool. */
  admission?: Admission
}

type StatedFile = { file: FileVersion; regular: boolean }
type Settled<T> = { status: 'ok'; value: T } | StorageFailure
type Unread = Exclude<ReadResult, { status: 'ok' }>
type LocalRead = { result: ReadResult; rememberUnavailable: boolean }
type PresenceOf = (files: readonly FileVersion[]) => Promise<Map<string, ContentPresence>>

/** Read outcomes that describe the file itself: repeating the read inside the TTL would only pin another
 *  pool thread or spawn another probe. Do not remember 'unavailable' here: once stat has succeeded,
 *  later realpath/readFile unavailability can be a transient lock or hydration failure that must recover
 *  on the next read attempt. */
const REMEMBERED: ReadonlySet<ReadResult['status']> = new Set<ReadResult['status']>(['dataless', 'unknown', 'timeout'])

/** The libuv pool size for a UV_THREADPOOL_SIZE value, never above libuv's own reading of it (libuv reads
 *  a negative value as a huge unsigned one; here it counts as 1). */
export function threadpoolSize(value: string | undefined): number {
  if (value === undefined) return DEFAULT_POOL_SIZE
  const size = Number.parseInt(value, 10)
  return size > 0 ? Math.min(size, MAX_POOL_SIZE) : 1
}

/** How many pool threads background fs work may hold at once: all but RESERVED_POOL_THREADS, at least 1. */
export function reservedPoolCapacity(poolSize = threadpoolSize(process.env.UV_THREADPOOL_SIZE)): number {
  return Math.max(1, poolSize - RESERVED_POOL_THREADS)
}

/** An admission that keeps RESERVED_POOL_THREADS of a `poolSize`-thread pool free. */
export function poolAdmission(poolSize = threadpoolSize(process.env.UV_THREADPOOL_SIZE)): Admission {
  return createAdmission(reservedPoolCapacity(poolSize))
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

function reportProgress(onProgress: ReadOptions['onProgress'], progress: HydrationProgress): void {
  try {
    onProgress?.(progress)
  } catch {
    // a broken listener must not reject the read
  }
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

export function createStorageGateway({
  root,
  detector = createDatalessDetector(),
  fs = { readdir, readFile, realpath, stat, lstat: (path) => lstat(path).then((s) => ({ isSymbolicLink: s.isSymbolicLink() })) },
  poolSize = threadpoolSize(process.env.UV_THREADPOOL_SIZE),
  admission = poolAdmission(poolSize)
}: StorageGatewayOptions): StorageGateway {
  const presenceOf = createPresenceQueue(detector)
  /** Running content reads, by resolved path and version. */
  const reads = new Map<string, Promise<Settled<Buffer>>>()
  /** Recent reads that returned no content, by path. The TTL is constant, so insertion order is expiry order. */
  const failures = new Map<string, { result: Unread; expiresAt: number }>()
  let resolvedRoot: { root: string; real: string } | undefined

  function currentRoot(): { status: 'ok'; root: string } | StorageFailure {
    try {
      return { status: 'ok', root: root() }
    } catch (error) {
      return { status: 'unavailable', code: (error as NodeJS.ErrnoException | null)?.code ?? 'ROOT_UNAVAILABLE' }
    }
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

  async function statFile(path: string, request: Request): Promise<Settled<StatedFile>> {
    const stats = await call('metadata', request, () => fs.stat(path))
    if (stats.status !== 'ok') return stats
    const { mtimeMs, ctimeMs, size, isFile } = stats.value
    return { status: 'ok', value: { file: { path, mtimeMs, ctimeMs, size }, regular: isFile ? isFile.call(stats.value) : true } }
  }

  /** Whether `path` names a symlink itself. Unreadable (settled failure) counts as a symlink: a caller
   *  that cannot verify the entry's own type must not treat it as a plain file. */
  async function isSymlink(path: string, request: Request): Promise<boolean> {
    const result = await call('metadata', request, () => fs.lstat(path))
    return result.status !== 'ok' || result.value.isSymbolicLink
  }

  /** The detector's verdicts, or none (every file then counts as unknown) when the request ends first. The
   *  probe runs on, and the detector caches its answer for the next call. */
  async function presenceWithin(files: readonly FileVersion[], request: Request): Promise<Map<string, ContentPresence>> {
    const verdicts = await untilEnded(presenceOf(files), request, 'waiting')
    return verdicts instanceof Map ? verdicts : new Map<string, ContentPresence>()
  }

  async function resolveRoot(base: string, request: Request): Promise<Settled<string>> {
    if (resolvedRoot?.root === base) return { status: 'ok', value: resolvedRoot.real }
    const real = await call('metadata', request, () => fs.realpath(base))
    if (real.status === 'ok') resolvedRoot = { root: base, real: real.value }
    return real
  }

  /** The symlink-free path of `path`, if it lies inside the symlink-free root. */
  async function resolveInside(base: string, path: string, request: Request): Promise<Settled<string>> {
    const realBase = await resolveRoot(base, request)
    if (realBase.status !== 'ok') return realBase
    const real = await call('metadata', request, () => fs.realpath(path))
    if (real.status !== 'ok') return real
    return leavesBase(relative(realBase.value, real.value)) ? outsideRoot() : real
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

  async function readLocal(base: string, path: string, request: Request, { hydrate, onProgress }: ReadOptions): Promise<LocalRead> {
    const stated = await statFile(path, request)
    if (stated.status !== 'ok') return { result: stated, rememberUnavailable: stated.status === 'unavailable' }
    // No read, listing or explicit open, touches a FIFO, socket or device: it would hold a pool thread until the peer appears.
    if (!stated.value.regular) return { result: { status: 'unavailable', code: 'NOT_REGULAR' }, rememberUnavailable: false }
    const version = versionOf(stated.value.file)
    if (!hydrate) {
      const presence = (await presenceWithin([stated.value.file], request)).get(path)
      if (request.signal.aborted) return { result: request.ended('waiting'), rememberUnavailable: false }
      if (presence !== 'local') return { result: { status: presence ?? 'unknown', version }, rememberUnavailable: false }
    }
    const real = await resolveInside(base, path, request)
    if (real.status !== 'ok') return { result: real, rememberUnavailable: false }
    if (hydrate) reportProgress(onProgress, { state: 'hydrating' })
    const bytes = await readShared(real.value, version, request)
    if (hydrate && bytes.status === 'ok') reportProgress(onProgress, { state: 'done', bytes: bytes.value.length })
    return { result: bytes.status === 'ok' ? { status: 'ok', version, bytes: bytes.value } : bytes, rememberUnavailable: false }
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

  return {
    async list(relDir, { signal } = {}) {
      const base = currentRoot()
      if (base.status !== 'ok') return base
      const dir = underRoot(base.root, relDir)
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
      const current = currentRoot()
      if (current.status !== 'ok') return new Map(relPaths.map((rel): [string, FileClass] => [rel, current]))
      const base = current.root
      const request = openRequest(METADATA_DEADLINE_MS, signal)
      try {
        const stats = await Promise.all(
          relPaths.map(async (rel): Promise<[string, Settled<StatedFile>, boolean]> => {
            const path = underRoot(base, rel)
            if (!path) return [rel, outsideRoot(), true]
            const [file, link] = await Promise.all([statFile(path, request), isSymlink(path, request)])
            return [rel, file, link]
          })
        )
        // A non-regular entry never reaches the detector: it is not a file whose presence can be probed.
        const files = stats.flatMap(([, file]) => (file.status === 'ok' && file.value.regular ? [file.value.file] : []))
        const presence = files.length > 0 ? await presenceWithin(files, request) : new Map<string, ContentPresence>()
        return new Map(
          stats.map(([rel, file, link]): [string, FileClass] => {
            if (file.status !== 'ok') return [rel, file]
            const verdict = presence.get(file.value.file.path)
            const status = verdict === 'local' ? 'ok' : (verdict ?? 'unknown')
            return [rel, { status, version: versionOf(file.value.file), isSymlink: link, isRegular: file.value.regular }]
          })
        )
      } finally {
        request.close()
      }
    },

    async read(relPath, options = {}) {
      const { signal, hydrate } = options
      const current = currentRoot()
      if (current.status !== 'ok') return current
      const base = current.root
      const path = underRoot(base, relPath)
      if (!path) return outsideRoot()
      const remembered = hydrate ? undefined : failures.get(path)
      if (remembered && remembered.expiresAt > performance.now()) return remembered.result
      const request = openRequest(hydrate ? HYDRATE_DEADLINE_MS : CONTENT_DEADLINE_MS, signal)
      try {
        const { result, rememberUnavailable } = await readLocal(base, path, request, options)
        // An explicit open answers for itself: its timeout says nothing about a later listing.
        if (!hydrate && result.status !== 'ok' && (REMEMBERED.has(result.status) || (rememberUnavailable && result.status === 'unavailable'))) remember(path, result)
        return result
      } finally {
        request.close()
      }
    }
  }
}
