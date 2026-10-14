/**
 * download.ts — one pinned file, streamed, resumable and verified (M2-0475).
 *
 * Keeps the ordering guarantees of asr-model-download.ts: bytes stream to `<name>.partial` and the file is
 * renamed to its real name only after BOTH its length and its sha256 match the pin. On top of that:
 *
 *   - a cut transfer resumes with `Range` guarded by `If-Range` (the validator saved beside the partial);
 *     a 200 reply, a 416 or a changed validator restarts THIS file from zero and nothing else;
 *   - a digest mismatch deletes the partial and retries once from zero; the second mismatch is 'tamper';
 *   - HTML / login-page responses and Access redirects are 'captive' (src/shared/bundle-response.ts);
 *   - 60 s to the first response, 120 s idle between chunks; 429/5xx honour Retry-After with capped
 *     exponential backoff and jitter.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isHtmlContentType, looksLikeAccessRedirect, looksLikeHtmlBytes } from '../../../../shared/bundle-response'
import { SpeechPackError } from './errors'
import { isImmutableUrl } from './manifest'

export interface DownloadTiming {
  requestTimeoutMs: number
  idleTimeoutMs: number
  /** Transient failures tolerated per file before giving up. */
  maxAttempts: number
  backoffBaseMs: number
  backoffCapMs: number
  retryAfterCapMs: number
}

export const DEFAULT_TIMING: DownloadTiming = {
  requestTimeoutMs: 60_000,
  idleTimeoutMs: 120_000,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffCapMs: 30_000,
  retryAfterCapMs: 300_000
}

export interface DownloadDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  random: () => number
  timing: DownloadTiming
  /** File-operation seams keep partial cleanup ordering deterministic in tests. */
  openFile?: typeof open
  removeFile?: typeof rm
}

export interface DownloadRequest {
  url: string
  dest: string
  bytes: number
  sha256: string
  signal: AbortSignal
  /** Rechecked before reads and writes so a revoked local policy stops the transfer promptly. */
  authorize?: () => boolean
  /** Awaitable settings/policy/capture boundary rechecked around each network and file await. */
  authorizeAsync?: () => Promise<void>
  /** A service-process nonce; partial bytes from a prior process cannot resume silently. */
  resumeScope?: string
  /** Owned model root; descendants are checked before any temporary path is created or opened. */
  trustedRoot?: string
  /** Bytes of this file on disk so far (resumed bytes included). */
  onProgress: (bytesOnDisk: number) => void
}

