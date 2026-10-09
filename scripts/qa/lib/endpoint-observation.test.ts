import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { endpointProtocolShape, observeLoopbackProtocols } from './endpoint-observation.mjs'

const CDP_PORT = 43121
const INSPECT_PORT = 43122
const privateMarker = 'PRIVATE_FIXTURE_MUST_NOT_LEAK'
const cdpBody = JSON.stringify({
  Browser: `Chrome/${privateMarker}`,
  webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/browser/foreign-fixture`
})
const inspectorBody = JSON.stringify([
  { type: 'node', webSocketDebuggerUrl: `ws://127.0.0.1:${INSPECT_PORT}/foreign-fixture` }
])

type Route = { status: number; body?: string; hang?: boolean; contentLength?: number }

function fakeRequests(routes: Record<string, Route>) {
  const seen: Array<{
    options: Record<string, unknown>
    destroy: ReturnType<typeof vi.fn>
    responseDestroy?: ReturnType<typeof vi.fn>
  }> = []
  const request = (options: Record<string, unknown>, receive: (response: EventEmitter & {
    statusCode: number
    headers: Record<string, string>
    destroy: ReturnType<typeof vi.fn>
  }) => void) => {
    const outgoing = new EventEmitter() as EventEmitter & { end: () => void; destroy: ReturnType<typeof vi.fn> }
    outgoing.destroy = vi.fn()
    const entry = {
      options,
      destroy: outgoing.destroy,
      responseDestroy: undefined as ReturnType<typeof vi.fn> | undefined
    }
    outgoing.end = () => {
      queueMicrotask(() => {
        const route = routes[String(options.path)]
        if (route?.hang) return
        const incoming = new EventEmitter() as EventEmitter & {
          statusCode: number
          headers: Record<string, string>
          destroy: ReturnType<typeof vi.fn>
        }
        incoming.statusCode = route?.status ?? 404
        incoming.headers = route?.contentLength ? { 'content-length': String(route.contentLength) } : {}
        incoming.destroy = vi.fn()
        entry.responseDestroy = incoming.destroy
        receive(incoming)
        if (route?.body) incoming.emit('data', Buffer.from(route.body))
        incoming.emit('end')
      })
    }
    seen.push(entry)
    return outgoing
  }
  return { request: request as any, seen }
}

