import { describe, expect, it } from 'vitest'
import { buildSpeechUpstreamRequest, normalizeSpeechProviderFrame, openSpeechUpstream } from './transport'

const base = {
  accountId: 'a'.repeat(32),
  gatewayId: 'approved-speech-gateway',
  routeId: 'deepgram-via-gateway' as const,
  modelId: 'nova-3',
  configVersion: 'route-config-7',
  allowedLanguages: ['en-US'],
  language: 'en-US',
  gatewayRunToken: 'synthetic-gateway-run-token',
  deepgramApiKey: 'synthetic-provider-key'
}

describe('speech upstream transport', () => {
  it('builds the documented Deepgram-via-Gateway URL and server-only headers', () => {
    const request = buildSpeechUpstreamRequest(base)
    const url = new URL(request.url)
    expect(url.origin).toBe('https://gateway.ai.cloudflare.com')
    expect(url.pathname).toBe(`/v1/${base.accountId}/${base.gatewayId}/deepgram/v1/listen`)
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('encoding')).toBe('linear16')
    expect(url.searchParams.get('sample_rate')).toBe('16000')
    expect(url.searchParams.get('channels')).toBe('1')
    expect(url.searchParams.get('interim_results')).toBe('true')
    expect(url.searchParams.get('mip_opt_out')).toBe('true')
    expect(url.searchParams.get('language')).toBe('en-US')
    expect(request.headers.get('authorization')).toBe('Token synthetic-provider-key')
    expect(request.headers.get('cf-aig-authorization')).toBe('Bearer synthetic-gateway-run-token')
    expect(request.headers.get('cf-aig-collect-log')).toBe('false')
    expect(request.headers.get('cf-aig-collect-log-payload')).toBe('false')
    expect(request.headers.has('x-metis-license')).toBe(false)
    expect(request.headers.has('x-metis-speech-grant')).toBe(false)
  })

  it('keeps Workers AI Nova-3 distinct and uses only its documented Gateway authorization', () => {
    const request = buildSpeechUpstreamRequest({
      ...base,
      routeId: 'workers-ai-nova3',
      modelId: '@cf/deepgram/nova-3',
      language: 'en',
      deepgramApiKey: undefined
    })
    const url = new URL(request.url)
    expect(url.pathname).toBe(`/v1/${base.accountId}/${base.gatewayId}/workers-ai`)
    expect(url.searchParams.get('model')).toBe('@cf/deepgram/nova-3')
    expect(url.searchParams.get('encoding')).toBe('linear16')
    expect(url.searchParams.get('sample_rate')).toBe('16000')
    expect(url.searchParams.get('language')).toBe('en')
    expect(request.headers.get('cf-aig-authorization')).toBe('Bearer synthetic-gateway-run-token')
    expect(request.headers.has('authorization')).toBe(false)
    expect(() =>
      buildSpeechUpstreamRequest({
        ...base,
        routeId: 'workers-ai-nova3',
        modelId: '@cf/deepgram/nova-3',
        language: undefined,
        deepgramApiKey: undefined
      })
    ).toThrow()
  })

  it('sends explicit multi for Deepgram auto mode and refuses it when deployment policy omits multi', () => {
    const request = buildSpeechUpstreamRequest({ ...base, language: undefined, allowedLanguages: ['multi'] })
    expect(new URL(request.url).searchParams.get('language')).toBe('multi')
    expect(() => buildSpeechUpstreamRequest({ ...base, language: undefined })).toThrow()
  })

  it('normalizes only bounded transcript/control messages and suppresses provider errors', () => {
    expect(normalizeSpeechProviderFrame(JSON.stringify({ type: 'Metadata', request_id: 'private-id' }))).toEqual({
      type: 'provider-complete'
    })
    expect(
      normalizeSpeechProviderFrame(
        JSON.stringify({
          type: 'Results',
          start: 0.2,
          duration: 0.3,
          is_final: true,
          languages: ['en-US'],
          channel: {
            alternatives: [
              {
                transcript: 'hello',
                words: [
                  { word: 'hello', punctuated_word: 'Hello.', start: 0.2, end: 0.5, language: 'en-US', speaker: 0 }
                ]
              }
            ]
          }
        })
      )
    ).toEqual({
      type: 'transcript',
      text: 'hello',
      startMs: 200,
      endMs: 500,
      final: true,
      languages: ['en-US'],
      words: [{ text: 'hello', punctuatedWord: 'Hello.', startMs: 200, endMs: 500, language: 'en-US', speaker: 0 }]
    })
    expect(
      normalizeSpeechProviderFrame(JSON.stringify({ type: 'Error', err_msg: 'secret and provider details' }))
    ).toEqual({
      type: 'error',
      code: 'UPSTREAM_UNAVAILABLE'
    })
    expect(normalizeSpeechProviderFrame('x'.repeat(64 * 1024 + 1))).toBeNull()
    expect(normalizeSpeechProviderFrame('{invalid json')).toBeNull()
  })

  it('maps a redirect or non-101 handshake to a content-free refusal', async () => {
    const result = await openSpeechUpstream(
      base,
      async () => new Response('secret upstream diagnostic', { status: 502 })
    )
    expect(result).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' })
    expect(JSON.stringify(result)).not.toContain('secret upstream diagnostic')
  })
})