const MAX_REDIRECTS = 5

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Copy missing files from caller-verified pack directories into an explicit install's staging area. */
export async function reuseVerifiedFiles(options: {
  candidates: readonly string[]
  destination: string
  files: readonly { path: string; bytes: number; sha256: string }[]
  authorize: () => boolean | Promise<boolean>
  validateCurrent: () => boolean
}): Promise<boolean> {
  for (const candidate of options.candidates) {
    for (const file of options.files) {
      const target = join(options.destination, ...file.path.split('/'))
      try {
        const targetInfo = await lstat(target)
        if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink !== 1) return false
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (!(await options.authorize()) || !options.validateCurrent()) return false
      const source = join(candidate, ...file.path.split('/'))
      let sourceHandle: Awaited<ReturnType<typeof open>> | undefined
      let targetHandle: Awaited<ReturnType<typeof open>> | undefined
      let verified = false
      let targetVersion: Awaited<ReturnType<NonNullable<typeof targetHandle>['stat']>> | undefined
      let writtenBytes = 0
      const writtenHash = createHash('sha256')
      try {
        await assertContainedDirectory(candidate, dirname(source))
        if (!options.validateCurrent()) return false
        if (!(await options.authorize()) || !options.validateCurrent()) return false
        const before = await lstat(source)
        if (!options.validateCurrent()) return false
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== file.bytes)
          return false
        sourceHandle = await open(
          source,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
        )
        if (!options.validateCurrent()) return false
        const heldBefore = await sourceHandle.stat()
        if (!options.validateCurrent()) return false
        if (!sameFileVersion(before, heldBefore) || !heldBefore.isFile() || heldBefore.nlink !== 1) return false
        await ensureContainedDirectory(options.destination, dirname(target))
        if (!options.validateCurrent()) return false
        targetHandle = await open(target, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
        if (!options.validateCurrent()) return false
        targetVersion = await targetHandle.stat()
        if (!options.validateCurrent()) return false
        const targetCreated = await lstat(target)
        if (!options.validateCurrent()) return false
        if (!targetVersion.isFile() || !sameFileVersion(targetVersion, targetCreated) || targetVersion.size !== 0)
          return false
        const hash = createHash('sha256')
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, file.bytes + 1))
        let copied = 0
        while (copied <= file.bytes) {
          if (!options.validateCurrent()) return false
          const read = await sourceHandle.read(buffer, 0, Math.min(buffer.length, file.bytes + 1 - copied), copied)
          if (!options.validateCurrent()) return false
          if (read.bytesRead === 0) break
          copied += read.bytesRead
          if (copied > file.bytes) return false
          const chunk = buffer.subarray(0, read.bytesRead)
          hash.update(chunk)
          let offset = 0
          while (offset < chunk.length) {
            if (!options.validateCurrent()) return false
            const written = await targetHandle.write(
              chunk,
              offset,
              chunk.length - offset,
              copied - read.bytesRead + offset
            )
            if (!options.validateCurrent()) return false
            if (written.bytesWritten <= 0) throw new Error('verified-file copy made no progress')
            offset += written.bytesWritten
          }
          writtenHash.update(chunk)
          writtenBytes += chunk.length
          targetVersion = await targetHandle.stat()
          if (!options.validateCurrent()) return false
          const targetPathVersion = await lstat(target)
          if (!options.validateCurrent() || !sameFileVersion(targetVersion, targetPathVersion)) return false
        }
        const heldAfter = await sourceHandle.stat()
        if (!options.validateCurrent()) return false
        const pathAfter = await lstat(source)
        if (!options.validateCurrent()) return false
        const targetHeld = await targetHandle.stat()
        if (!options.validateCurrent()) return false
        const targetPath = await lstat(target)
        if (!options.validateCurrent()) return false
        if (
          copied !== file.bytes ||
          hash.digest('hex') !== file.sha256 ||
          writtenBytes !== file.bytes ||
          writtenHash.copy().digest('hex') !== file.sha256 ||
          !sameFileVersion(heldBefore, heldAfter) ||
          !sameFileVersion(heldAfter, pathAfter) ||
          heldAfter.nlink !== 1 ||
          pathAfter.nlink !== 1 ||
          !sameFileVersion(targetHeld, targetPath) ||
          !targetHeld.isFile() ||
          targetHeld.nlink !== 1 ||
          targetHeld.size !== file.bytes ||
          !options.validateCurrent()
        )
          return false
        await targetHandle.sync()
        if (!options.validateCurrent()) return false
        verified = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      } finally {
        await sourceHandle?.close().catch(() => undefined)
        if (targetHandle && !verified) {
          try {
            if (options.validateCurrent()) {
              const beforeCleanup = await targetHandle.stat()
              if (options.validateCurrent()) {
                const pathTarget = await lstat(target)
                if (options.validateCurrent()) {
                  const cleanupHash = createHash('sha256')
                  const cleanupBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, writtenBytes + 1))
                  let cleanupBytes = 0
                  while (cleanupBytes < writtenBytes && options.validateCurrent()) {
                    const read = await targetHandle.read(
                      cleanupBuffer,
                      0,
                      Math.min(cleanupBuffer.length, writtenBytes - cleanupBytes),
                      cleanupBytes
                    )
                    if (!options.validateCurrent() || read.bytesRead === 0) break
                    cleanupBytes += read.bytesRead
                    cleanupHash.update(cleanupBuffer.subarray(0, read.bytesRead))
                  }
                  if (options.validateCurrent()) {
                    const afterCleanup = await targetHandle.stat()
                    if (options.validateCurrent()) {
                      const finalPath = await lstat(target)
                      if (
                        options.validateCurrent() &&
                        targetVersion &&
                        sameFileVersion(beforeCleanup, targetVersion) &&
                        sameFileVersion(beforeCleanup, pathTarget) &&
                        sameFileVersion(beforeCleanup, afterCleanup) &&
                        sameFileVersion(afterCleanup, finalPath) &&
                        afterCleanup.size === writtenBytes &&
                        cleanupBytes === writtenBytes &&
                        cleanupHash.digest('hex') === writtenHash.copy().digest('hex')
                      ) {
                        await unlink(target)
                        options.validateCurrent()
                      }
                    }
                  }
                }
              }
            }
          } catch {
            // A failed copy leaves no trusted destination; the caller's staging verifier rejects it.
          }
        }
        await targetHandle?.close().catch(() => undefined)
      }
    }
  }
  return true
}

