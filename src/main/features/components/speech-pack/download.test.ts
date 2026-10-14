import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open as openAsync, rm as rmAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TIMING, downloadVerified, type DownloadDeps } from './download'
import { SpeechPackError } from './errors'
import { rangeHandler, serve, sha256Hex, type FixtureServer } from './test-server.fixture'

const body = randomBytes(200_000)
const pin = { bytes: body.length, sha256: sha256Hex(body) }

let dir: string
let server: FixtureServer | undefined
let sleeps: number[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'speech-pack-dl-'))
  sleeps = []
})
afterEach(async () => {
  await server?.close()
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

const deps = (over: Partial<DownloadDeps> = {}, timing: Partial<typeof DEFAULT_TIMING> = {}): DownloadDeps => ({
  fetch: globalThis.fetch,
  sleep: async (ms) => {
    sleeps.push(ms)
  },
  random: () => 0.5,
  timing: { ...DEFAULT_TIMING, ...timing },
  ...over
})

const request = (url: string, signal = new AbortController().signal) => ({
  url,
  dest: join(dir, 'model.bin'),
  ...pin,
  signal,
  onProgress: () => undefined
})

const failure = async (run: Promise<unknown>): Promise<SpeechPackError> => {
  try {
    await run
  } catch (err) {
    return err as SpeechPackError
  }
  throw new Error('expected the download to fail')
}

describe('downloadVerified', () => {
  it('downloads, verifies and renames a file', async () => {
    server = await serve(rangeHandler(body))
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(readFileSync(join(dir, 'model.bin')).equals(body)).toBe(true)
    expect(existsSync(join(dir, 'model.bin.partial'))).toBe(false)
  })

  it('resumes a transfer cut at 30% with a guarded Range request', async () => {
    const cut = Math.floor(body.length * 0.3)
    server = await serve(rangeHandler(body, { cutFirstAt: cut }))
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(readFileSync(join(dir, 'model.bin')).equals(body)).toBe(true)
    expect(server.requests).toHaveLength(2)
    const resumed = server.requests[1].headers
    expect(resumed['if-range']).toBe('"v1"')
    const from = Number(/^bytes=(\d+)-$/.exec(resumed.range ?? '')?.[1])
    expect(from).toBeGreaterThan(0)
    expect(from).toBeLessThanOrEqual(cut)
  })

  it('restarts only this file when the server ignores Range', async () => {
    server = await serve(rangeHandler(body, { cutFirstAt: 60_000, ignoreRange: true }))
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(readFileSync(join(dir, 'model.bin')).equals(body)).toBe(true)
    expect(server.requests).toHaveLength(2)
  })

  it('restarts when the validator has changed (If-Range mismatch answers 200)', async () => {
    let served = 0
    const first = rangeHandler(body, { etag: '"v1"', cutFirstAt: 60_000 })
    const second = rangeHandler(body, { etag: '"v2"' })
    server = await serve((req, res, i) => (served++ === 0 ? first(req, res, i) : second(req, res, i)))
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(readFileSync(join(dir, 'model.bin')).equals(body)).toBe(true)
  })

  it('rejects a 206 response with a changed validator before appending its body', async () => {
    const progressByRequest: Array<{ requestCount: number; bytes: number }> = []
    server = await serve(rangeHandler(body, { cutFirstAt: 60_000, changeValidatorOnResume: true }))
    await downloadVerified(
      {
        ...request(`${server.base}/pin/model.bin`),
        onProgress: (bytes) => progressByRequest.push({ requestCount: server!.requests.length, bytes })
      },
      deps()
    )
    expect(readFileSync(join(dir, 'model.bin'))).toEqual(body)
    expect(server.requests).toHaveLength(3)
    expect(server.requests[1].headers.range).toBe('bytes=60000-')
    expect(server.requests[2].headers.range).toBeUndefined()
    expect(progressByRequest.some(({ requestCount, bytes }) => requestCount === 2 && bytes > 60_000)).toBe(false)
  })

  it('retries once from zero after one flipped byte, then succeeds', async () => {
    const flipped = Buffer.from(body)
    flipped[1000] ^= 0xff
    server = await serve(rangeHandler(body, { mutate: (b, i) => (i === 0 ? flipped : b) }))
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1].headers.range).toBeUndefined()
    expect(readFileSync(join(dir, 'model.bin')).equals(body)).toBe(true)
  })

  it('reports tamper when the bytes are wrong twice, leaving no file behind', async () => {
    const flipped = Buffer.from(body)
    flipped[1000] ^= 0xff
    server = await serve(rangeHandler(body, { mutate: () => flipped }))
    const err = await failure(downloadVerified(request(`${server.base}/pin/model.bin`), deps()))
    expect(err.kind).toBe('tamper')
    expect(server.requests).toHaveLength(2)
    expect(existsSync(join(dir, 'model.bin'))).toBe(false)
    expect(existsSync(join(dir, 'model.bin.partial'))).toBe(false)
  })

  it('reports captive for an HTML content type', async () => {
    server = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<html><body>Sign in</body></html>')
    })
    const err = await failure(downloadVerified(request(`${server.base}/pin/model.bin`), deps()))
    expect(err.kind).toBe('captive')
    expect(existsSync(join(dir, 'model.bin'))).toBe(false)
  })

  it('reports captive for an HTML body served as binary', async () => {
    server = await serve((_req, res) => {
      res.setHeader('content-type', 'application/octet-stream')
      res.end('<!doctype html><html><body>Sign in</body></html>')
    })
    const err = await failure(downloadVerified(request(`${server.base}/pin/model.bin`), deps()))
    expect(err.kind).toBe('captive')
  })

  it('reports captive for a redirect to an Access login', async () => {
    server = await serve((_req, res) => {
      res.statusCode = 302
      res.setHeader('location', 'https://team.cloudflareaccess.com/login')
      res.end()
    })
    const err = await failure(downloadVerified(request(`${server.base}/pin/model.bin`), deps()))
    expect(err.kind).toBe('captive')
  })

  it('reports offline after the attempt budget when the network is unreachable', async () => {
    let calls = 0
    const fetch = (async () => {
      calls++
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const err = await failure(downloadVerified(request('http://127.0.0.1:1/pin/model.bin'), deps({ fetch }, { maxAttempts: 3 })))
    expect(err.kind).toBe('offline')
    expect(calls).toBe(3)
    expect(sleeps).toHaveLength(2)
  })

  it('honours Retry-After and backs off with a cap', async () => {
    server = await serve((req, res, i) => {
      if (i === 0) {
        res.statusCode = 503
        res.setHeader('retry-after', '7')
        res.end()
      } else rangeHandler(body)(req, res, i)
    })
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(sleeps).toEqual([7000])
  })

  it('retries a 503 error page served as HTML instead of reporting captive', async () => {
    server = await serve((req, res, i) => {
      if (i === 0) {
        res.statusCode = 503
        res.setHeader('content-type', 'text/html')
        res.end('<html>busy</html>')
      } else rangeHandler(body)(req, res, i)
    })
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(sleeps).toHaveLength(1)
  })

  it('caps the exponential backoff', async () => {
    server = await serve((_req, res) => {
      res.statusCode = 500
      res.end()
    })
    const err = await failure(
      downloadVerified(request(`${server.base}/pin/model.bin`), deps({}, { maxAttempts: 6, backoffBaseMs: 1000, backoffCapMs: 4000 }))
    )
    expect(err.kind).toBe('http')
    // random() = 0.5 -> factor 0.75 of min(cap, base * 2^n)
    expect(sleeps).toEqual([750, 1500, 3000, 3000, 3000])
  })

  it('does not retry a 404', async () => {
    server = await serve((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const err = await failure(downloadVerified(request(`${server.base}/pin/model.bin`), deps()))
    expect(err.kind).toBe('http')
    expect(server.requests).toHaveLength(1)
  })

  it('never downloads a file that already passed verification', async () => {
    server = await serve(rangeHandler(body))
    writeFileSync(join(dir, 'model.bin'), body)
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(server.requests).toHaveLength(0)
  })

  it('does not adopt a same-size destination until its digest matches the pin', async () => {
    server = await serve(rangeHandler(body))
    const corrupt = Buffer.from(body)
    corrupt[0] ^= 0xff
    writeFileSync(join(dir, 'model.bin'), corrupt)
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps())
    expect(server.requests).toHaveLength(1)
    expect(readFileSync(join(dir, 'model.bin'))).toEqual(body)
  })

  it.each([
    ['missing Content-Length', undefined],
    ['matching Content-Length', '5']
  ])('rejects an oversized streamed chunk with %s before writing or reading further', async (_label, contentLength) => {
    const expected = Buffer.from('12345')
    const prior = Buffer.from('previous verified artifact')
    writeFileSync(join(dir, 'model.bin'), prior)

    let reads = 0
    let cancelled = false
    let body: ReadableStream<Uint8Array>
    body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1
          if (reads === 1) controller.enqueue(Buffer.from('123456'))
          else controller.enqueue(Buffer.from('must not be consumed'))
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
    const headers = new Headers()
    if (contentLength !== undefined) headers.set('content-length', contentLength)
    const fetch = (async () => new Response(body, { status: 200, headers })) as typeof globalThis.fetch
    const progress: number[] = []
    const err = await failure(
      downloadVerified(
        {
          url: 'https://models.example.test/resolve/0123456789abcdef0123456789abcdef01234567/model.bin',
          dest: join(dir, 'model.bin'),
          bytes: expected.length,
          sha256: createHash('sha256').update(expected).digest('hex'),
          signal: new AbortController().signal,
          onProgress: (n) => progress.push(n)
        },
        deps({ fetch }, { maxAttempts: 1 })
      )
    )

    expect(err.kind).toBe('tamper')
    expect(progress.every((n) => n <= expected.length)).toBe(true)
    expect(reads).toBe(1)
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
    expect(readFileSync(join(dir, 'model.bin'))).toEqual(prior)
    expect(existsSync(join(dir, 'model.bin.partial'))).toBe(false)
  })

  it('accepts an exact-size chunked response with no Content-Length', async () => {
    const chunks = [body.subarray(0, 31_337), body.subarray(31_337)]
    let index = 0
    const fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (index === chunks.length) controller.close()
              else controller.enqueue(chunks[index++])
            }
          },
          { highWaterMark: 0 }
        ),
        { status: 200 }
      )) as typeof globalThis.fetch
    await downloadVerified(request('https://models.example.test/resolve/0123456789abcdef0123456789abcdef01234567/model.bin'), deps({ fetch }))
    expect(readFileSync(join(dir, 'model.bin'))).toEqual(body)
    expect(existsSync(join(dir, 'model.bin.partial'))).toBe(false)
  })

  it('waits for the partial file handle to close before cleanup', async () => {
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    let markCloseStarted!: () => void
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve
    })
    let closed = false
    let cleanupObserved = false
    let settled = false
    const openFile = (async (path, flags) => {
      const handle = await openAsync(path, flags)
      const actualClose = handle.close.bind(handle)
      handle.close = async () => {
        markCloseStarted()
        await closeGate
        await actualClose()
        closed = true
      }
      return handle
    }) as typeof openAsync
    const removeFile = (async (path, options) => {
      if (typeof path === 'string' && path.endsWith('model.bin.partial')) cleanupObserved = closed
      return rmAsync(path, options)
    }) as typeof rmAsync
    const fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(Buffer.from('123456'))
          }
        }, { highWaterMark: 0 }),
        { status: 200 }
      )) as typeof globalThis.fetch
    const operation = downloadVerified(
      {
        url: 'https://models.example.test/resolve/0123456789abcdef0123456789abcdef01234567/model.bin',
        dest: join(dir, 'model.bin'),
        bytes: 5,
        sha256: createHash('sha256').update('12345').digest('hex'),
        signal: new AbortController().signal,
        onProgress: () => undefined
      },
      deps({ fetch, openFile, removeFile }, { maxAttempts: 1 })
    )
    const outcome = operation.catch((err) => err)
    void outcome.then(() => {
      settled = true
    })

    try {
      const closedOrFinished = await Promise.race([
        closeStarted.then(() => 'close-started' as const),
        outcome.then(() => 'operation-settled' as const)
      ])
      expect(closedOrFinished).toBe('close-started')
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(cleanupObserved).toBe(false)
    } finally {
      releaseClose()
    }

    const err = await outcome
    expect(err).toBeInstanceOf(SpeechPackError)
    expect((err as SpeechPackError).kind).toBe('tamper')
    expect(closed).toBe(true)
    expect(cleanupObserved).toBe(true)
    expect(existsSync(join(dir, 'model.bin.partial'))).toBe(false)
  })

  it('treats a stalled body as a timeout and resumes', async () => {
    let stalled = false
    const ok = rangeHandler(body)
    server = await serve((req, res, i) => {
      if (!stalled) {
        stalled = true
        res.setHeader('etag', '"v1"')
        res.setHeader('content-length', String(body.length))
        res.write(body.subarray(0, 50_000))
        return
      }
      ok(req, res, i)
    })
    await downloadVerified(request(`${server.base}/pin/model.bin`), deps({}, { idleTimeoutMs: 100 }))
    expect(readFileSync(join(dir, 'model.bin')).equals(body)).toBe(true)
    expect(server.requests[1].headers.range).toBe('bytes=50000-')
  })

  it('stops promptly when aborted and keeps the partial for a later resume', async () => {
    server = await serve((_req, res) => {
      res.setHeader('etag', '"v1"')
      res.setHeader('content-length', String(body.length))
      res.write(body.subarray(0, 40_000))
    })
    const ctrl = new AbortController()
    const run = downloadVerified({ ...request(`${server.base}/pin/model.bin`, ctrl.signal), onProgress: (n) => n >= 40_000 && ctrl.abort('pause') }, deps())
    await expect(run).rejects.toBe('pause')
    expect(existsSync(join(dir, 'model.bin.partial'))).toBe(true)
    expect(existsSync(join(dir, 'model.bin'))).toBe(false)
  })

  it('refuses a URL that names a branch before touching the network', async () => {
    server = await serve(rangeHandler(body))
    const err = await failure(downloadVerified(request(`${server.base}/x/resolve/main/model.bin`), deps()))
    expect(err.kind).toBe('http')
    expect(server.requests).toHaveLength(0)
  })
})
