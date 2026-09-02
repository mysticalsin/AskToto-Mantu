/**
 * install-proxy.test.ts — MQA-190.
 *
 * `installProxyAwareFetch()` is the FIRST await inside `app.whenReady()` (src/main/index.ts), ahead of
 * `runStep('createTray')` / `runStep('createWindow')`. Its OS-proxy probe is
 * `session.defaultSession.resolveProxy(...)`, which on a machine configured with "use an automatic
 * configuration script" has to fetch and compile a PAC file first. Off the corporate network that host
 * can black-hole, and nothing in this module bounded the wait: no AbortSignal, no deadline. The user got
 * no tray icon, no window and no error for however long Chromium took to give up.
 *
 * These are behavioural, not source-level: a resolver that never settles must not stop boot, and a
 * resolver that settles LATE must still end with the proxy installed — otherwise the deadline would
 * trade a boot stall for a provider outage on exactly the networks this module exists to serve.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const resolveProxy = vi.fn<(url: string) => Promise<string>>()
const setGlobalDispatcher = vi.fn()

vi.mock('electron', () => ({
  session: { defaultSession: { resolveProxy: (url: string) => resolveProxy(url) } }
}))

vi.mock('../logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: vi.fn()
}))

const fakes = vi.hoisted(() => {
  class FakeProxyAgent {
    constructor(public readonly uri: string) {}
  }
  class FakeAgent {
    constructor(public readonly opts: unknown) {}
  }
  class FakeEnvHttpProxyAgent {}
  return { FakeProxyAgent, FakeAgent, FakeEnvHttpProxyAgent }
})
const { FakeProxyAgent, FakeAgent } = fakes

vi.mock('undici', () => ({
  Agent: fakes.FakeAgent,
  EnvHttpProxyAgent: fakes.FakeEnvHttpProxyAgent,
  ProxyAgent: fakes.FakeProxyAgent,
  setGlobalDispatcher: (d: unknown) => setGlobalDispatcher(d)
}))

import { installProxyAwareFetch } from './install-proxy'

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

describe('MQA-190 — the OS proxy probe must never hold boot open', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    vi.useFakeTimers()
    saved = {}
    for (const k of PROXY_ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    resolveProxy.mockReset()
    setGlobalDispatcher.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const k of PROXY_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('resolves within the deadline when resolveProxy never settles, so the tray and window still get created', async () => {
    resolveProxy.mockReturnValue(new Promise<string>(() => {})) // a PAC host that black-holes

    let settled = false
    const boot = installProxyAwareFetch().then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await boot
    expect(settled).toBe(true)
    // Boot continues on a direct dispatcher rather than on nothing at all.
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1)
    expect(setGlobalDispatcher.mock.calls[0][0]).toBeInstanceOf(FakeAgent)
  })

  it('still installs the proxy when a slow PAC answers AFTER the deadline', async () => {
    // The regression the deadline could introduce: a corporate machine actually ON the corporate network,
    // whose PAC merely takes a few seconds, must not silently lose proxy routing for the whole session.
    let land: (v: string) => void = () => {}
    resolveProxy.mockReturnValue(
      new Promise<string>((r) => {
        land = r
      })
    )

    await Promise.all([installProxyAwareFetch(), vi.advanceTimersByTimeAsync(5_000)])
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1)

    land('PROXY corp-proxy.internal:8080')
    await vi.advanceTimersByTimeAsync(0)

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2)
    const late = setGlobalDispatcher.mock.calls[1][0] as InstanceType<typeof FakeProxyAgent>
    expect(late).toBeInstanceOf(FakeProxyAgent)
    expect(late.uri).toBe('http://corp-proxy.internal:8080')
  })

  it('installs the system proxy immediately when the resolver answers promptly', async () => {
    resolveProxy.mockResolvedValue('PROXY fast-proxy.corp:3128')
    await Promise.all([installProxyAwareFetch(), vi.advanceTimersByTimeAsync(0)])
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1)
    expect((setGlobalDispatcher.mock.calls[0][0] as InstanceType<typeof FakeProxyAgent>).uri).toBe('http://fast-proxy.corp:3128')
  })
})
