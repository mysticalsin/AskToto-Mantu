import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPERATOR_URL } from '@shared/operator'
import { operatorHeartbeat, setOperatorFetchForTests, stopOperatorRuntime } from './operator-ingest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.8.0-test' }
}))
vi.mock('./license', () => ({
  getMachineId: () => 'machine-test-default-url'
}))
vi.mock('./logger', () => ({
  mainLog: { warn: () => {}, info: () => {}, error: () => {} }
}))

afterEach(() => {
  setOperatorFetchForTests(null)
  stopOperatorRuntime()
})

describe('operatorHeartbeat DEFAULT_OPERATOR_URL fallback', () => {
  it('phones home to DEFAULT when Settings operatorUrl is empty (secret required)', async () => {
    const calls: { url: string }[] = []
    setOperatorFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input) })
      return new Response('{"ok":true,"fundedProviders":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch)

    const r = await operatorHeartbeat({
      operatorUrl: '',
      operatorIngestSecret: 'shared-secret-for-tests'
    })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${DEFAULT_OPERATOR_URL}/v1/heartbeat`)
  })

  it('does not POST without ingest secret even when DEFAULT resolves', async () => {
    const calls: string[] = []
    setOperatorFetchForTests((async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    const r = await operatorHeartbeat({ operatorUrl: '', operatorIngestSecret: '' })
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
