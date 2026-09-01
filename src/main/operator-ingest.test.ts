import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { METIS_OPERATOR_URL } from '@shared/operator'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.8.0-test',
    getPath: () => '/tmp/asktoto-operator-test'
  }
}))

vi.mock('./license', () => ({
  getMachineId: () => 'machine-id-fixture'
}))

import {
  operatorHeartbeat,
  operatorOsLabel,
  recordOperatorAsk,
  setOperatorFetchForTests,
  startOperatorRuntime,
  stopOperatorRuntime
} from './operator-ingest'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body)
  } as Response
}

describe('Operator heartbeat — always on, no seat opt-out', () => {
  const posts: { url: string; body: string; headers: Record<string, string> }[] = []

  beforeEach(() => {
    posts.length = 0
    setOperatorFetchForTests(async (input, init) => {
      posts.push({
        url: String(input),
        body: String(init?.body ?? ''),
        headers: (init?.headers ?? {}) as Record<string, string>
      })
      return jsonResponse({ ok: true, retry: [] })
    })
  })

  afterEach(() => {
    stopOperatorRuntime()
    setOperatorFetchForTests(null)
  })

  it('a fresh profile reports to the live Operator Worker', async () => {
    const r = await operatorHeartbeat({
      ...DEFAULT_SETTINGS,
      operatorIngestSecret: 'test-ingest-secret'
    })
    expect(r.ok).toBe(true)
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(`${METIS_OPERATOR_URL}/v1/heartbeat`)
    const body = JSON.parse(posts[0].body) as { seatHash: string; os: string; appVersion: string }
    expect(body.seatHash).toMatch(/^[0-9a-f]{32}$/)
    expect(body.appVersion).toBe('1.8.0-test')
    expect(['darwin', 'win', 'linux']).toContain(body.os)
  })

  it('persisted opt-out / false / empty URL still heartbeats to Operator', async () => {
    const r = await operatorHeartbeat({
      operatorEnabled: false,
      operatorUrl: '',
      sendAskText: false,
      operatorIngestSecret: 'test-ingest-secret'
    })
    expect(r.ok).toBe(true)
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(`${METIS_OPERATOR_URL}/v1/heartbeat`)
  })

  it('a stored decoy Operator URL cannot redirect the seat', async () => {
    await operatorHeartbeat({
      operatorUrl: 'https://attacker.example',
      operatorEnabled: false,
      operatorIngestSecret: 'test-ingest-secret'
    })
    expect(posts[0].url).toBe(`${METIS_OPERATOR_URL}/v1/heartbeat`)
  })

  it('startOperatorRuntime heartbeats immediately even when settings say off', async () => {
    startOperatorRuntime(() => ({
      operatorEnabled: false,
      operatorUrl: '',
      sendAskText: false,
      operatorIngestSecret: 'test-ingest-secret'
    }))
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0))
    expect(posts[0].url).toBe(`${METIS_OPERATOR_URL}/v1/heartbeat`)
  })

  it('Ask ingest also ignores stored false and never carries a provider key', async () => {
    await recordOperatorAsk(
      {
        operatorEnabled: false,
        operatorUrl: '',
        sendAskText: false,
        operatorIngestSecret: 'test-ingest-secret',
        licenseKey: 'ATK-SHOULD-HASH'
      },
      { id: 'ask-1', mode: 'general', provider: 'cloudflare', model: 'x', question: 'sk-ant-abcdefghijklmnopqrstuvwxyz hello' }
    )
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(`${METIS_OPERATOR_URL}/v1/ingest`)
    const body = JSON.parse(posts[0].body) as Record<string, unknown>
    expect(body.id).toBe('ask-1')
    expect(String(body.seatHash)).not.toContain('ATK-SHOULD-HASH')
    expect(JSON.stringify(body)).not.toMatch(/sk-ant-abcdefghijklmnopqrstuvwxyz/)
    expect(body).not.toHaveProperty('apiKey')
    expect(body).not.toHaveProperty('licenseKey')
  })

  it('Mac and Windows seats use the same always-on URL (os label only changes)', () => {
    expect(operatorOsLabel('darwin')).toBe('darwin')
    expect(operatorOsLabel('win32')).toBe('win')
    expect(METIS_OPERATOR_URL).toMatch(/^https:\/\/metis-operator\.tony-walteur\.workers\.dev$/)
  })
})
