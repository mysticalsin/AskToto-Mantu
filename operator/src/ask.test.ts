import { describe, expect, it } from 'vitest'
import { handleOperatorAsk } from './ask'

const SECRET = 'sk-ant-never-leave-the-worker'

function sseUpstream(chunks: string[]): Response {
  const body = chunks.map((c) => `data: ${c}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function readSse(res: Response): Promise<string> {
  return await res.text()
}

describe('Operator /v1/ask', () => {
  it('refuses an unfunded provider and never echoes a key', async () => {
    const res = await handleOperatorAsk(
      JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }),
      {},
      async () => {
        throw new Error('must not call upstream')
      }
    )
    expect(res.status).toBe(402)
    const body = await res.text()
    expect(body).toContain('not Operator-funded')
    expect(body).not.toContain(SECRET)
  })

  it('never funds Dust or CLI and never returns the env secret', async () => {
    for (const provider of ['dust', 'claude-cli', 'codex-cli', 'local']) {
      const res = await handleOperatorAsk(
        JSON.stringify({ provider, model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
        { ANTHROPIC_API_KEY: SECRET, DUST_API_KEY: 'dust-secret' },
        async () => {
          throw new Error('must not call upstream')
        }
      )
      expect(res.status).toBe(402)
      const body = await res.text()
      expect(body).not.toContain(SECRET)
      expect(body).not.toContain('dust-secret')
    }
  })

  it('proxies Anthropic with the Worker key and streams deltas without leaking it', async () => {
    let sawKey = false
    const res = await handleOperatorAsk(
      JSON.stringify({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        system: 'be brief',
        messages: [{ role: 'user', content: 'hi' }]
      }),
      { ANTHROPIC_API_KEY: SECRET },
      async (_url, init) => {
        const headers = init?.headers as Record<string, string>
        if (headers['x-api-key'] === SECRET) sawKey = true
        expect(JSON.stringify(init?.body)).not.toContain(SECRET)
        return sseUpstream([
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }),
          JSON.stringify({ type: 'message_stop' })
        ])
      }
    )
    expect(sawKey).toBe(true)
    expect(res.status).toBe(200)
    const text = await readSse(res)
    expect(text).toContain('"t":"delta"')
    expect(text).toContain('hello')
    expect(text).toContain('"t":"done"')
    expect(text).not.toContain(SECRET)
  })
})