async function ensureContainedDirectory(root: string, target: string): Promise<void> {
  const boundary = resolve(root)
  const resolvedTarget = resolve(target)
  const rel = relative(boundary, resolvedTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('reuse target escaped staging')
  let current = boundary
  const rootStat = await lstat(current)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('reuse staging root is unsafe')
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const item = await lstat(current)
    if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('reuse target parent is unsafe')
  }
}

async function assertContainedDirectory(root: string, target: string): Promise<void> {
  const boundary = resolve(root)
  const resolvedTarget = resolve(target)
  const rel = relative(boundary, resolvedTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('reuse source escaped its pack')
  let current = boundary
  const rootStat = await lstat(current)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('reuse source pack is unsafe')
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    const item = await lstat(current)
    if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('reuse source parent is unsafe')
  }
}

function sameFileVersion(
  a: {
    dev: number | bigint
    ino: number | bigint
    nlink: number | bigint
    size: number | bigint
    mtimeMs: number | bigint
    ctimeMs: number | bigint
  },
  b: {
    dev: number | bigint
    ino: number | bigint
    nlink: number | bigint
    size: number | bigint
    mtimeMs: number | bigint
    ctimeMs: number | bigint
  }
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  )
}

/** Find a parent whose filesystem can report available bytes for a not-yet-created staging path. */
export async function nearestExistingPath(path: string): Promise<string> {
  let current = path
  while (!(await pathExists(current)) && dirname(current) !== current) current = dirname(current)
  return current
}

/** Free bytes at an existing path, used before creating a large model staging tree. */
export async function availableBytesAtPath(path: string): Promise<number> {
  const fs = await statfs(path)
  return fs.bavail * fs.bsize
}

async function assertSafeDownloadPaths(dest: string, trustedRoot?: string): Promise<void> {
  const boundary = resolve(trustedRoot ?? dirname(dest))
  const parent = resolve(dirname(dest))
  const rel = relative(boundary, parent)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new SpeechPackError('tamper', 'download parent escapes its owned root')
  const boundaryStat = await lstat(boundary)
  if (!boundaryStat.isDirectory() || boundaryStat.isSymbolicLink())
    throw new SpeechPackError('tamper', 'download root is unsafe')
  let current = boundary
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const item = await lstat(current)
    if (!item.isDirectory() || item.isSymbolicLink()) throw new SpeechPackError('tamper', 'download parent is unsafe')
  }
  for (const leaf of [dest, `${dest}.partial`, `${dest}.partial.json`]) {
    try {
      const item = await lstat(leaf)
      if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1)
        throw new SpeechPackError('tamper', 'download temporary file is unsafe')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** A failure worth another attempt. `restart` means the partial was discarded and no delay is needed. */
class Transient extends Error {
  constructor(
    readonly kind: 'offline' | 'http',
    readonly retryAfterMs = 0,
    readonly restart = false
  ) {
    super(kind)
  }
}

/** The response body crossed a pinned byte boundary; it must not be retried or retained. */
class OversizedResponse extends SpeechPackError {
  constructor() {
    super('tamper', 'response exceeded its pinned byte range')
    this.name = 'OversizedResponse'
  }
}

export async function sha256File(
  path: string,
  options: { expectedBytes?: number; authorizeAsync?: () => Promise<void> } = {}
): Promise<string> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    await options.authorizeAsync?.()
    const data = chunk as Buffer
    bytes += data.byteLength
    if (bytes > (options.expectedBytes ?? 10_000_000_000))
      throw new SpeechPackError('tamper', 'file exceeded its pinned size')
    hash.update(data)
  }
  await options.authorizeAsync?.()
  if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) {
    throw new SpeechPackError('tamper', 'file did not match its pinned size')
  }
  return hash.digest('hex')
}

