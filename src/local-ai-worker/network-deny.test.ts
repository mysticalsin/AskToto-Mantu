import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNetworkDeny, type NetworkDenyGuard } from './network-deny.mjs'

describe('installNetworkDeny', () => {
  let guard: NetworkDenyGuard | undefined

  afterEach(() => {
    guard?.restore()
    guard = undefined
  })

  it('blocks fetch, HTTP, and HTTPS while counting attempts without URLs', () => {
    const electronNet = { fetch: vi.fn(), request: vi.fn() }
    const originalNetConnect = net.connect
    guard = installNetworkDeny({ electronNet })

    expect(net.connect).not.toBe(originalNetConnect)

    expect(() => fetch('https://example.com/model.gguf')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => http.request('http://example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => http.get('http://example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => https.request('https://example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => https.get('https://example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => net.connect(443, 'example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => net.createConnection(443, 'example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => tls.connect(443, 'example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => http2.connect('https://example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => electronNet.fetch('https://example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => electronNet.request('https://example.com')).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(() => guard?.denyRemoteModelResolver()).toThrow('LOCAL_AI_NETWORK_DISABLED')
    expect(guard.attempts()).toBe(12)
  })

  it('is idempotent and restores the exact original functions', () => {
    const original = {
      fetch: globalThis.fetch,
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
      http2Connect: http2.connect,
      netConnect: net.connect,
      netCreateConnection: net.createConnection,
      tlsConnect: tls.connect
    }
    guard = installNetworkDeny()
    const again = installNetworkDeny()

    expect(again).toBe(guard)
    guard.restore()
    expect(globalThis.fetch).toBe(original.fetch)
    expect(http.request).toBe(original.httpRequest)
    expect(http.get).toBe(original.httpGet)
    expect(https.request).toBe(original.httpsRequest)
    expect(https.get).toBe(original.httpsGet)
    expect(http2.connect).toBe(original.http2Connect)
    expect(net.connect).toBe(original.netConnect)
    expect(net.createConnection).toBe(original.netCreateConnection)
    expect(tls.connect).toBe(original.tlsConnect)
    expect(() => again.restore()).not.toThrow()
  })

  it('emits no URL or credential content', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    guard = installNetworkDeny()
    expect(() => fetch('https://secret.example/token?key=do-not-log')).toThrow()
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})
