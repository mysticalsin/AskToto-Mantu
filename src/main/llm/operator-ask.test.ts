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
const SCREENSHOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('streamOperatorAsk', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('MQA-301 includes the explicitly requested screenshot in the signed managed vision request', async () => {
    const h = handlers()
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response('data: {"t":"done"}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    }))
    vi.stubGlobal('fetch', fetcher)
    streamOperatorAsk({
      providerId: 'cloudflare', kind: 'openai', apiKey: '', viaOperator: true,
      operatorTransport: { url: 'https://operator.test', secret: 'METIS-OP-1.fixture' },
      model: '@cf/deepseek-ai/deepseek-v4-flash-0731', temperature: 0.2, system: 'sys',
      req: { ...req, mode: 'vision', image: SCREENSHOT_PNG }, handlers: h
    })
    await vi.waitFor(() => expect(h.onDone).toHaveBeenCalled())
    expect(fetcher).toHaveBeenCalledOnce()
    const init = fetcher.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      mode: 'vision', model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      image: { mimeType: 'image/png', data: SCREENSHOT_PNG }
    })
  })

  it.each([
    ['not an image', 'vision'],
    ['A'.repeat(5_500_004), 'vision'],
    [SCREENSHOT_PNG, 'answer'],
    ['', 'vision']
  ] as const)('refuses an invalid or unrequested screenshot before any network request (%#)', async (image, mode) => {
    const h = handlers()
    const fetcher = vi.fn(async () => new Response('data: {"t":"done"}\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    }))
    vi.stubGlobal('fetch', fetcher)
    streamOperatorAsk({
      providerId: 'openai', kind: 'openai', apiKey: '', viaOperator: true,
      operatorTransport: { url: 'https://operator.test', secret: 'METIS-OP-1.fixture' },
      model: 'gpt-4o-mini', temperature: 0.2, system: 'sys',
      req: { ...req, mode, image }, handlers: h
    })
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalled())
    expect(fetcher).not.toHaveBeenCalled()
    expect(h.onDone).not.toHaveBeenCalled()
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

  it('refuses redirects instead of forwarding the licence and conversation to another origin', async () => {
    const h = handlers()
    const fetcher = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/ask' } }))
    vi.stubGlobal('fetch', fetcher)
    streamOperatorAsk({
      providerId: 'anthropic', kind: 'anthropic', apiKey: '', viaOperator: true,
      operatorTransport: { url: 'https://operator.test', secret: 'METIS-OP-1.fixture' },
      model: 'fixture-model', temperature: 0.2, system: 'fixture-system', req, handlers: h
    })
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalled())
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith('https://operator.test/v1/ask', expect.objectContaining({
      redirect: 'manual', headers: expect.objectContaining({ 'x-metis-license': 'METIS-OP-1.fixture' })
    }))
    expect(h.onDone).not.toHaveBeenCalled()
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

  it.each(['cancelled', 'unexpected_eof', 'refusal', 'tool_calls', 'vendor_new_reason'])(
    'fails closed when Operator supplies the non-natural terminal reason %s',
    async (finishReason) => {
      const h = handlers()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            `data: {"t":"delta","text":"partial recap"}\n\ndata: ${JSON.stringify({ t: 'done', finishReason })}\n\n`,
            {
              status: 200,
              headers: { 'content-type': 'text/event-stream; charset=utf-8' }
            }
          )
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
        expect(h.onDone).toHaveBeenCalledWith({}, { status: 'incomplete', reason: finishReason })
      )
      expect(h.onError).not.toHaveBeenCalled()
    }
  )

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