/** Size of the file at `path`, or 0 when it does not exist. */
export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : 0
}

/** Headers of the response that identify the byte content, for `If-Range`. Weak ETags cannot guard a range. */
function validatorOf(headers: Headers): string | null {
  const etag = headers.get('etag')
  if (etag && !etag.startsWith('W/')) return etag
  return headers.get('last-modified')
}

async function request(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  deps: DownloadDeps,
  authorizeAsync?: () => Promise<void>
): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await authorizeAsync?.()
    const res = await deps.fetch(current, { headers, signal, redirect: 'manual' })
    await authorizeAsync?.()
    if (res.status < 300 || res.status >= 400) return res
    const location = res.headers.get('location')
    await res.body?.cancel().catch(() => undefined)
    if (!location) throw new SpeechPackError('http', 'redirect without a location')
    if (looksLikeAccessRedirect(location)) throw new SpeechPackError('captive', 'redirected to a login page')
    const next = new URL(location, current)
    if (current.startsWith('https:') && next.protocol !== 'https:') {
      throw new SpeechPackError('http', 'redirect downgraded the connection')
    }
    if (!isImmutableUrl(next.href)) throw new SpeechPackError('http', 'redirect to a mutable reference')
    current = next.href
  }
  throw new SpeechPackError('http', 'too many redirects')
}

