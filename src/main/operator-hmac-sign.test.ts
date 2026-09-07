import { describe, expect, it } from 'vitest'
import { ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_HMAC_SKEW_MS } from '@shared/operator-hmac'
import { generateOperatorLicense } from '@shared/operator-license'
import { hashOperatorId, operatorHmacHeaders, seatKeyFromLicense, sha256HexUtf8, signOperatorIngest } from './operator-hmac-sign'

describe('operator HMAC signer', () => {
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

describe('signing as a license instead of the shared secret', () => {
  const mint = async (): Promise<string> =>
    (await generateOperatorLicense('worker-ingest-secret', { days: 30, now: 1_725_000_000_000 })).token

  it('names the license and signs with its derived key, not the secret', async () => {
    const token = await mint()
    const headers = operatorHmacHeaders('the-shared-secret', 'dev', '{}', 100, token)
    expect(headers[OPERATOR_HMAC_HEADERS.license]).toMatch(/^[a-f0-9]{16}$/)
    expect(headers[OPERATOR_HMAC_HEADERS.sig]).toBe(
      signOperatorIngest(seatKeyFromLicense(token), '100', headers[OPERATOR_HMAC_HEADERS.nonce], 'dev', '{}')
    )
    // The shared secret is not what signed it, so a seat holding only a license is still authentic.
    expect(headers[OPERATOR_HMAC_HEADERS.sig]).not.toBe(
      signOperatorIngest('the-shared-secret', '100', headers[OPERATOR_HMAC_HEADERS.nonce], 'dev', '{}')
    )
  })

  it('the token itself never leaves the machine, only its jti', async () => {
    const token = await mint()
    const headers = operatorHmacHeaders('', 'dev', '{}', 100, token)
    expect(JSON.stringify(headers)).not.toContain(token)
    expect(seatKeyFromLicense(token)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('falls back to the shared secret when there is no license', async () => {
    const headers = operatorHmacHeaders('the-shared-secret', 'dev', '{}', 100)
    expect(headers[OPERATOR_HMAC_HEADERS.license]).toBeUndefined()
    expect(headers[OPERATOR_HMAC_HEADERS.sig]).toBe(
      signOperatorIngest('the-shared-secret', '100', headers[OPERATOR_HMAC_HEADERS.nonce], 'dev', '{}')
    )
  })

  it('ignores a malformed token rather than signing with a key the Worker cannot reproduce', () => {
    const headers = operatorHmacHeaders('the-shared-secret', 'dev', '{}', 100, 'not-a-license')
    expect(headers[OPERATOR_HMAC_HEADERS.license]).toBeUndefined()
    expect(headers[OPERATOR_HMAC_HEADERS.sig]).toBe(
      signOperatorIngest('the-shared-secret', '100', headers[OPERATOR_HMAC_HEADERS.nonce], 'dev', '{}')
    )
  })

  it('two licenses derive different keys, so one seat cannot sign as another', async () => {
    expect(seatKeyFromLicense(await mint())).not.toBe(seatKeyFromLicense(await mint()))
  })
})
