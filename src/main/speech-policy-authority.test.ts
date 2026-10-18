import { describe, expect, it } from 'vitest'
import { emptyModelPolicyEntry, MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from '@shared/model-policy'
import { generateOperatorLicense } from '@shared/operator-license'
import {
  normalizeSpeechPolicyOrigin,
  resolveSpeechPolicyIdentity,
  speechPolicyIsConfigured,
  SpeechPolicyAuthority
} from './speech-policy-authority'

const NOW = 1_900_000_000_000

function license(
  jti = '0123456789abcdef',
  issuedAt = Math.floor(NOW / 1000) - 60,
  expiresAt = Math.floor(NOW / 1000) + 3600
): string {
  return `METIS-OP-1.${jti}.${issuedAt}.${expiresAt}.AAAAAAAAAAAAAAAAAAAA`
}

function policy(version = NOW): ModelPolicyDocument {
  const capabilities = Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((key) => [key, emptyModelPolicyEntry('anthropic', 'claude-sonnet-4-6')])
  ) as ModelPolicyDocument['capabilities']
  return { version, updatedAt: version, updatedBy: 'fixture', localSpeechPack: 'offered', capabilities }
}

function identity(jti = '0123456789abcdef', deviceId = 'device-01') {
  return resolveSpeechPolicyIdentity(
    { operatorUrl: 'https://operator.test', operatorLicenseToken: license(jti) },
    deviceId,
    NOW
  )!
}

describe('strict speech policy identity', () => {
  it('normalizes only an HTTPS origin with no userinfo, path, query or fragment', () => {
    expect(normalizeSpeechPolicyOrigin('https://operator.test')).toBe('https://operator.test')
    expect(normalizeSpeechPolicyOrigin('https://operator.test/')).toBe('https://operator.test')
    for (const raw of [
      'http://operator.test',
      'https://user@operator.test',
      'https://@operator.test',
      'https://operator.test/v1',
      'https://operator.test?',
      'https://operator.test/#'
    ]) {
      expect(normalizeSpeechPolicyOrigin(raw)).toBeNull()
    }
  })

  it('requires a direct, well-formed live seat licence and durable device identity', () => {
    const settings = { operatorUrl: 'https://operator.test', operatorLicenseToken: license() }
    expect(resolveSpeechPolicyIdentity(settings, 'durable-device', NOW)).not.toBeNull()
    expect(
      resolveSpeechPolicyIdentity({ ...settings, operatorUrl: 'https://operator.test/path' }, 'durable', NOW)
    ).toBeNull()
    expect(
      resolveSpeechPolicyIdentity(
        { operatorUrl: settings.operatorUrl, operatorIngestSecret: 'fleet-secret' },
        'durable',
        NOW
      )
    ).toBeNull()
    expect(resolveSpeechPolicyIdentity(settings, null, NOW)).toBeNull()
    expect(resolveSpeechPolicyIdentity(settings, 'durable', NOW + 3_601_000)).toBeNull()
    expect(
      resolveSpeechPolicyIdentity(
        { ...settings, operatorLicenseToken: license('1123456789abcdef', Math.floor(NOW / 1000) + 1) },
        'durable',
        NOW
      )
    ).toBeNull()
    expect(
      resolveSpeechPolicyIdentity({ ...settings, operatorLicenseToken: license('2123456789abcdef', 1) }, 'durable', NOW)
    ).toBeNull()
  })

  it.each([0, 364])('accepts an issuer-generated 365-day licence issued %i days ago while it remains live', async (ageDays) => {
    const minted = await generateOperatorLicense('synthetic-speech-policy-issuer-secret', {
      days: 365,
      now: NOW - ageDays * 24 * 60 * 60 * 1000,
      jti: '3123456789abcdef'
    })
    expect(resolveSpeechPolicyIdentity({
      operatorUrl: 'https://operator.test', operatorLicenseToken: minted.token
    }, 'durable-device', NOW)).not.toBeNull()
  })

  it('refuses a live licence whose issued lifetime exceeds the issuer maximum by one second', () => {
    const issuedAt = Math.floor(NOW / 1000)
    expect(resolveSpeechPolicyIdentity({
      operatorUrl: 'https://operator.test',
      operatorLicenseToken: license('4123456789abcdef', issuedAt, issuedAt + 365 * 24 * 60 * 60 + 1)
    }, 'durable-device', NOW)).toBeNull()
  })
})

