import { describe, expect, it } from 'vitest'
import {
  BrokerSpeechSettingsSchema,
  CloudSpeechSettingsSchema,
  DEFAULT_BROKER_SPEECH_SETTINGS,
  DEFAULT_CLOUD_SPEECH_SETTINGS,
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

  it('preserves malformed explicit settings through the aggregate settings schema for a fail-closed reader', () => {
    const malformed = { transport: 'broker-v1', engine: 'soniox' }
    const parsed = CloudSpeechSettingsSchema.parse({ brokerSpeech: malformed })
    expect(parsed.brokerSpeech).toEqual(malformed)
    expect(parseBrokerSpeechSettings(parsed.brokerSpeech)).toEqual({ ok: false, code: 'INVALID_PROFILE' })
    const aggregate = BaseSettingsSchema.parse({ ...DEFAULT_SETTINGS, brokerSpeech: malformed })
    expect(aggregate.brokerSpeech).toEqual(malformed)
  })
})
