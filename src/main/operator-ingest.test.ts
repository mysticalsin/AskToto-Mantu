import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '1.8.0-test' }
}))
vi.mock('./license', () => ({ getMachineId: () => 'machine-test' }))
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./logger', () => ({ mainLog: { warn, info: vi.fn(), error: vi.fn() } }))

import { operatorHeartbeat, setOperatorFetchForTests } from './operator-ingest'
import { setOperatorOverlayFetchForTests, pullOperatorSkillManifest } from './operator-overlay'

const SETTINGS = { operatorUrl: 'https://metis-operator.test', operatorIngestSecret: 'shared-secret' }
const ACCESS_LOGIN = 'https://tony-walteur.cloudflareaccess.com/cdn-cgi/access/login/metis-operator.test?kid=x'
const ACCESS_HTML =
  '<!DOCTYPE html><html><head><title>Sign in · Cloudflare Access</title></head><body><form action="https://tony-walteur.cloudflareaccess.com/cdn-cgi/access/login"></form></body></html>'

function reply(status: number, body: string, headers: Record<string, string>): Response {
  return new Response(body, { status, headers })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  warn.mockClear()
  fetchMock = vi.fn()
  setOperatorFetchForTests(fetchMock as unknown as typeof fetch)
  setOperatorOverlayFetchForTests(fetchMock as unknown as typeof fetch)
})

afterEach(() => {
  setOperatorFetchForTests(null)
  setOperatorOverlayFetchForTests(null)
})

describe('Operator device calls refuse a Cloudflare Access 302', () => {
  it('heartbeat: never follows the redirect, reports failure, names Access in the log', async () => {
    fetchMock.mockResolvedValue(reply(302, '', { location: ACCESS_LOGIN }))
    const beat = await operatorHeartbeat(SETTINGS)
    expect(beat).toEqual({ ok: false, retry: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://metis-operator.test/v1/heartbeat')
    expect(init.redirect).toBe('manual')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/heartbeat is behind Cloudflare Access.*302/))
  })

  it('heartbeat: a followed Access login page (200 text/html) is not a successful heartbeat', async () => {
    fetchMock.mockResolvedValue(reply(200, ACCESS_HTML, { 'content-type': 'text/html; charset=utf-8' }))
    expect(await operatorHeartbeat(SETTINGS)).toEqual({ ok: false, retry: [] })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/behind Cloudflare Access/))
  })

  it('heartbeat: a real JSON answer still carries Retry ids', async () => {
    fetchMock.mockResolvedValue(
      reply(200, JSON.stringify({ ok: true, retry: ['crm-1', 'crm-1', 'crm-2'] }), { 'content-type': 'application/json' })
    )
    expect(await operatorHeartbeat(SETTINGS)).toEqual({ ok: true, retry: ['crm-1', 'crm-2'] })
    expect(warn).not.toHaveBeenCalled()
  })

  it('manifest: an Access 302 applies nothing and does not throw', async () => {
    fetchMock.mockResolvedValue(reply(302, '', { location: ACCESS_LOGIN }))
    await expect(pullOperatorSkillManifest(SETTINGS)).resolves.toBe(0)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('manual')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/skills\/manifest is behind Cloudflare Access/))
  })

  it('manifest: a login page body is never parsed as skills', async () => {
    fetchMock.mockResolvedValue(reply(200, ACCESS_HTML, { 'content-type': 'text/html' }))
    await expect(pullOperatorSkillManifest(SETTINGS)).resolves.toBe(0)
  })
})
