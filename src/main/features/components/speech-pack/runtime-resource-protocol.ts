import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { RuntimeFeatureLease, VerifiedRuntimeResourcePin } from './runtime-lease'

const BLOCK = 64 * 1024
const MAX_RESOURCE_BYTES = 10_000_000_000
const MAX_PENDING_REQUESTS = 16
const MAX_ACTIVE_STREAMS = 8

export type HostAsset = {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly contentSecurityPolicy?: string
}
type LiveStream = {
  readonly cancel: () => Promise<void>
  readonly settled: Promise<void>
  readonly pull: (controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void>
}

function version(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.blksize,
    stat.blocks,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs
  ]
    .map(String)
    .join(':')
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const types: Readonly<Record<string, string>> = {
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    wasm: 'application/wasm',
    json: 'application/json',
    onnx: 'application/octet-stream',
    bin: 'application/octet-stream',
    txt: 'text/plain; charset=utf-8'
  }
  return types[extension] ?? 'application/octet-stream'
}

function resourcePath(pathname: string): string | null {
  if (!pathname.startsWith('/runtime/')) return null
  const path = pathname.slice('/runtime/'.length)
  if (
    path.length < 1 ||
    path.length > 1024 ||
    path.includes('%') ||
    path.includes('\\') ||
    !/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    return null
  return path
}

function noStoreHeaders(type: string, bytes: number): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes),
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff'
  })
}

async function openVerifiedResource(
  pin: VerifiedRuntimeResourcePin,
  assertCurrent: () => Promise<void>,
  signal: AbortSignal
) {
  if (
    (process.platform !== 'win32' && (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)) ||
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes < 0 ||
    pin.bytes > MAX_RESOURCE_BYTES ||
    !/^[0-9a-f]{64}$/.test(pin.sha256)
  ) {
    throw new Error('RUNTIME_RESOURCE_OPEN_UNAVAILABLE')
  }
  await assertCurrent()
  const handle = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat({ bigint: true })
    const named = await lstat(pin.path, { bigint: true })
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size !== BigInt(pin.bytes) ||
      !named.isFile() ||
      named.nlink !== 1n ||
      version(opened) !== version(named)
    ) {
      throw new Error('RUNTIME_RESOURCE_SHAPE_INVALID')
    }
    const hash = createHash('sha256')
    const bytes = Buffer.allocUnsafe(BLOCK)
    let offset = 0
    while (offset < pin.bytes) {
      if (signal.aborted) throw signal.reason ?? new Error('RUNTIME_RESOURCE_REVOKED')
      await assertCurrent()
      const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, pin.bytes - offset), offset)
      await assertCurrent()
      if (!bytesRead) throw new Error('RUNTIME_RESOURCE_TRUNCATED')
      hash.update(bytes.subarray(0, bytesRead))
      offset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, pin.bytes)
    await assertCurrent()
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(pin.path, { bigint: true })
    if (
      extraBytes ||
      version(after) !== version(opened) ||
      version(pathAfter) !== version(opened) ||
      hash.digest('hex') !== pin.sha256
    ) {
      throw new Error('RUNTIME_RESOURCE_PIN_MISMATCH')
    }
    await assertCurrent()
    return { handle, opened }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/** Exact-member server for a private Session. It never derives a filesystem path from a URL. */
