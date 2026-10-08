import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { clearTimeout as realClearTimeout, setTimeout as realSetTimeout } from 'node:timers'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { inspectorClient } from '../golden-flows/right-edge-hide-rows.mjs'

interface ClientOptions {
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  closeTimeoutMs?: number
  signal?: AbortSignal
}
interface Client {
  send(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>
  evaluate(expression: string): Promise<unknown>
  collectGarbage(): Promise<boolean>
  close(): Promise<void>
}
// Exercise the existing public export before the options are implemented, not a missing future module.
const exportedConnect = inspectorClient as (url: string, options?: ClientOptions) => Promise<Client>
const BUDGETS = { connectTimeoutMs: 1_000, requestTimeoutMs: 3_000, closeTimeoutMs: 250 }
const OUTER_MS = 4_000
const ownedRequestTimers = new Set<ReturnType<typeof realSetTimeout>>()

function captureRequest<T>(operation: () => Promise<T>, budget: number) {
  const timers = vi.spyOn(globalThis, 'setTimeout')
  try {
    return operation()
  } finally {
    // Capture only synchronous request-timer creation during this client's own method invocation.
    // 10_000 is the old client's fixed request budget, retained solely for bounded red-test cleanup.
    timers.mock.calls.forEach((args, index) => {
      const result = timers.mock.results[index]
      if ([budget, 10_000].includes(Number(args[1])) && result.type === 'return') {
        ownedRequestTimers.add(result.value)
      }
    })
    timers.mockRestore()
  }
}

async function connect(url: string, options?: ClientOptions): Promise<Client> {
  const client = await exportedConnect(url, options)
  const budget = options?.requestTimeoutMs ?? 10_000
  return {
    send: (method, params, callOptions) =>
      captureRequest(() => client.send(method, params, callOptions), callOptions?.timeoutMs ?? budget),
    evaluate: (expression) => captureRequest(() => client.evaluate(expression), budget),
    collectGarbage: () => captureRequest(() => client.collectGarbage(), budget),
    close: () => client.close()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  )
}

function observedRequest(operation: () => Promise<unknown>) {
  const previous = new Set(ownedRequestTimers)
  const outcome = observe(operation())
  const timers = [...ownedRequestTimers].filter((timer) => !previous.has(timer))
  return { outcome, timers }
}

function expectTimersCleared(handles: ReturnType<typeof realSetTimeout>[]) {
  expect(handles.length).toBeGreaterThan(0)
  for (const handle of handles) expect(clearedTimers.mock.calls.some(([value]) => value === handle)).toBe(true)
}

async function within<T>(promise: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof realSetTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = realSetTimeout(() => reject(new Error(`TEST_OUTER_DEADLINE: ${stage}`)), OUTER_MS)
      })
    ])
  } finally {
    realClearTimeout(timer)
  }
}

async function rejected(outcome: ReturnType<typeof observe>) {
  const result = await within(outcome, 'client must reject within its configured budget')
  expect(result.status).toBe('rejected')
  if (result.status !== 'rejected') throw new Error('client unexpectedly fulfilled')
  expect(result.error).toBeInstanceOf(Error)
  expect(String(result.error)).not.toContain('TEST_OUTER_DEADLINE')
  return result.error as Error
}

type Request = { id: number; method: string; params?: Record<string, unknown> }
type Mode = 'websocket' | 'stall-upgrade' | 'refuse-upgrade' | 'no-close-ack'
const cleanups: Array<() => Promise<void>> = []
let clearedTimers: MockInstance<typeof globalThis.clearTimeout>

beforeEach(() => {
  // This spy forwards real clears. Fixture deadlines use the original timer functions directly.
  clearedTimers = vi.spyOn(globalThis, 'clearTimeout')
})

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    for (const timer of ownedRequestTimers) realClearTimeout(timer)
    ownedRequestTimers.clear()
    clearedTimers.mockRestore()
  }
})

