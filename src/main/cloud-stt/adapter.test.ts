import { describe, expect, it } from 'vitest'
import {
  allowLocalSttFallback,
  buildNova3GatewayWsUrl,
  CLOUDFLARE_NOVA3_MODEL,
  normalizeCloudSttTokens,
  normalizeNova3ResultsMessage,
  normalizeSonioxMessage,
  planCloudSttSession,
  CloudSttError,
  CLOUD_STT_UNCONFIGURED,
  CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED
} from './adapter'
import { resolveEnterpriseLiveProfile } from '../../shared/enterprise-live-profile'

describe('planCloudSttSession', () => {
  const cloudOnly = resolveEnterpriseLiveProfile({
    managed: true,
    inferenceMode: 'cloud-only',
    summaryOnly: true
  })

  it('blocks unconfigured cloud STT under CLOUD_ONLY with honest error', () => {
    const r = planCloudSttSession({ provider: 'unconfigured', profile: cloudOnly })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('UNCONFIGURED')
      expect(r.error).toBe(CLOUD_STT_UNCONFIGURED)
    }
  })

  it('accepts configured Nova-3 under CLOUD_ONLY and surfaces model id', () => {
    const r = planCloudSttSession({ provider: 'cloudflare-nova3', profile: cloudOnly })
    expect(r).toEqual({
      ok: true,
      provider: 'cloudflare-nova3',
      cloudOnly: true,
      modelId: CLOUDFLARE_NOVA3_MODEL
    })
  })

  it('accepts Soniox under CLOUD_ONLY without inventing a CF model id', () => {
    const r = planCloudSttSession({ provider: 'soniox', profile: cloudOnly })
    expect(r).toEqual({ ok: true, provider: 'soniox', cloudOnly: true })
  })
})

describe('allowLocalSttFallback', () => {
  it('refuses local fallback when CLOUD_ONLY', () => {
    const r = allowLocalSttFallback(
      resolveEnterpriseLiveProfile({ managed: true, inferenceMode: 'cloud-only' })
    )
    expect(r).toEqual({ allowed: false, error: CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED })
  })

  it('allows local fallback on legacy', () => {
    expect(allowLocalSttFallback(resolveEnterpriseLiveProfile({})).allowed).toBe(true)
  })
})