/** One pass over the network. Ends with the partial holding exactly `bytes` bytes, or throws. */
async function transferOnce(req: DownloadRequest, deps: DownloadDeps): Promise<void> {
  const partial = `${req.dest}.partial`
  const meta = `${req.dest}.partial.json`
  const { timing } = deps
  const removeFile = deps.removeFile ?? rm
  const discard = async (): Promise<void> => {
    await removeFile(partial, { force: true })
    await removeFile(meta, { force: true })
  }

  await assertSafeDownloadPaths(req.dest, req.trustedRoot)

  let offset = await sizeOf(partial)
  let validator: string | null = null
  let storedScope: string | undefined
  try {
    const metadata = JSON.parse(await readFile(meta, 'utf8')) as { validator?: string; scope?: string }
    validator = metadata.validator ?? null
    storedScope = metadata.scope
  } catch {
    validator = null
  }
  if (
    offset > req.bytes ||
    (offset > 0 && (!validator || (req.resumeScope !== undefined && storedScope !== req.resumeScope)))
  ) {
    await discard()
    offset = 0
  }
  if (offset === req.bytes) return

  // One controller for: the caller's cancel/pause, the request timeout and the idle timeout.
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number): void => {
    clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(), ms)
  }
  const onOuterAbort = (): void => ctrl.abort()
  let unclaimedBody: ReadableStream<Uint8Array> | null = null
  if (req.signal.aborted) throw req.signal.reason
  req.signal.addEventListener('abort', onOuterAbort, { once: true })
  arm(timing.requestTimeoutMs)

  try {
    const headers: Record<string, string> = {}
    if (offset > 0 && validator) {
      headers.Range = `bytes=${offset}-`
      headers['If-Range'] = validator
    }
    const res = await request(req.url, headers, ctrl.signal, deps, req.authorizeAsync)
    unclaimedBody = res.body
    const contentType = res.headers.get('content-type')

    if (res.status === 416) {
      await res.body?.cancel().catch(() => undefined)
      await discard()
      throw new Transient('http', 0, true)
    }
    // Throttling and server errors are checked before the content type: CDN error pages are served as HTML.
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined)
      throw new Transient('http', parseRetryAfter(res.headers.get('retry-after')))
    }
    if (isHtmlContentType(contentType)) {
      await res.body?.cancel().catch(() => undefined)
      throw new SpeechPackError('captive', 'received a web page instead of the file')
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined)
      throw new SpeechPackError('http', `HTTP ${res.status}`)
    }

    let append = false
    let declaredWrong = false
    let rangeBytes = 0
    if (res.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '')
      const start = range ? Number(range[1]) : Number.NaN
      const end = range ? Number(range[2]) : Number.NaN
      const total = range ? Number(range[3]) : Number.NaN
      rangeBytes = end - start + 1
      const contentLength = res.headers.get('content-length')
      const rangeInvalid =
        offset <= 0 ||
        !validator ||
        validatorOf(res.headers) !== validator ||
        !range ||
        start !== offset ||
        !Number.isSafeInteger(end) ||
        end < start ||
        end >= req.bytes ||
        !Number.isSafeInteger(rangeBytes) ||
        total !== req.bytes ||
        (contentLength !== null && Number(contentLength) !== rangeBytes)
      if (rangeInvalid) {
        await res.body?.cancel().catch(() => undefined)
        await discard()
        throw new Transient('http', 0, true)
      }
      append = true
    } else {
      // A 200 to a ranged request means the server ignored Range or the validator changed: this file restarts.
      // A wrong declared length is only reported after the first chunk, so a login page served as binary stays 'captive'.
      const declared = res.headers.get('content-length')
      declaredWrong = declared !== null && Number(declared) !== req.bytes
      await discard()
      offset = 0
    }
    if (!res.body) throw new SpeechPackError('http', 'response carried no body')

    await assertSafeDownloadPaths(req.dest, req.trustedRoot)
    const fresh = validatorOf(res.headers)
    if (!append && fresh)
      await writeFile(
        meta,
        JSON.stringify({ validator: fresh, ...(req.resumeScope ? { scope: req.resumeScope } : {}) })
      )
    if (!append && !fresh) await rm(meta, { force: true })

    const reader = res.body.getReader()
    unclaimedBody = null
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let bodyDone = false
    try {
      handle = await (deps.openFile ?? open)(partial, append ? 'a' : 'w')
      let written = offset
      let receivedInRange = 0
      let first = true
      arm(timing.idleTimeoutMs)
      for (;;) {
        if (req.authorize && !req.authorize()) throw new SpeechPackError('policy', 'transfer is no longer authorized')
        await req.authorizeAsync?.()
        const { done, value } = await reader.read()
        await req.authorizeAsync?.()
        if (done) {
          bodyDone = true
          break
        }
        if (!value || value.byteLength === 0) continue
        if (req.authorize && !req.authorize()) throw new SpeechPackError('policy', 'transfer is no longer authorized')
        await req.authorizeAsync?.()
        if (first) {
          first = false
          if (looksLikeHtmlBytes(value)) throw new SpeechPackError('captive', 'received a web page instead of the file')
          if (declaredWrong) throw new SpeechPackError('http', 'server declared an unexpected length')
        }
        arm(timing.idleTimeoutMs)
        // Reject the entire chunk before it reaches disk. A chunk is never partially written because
        // that could make a malformed range look like a valid resumable prefix.
        if (value.byteLength > req.bytes - written || (append && value.byteLength > rangeBytes - receivedInRange)) {
          throw new OversizedResponse()
        }
        await handle.writeFile(value)
        await req.authorizeAsync?.()
        written += value.byteLength
        receivedInRange += value.byteLength
        req.onProgress(written)
      }
    } finally {
      try {
        if (!bodyDone) await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      } finally {
        if (handle) await handle.close()
      }
    }

    const size = await sizeOf(partial)
    if (size > req.bytes) {
      await discard()
      throw new Transient('http', 0, true)
    }
    if (size < req.bytes) throw new Transient('offline')
  } catch (err) {
    // The body reader and actual FileHandle have both been closed before this removes the partial.
    if (err instanceof OversizedResponse) {
      await discard()
      throw err
    }
    if (err instanceof SpeechPackError || err instanceof Transient) throw err
    // Timeouts and network errors alike are transient; the caller's own abort is not.
    if (req.signal.aborted) throw req.signal.reason
    throw new Transient('offline')
  } finally {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onOuterAbort)
    if (unclaimedBody) await unclaimedBody.cancel().catch(() => undefined)
    ctrl.abort()
  }
}