async function fixture(mode: Mode = 'websocket') {
  const server = createServer()
  const websocket = new WebSocketServer({ noServer: true })
  const sockets = new Set<Socket>()
  const upgraded = deferred<void>()
  const disconnected = deferred<void>()
  const peer = deferred<WebSocket>()
  const frame = deferred<Buffer>()
  const requests: Request[] = []
  const waiting: Array<{ count: number; resolve: (requests: Request[]) => void }> = []
  let connections = 0
  server.on('connection', (socket) => {
    connections++
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => {
      sockets.delete(socket)
      disconnected.resolve()
    })
  })
  server.on('upgrade', (request, socket, head) => {
    upgraded.resolve()
    if (mode === 'stall-upgrade') {
      socket.resume()
      return
    }
    if (mode === 'refuse-upgrade') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    if (mode === 'no-close-ack') {
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      )
      socket.on('data', (bytes: Buffer) => frame.resolve(bytes))
      socket.resume()
      return
    }
    websocket.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => undefined)
      ws.on('message', (data) => {
        requests.push(JSON.parse(data.toString()) as Request)
        for (const waiter of waiting) if (requests.length >= waiter.count) waiter.resolve(requests)
      })
      peer.resolve(ws)
    })
  })
  cleanups.push(async () => {
    for (const ws of websocket.clients) ws.terminate()
    for (const socket of sockets) socket.destroy()
    await within(
      Promise.all([
        new Promise<void>((resolve) => websocket.close(() => resolve())),
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      ]),
      'owned server cleanup'
    )
  })
  await within(
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    }),
    'owned server listen'
  )
  const address = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${address.port}/inspector`,
    peer: () => within(peer.promise, 'WebSocket handshake'),
    upgraded: () => within(upgraded.promise, 'HTTP upgrade request'),
    disconnected: () => within(disconnected.promise, 'client closes its actual TCP socket'),
    frame: () => within(frame.promise, 'client sends a close frame'),
    connectionCount: () => connections,
    destroy: () => sockets.forEach((socket) => socket.destroy()),
    writeFrame: (bytes: Buffer) => sockets.forEach((socket) => socket.write(bytes)),
    endFrame: (bytes: Buffer) => sockets.forEach((socket) => socket.end(bytes)),
    requests: (count: number) =>
      within(
        requests.length >= count
          ? Promise.resolve(requests)
          : new Promise<Request[]>((resolve) => waiting.push({ count, resolve })),
        `peer receives ${count} requests`
      )
  }
}

async function pendingPair(client: Client, server: Awaited<ReturnType<typeof fixture>>) {
  const pending = [
    observedRequest(() => client.send('Runtime.first')),
    observedRequest(() => client.send('Runtime.second'))
  ]
  await server.requests(2)
  return pending
}

async function expectTerminal(
  client: Client,
  server: Awaited<ReturnType<typeof fixture>>,
  pending: ReturnType<typeof observedRequest>[]
) {
  await Promise.all(pending.map(({ outcome }) => rejected(outcome)))
  for (const { timers } of pending) expectTimersCleared(timers)
  await server.disconnected()
  await rejected(observe(client.send('Runtime.afterFailure')))
}

describe('inspectorClient transport lifecycle', { timeout: 15_000 }, () => {
  it('maps out-of-order replies to their requests and ignores valid unsolicited events', async () => {
    const server = await fixture()
    const client = await connect(server.url, BUDGETS)
    const first = observe(client.send('Runtime.first', { value: 1 }))
    const second = observe(client.send('Runtime.second', { value: 2 }))
    const [one, two] = await server.requests(2)
    expect(one).toEqual({ id: expect.any(Number), method: 'Runtime.first', params: { value: 1 } })
    expect(two).toEqual({ id: expect.any(Number), method: 'Runtime.second', params: { value: 2 } })
    expect(one.id).not.toBe(two.id)
    const peer = await server.peer()
    peer.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: {} }))
    peer.send(JSON.stringify({ id: two.id, result: { value: 'second' } }))
    peer.send(JSON.stringify({ id: one.id, result: { value: 'first' } }))
    expect(await within(first, 'first response')).toEqual({ status: 'fulfilled', value: { value: 'first' } })
    expect(await within(second, 'second response')).toEqual({ status: 'fulfilled', value: { value: 'second' } })
    await within(client.close(), 'graceful close')
    await server.disconnected()
  })

  it('preserves synchronous evaluate and collectGarbage without awaitPromise', async () => {
    const server = await fixture()
    const client = await connect(server.url)
    const value = observe(client.evaluate('({ ok: true })'))
    const [evaluation] = await server.requests(1)
    expect(evaluation).toEqual({
      id: expect.any(Number),
      method: 'Runtime.evaluate',
      params: { expression: '({ ok: true })', returnByValue: true }
    })
    const peer = await server.peer()
    peer.send(JSON.stringify({ id: evaluation.id, result: { result: { value: { ok: true } } } }))
    expect(await within(value, 'evaluate response')).toEqual({ status: 'fulfilled', value: { ok: true } })
    const collected = observe(client.collectGarbage())
    const [, collection] = await server.requests(2)
    expect(collection).toEqual({ id: expect.any(Number), method: 'HeapProfiler.collectGarbage' })
    peer.send(JSON.stringify({ id: collection.id, result: {} }))
    expect(await within(collected, 'collection response')).toEqual({ status: 'fulfilled', value: true })
    await within(client.close(), 'graceful close')
  })

  it('clears the real request timer after a response and tolerates a late duplicate reply', async () => {
    const server = await fixture()
    const client = await connect(server.url, { ...BUDGETS, requestTimeoutMs: 1_370 })
    const answer = observedRequest(() => client.send('Runtime.fast'))
    const [request] = await server.requests(1)
    const peer = await server.peer()
    peer.send(JSON.stringify({ id: request.id, result: {} }))
    expect(await within(answer.outcome, 'fast response')).toEqual({ status: 'fulfilled', value: {} })
    expectTimersCleared(answer.timers)
    peer.send(JSON.stringify({ id: request.id, result: { late: true } }))
    const next = observedRequest(() => client.send('Runtime.next'))
    const [, nextRequest] = await server.requests(2)
    peer.send(JSON.stringify({ id: nextRequest.id, result: { next: true } }))
    expect(await within(next.outcome, 'response after duplicate')).toEqual({
      status: 'fulfilled',
      value: { next: true }
    })
    expectTimersCleared(next.timers)
    await within(client.close(), 'graceful close')
  })

  it.each([
    'connectTimeoutMs',
    'requestTimeoutMs',
    'closeTimeoutMs'
  ] as const)('rejects invalid %s budgets without opening a connection', async (option) => {
    const server = await fixture()
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejected(observe(connect(server.url, { ...BUDGETS, [option]: value })))
    }
    expect(server.connectionCount()).toBe(0)
  })

  it('rejects a refused HTTP upgrade and releases the connection', async () => {
    const server = await fixture('refuse-upgrade')
    const connection = observe(connect(server.url, BUDGETS))
    await server.upgraded()
    await rejected(connection)
    await server.disconnected()
  })

  it('terminates a stalled HTTP upgrade at the connection deadline', async () => {
    const server = await fixture('stall-upgrade')
    const connection = observe(connect(server.url, { ...BUDGETS, connectTimeoutMs: 250 }))
    await server.upgraded()
    expect((await rejected(connection)).message).toMatch(/connect.*(timeout|timed out|deadline)/i)
    await server.disconnected()
  })

  it('rejects a pre-aborted connection without opening a socket', async () => {
    const server = await fixture()
    const controller = new AbortController()
    controller.abort()
    await rejected(observe(connect(server.url, { ...BUDGETS, signal: controller.signal })))
    expect(server.connectionCount()).toBe(0)
  })

  it('terminates a CONNECTING socket when aborted during the HTTP upgrade', async () => {
    const server = await fixture('stall-upgrade')
    const controller = new AbortController()
    const connection = observe(connect(server.url, { ...BUDGETS, connectTimeoutMs: 10_000, signal: controller.signal }))
    await server.upgraded()
    controller.abort()
    expect((await rejected(connection)).message).toMatch(/abort/i)
    await server.disconnected()
  })

  it.each(['default', 'per-call'] as const)('fails all work when the %s request deadline expires', async (budget) => {
    const server = await fixture()
    const client = await connect(server.url, { ...BUDGETS, requestTimeoutMs: budget === 'default' ? 250 : 10_000 })
    const first = observe(client.send('Runtime.stalled', {}, budget === 'per-call' ? { timeoutMs: 250 } : undefined))
    const second = observedRequest(() => client.send('Runtime.alsoPending'))
    await server.requests(2)
    expect((await rejected(first)).message).toMatch(/(timeout|timed out|deadline)/i)
    await expectTerminal(client, server, [second])
  })

  it('rejects invalid per-call budgets without sending or poisoning a healthy connection', async () => {
    const server = await fixture()
    const client = await connect(server.url, BUDGETS)
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejected(observe(client.send('Runtime.invalidBudget', {}, { timeoutMs })))
    }
    const answer = observe(client.send('Runtime.healthy'))
    const [request] = await server.requests(1)
    expect(request.method).toBe('Runtime.healthy')
    ;(await server.peer()).send(JSON.stringify({ id: request.id, result: { ok: true } }))
    expect(await within(answer, 'response after invalid budgets')).toEqual({ status: 'fulfilled', value: { ok: true } })
    await within(client.close(), 'graceful close')
  })

  it('aborts an open connection and rejects every pending and future request', async () => {
    const server = await fixture()
    const controller = new AbortController()
    const client = await connect(server.url, { ...BUDGETS, requestTimeoutMs: 10_000, signal: controller.signal })
    const pending = await pendingPair(client, server)
    controller.abort()
    await expectTerminal(client, server, pending)
  })

  it.each(['error', 'exception'] as const)('rejects a CDP %s but keeps a healthy transport usable', async (kind) => {
    const server = await fixture()
    const client = await connect(server.url, BUDGETS)
    const failed = observedRequest(() => client.send('Runtime.failed'))
    const [request] = await server.requests(1)
    const peer = await server.peer()
    const failure =
      kind === 'error'
        ? { error: { code: -32601, message: 'synthetic protocol error' } }
        : { result: { exceptionDetails: { text: 'synthetic evaluation exception' } } }
    peer.send(JSON.stringify({ id: request.id, ...failure }))
    expect((await rejected(failed.outcome)).message).toContain('synthetic')
    expectTimersCleared(failed.timers)
    const next = observedRequest(() => client.send('Runtime.healthy'))
    const [, healthy] = await server.requests(2)
    peer.send(JSON.stringify({ id: healthy.id, result: { ok: true } }))
    expect(await within(next.outcome, 'healthy response')).toEqual({ status: 'fulfilled', value: { ok: true } })
    expectTimersCleared(next.timers)
    await within(client.close(), 'graceful close')
  })

  it.each([
    'json',
    'shape',
    'id',
    'binary',
    'wire-frame'
  ] as const)('fails the connection for a malformed %s response', async (kind) => {
    const server = await fixture()
    // An ignored protocol error must not pass later because an unrelated request timer expires.
    const client = await connect(server.url, { ...BUDGETS, requestTimeoutMs: 10_000 })
    const pending = await pendingPair(client, server)
    const [request] = await server.requests(2)
    const peer = await server.peer()
    if (kind === 'json') peer.send('{')
    if (kind === 'shape') peer.send(JSON.stringify({ id: request.id }))
    if (kind === 'id') peer.send(JSON.stringify({ id: String(request.id), result: {} }))
    if (kind === 'binary') peer.send(Buffer.from(JSON.stringify({ id: request.id, result: {} })))
    if (kind === 'wire-frame') server.writeFrame(Buffer.from([0x83, 0x00])) // Reserved opcode, real socket error.
    await expectTerminal(client, server, pending)
  })

  it('rejects pending and future requests after abrupt peer disconnection', async () => {
    const server = await fixture()
    const client = await connect(server.url, { ...BUDGETS, requestTimeoutMs: 10_000 })
    const pending = await pendingPair(client, server)
    ;(await server.peer()).terminate()
    await expectTerminal(client, server, pending)
  })

  it('closes idempotently and rejects pending work immediately', async () => {
    const server = await fixture()
    const client = await connect(server.url, { ...BUDGETS, requestTimeoutMs: 10_000 })
    const pending = await pendingPair(client, server)
    const firstClose = observe(client.close())
    const secondClose = observe(client.close())
    await expectTerminal(client, server, pending)
    expect(await within(firstClose, 'first close')).toMatchObject({ status: 'fulfilled' })
    expect(await within(secondClose, 'second close')).toMatchObject({ status: 'fulfilled' })
    await within(client.close(), 'already closed')
  })

  it('accepts a real empty close acknowledgement after initiating graceful close', async () => {
    const server = await fixture('no-close-ack')
    const client = await connect(server.url, BUDGETS)
    const closing = observe(client.close())
    const frame = await server.frame()
    expect(frame[0] & 0x0f).toBe(8)
    server.endFrame(Buffer.from([0x88, 0x00]))
    expect(await within(closing, 'empty close acknowledgement')).toMatchObject({ status: 'fulfilled' })
    await server.disconnected()
    await within(client.close(), 'already gracefully closed')
  })

  it.each([
    'deadline',
    'abnormal-peer-close'
  ] as const)('does not report graceful cleanup after %s', async (failure) => {
    const server = await fixture('no-close-ack')
    const client = await connect(server.url, BUDGETS)
    const closing = observe(client.close())
    const frame = await server.frame()
    expect(frame[0] & 0x0f).toBe(8)
    if (failure === 'abnormal-peer-close') server.destroy()
    await rejected(closing)
    await server.disconnected()
    await rejected(observe(client.send('Runtime.afterClose')))
    await rejected(observe(client.close()))
  })
})