export function createRuntimeResourceProtocol(options: {
  readonly token: string
  readonly lease: RuntimeFeatureLease
  readonly hostAssets: Readonly<Record<string, HostAsset>>
  readonly assertCurrent: () => Promise<void>
}) {
  if (!/^[0-9a-f]{64}$/.test(options.token)) throw new Error('RUNTIME_HOST_TOKEN_INVALID')
  const resources = new Map<string, VerifiedRuntimeResourcePin>()
  for (const [name] of options.lease.rendererResources()) {
    resources.set(name, options.lease.rendererResource(name))
  }
  const streams = new Set<LiveStream>()
  let active = true
  let revokePromise: Promise<void> | null = null
  let pendingRequests = 0
  let requestWaiters: (() => void)[] = []
  let pendingStreamAdmissions = 0
  const assertLive = async (): Promise<void> => {
    if (!active) throw new Error('RUNTIME_RESOURCE_REVOKED')
    await options.assertCurrent()
    if (!active) throw new Error('RUNTIME_RESOURCE_REVOKED')
  }

  const handleRequest = async (request: Request): Promise<Response> => {
    if (!active) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 404 })
    const rawPath = /^metis-runtime:\/\/[^/]+(\/[^?#]*)/.exec(request.url)?.[1]
    if (
      !rawPath ||
      rawPath.includes('%') ||
      rawPath.includes('\\') ||
      rawPath.split('/').some((part) => part === '.' || part === '..')
    ) {
      return new Response(null, { status: 404 })
    }
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response(null, { status: 404 })
    }
    if (
      url.protocol !== 'metis-runtime:' ||
      url.hostname !== options.token ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname.includes('%') ||
      url.pathname.includes('\\')
    )
      return new Response(null, { status: 404 })
    const host = options.hostAssets[url.pathname]
    if (host) {
      try {
        await assertLive()
      } catch {
        return new Response(null, { status: 404 })
      }
      const headers = noStoreHeaders(host.contentType, host.bytes.byteLength)
      if (host.contentSecurityPolicy) headers.set('Content-Security-Policy', host.contentSecurityPolicy)
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(host.bytes, { status: 200, headers })
    }
    const relativePath = resourcePath(url.pathname)
    const pin = relativePath ? resources.get(relativePath) : undefined
    if (!pin || !relativePath) return new Response(null, { status: 404 })
    if (request.method === 'HEAD') {
      try {
        const verified = await openVerifiedResource(pin, assertLive, new AbortController().signal)
        await verified.handle.close()
        await assertLive()
        return new Response(null, { status: 200, headers: noStoreHeaders(contentType(relativePath), pin.bytes) })
      } catch {
        return new Response(null, { status: 404 })
      }
    }
    if (streams.size + pendingStreamAdmissions >= MAX_ACTIVE_STREAMS) {
      return new Response(null, { status: 429, headers: { 'Cache-Control': 'no-store' } })
    }
    pendingStreamAdmissions += 1
    const abort = new AbortController()
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let verifiedVersion: string | null = null
    let offset = 0
    let closed = false
    let pendingOperations = 0
    const streamedHash = createHash('sha256')
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    let live!: LiveStream
    const settleIfClosed = (): void => {
      if (closed && pendingOperations === 0) {
        streams.delete(live)
        settle()
      }
    }
    const beginOperation = (): void => {
      pendingOperations += 1
    }
    const endOperation = (): void => {
      pendingOperations -= 1
      settleIfClosed()
    }
    const close = async (cancel: boolean): Promise<void> => {
      if (closed) return
      closed = true
      if (cancel) abort.abort(new Error('RUNTIME_RESOURCE_REVOKED'))
      if (handle) await handle.close().catch(() => undefined)
      handle = null
      settleIfClosed()
    }
    live = {
      settled,
      cancel: async () => {
        await close(true)
      },
      pull: async (stream) => {
        beginOperation()
        try {
          if (!active || abort.signal.aborted || !handle) throw new Error('RUNTIME_RESOURCE_REVOKED')
          await assertLive()
          const before = await handle.stat({ bigint: true })
          const named = await lstat(pin.path, { bigint: true })
          await assertLive()
          if (
            !verifiedVersion ||
            version(before) !== verifiedVersion ||
            version(named) !== verifiedVersion ||
            offset > pin.bytes
          )
            throw new Error('RUNTIME_RESOURCE_CHANGED')
          if (offset === pin.bytes) {
            if (streamedHash.digest('hex') !== pin.sha256) throw new Error('RUNTIME_RESOURCE_PIN_MISMATCH')
            await close(false)
            stream.close()
            return
          }
          const buffer = Buffer.allocUnsafe(Math.min(BLOCK, pin.bytes - offset))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
          await assertLive()
          const after = await handle.stat({ bigint: true })
          const pathAfter = await lstat(pin.path, { bigint: true })
          await assertLive()
          if (!bytesRead || version(after) !== verifiedVersion || version(pathAfter) !== verifiedVersion) {
            throw new Error('RUNTIME_RESOURCE_CHANGED')
          }
          if (!active || abort.signal.aborted || closed) throw new Error('RUNTIME_RESOURCE_REVOKED')
          const chunk = buffer.subarray(0, bytesRead)
          offset += bytesRead
          streamedHash.update(chunk)
          stream.enqueue(chunk)
        } catch {
          await close(true)
          stream.error(new Error('RUNTIME_RESOURCE_UNAVAILABLE'))
        } finally {
          endOperation()
        }
      }
    }
    streams.add(live)
    pendingStreamAdmissions -= 1
    const body = new ReadableStream<Uint8Array>({
      async start(stream) {
        beginOperation()
        try {
          const verified = await openVerifiedResource(pin, assertLive, abort.signal)
          if (!active || abort.signal.aborted || closed) {
            await verified.handle.close().catch(() => undefined)
            throw new Error('RUNTIME_RESOURCE_REVOKED')
          }
          handle = verified.handle
          verifiedVersion = version(verified.opened)
        } catch {
          await close(true)
          stream.error(new Error('RUNTIME_RESOURCE_UNAVAILABLE'))
        } finally {
          endOperation()
        }
      },
      pull: (stream) => live.pull(stream),
      cancel: () => live.cancel()
    })
    return new Response(body, { status: 200, headers: noStoreHeaders(contentType(relativePath), pin.bytes) })
  }

  const handle = async (request: Request): Promise<Response> => {
    if (!active) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }
    if (pendingRequests >= MAX_PENDING_REQUESTS) {
      return new Response(null, { status: 429, headers: { 'Cache-Control': 'no-store' } })
    }
    pendingRequests += 1
    try {
      return await handleRequest(request)
    } finally {
      pendingRequests -= 1
      if (pendingRequests === 0) {
        for (const resolve of requestWaiters) resolve()
        requestWaiters = []
      }
    }
  }

  return Object.freeze({
    handle,
    revoke(): Promise<void> {
      if (revokePromise) return revokePromise
      active = false
      revokePromise = (async () => {
        await Promise.all([...streams].map((stream) => stream.cancel()))
        if (pendingRequests > 0) {
          await new Promise<void>((resolve) => requestWaiters.push(resolve))
        }
        await Promise.all([...streams].map((stream) => stream.settled))
      })()
      return revokePromise
    }
  })
}
