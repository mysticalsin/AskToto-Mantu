import { describe, expect, it } from 'vitest'
import { DEFAULT_OPERATOR_URL, resolveOperatorCredential } from './operator'

describe('MQA-295 Operator credentials stay with their verified endpoint', () => {
  const env = { METIS_OPERATOR_INGEST_SECRET: 'synthetic-environment-credential' }
  it('uses the saved individual licence before legacy credentials', () => {
    expect(resolveOperatorCredential({ operatorLicenseToken: ' licence ', operatorIngestSecret: 'legacy' }, env)).toBe('licence')
  })
  it('does not send an environment credential to a renderer URL override', () => {
    expect(resolveOperatorCredential({ operatorUrl: 'https://different-service.test' }, env)).toBe('')
    expect(resolveOperatorCredential({ operatorUrl: 'https://different-service.test' }, { ...env, METIS_OPERATOR_URL: DEFAULT_OPERATOR_URL })).toBe('')
  })
  it('preserves environment-managed deployments at their configured endpoint', () => {
    expect(resolveOperatorCredential({}, env)).toBe(env.METIS_OPERATOR_INGEST_SECRET)
    expect(resolveOperatorCredential({ operatorUrl: 'https://managed.test' }, { ...env, METIS_OPERATOR_URL: 'https://managed.test' })).toBe(env.METIS_OPERATOR_INGEST_SECRET)
  })
})
