import { describe, expect, it, vi } from 'vitest'
import { installEgressGuard, type WebRequestLike } from './egress-guard'

vi.mock('electron', () => ({
  session: {
    get defaultSession(): never {
      throw new Error('tests must inject webRequest')
    }
  }
}))
vi.mock('../logger', () => ({
  mainLog: { info: () => {}, warn: () => {} },
  auditLog: () => {}
}))

type Listener = (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void

function fakeWebRequest(): { webRequest: WebRequestLike; fire: (url: string) => boolean } {
  let listener: Listener | null = null
  return {
    webRequest: {
      onBeforeRequest: (_filter, l) => {
        listener = l
      }
    },
    fire: (url) => {
      let cancel = false
      listener?.({ url }, (r) => {
        cancel = r.cancel
      })
      return cancel
    }
  }
}

function harness(allow: readonly string[] | null) {
  const baseFetch = vi.fn(async () => new Response('ok'))
  let installed: typeof fetch | null = null
  const audit = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn() }
  const wr = fakeWebRequest()
  const handle = installEgressGuard(allow, {
    baseFetch: baseFetch as unknown as typeof fetch,
    setGlobalFetch: (f) => {
      installed = f
    },
    webRequest: wr.webRequest,
    audit,
    log
  })
  return { baseFetch, installed: () => installed, audit, log, wr, handle }
}

describe('installEgressGuard', () => {
  it('no policy: nothing wrapped, nothing hooked, base fetch untouched', async () => {
    const h = harness(null)
    expect(h.handle.enforcing).toBe(false)
    expect(h.installed()).toBeNull()
    expect(h.wr.fire('https://anything.example/')).toBe(false)
    await h.handle.fetch('https://anything.example/')
    expect(h.baseFetch).toHaveBeenCalledTimes(1)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it('policy: allowed hosts pass to the base fetch, others reject with a TypeError like a dead network', async () => {
    const h = harness(['graph.microsoft.com', '*.dust.tt'])
    expect(h.handle.enforcing).toBe(true)
    const f = h.installed()!
    await f('https://graph.microsoft.com/v1.0/me')
    await f('https://eu.dust.tt/api')
    await f('http://127.0.0.1:8080/health')
    expect(h.baseFetch).toHaveBeenCalledTimes(3)
    await expect(f('https://api.openai.com/v1/chat')).rejects.toThrow(TypeError)
    await expect(f(new URL('https://evil.example/'))).rejects.toThrow(/egress allowlist/)
    await expect(f(new Request('https://api.openai.com/other'))).rejects.toThrow(TypeError)
    expect(h.baseFetch).toHaveBeenCalledTimes(3)
    expect([...h.handle.blocked]).toEqual(['api.openai.com', 'evil.example'])
  })

  it('audits each blocked host once per session, hostname only', async () => {
    const h = harness([])
    const f = h.installed()!
    await expect(f('https://a.example/one?secret=1')).rejects.toThrow()
    await expect(f('https://a.example/two?secret=2')).rejects.toThrow()
    expect(h.wr.fire('https://a.example/three')).toBe(true)
    const blockedCalls = h.audit.mock.calls.filter((c) => c[0] === 'net.egress.blocked')
    expect(blockedCalls).toHaveLength(1)
    expect(blockedCalls[0][1]).toEqual({ host: 'a.example', via: 'fetch' })
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('secret')
  })

  it('Chromium hook cancels disallowed network URLs and lets non-network schemes through', () => {
    const h = harness(['graph.microsoft.com'])
    expect(h.wr.fire('https://graph.microsoft.com/v1.0/me')).toBe(false)
    expect(h.wr.fire('https://huggingface.co/model.bin')).toBe(true)
    expect(h.wr.fire('file:///app/renderer/index.html')).toBe(false)
    expect(h.wr.fire('devtools://devtools/bundled/x')).toBe(false)
    expect(h.wr.fire('http://localhost:5173/x')).toBe(false)
  })

  it('restore puts the base fetch back', async () => {
    const h = harness(['graph.microsoft.com'])
    h.handle.restore()
    expect(h.installed()).toBe(h.baseFetch)
  })

  it('a missing Chromium hook degrades to fetch-only and says so', () => {
    const audit = vi.fn()
    const log = { info: vi.fn(), warn: vi.fn() }
    const handle = installEgressGuard(['x.example'], {
      baseFetch: (async () => new Response('')) as unknown as typeof fetch,
      setGlobalFetch: () => {},
      webRequest: null,
      audit,
      log
    })
    expect(handle.enforcing).toBe(true)
    expect(log.warn.mock.calls.some((c) => String(c[0]).includes('only main-process fetch'))).toBe(true)
    expect(audit).toHaveBeenCalledWith('net.egress.policy', { hosts: 1, chromiumHook: false })
  })
})