describe('speech policy scope high-water authority', () => {
  it.each([
    { version: NOW, result: 'conflict', event: { kind: 'revoked', reason: 'policy-conflict' } },
    { version: NOW + 1, result: 'accepted', event: { kind: 'changed', reason: 'policy-changed' } }
  ])('retires a live unmanaged proof on managed $result before another authority read', ({ version, result, event }) => {
    const authority = new SpeechPolicyAuthority()
    const currentIdentity = identity()
    const events: unknown[] = []
    authority.setProofListener((notification) => events.push(notification))
    authority.observeIdentity(currentIdentity)
    expect(authority.acceptUnmanaged(currentIdentity, NOW, 'unmanaged-1', NOW, 100)).toBe('unmanaged')
    const pending = authority.capture(currentIdentity)

    expect(authority.acceptUnmanaged(currentIdentity, NOW, 'unmanaged-1', NOW + 1, 101)).toBe('unmanaged')
    expect(authority.acceptManaged(currentIdentity, policy(NOW - 1), NOW + 2, 'lower')).toBe('lower-version')
    expect(events).toEqual([])
    expect(authority.isCurrent(pending, currentIdentity)).toBe(true)
    expect(authority.authorityStatus(currentIdentity, NOW + 2, 102).status).toBe('unmanaged')

    expect(authority.acceptManaged(currentIdentity, policy(version), NOW + 3, 'managed-1')).toBe(result)
    expect(events).toEqual([event])
    expect(authority.isCurrent(pending, currentIdentity)).toBe(false)
    expect(authority.authorityStatus(currentIdentity, NOW + 3, 103).status).toBe(
      result === 'accepted' ? 'managed' : 'unverified'
    )

    expect(authority.acceptManaged(currentIdentity, policy(version), NOW + 4, 'managed-1')).toBe(result)
    expect(events).toEqual([event])
    if (result === 'conflict') {
      expect(authority.acceptManaged(currentIdentity, policy(NOW - 1), NOW + 5, 'lower')).toBe('lower-version')
      expect(authority.acceptManaged(currentIdentity, policy(NOW + 1), NOW + 6, 'recovery')).toBe('accepted')
      expect(events).toEqual([event])
      expect(authority.authorityStatus(currentIdentity, NOW + 6, 106).status).toBe('managed')
    }
  })

  it.each([false, true])('does not notify for an inactive or ABA-retired unmanaged proof (ABA=%s)', (returnToScope) => {
    const authority = new SpeechPolicyAuthority()
    const first = identity()
    const events: unknown[] = []
    authority.setProofListener((event) => events.push(event))
    authority.observeIdentity(first)
    expect(authority.acceptUnmanaged(first, NOW, 'unmanaged-1', NOW, 100)).toBe('unmanaged')
    authority.observeIdentity(identity('1123456789abcdef', 'device-02'))
    if (returnToScope) authority.observeIdentity(first)

    expect(authority.acceptManaged(first, policy(NOW + 1), NOW + 1, 'managed-1')).toBe('accepted')
    expect(events).toEqual([])
  })

  it('requires a verified signed-unmanaged receipt and advances identity across scope ABA', () => {
    const authority = new SpeechPolicyAuthority()
    const first = identity()
    const firstStatus = authority.authorityStatus(first, NOW)
    expect(firstStatus.status).toBe('unverified')

    authority.observeIdentity(identity('1123456789abcdef', 'device-02'))
    const returnedStatus = authority.authorityStatus(first, NOW)
    expect(returnedStatus.status).toBe('unverified')
    expect(returnedStatus.identity).not.toBe(firstStatus.identity)

    authority.observeIdentity(first)
    expect(authority.acceptUnmanaged(first, NOW, 'signed-unmanaged-revision', NOW, 100)).toBe('unmanaged')
    expect(authority.authorityStatus(first, NOW, 100)).toMatchObject({
      status: 'unmanaged',
      identity: expect.stringContaining('signed-unmanaged-revision')
    })
  })

  it('requires a fresh epoch-bound unmanaged proof while retaining its high-water replay tombstone', () => {
    const authority = new SpeechPolicyAuthority()
    const currentIdentity = identity()
    authority.observeIdentity(currentIdentity)
    expect(authority.acceptUnmanaged(currentIdentity, NOW, 'unmanaged-1', NOW, 100)).toBe('unmanaged')
    const initial = authority.authorityStatus(currentIdentity, NOW + 60_000, 60_100)
    expect(initial.status).toBe('unmanaged')
    expect(authority.authorityStatus(currentIdentity, NOW + 60_001, 60_101).status).toBe('unverified')

    expect(authority.acceptUnmanaged(currentIdentity, NOW, 'unmanaged-1', NOW + 60_001, 60_101)).toBe('unmanaged')
    const renewed = authority.authorityStatus(currentIdentity, NOW + 60_002, 60_102)
    expect(renewed.status).toBe('unmanaged')
    expect(renewed.identity).not.toBe(initial.identity)
    authority.invalidateAll()
    expect(authority.authorityStatus(currentIdentity, NOW + 60_002, 60_102).status).toBe('unverified')
    expect(authority.acceptUnmanaged(currentIdentity, NOW - 1, 'stale-unmanaged', NOW + 60_003, 60_103)).toBe(
      'lower-version'
    )
    expect(authority.authorityStatus(currentIdentity, NOW + 60_003, 60_103).status).toBe('unverified')
  })

  it('invalidates an unmanaged grant after identity-scope ABA', () => {
    const authority = new SpeechPolicyAuthority()
    const first = identity()
    const second = identity('1123456789abcdef', 'device-02')
    authority.observeIdentity(first)
    expect(authority.acceptUnmanaged(first, NOW, 'unmanaged-1', NOW, 100)).toBe('unmanaged')
    authority.observeIdentity(second)
    authority.observeIdentity(first)
    expect(authority.authorityStatus(first, NOW, 100).status).toBe('unverified')
  })

  it('treats an operator URL or credential as configured even before verified proof exists', () => {
    expect(speechPolicyIsConfigured({ operatorUrl: 'https://operator.test' })).toBe(true)
    expect(speechPolicyIsConfigured({ operatorIngestSecret: 'configured' })).toBe(true)
    expect(speechPolicyIsConfigured({})).toBe(false)
  })

  it('does not renew freshness from lower versions or accept conflicting same-version content', () => {
    const authority = new SpeechPolicyAuthority()
    const currentIdentity = identity()
    const currentPolicy = policy()
    authority.observeIdentity(currentIdentity)
    expect(authority.acceptManaged(currentIdentity, currentPolicy, NOW, 'revision-1')).toBe('accepted')
    expect(authority.acceptManaged(currentIdentity, currentPolicy, NOW + 10, 'revision-1')).toBe('accepted')
    expect(authority.get(currentIdentity, NOW + 10)?.verifiedAt).toBe(NOW + 10)

    expect(authority.acceptManaged(currentIdentity, policy(NOW - 1), NOW + 20, 'revision-old')).toBe('lower-version')
    expect(authority.get(currentIdentity, NOW + 20)?.policy.version).toBe(NOW)

    expect(authority.acceptManaged(currentIdentity, currentPolicy, NOW + 30, 'revision-conflict')).toBe('conflict')
    expect(authority.get(currentIdentity, NOW + 30)).toBeNull()
    expect(authority.acceptManaged(currentIdentity, policy(NOW - 1), NOW + 40, 'revision-old')).toBe('lower-version')
    expect(authority.get(currentIdentity, NOW + 40)).toBeNull()
  })

  it('treats signed unmanaged policy as a versioned tombstone for that identity', () => {
    const authority = new SpeechPolicyAuthority()
    const currentIdentity = identity()
    authority.observeIdentity(currentIdentity)
    expect(authority.acceptManaged(currentIdentity, policy(), NOW, 'managed-1')).toBe('accepted')
    expect(authority.acceptUnmanaged(currentIdentity, NOW + 1, 'unmanaged-1', NOW + 1, 101)).toBe('unmanaged')
    expect(authority.get(currentIdentity, NOW + 1)).toBeNull()
    expect(authority.acceptManaged(currentIdentity, policy(NOW), NOW + 2, 'managed-1')).toBe('lower-version')
    expect(authority.acceptManaged(currentIdentity, policy(NOW + 2), NOW + 3, 'managed-2')).toBe('accepted')
    expect(authority.get(currentIdentity, NOW + 3)?.policy.version).toBe(NOW + 2)
  })

  it('clears usable authority on a signed lower-version unmanaged response without lowering the high-water mark', () => {
    const authority = new SpeechPolicyAuthority()
    const currentIdentity = identity()
    authority.observeIdentity(currentIdentity)
    expect(authority.acceptManaged(currentIdentity, policy(NOW + 2), NOW, 'managed-2')).toBe('accepted')

    expect(authority.acceptUnmanaged(currentIdentity, NOW + 1, 'unmanaged-1', NOW + 1, 101)).toBe('lower-version')
    expect(authority.get(currentIdentity, NOW + 1)).toBeNull()
    expect(authority.acceptManaged(currentIdentity, policy(NOW + 1), NOW + 2, 'managed-1')).toBe('lower-version')
    expect(authority.acceptManaged(currentIdentity, policy(NOW + 3), NOW + 3, 'managed-3')).toBe('accepted')
  })

  it('invalidates in-flight captures when a different live identity is observed', () => {
    const authority = new SpeechPolicyAuthority()
    const first = identity()
    const second = identity('1123456789abcdef', 'device-02')
    const captured = authority.capture(first)
    expect(captured).not.toBeNull()
    authority.observeIdentity(second)
    expect(authority.isCurrent(captured, first)).toBe(false)
  })

  it('hard-invalidates verified proofs, advances pending captures, and preserves scoped high-water', () => {
    const authority = new SpeechPolicyAuthority()
    const currentIdentity = identity()
    expect(authority.acceptManaged(currentIdentity, policy(), NOW, 'revision-1')).toBe('accepted')
    const pending = authority.capture(currentIdentity)
    expect(authority.get(currentIdentity, NOW)).not.toBeNull()

    authority.invalidateAll()

    expect(authority.isCurrent(pending, currentIdentity)).toBe(false)
    expect(authority.get(currentIdentity, NOW)).toBeNull()
    expect(authority.acceptManaged(currentIdentity, policy(NOW - 1), NOW + 1, 'revision-old')).toBe('lower-version')
    expect(authority.get(currentIdentity, NOW + 1)).toBeNull()
    expect(authority.acceptManaged(currentIdentity, policy(), NOW + 2, 'revision-1')).toBe('accepted')
  })

  it('refuses new scopes when the bounded high-water table is full instead of evicting prior versions', () => {
    const authority = new SpeechPolicyAuthority()
    for (let index = 0; index < 32; index++) {
      const currentIdentity = identity(index.toString(16).padStart(16, '0'), `device-${index}`)
      expect(authority.acceptManaged(currentIdentity, policy(), NOW, `revision-${index}`)).toBe('accepted')
    }
    const overflowIdentity = identity('ffffffffffffffff', 'overflow-device')
    expect(authority.acceptManaged(overflowIdentity, policy(), NOW, 'overflow')).toBe('capacity')
    expect(authority.get(identity('0000000000000000', 'device-0'), NOW)?.policy.version).toBe(NOW)
  })
})
