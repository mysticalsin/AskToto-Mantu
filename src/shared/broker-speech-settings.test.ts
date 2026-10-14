import { describe, expect, it } from 'vitest'
import {
  BrokerSpeechSettingsSchema,
  CloudSpeechSettingsSchema,
  BROKER_SPEECH_SETTINGS_REFUSAL,
  DEFAULT_BROKER_SPEECH_SETTINGS,
  DEFAULT_CLOUD_SPEECH_SETTINGS,
  BrokerSpeechSettingsLoadSchema,
  BrokerSpeechSettingsWriteSchema,
  parseBrokerSpeechSettings
} from './broker-speech-settings'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from './ipc'

describe('broker speech settings', () => {
  it('defaults an omitted profile to the old transport and keeps old cloud defaults', () => {
    expect(parseBrokerSpeechSettings(undefined)).toEqual({ ok: true, value: DEFAULT_BROKER_SPEECH_SETTINGS })
    expect(CloudSpeechSettingsSchema.parse({})).toEqual(DEFAULT_CLOUD_SPEECH_SETTINGS)
    expect(DEFAULT_CLOUD_SPEECH_SETTINGS.enterpriseLive).toEqual({
      managed: false,
      inferenceMode: 'legacy',
      summaryOnly: false
    })
    expect(DEFAULT_CLOUD_SPEECH_SETTINGS.cloudSttProvider).toBe('unconfigured')
  })

  it('accepts only the exact transport and engine values', () => {
    expect(BrokerSpeechSettingsSchema.parse({ transport: 'broker-v1', engine: 'deepgram-nova3' })).toEqual({
      transport: 'broker-v1',
      engine: 'deepgram-nova3'
    })
    expect(BrokerSpeechSettingsSchema.parse({ transport: 'broker-v1', engine: 'cloudflare-nova3' })).toEqual({
      transport: 'broker-v1',
      engine: 'cloudflare-nova3'
    })
    expect(BrokerSpeechSettingsSchema.parse({ transport: 'legacy', engine: 'unconfigured' })).toEqual(
      DEFAULT_BROKER_SPEECH_SETTINGS
    )
    expect(BrokerSpeechSettingsWriteSchema.safeParse(BROKER_SPEECH_SETTINGS_REFUSAL).success).toBe(false)
  })

  it('refuses malformed explicit values rather than replacing them with the legacy default', () => {
    for (const value of [
      null,
      [],
      'broker-v1',
      { transport: 'broker-v1' },
      { transport: 'broker-v1', engine: 'soniox' },
      { transport: 'legacy', engine: 'unconfigured', extra: true }
    ]) {
      expect(parseBrokerSpeechSettings(value)).toEqual({ ok: false, code: 'INVALID_PROFILE' })
    }
  })

  it('reduces malformed explicit settings to one fixed refusal through aggregate settings schemas', () => {
    const malformed = { transport: 'broker-v1', engine: 'soniox', privateValue: 'discard-me' }
    const parsed = CloudSpeechSettingsSchema.parse({ brokerSpeech: malformed })
    expect(parsed.brokerSpeech).toEqual(BROKER_SPEECH_SETTINGS_REFUSAL)
    expect(parseBrokerSpeechSettings(parsed.brokerSpeech)).toEqual({ ok: false, code: 'INVALID_PROFILE' })
    const aggregate = BaseSettingsSchema.parse({ ...DEFAULT_SETTINGS, brokerSpeech: malformed })
    expect(aggregate.brokerSpeech).toEqual(BROKER_SPEECH_SETTINGS_REFUSAL)
    expect(JSON.stringify(aggregate.brokerSpeech)).not.toContain('discard-me')
    expect(
      BrokerSpeechSettingsLoadSchema.parse({ transport: 'broker-v1', engine: 'unknown', secret: 'discard-me' })
    ).toEqual(BROKER_SPEECH_SETTINGS_REFUSAL)
  })
})
