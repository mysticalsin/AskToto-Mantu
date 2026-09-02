import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AskStart } from '@shared/ipc'
import type { StreamHandlers } from './shared'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '1.8.2' } }))
vi.mock('../license', () => ({ getMachineId: () => 'machine-test' }))
vi.mock('../logger', () => ({ mainLog: { warn: vi.fn() }, auditLog: vi.fn() }))

import { streamOperatorAsk } from './operator-ask'

function handlers(): StreamHandlers {
  return { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
}

const req = { id: 'ask-1', mode: 'answer', prompt: 'hello', history: [] } as AskStart

describe('streamOperatorAsk', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs /v1/ask with HMAC headers and never sends an LLM key', async () => {
    const h = handlers()
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://operator.test/v1/ask')
      const body = String(init.body)
      expect(body).toContain('"provider":"anthropic"')
      expect(body).not.toMatch(/sk-ant|ANTHROPIC_API_KEY/)
      const headers = init.headers as Record<string, string>
      expect(headers['content-type']).toBe('application/json')
      expect(headers['x-metis-device'] || headers['X-Metis-Device'] || Object.keys(headers).join(',')).toBeTruthy()
      return new Response('data: {"t":"delta","text":"hi"}\n\ndata: {"t":"done"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    await new Promise<void>((resolve) => {
      h.onDone = () => resolve()
      streamOperatorAsk({
        providerId: 'anthropic',
        kind: 'anthropic',
        apiKey: '',
        viaOperator: true,
        operatorTransport: { url: 'https://operator.test', secret: 'ingest-secret' },
        model: 'claude-haiku-4-5-20251001',
        temperature: 0.2,
        system: 'sys',
        req,
        handlers: h
      })
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(h.onDelta).toHaveBeenCalledWith('hi')
  })

  it('fails loud when Operator transport is missing — does not invent a seat key', async () => {
    const onError = vi.fn()
    await new Promise<void>((resolve) => {
      onError.mockImplementation(() => resolve())
      streamOperatorAsk({
        providerId: 'anthropic',
        kind: 'anthropic',
        apiKey: '',
        viaOperator: true,
        model: 'claude-haiku-4-5-20251001',
        temperature: 0.2,
        system: 'sys',
        req,
        handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError }
      })
    })
    expect(onError).toHaveBeenCalled()
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/Operator is not reachable/)
  })
})
