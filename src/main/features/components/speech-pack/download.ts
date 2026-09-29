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
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
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
}

export interface DownloadRequest {
  url: string
  dest: string
  bytes: number
  sha256: string
  signal: AbortSignal
  /** Bytes of this file on disk so far (resumed bytes included). */
  onProgress: (bytesOnDisk: number) => void
}

const MAX_REDIRECTS = 5

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

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
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

async function request(url: string, headers: Record<string, string>, signal: AbortSignal, deps: DownloadDeps): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await deps.fetch(current, { headers, signal, redirect: 'manual' })
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
  const discard = (): void => {
    rmSync(partial, { force: true })
    rmSync(meta, { force: true })
  }

  let offset = sizeOf(partial)
  let validator: string | null = null
  if (existsSync(meta)) {
    try {
      validator = (JSON.parse(readFileSync(meta, 'utf8')) as { validator?: string }).validator ?? null
    } catch {
      validator = null
    }
  }
  if (offset > req.bytes || (offset > 0 && !validator)) {
    discard()
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
  if (req.signal.aborted) throw req.signal.reason
  req.signal.addEventListener('abort', onOuterAbort, { once: true })
  arm(timing.requestTimeoutMs)

  try {
    const headers: Record<string, string> = {}
    if (offset > 0 && validator) {
      headers.Range = `bytes=${offset}-`
      headers['If-Range'] = validator
    }
    const res = await request(req.url, headers, ctrl.signal, deps)
    const contentType = res.headers.get('content-type')

    if (res.status === 416) {
      await res.body?.cancel().catch(() => undefined)
      discard()
      throw new Transient('http', 0, true)
    }
    if (isHtmlContentType(contentType)) {
      await res.body?.cancel().catch(() => undefined)
      throw new SpeechPackError('captive', 'received a web page instead of the file')
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined)
      throw new Transient('http', parseRetryAfter(res.headers.get('retry-after')))
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined)
      throw new SpeechPackError('http', `HTTP ${res.status}`)
    }

    let append = false
    if (res.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '')
      if (!range || Number(range[1]) !== offset || (range[3] !== '*' && Number(range[3]) !== req.bytes)) {
        await res.body?.cancel().catch(() => undefined)
        discard()
        throw new Transient('http', 0, true)
      }
      append = true
    } else {
      // A 200 to a ranged request means the server ignored Range or the validator changed: this file restarts.
      const declared = res.headers.get('content-length')
      if (declared !== null && Number(declared) !== req.bytes) {
        await res.body?.cancel().catch(() => undefined)
        throw new SpeechPackError('http', 'server declared an unexpected length')
      }
      discard()
      offset = 0
    }
    if (!res.body) throw new SpeechPackError('http', 'response carried no body')

    mkdirSync(dirname(req.dest), { recursive: true })
    const fresh = validatorOf(res.headers)
    if (!append && fresh) writeFileSync(meta, JSON.stringify({ validator: fresh }))
    if (!append && !fresh) rmSync(meta, { force: true })

    const handle = await open(partial, append ? 'a' : 'w')
    try {
      const reader = res.body.getReader()
      let written = offset
      let first = true
      arm(timing.idleTimeoutMs)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        if (first) {
          first = false
          if (looksLikeHtmlBytes(value)) throw new SpeechPackError('captive', 'received a web page instead of the file')
        }
        arm(timing.idleTimeoutMs)
        await handle.write(value)
        written += value.byteLength
        req.onProgress(written)
        if (written > req.bytes) break
      }
    } finally {
      await handle.close()
    }

    const size = sizeOf(partial)
    if (size > req.bytes) {
      discard()
      throw new Transient('http', 0, true)
    }
    if (size < req.bytes) throw new Transient('offline')
  } catch (err) {
    if (err instanceof SpeechPackError || err instanceof Transient) throw err
    // Timeouts and network errors alike are transient; the caller's own abort is not.
    if (req.signal.aborted) throw req.signal.reason
    throw new Transient('offline')
  } finally {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * Bring `req.dest` into existence with exactly the pinned bytes. A file already present under its real name
 * was renamed only after verification and is never fetched again.
 */
export async function downloadVerified(req: DownloadRequest, deps: DownloadDeps): Promise<void> {
  if (!isImmutableUrl(req.url)) throw new SpeechPackError('http', 'source is not pinned to an immutable reference')
  if (sizeOf(req.dest) === req.bytes) {
    req.onProgress(req.bytes)
    return
  }
  const partial = `${req.dest}.partial`
  const { timing } = deps
  let attempts = 0
  let mismatches = 0

  for (;;) {
    if (req.signal.aborted) throw req.signal.reason
    const before = sizeOf(partial)
    req.onProgress(before)
    try {
      await transferOnce(req, deps)
      if ((await sha256File(partial)) === req.sha256) {
        rmSync(`${partial}.json`, { force: true })
        renameSync(partial, req.dest)
        req.onProgress(req.bytes)
        return
      }
      rmSync(partial, { force: true })
      rmSync(`${partial}.json`, { force: true })
      if (++mismatches > 1) throw new SpeechPackError('tamper', 'downloaded file does not match its pin')
    } catch (err) {
      if (!(err instanceof Transient)) throw err
      // Progress resets the budget: a flaky link that keeps advancing is not a failing one.
      if (sizeOf(partial) > before) attempts = 0
      if (++attempts >= timing.maxAttempts) throw new SpeechPackError(err.kind, 'transfer failed')
      if (err.restart) continue
      const backoff = Math.min(timing.backoffCapMs, timing.backoffBaseMs * 2 ** (attempts - 1)) * (0.5 + deps.random() / 2)
      const wait = Math.max(backoff, Math.min(err.retryAfterMs, timing.retryAfterCapMs))
      // Pause and cancel must not wait out a long Retry-After.
      await Promise.race([
        deps.sleep(wait),
        new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }))
      ])
    }
  }
}
