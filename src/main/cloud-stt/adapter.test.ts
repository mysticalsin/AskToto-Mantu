import { describe, expect, it } from 'vitest'
import {
  allowLocalSttFallback,
  buildNova3GatewayWsUrl,
  buildSonioxStartConfig,
  CLOUDFLARE_NOVA3_MODEL,
  normalizeCloudSttTokens,
  normalizeNova3ResultsMessage,
  normalizeSonioxMessage,
  planCloudSttSession,
  resolveNova3LanguageQuery,
  resolveSonioxLanguageConfig,
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
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.provider).toBe('cloudflare-nova3')
      expect(r.cloudOnly).toBe(true)
      expect(r.modelId).toBe(CLOUDFLARE_NOVA3_MODEL)
      expect(r.asrLanguage).toBe('auto')
      expect(r.novaLanguage).toEqual({ language: 'multi', detect_language: true })
      expect(r.sonioxLanguage.language_hints).toEqual(['fr', 'en', 'es', 'pt', 'it'])
    }
  })

  it('accepts Soniox under CLOUD_ONLY without inventing a CF model id', () => {
    const r = planCloudSttSession({ provider: 'soniox', profile: cloudOnly, asrLanguage: 'French' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r).toMatchObject({
        ok: true,
        provider: 'soniox',
        cloudOnly: true,
        asrLanguage: 'French',
        novaLanguage: { language: 'fr-CA', detect_language: false },
        sonioxLanguage: { language_hints: ['fr'], autoDetect: false }
      })
      expect(r.modelId).toBeUndefined()
    }
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

  it('keeps the final transcript text when words[] is empty (F-L04-1)', () => {
    const out = normalizeNova3ResultsMessage(
      {
        type: 'Results',
        is_final: true,
        channel: {
          alternatives: [
            {
              transcript: 'Hello world',
              words: []
            }
          ]
        }
      },
      { scope, messageSequence: 5 }
    )
    expect(out.finals).toHaveLength(1)
    expect(out.finals[0]).toMatchObject({
      text: 'Hello world',
      cluster: 'unknown',
      isFinal: true
    })
    expect(out.interimText).toBe('')
  })

  it('drops a final Results message with empty words and blank transcript (unchanged)', () => {
    const out = normalizeNova3ResultsMessage(
      {
        type: 'Results',
        is_final: true,
        channel: {
          alternatives: [{ transcript: '   ', words: [] }]
        }
      },
      { scope, messageSequence: 6 }
    )
    expect(out).toEqual({ finals: [], interimText: '', finished: false })
  })
})

describe('resolveNova3LanguageQuery / resolveSonioxLanguageConfig', () => {
  it('auto → multi + detect_language (never English-only hardcode)', () => {
    expect(resolveNova3LanguageQuery('auto')).toEqual({ language: 'multi', detect_language: true })
    expect(resolveNova3LanguageQuery(undefined)).toEqual({ language: 'multi', detect_language: true })
    expect(resolveNova3LanguageQuery('')).toEqual({ language: 'multi', detect_language: true })
    const s = resolveSonioxLanguageConfig('auto')
    expect(s.autoDetect).toBe(true)
    expect(s.language_hints).toEqual(['fr', 'en', 'es', 'pt', 'it'])
    expect(s.language_hints).not.toEqual(['en'])
  })

  it('French / fr → fr-CA (Québec preference); explicit Settings win', () => {
    expect(resolveNova3LanguageQuery('French')).toEqual({ language: 'fr-CA', detect_language: false })
    expect(resolveNova3LanguageQuery('fr')).toEqual({ language: 'fr-CA', detect_language: false })
    expect(resolveNova3LanguageQuery('fr-CA')).toEqual({ language: 'fr-CA', detect_language: false })
    expect(resolveNova3LanguageQuery('fr-FR')).toEqual({ language: 'fr-FR', detect_language: false })
    expect(resolveSonioxLanguageConfig('French')).toEqual({ language_hints: ['fr'], autoDetect: false })
  })

  it('maps other Settings display names without inventing en', () => {
    expect(resolveNova3LanguageQuery('Spanish').language).toBe('es')
    expect(resolveNova3LanguageQuery('German').language).toBe('de')
  })
})

describe('buildNova3GatewayWsUrl', () => {
  it('returns null when account or gateway missing', () => {
    expect(buildNova3GatewayWsUrl({})).toBeNull()
    expect(buildNova3GatewayWsUrl({ accountId: 'a' })).toBeNull()
  })

  it('builds AI Gateway workers-ai WS URL with Nova-3 model + auto multilingual (not en)', () => {
    const url = buildNova3GatewayWsUrl({ accountId: 'acc', gatewayId: 'gw' })
    expect(url).toContain('wss://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai?')
    expect(url).toContain(`model=${encodeURIComponent(CLOUDFLARE_NOVA3_MODEL)}`)
    expect(url).toContain('encoding=linear16')
    expect(url).toContain('sample_rate=16000')
    expect(url).toContain('diarize=true')
    expect(url).toContain('language=multi')
    expect(url).toContain('detect_language=true')
    expect(url).not.toMatch(/language=en(?!-)/)
  })

  it('pins French Settings / fr-CA on the WS query (FR Listen wiring)', () => {
    const url = buildNova3GatewayWsUrl({
      accountId: 'acc',
      gatewayId: 'gw',
      asrLanguage: 'French'
    })
    expect(url).toContain('language=fr-CA')
    expect(url).toContain('detect_language=false')
    expect(url).not.toContain('language=en')
    expect(url).not.toContain('language=multi')
  })

  it('sticky pin on auto narrows Nova language (mid-meeting follow)', () => {
    const url = buildNova3GatewayWsUrl({
      accountId: 'acc',
      gatewayId: 'gw',
      asrLanguage: 'auto',
      pinnedLang: 'Spanish'
    })
    expect(url).toContain('language=es')
    expect(url).toContain('detect_language=false')
    expect(url).toContain('diarize=true')
  })

  it('accepts raw fr-CA and FR fixture language tag', () => {
    // scripts/qa/asr-fixtures fr clips use lang "fr" — bare fr normalizes to fr-CA.
    const url = buildNova3GatewayWsUrl({ accountId: 'acc', gatewayId: 'gw', asrLanguage: 'fr' })
    expect(url).toContain('language=fr-CA')
  })
})

describe('buildSonioxStartConfig', () => {
  it('auto → core multilingual hints + speaker diarization on', () => {
    const c = buildSonioxStartConfig({ asrLanguage: 'auto' })
    expect(c.language_hints).toEqual(['fr', 'en', 'es', 'pt', 'it'])
    expect(c.enable_speaker_diarization).toBe(true)
    expect(c.autoDetect).toBe(true)
  })

  it('sticky pin on auto narrows hints; explicit French ignores pin', () => {
    expect(buildSonioxStartConfig({ asrLanguage: 'auto', pinnedLang: 'Spanish' })).toEqual({
      language_hints: ['es'],
      enable_speaker_diarization: true,
      autoDetect: false
    })
    expect(buildSonioxStartConfig({ asrLanguage: 'French', pinnedLang: 'Spanish' }).language_hints).toEqual([
      'fr'
    ])
  })

  it('maps EN/ES/PT/IT explicit Settings', () => {
    for (const [name, code] of [
      ['English', 'en'],
      ['Spanish', 'es'],
      ['Portuguese', 'pt'],
      ['Italian', 'it']
    ] as const) {
      expect(buildSonioxStartConfig({ asrLanguage: name }).language_hints).toEqual([code])
    }
  })
})