describe('bounded unowned endpoint protocol observation', () => {
  it('recognizes foreign protocol shapes without claiming ownership or returning content', () => {
    expect(endpointProtocolShape('cdp', cdpBody, CDP_PORT)).toBe(true)
    expect(endpointProtocolShape('inspector', inspectorBody, INSPECT_PORT)).toBe(true)
    expect(endpointProtocolShape('cdp', cdpBody, INSPECT_PORT)).toBe(false)
    expect(endpointProtocolShape('inspector', inspectorBody, CDP_PORT)).toBe(false)
    expect(endpointProtocolShape('cdp', 'not JSON', CDP_PORT)).toBe(false)
    expect(endpointProtocolShape('cdp', cdpBody + 'x'.repeat(2_049), CDP_PORT)).toBe(false)
    expect(endpointProtocolShape('inspector', JSON.stringify([{ type: 'page' }]), INSPECT_PORT)).toBe(false)
    expect(
      endpointProtocolShape(
        'cdp',
        JSON.stringify({ Browser: 'Chrome', webSocketDebuggerUrl: `ws://example.com:${CDP_PORT}/devtools/browser/x` }),
        CDP_PORT
      )
    ).toBe(false)
  })

  it('checks only two fixed loopback paths with no redirect and destroys both completed requests', async () => {
    const { request, seen } = fakeRequests({
      '/json/version': { status: 200, body: cdpBody },
      '/json/list': { status: 200, body: inspectorBody }
    })
    const observer = observeLoopbackProtocols({
      cdpPort: CDP_PORT,
      inspectPort: INSPECT_PORT,
      deadline: performance.now() + 1_000,
      request
    })
    await observer.settled
    const diagnostic = observer.cancel()
    expect(diagnostic).toBe('BOTH_PROTOCOL_SHAPES_OBSERVED')
    expect(JSON.stringify({ cdp_diagnostic: diagnostic })).not.toContain(privateMarker)
    expect(seen.map((entry) => entry.options.path).sort()).toEqual(['/json/list', '/json/version'])
    for (const { options, destroy } of seen) {
      expect(options).toMatchObject({ protocol: 'http:', hostname: '127.0.0.1', method: 'GET', agent: false })
      expect([CDP_PORT, INSPECT_PORT]).toContain(options.port)
      expect(destroy).toHaveBeenCalled()
    }
    expect(seen.every(({ responseDestroy }) => responseDestroy?.mock.calls.length)).toBe(true)
  })

  it('does not follow a redirect, treat invalid bodies as observed, or serialize raw response content', async () => {
    const { request, seen } = fakeRequests({
      '/json/version': { status: 302, body: cdpBody },
      '/json/list': { status: 200, body: `${privateMarker}\nnot JSON` }
    })
    const observer = observeLoopbackProtocols({
      cdpPort: CDP_PORT,
      inspectPort: INSPECT_PORT,
      deadline: performance.now() + 1_000,
      request
    })
    await new Promise((resolve) => setImmediate(resolve))
    const diagnostic = observer.cancel()
    await observer.settled
    expect(diagnostic).toBe('NOT_OBSERVED')
    expect(JSON.stringify({ cdp_diagnostic: diagnostic })).not.toContain(privateMarker)
    expect(seen.every(({ destroy }) => destroy.mock.calls.length > 0)).toBe(true)
  })

  it('retains a single positive observation while another request is cancelled', async () => {
    const { request, seen } = fakeRequests({
      '/json/version': { status: 200, body: cdpBody },
      '/json/list': { status: 200, hang: true }
    })
    const observer = observeLoopbackProtocols({
      cdpPort: CDP_PORT,
      inspectPort: INSPECT_PORT,
      deadline: performance.now() + 1_000,
      request
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(observer.cancel()).toBe('CDP_PROTOCOL_SHAPE_OBSERVED')
    await observer.settled
    expect(seen.every(({ destroy }) => destroy.mock.calls.length > 0)).toBe(true)
  })

  it('distinguishes an inspector-only protocol shape from a CDP shape not observed', async () => {
    const { request } = fakeRequests({
      '/json/version': { status: 200, body: 'not JSON' },
      '/json/list': { status: 200, body: inspectorBody }
    })
    const observer = observeLoopbackProtocols({
      cdpPort: CDP_PORT,
      inspectPort: INSPECT_PORT,
      deadline: performance.now() + 1_000,
      request
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(observer.cancel()).toBe('INSPECTOR_PROTOCOL_SHAPE_OBSERVED')
    await observer.settled
  })

  it('aborts a silent peer at the deadline and cannot turn a timeout into an observation', async () => {
    const { request, seen } = fakeRequests({
      '/json/version': { status: 200, hang: true },
      '/json/list': { status: 200, hang: true }
    })
    const observer = observeLoopbackProtocols({
      cdpPort: CDP_PORT,
      inspectPort: INSPECT_PORT,
      deadline: performance.now() + 25,
      request
    })
    await observer.settled
    expect(observer.cancel()).toBe('NOT_OBSERVED')
    expect(seen.every(({ destroy }) => destroy.mock.calls.length > 0)).toBe(true)
  })

  it('destroys an oversized streamed body even when the peer omits Content-Length', async () => {
    const { request, seen } = fakeRequests({
      '/json/version': { status: 200, body: 'x'.repeat(2_049) },
      '/json/list': { status: 200, body: 'x'.repeat(2_049) }
    })
    const observer = observeLoopbackProtocols({
      cdpPort: CDP_PORT,
      inspectPort: INSPECT_PORT,
      deadline: performance.now() + 1_000,
      request
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(observer.cancel()).toBe('NOT_OBSERVED')
    await observer.settled
    expect(seen.every(({ destroy }) => destroy.mock.calls.length > 0)).toBe(true)
    expect(seen.every(({ responseDestroy }) => (responseDestroy?.mock.calls.length ?? 0) > 0)).toBe(true)
  })

  it('caps oversized responses and does not start requests for an already-expired deadline', async () => {
    const { request, seen } = fakeRequests({
      '/json/version': { status: 200, body: cdpBody, contentLength: 3_000 },
      '/json/list': { status: 200, body: inspectorBody, contentLength: 3_000 }
    })
    const observer = observeLoopbackProtocols({
      cdpPort: CDP_PORT,
      inspectPort: INSPECT_PORT,
      deadline: performance.now() + 1_000,
      request
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(observer.cancel()).toBe('NOT_OBSERVED')
    await observer.settled
    expect(seen.every(({ destroy }) => destroy.mock.calls.length > 0)).toBe(true)

    const expired = observeLoopbackProtocols({
      cdpPort: CDP_PORT,
      inspectPort: INSPECT_PORT,
      deadline: performance.now() - 1,
      request
    })
    const beforeExpired = seen.length
    await expired.settled
    expect(expired.cancel()).toBe('NOT_OBSERVED')
    expect(seen).toHaveLength(beforeExpired)
  })
})
