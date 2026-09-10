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
      vi.mocked(h.onDone).mockImplementation(() => resolve())
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
    expect(h.onDone).toHaveBeenCalledWith({}, { status: 'complete', reason: 'done' })
  })

  it('reports an unexpected EOF instead of treating a partial SSE answer as complete', async () => {
    const h = handlers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('data: {"t":"delta","text":"partial recap"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' }
        })
      )
    )

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

    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(expect.stringMatching(/ended.*done/i)))
    expect(h.onDelta).toHaveBeenCalledWith('partial recap')
    expect(h.onDone).not.toHaveBeenCalled()
  })

  it('forwards an explicit incomplete terminal reason from Operator', async () => {
    const h = handlers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('data: {"t":"delta","text":"partial recap"}\n\ndata: {"t":"done","finishReason":"length"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' }
        })
      )
    )

    streamOperatorAsk({
      providerId: 'openai',
      kind: 'openai',
      apiKey: '',
      viaOperator: true,
      operatorTransport: { url: 'https://operator.test', secret: 'ingest-secret' },
      model: 'gpt-4.1',
      temperature: 0.2,
      system: 'sys',
      req,
      handlers: h
    })

    await vi.waitFor(() =>
      expect(h.onDone).toHaveBeenCalledWith({}, { status: 'incomplete', reason: 'length' })
    )
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('fails loud when Operator returns Access login HTML instead of a stream', async () => {
    const onError = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          '<!DOCTYPE html><html><body>Sign in · Cloudflare Access https://team.cloudflareaccess.com</body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
        )
      )
    )
    await new Promise<void>((resolve) => {
      onError.mockImplementation(() => resolve())
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
        handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError }
      })
    })
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/login page/)
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
