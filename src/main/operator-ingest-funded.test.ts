import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '1.8.2', getPath: () => '/tmp' } }))
vi.mock('./license', () => ({ getMachineId: () => 'machine-test' }))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn() } }))

import { DEFAULT_OPERATOR_URL } from '@shared/operator'
import {
  fundedProvidersFromHeartbeat,
  operatorAskTransport,
  operatorFundedProviders,
  operatorHeartbeat,
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

  it('heartbeats the shipped Operator URL when Settings URL is empty and a secret is set', async () => {
    const urls: string[] = []
    setOperatorFetchForTests(async (input) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ ok: true, retry: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const beat = await operatorHeartbeat({ operatorIngestSecret: 'ingest-secret' })
    expect(beat.ok).toBe(true)
    expect(urls).toEqual([`${DEFAULT_OPERATOR_URL}/v1/heartbeat`])
  })

  it('does not heartbeat without an ingest secret even when the default URL applies', async () => {
    const urls: string[] = []
    setOperatorFetchForTests(async (input) => {
      urls.push(String(input))
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const beat = await operatorHeartbeat({})
    expect(beat.ok).toBe(false)
    expect(urls).toHaveLength(0)
  })

  it('an explicit http Operator URL overrides the shipped default and does not heartbeat', async () => {
    const urls: string[] = []
    setOperatorFetchForTests(async (input) => {
      urls.push(String(input))
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const beat = await operatorHeartbeat({
      operatorUrl: 'http://localhost:8787',
      operatorIngestSecret: 'ingest-secret'
    })
    expect(beat.ok).toBe(false)
    expect(urls).toHaveLength(0)
    expect(operatorAskTransport({ operatorIngestSecret: 'ingest-secret' })).toEqual({
      url: DEFAULT_OPERATOR_URL,
      secret: 'ingest-secret'
    })
    expect(operatorAskTransport({ operatorUrl: 'http://localhost:8787', operatorIngestSecret: 'x' })).toBeNull()
  })
})
