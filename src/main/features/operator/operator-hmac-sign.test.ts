import { describe, expect, it } from 'vitest'
import { ingestCanonical, OPERATOR_HMAC_SKEW_MS } from '@shared/operator-hmac'
import { hashOperatorId, operatorHmacHeaders, sha256HexUtf8, signOperatorIngest } from './operator-hmac-sign'

describe('operator HMAC signer', () => {
  it('authenticates a licensed seat without exposing the shared server secret', () => {
    const token = 'METIS-OP-1.abcdef0123456789.100.200.abcdefghijklmnopqrstuv'
    const headers = operatorHmacHeaders(token, 'device-test-0001', '{}', 150_000)
    expect(headers['x-metis-license']).toBe(token)
    expect(headers['x-metis-sig']).toBe(signOperatorIngest(token, '150000', headers['x-metis-nonce'], 'device-test-0001', '{}'))
    expect(operatorHmacHeaders('legacy-server-secret', 'device-test-0001', '{}')['x-metis-license']).toBeUndefined()
  })
  it('matches the Worker canonical string', () => {
    const body = '{"id":"a"}'
    const hash = sha256HexUtf8(body)
    const canon = ingestCanonical('100', 'n1', 'dev', hash)
    expect(canon).toBe(`100.n1.dev.${hash}`)
    const sig = signOperatorIngest('secret', '100', 'n1', 'dev', body)
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    expect(signOperatorIngest('other', '100', 'n1', 'dev', body)).not.toBe(sig)
  })

  it('hashes seat and device ids (never the raw license key)', () => {
    const h = hashOperatorId('license-key-plain')
    expect(h).toHaveLength(32)
    expect(h).not.toContain('license-key-plain')
    expect(OPERATOR_HMAC_SKEW_MS).toBe(5 * 60 * 1000)
  })
})
