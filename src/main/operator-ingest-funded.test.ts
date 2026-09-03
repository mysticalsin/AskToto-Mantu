import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '1.8.2', getPath: () => '/tmp' } }))
vi.mock('./license', () => ({ getMachineId: () => 'machine-test' }))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('./auth', () => ({ authStatus: () => ({ email: 'seat@example.com' }) }))

import {
  fundedProvidersFromHeartbeat,
  operatorAskTransport,
  operatorFundedProviders,
  operatorHeartbeat,
  seatMeta,
  setOperatorFetchForTests,
  setOperatorFundedProvidersForTests
} from './operator-ingest'

describe('heartbeat fundedProviders — IDs only, never secrets', () => {
  beforeEach(() => {
    setOperatorFundedProvidersForTests([])
    setOperatorFetchForTests(null)
  })

  it('keeps Operator-hosted IDs and drops CLI, Dust, local, and vault-looking rows', () => {
    expect(
      fundedProvidersFromHeartbeat({
        ok: true,
        fundedProviders: ['anthropic', 'claude-cli', 'dust', 'local', 'cloudflare-account', 'openai', 'sk-ant-secret']
      })
    ).toEqual(['anthropic', 'openai'])
  })

  it('stores heartbeat IDs in RAM only and never treats a secret as a provider id', async () => {
    setOperatorFetchForTests(async () =>
      new Response(JSON.stringify({ ok: true, retry: [], fundedProviders: ['anthropic', 'dust'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const beat = await operatorHeartbeat({
      operatorUrl: 'https://operator.test',
      operatorIngestSecret: 'ingest-secret'
    })
    expect(beat.ok).toBe(true)
    expect(operatorFundedProviders()).toEqual(['anthropic'])
    expect(JSON.stringify(operatorFundedProviders())).not.toContain('ingest-secret')
  })

  it('does not treat Access login HTML as a successful heartbeat', async () => {
    setOperatorFetchForTests(
      async () =>
        new Response(
          '<!DOCTYPE html><html><body>Sign in · Cloudflare Access https://team.cloudflareaccess.com</body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        )
    )
    const beat = await operatorHeartbeat({
      operatorUrl: 'https://operator.test',
      operatorIngestSecret: 'ingest-secret'
    })
    expect(beat.ok).toBe(false)
    expect(operatorFundedProviders()).toEqual([])
  })

  it('Ask transport is URL + ingest secret only — never an LLM key', () => {
    const t = operatorAskTransport({
      operatorUrl: 'https://operator.test',
      operatorIngestSecret: 'ingest-secret'
    })
    expect(t).toEqual({ url: 'https://operator.test', secret: 'ingest-secret' })
    expect(JSON.stringify(t)).not.toMatch(/sk-ant|sk-|ANTHROPIC/)
  })

  it('includes hostname and SSO email in seatMeta when available', () => {
    const meta = seatMeta({ licenseKey: 'seat-key' })
    expect(meta.seatHash).toHaveLength(32)
    expect(meta.ssoEmail).toBe('seat@example.com')
    expect(meta.hostname === undefined || typeof meta.hostname === 'string').toBe(true)
  })
})
