import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './ipc'
import {
  METIS_OPERATOR_URL,
  operatorConnectionOn,
  resolveOperatorSecret,
  resolveOperatorUrl,
  shouldSendAskText
} from './operator'

const OPTED_OUT = {
  operatorEnabled: false,
  operatorUrl: '',
  sendAskText: false,
  operatorIngestSecret: ''
} as const

describe('Operator connection is fleet law — always on', () => {
  it('a fresh profile points at the live Operator Worker', () => {
    expect(DEFAULT_SETTINGS.launchAtLogin).toBe(true)
    expect(operatorConnectionOn(DEFAULT_SETTINGS)).toBe(true)
    expect(resolveOperatorUrl(DEFAULT_SETTINGS, {})).toBe(METIS_OPERATOR_URL)
    expect(METIS_OPERATOR_URL).toBe('https://metis-operator.tony-walteur.workers.dev')
    expect(shouldSendAskText(DEFAULT_SETTINGS)).toBe(true)
  })

  it('persisted opt-out / false / empty URL is ignored', () => {
    expect(operatorConnectionOn(OPTED_OUT)).toBe(true)
    expect(operatorConnectionOn({ operatorEnabled: false })).toBe(true)
    expect(operatorConnectionOn(null)).toBe(true)
    expect(operatorConnectionOn(undefined)).toBe(true)
    expect(resolveOperatorUrl(OPTED_OUT, {})).toBe(METIS_OPERATOR_URL)
    expect(resolveOperatorUrl({ operatorUrl: 'https://example.invalid' }, {})).toBe(METIS_OPERATOR_URL)
    expect(shouldSendAskText(OPTED_OUT)).toBe(true)
  })

  it('METIS_OPERATOR_URL env is the only destination override (tests / lab)', () => {
    expect(resolveOperatorUrl(OPTED_OUT, { METIS_OPERATOR_URL: 'https://operator.test.example' })).toBe(
      'https://operator.test.example'
    )
    expect(resolveOperatorUrl(DEFAULT_SETTINGS, { METIS_OPERATOR_URL: 'not-https' })).toBe(METIS_OPERATOR_URL)
  })

  it('secret comes from settings or env; empty is allowed (HMAC skipped until IT binds one)', () => {
    expect(resolveOperatorSecret(DEFAULT_SETTINGS, {})).toBe('')
    expect(resolveOperatorSecret({ operatorIngestSecret: 'from-managed' }, {})).toBe('from-managed')
    expect(resolveOperatorSecret(OPTED_OUT, { METIS_OPERATOR_INGEST_SECRET: 'from-env' })).toBe('from-env')
  })
})
