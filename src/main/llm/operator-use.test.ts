import { afterEach, describe, expect, it } from 'vitest'
import { streamOperatorUse } from './operator-use'
import {
  setOperatorFetchForTests,
  setOperatorFundedProvidersForTests,
  type OperatorRuntimeSettings
} from '../operator-ingest'

const settings: OperatorRuntimeSettings = {
  operatorUrl: 'https://operator.test',
  operatorIngestSecret: 'ingest-secret-for-tests'
}

afterEach(() => {
  setOperatorFetchForTests(null)
  setOperatorFundedProvidersForTests([])
})

describe('streamOperatorUse', () => {
  it('completes an ask with no local API key after Operator funds the provider', async () => {
    setOperatorFundedProvidersForTests(['anthropic'])
    let posted = ''
    setOperatorFetchForTests(async (input, init) => {
      posted = String(input)
      const body = String(init?.body ?? '')
      expect(body).not.toMatch(/sk-ant-|cipher|"iv"|grant/)
      expect(JSON.parse(body)).toEqual(
        expect.objectContaining({
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'hello from a seat' }]
        })
      )
      return new Response(JSON.stringify({ ok: true, text: 'funded answer', inputTokens: 8, outputTokens: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const text = await new Promise<string>((resolve, reject) => {
      let out = ''
      streamOperatorUse({
        providerId: 'anthropic',
        kind: 'anthropic',
        apiKey: '',
        model: 'claude-haiku-4-5-20251001',
        temperature: 0,
        system: 'Be brief.',
        req: { id: 'ask-1', mode: 'answer', prompt: 'hello from a seat', history: [] },
        handlers: {
          onDelta: (d) => {
            out += d
          },
          onDone: () => resolve(out),
          onError: (e) => reject(new Error(e))
        },
        operator: settings
      })
    })
    expect(posted).toBe('https://operator.test/v1/use')
    expect(text).toBe('funded answer')
  })

  it('fails closed when Operator is not funded and never asks the seat for a leftover key', async () => {
    setOperatorFundedProvidersForTests([])
    setOperatorFetchForTests(async () => {
      throw new Error('should not fetch')
    })
    const err = await new Promise<string>((resolve) => {
      streamOperatorUse({
        providerId: 'anthropic',
        kind: 'anthropic',
        apiKey: '',
        model: 'claude-haiku-4-5-20251001',
        temperature: 0,
        system: '',
        req: { id: 'ask-2', mode: 'answer', prompt: 'hi', history: [] },
        handlers: {
          onDelta: () => undefined,
          onDone: () => resolve('done'),
          onError: (e) => resolve(e)
        },
        operator: settings
      })
    })
    expect(err).toBe('Operator cannot issue a use')
  })

  it('refuses screenshots on the Operator path', async () => {
    setOperatorFundedProvidersForTests(['anthropic'])
    const err = await new Promise<string>((resolve) => {
      streamOperatorUse({
        providerId: 'anthropic',
        kind: 'anthropic',
        apiKey: '',
        model: 'claude-haiku-4-5-20251001',
        temperature: 0,
        system: '',
        req: { id: 'ask-3', mode: 'vision', prompt: 'what is this', image: 'aaaa', history: [] },
        handlers: {
          onDelta: () => undefined,
          onDone: () => resolve('done'),
          onError: (e) => resolve(e)
        },
        operator: settings
      })
    })
    expect(err).toMatch(/cannot receive screenshots/)
  })
})