/**
 * Bring `req.dest` into existence with exactly the pinned bytes. A file already present under its real name
 * was renamed only after verification and is never fetched again.
 */
export async function downloadVerified(req: DownloadRequest, deps: DownloadDeps): Promise<void> {
  if (!isImmutableUrl(req.url)) throw new SpeechPackError('http', 'source is not pinned to an immutable reference')
  await assertSafeDownloadPaths(req.dest, req.trustedRoot)
  if ((await sizeOf(req.dest)) === req.bytes) {
    try {
      if (
        (await sha256File(req.dest, { expectedBytes: req.bytes, authorizeAsync: req.authorizeAsync })) === req.sha256
      ) {
        req.onProgress(req.bytes)
        return
      }
    } catch {
      // A failed read is not evidence that an existing artifact matches the pin.
    }
  }
  const partial = `${req.dest}.partial`
  const { timing } = deps
  const removeFile = deps.removeFile ?? rm
  let attempts = 0
  let mismatches = 0

  for (;;) {
    if (req.signal.aborted) throw req.signal.reason
    if (req.authorize && !req.authorize()) throw new SpeechPackError('policy', 'transfer is no longer authorized')
    await req.authorizeAsync?.()
    let before = await sizeOf(partial)
    if (before > req.bytes) {
      await removeFile(partial, { force: true })
      await removeFile(`${partial}.json`, { force: true })
      before = 0
    }
    req.onProgress(before)
    try {
      await transferOnce(req, deps)
      await req.authorizeAsync?.()
      if (
        (await sha256File(partial, { expectedBytes: req.bytes, authorizeAsync: req.authorizeAsync })) === req.sha256
      ) {
        await req.authorizeAsync?.()
        await removeFile(`${partial}.json`, { force: true })
        await rename(partial, req.dest)
        req.onProgress(req.bytes)
        return
      }
      await removeFile(partial, { force: true })
      await removeFile(`${partial}.json`, { force: true })
      if (++mismatches > 1) throw new SpeechPackError('tamper', 'downloaded file does not match its pin')
    } catch (err) {
      if (!(err instanceof Transient)) throw err
      // Progress resets the budget: a flaky link that keeps advancing is not a failing one.
      if ((await sizeOf(partial)) > before) attempts = 0
      if (++attempts >= timing.maxAttempts) throw new SpeechPackError(err.kind, 'transfer failed')
      if (err.restart) continue
      const backoff =
        Math.min(timing.backoffCapMs, timing.backoffBaseMs * 2 ** (attempts - 1)) * (0.5 + deps.random() / 2)
      const wait = Math.max(backoff, Math.min(err.retryAfterMs, timing.retryAfterCapMs))
      // Pause and cancel must not wait out a long Retry-After.
      const stopWaiting = new AbortController()
      try {
        await Promise.race([
          deps.sleep(wait),
          new Promise<void>((resolve) =>
            req.signal.addEventListener('abort', () => resolve(), { once: true, signal: stopWaiting.signal })
          )
        ])
      } finally {
        stopWaiting.abort()
      }
    }
  }
}