describe('normalizeCloudSttTokens', () => {
  it('groups consecutive same-cluster finals and keeps interim separate', () => {
    const out = normalizeCloudSttTokens([
      { text: 'Hel', startMs: 0, endMs: 100, isFinal: false },
      { text: 'Hello ', startMs: 0, endMs: 400, isFinal: true, cluster: '1', language: 'en' },
      { text: 'world', startMs: 400, endMs: 800, isFinal: true, cluster: '1', language: 'en' },
      { text: 'Hi', startMs: 900, endMs: 1100, isFinal: true, cluster: '2', language: 'en' }
    ])
    expect(out.interimText).toBe('Hel')
    expect(out.finals).toHaveLength(2)
    expect(out.finals[0]).toMatchObject({ text: 'Hello world', cluster: '1' })
    expect(out.finals[1]).toMatchObject({ text: 'Hi', cluster: '2' })
    expect(out.finals[0].id).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('normalizeSonioxMessage', () => {
  const scope = { tenantId: 't', meetingId: 'm', captureId: 'c', epoch: 'e1' }

  it('preserves multiple speakers in one message', () => {
    const out = normalizeSonioxMessage(
      {
        tokens: [
          { text: 'Hello.', start_ms: 0, end_ms: 100, is_final: true, speaker: '1' },
          { text: ' Bonjour.', start_ms: 101, end_ms: 200, is_final: true, speaker: '2' },
          { text: ' Not final', is_final: false }
        ]
      },
      { scope, messageSequence: 1 }
    )
    expect(out.finals).toHaveLength(2)
    expect(out.finals[1].cluster).toBe('2')
    expect(out.interimText).toBe(' Not final')
  })

  it('skips translation tokens rather than inventing timestamps', () => {
    const out = normalizeSonioxMessage(
      { tokens: [{ text: 'Hello', translation_status: 'translation', is_final: true }] },
      { scope, messageSequence: 1 }
    )
    expect(out.finals).toHaveLength(0)
  })

  it('fails when final tokens lack source timestamps', () => {
    expect(() =>
      normalizeSonioxMessage(
        { tokens: [{ text: 'Hello', is_final: true, speaker: '1' }] },
        { scope, messageSequence: 1 }
      )
    ).toThrow(CloudSttError)
  })

  it('surfaces upstream errors without rethrowing provider content', () => {
    expect(() =>
      normalizeSonioxMessage(
        { error_code: 503, error_message: 'SECRET OR CONTENT', tokens: [] },
        { scope, messageSequence: 1 }
      )
    ).toThrow(/STT_UPSTREAM_ERROR/)
  })

  it('applies streamOffsetMs on the meeting audio clock', () => {
    const out = normalizeSonioxMessage(
      { tokens: [{ text: 'Olà', is_final: true, speaker: '1', start_ms: 10, end_ms: 20 }] },
      { scope, messageSequence: 1, streamOffsetMs: 1000 }
    )
    expect(out.finals[0].startMs).toBe(1010)
  })
})

describe('normalizeNova3ResultsMessage', () => {
  const scope = { tenantId: 't', meetingId: 'm', captureId: 'c', epoch: 'e1' }

  it('maps Deepgram Results words with speaker clusters to finals', () => {
    const out = normalizeNova3ResultsMessage(
      {
        type: 'Results',
        is_final: true,
        channel: {
          alternatives: [
            {
              transcript: 'Hello world',
              words: [
                { word: 'Hello', start: 0.0, end: 0.4, speaker: 0 },
                { word: 'world', start: 0.4, end: 0.8, speaker: 0 }
              ]
            }
          ]
        }
      },
      { scope, messageSequence: 1 }
    )
    expect(out.finals).toHaveLength(1)
    expect(out.finals[0]).toMatchObject({ text: 'Hello world', cluster: '0' })
    expect(out.finals[0].startMs).toBe(0)
    expect(out.finals[0].endMs).toBe(800)
  })

  it('keeps interim Results as interimText only', () => {
    const out = normalizeNova3ResultsMessage(
      {
        type: 'Results',
        is_final: false,
        channel: {
          alternatives: [
            {
              transcript: 'Hel',
              words: [{ word: 'Hel', start: 0, end: 0.2, speaker: 0 }]
            }
          ]
        }
      },
      { scope, messageSequence: 2 }
    )
    expect(out.finals).toHaveLength(0)
    expect(out.interimText).toBe('Hel')
  })

  it('ignores non-Results control messages', () => {
    const out = normalizeNova3ResultsMessage(
      { type: 'SpeechStarted' },
      { scope, messageSequence: 3 }
    )
    expect(out).toEqual({ finals: [], interimText: '', finished: false })
  })

  it('splits consecutive words from different speakers', () => {
    const out = normalizeNova3ResultsMessage(
      {
        type: 'Results',
        is_final: true,
        channel: {
          alternatives: [
            {
              words: [
                { punctuated_word: 'Hi,', start: 0, end: 0.2, speaker: 0 },
                { punctuated_word: 'there.', start: 0.3, end: 0.6, speaker: 1 }
              ]
            }
          ]
        }
      },
      { scope, messageSequence: 4 }
    )
    expect(out.finals).toHaveLength(2)
    expect(out.finals[0].cluster).toBe('0')
    expect(out.finals[1].cluster).toBe('1')
  })
})

describe('buildNova3GatewayWsUrl', () => {
  it('returns null when account or gateway missing', () => {
    expect(buildNova3GatewayWsUrl({})).toBeNull()
    expect(buildNova3GatewayWsUrl({ accountId: 'a' })).toBeNull()
  })

  it('builds AI Gateway workers-ai WS URL with Nova-3 model', () => {
    const url = buildNova3GatewayWsUrl({ accountId: 'acc', gatewayId: 'gw' })
    expect(url).toContain('wss://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai?')
    expect(url).toContain(`model=${encodeURIComponent(CLOUDFLARE_NOVA3_MODEL)}`)
    expect(url).toContain('encoding=linear16')
    expect(url).toContain('sample_rate=16000')
    expect(url).toContain('diarize=true')
  })
})
