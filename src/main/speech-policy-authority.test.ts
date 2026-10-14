import { describe, expect, it } from 'vitest'
import { emptyModelPolicyEntry, MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from '@shared/model-policy'
import {
  normalizeSpeechPolicyOrigin,
  resolveSpeechPolicyIdentity,
  SpeechPolicyAuthority
} from './speech-policy-authority'

const NOW = 1_900_000_000_000

function license(jti = '0123456789abcdef', issuedAt = Math.floor(NOW / 1000) - 60): string {
  return `METIS-OP-1.${jti}.${issuedAt}.${Math.floor(NOW / 1000) + 3600}.AAAAAAAAAAAAAAAAAAAA`
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
})

describe('speech policy scope high-water authority', () => {
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
    expect(authority.acceptUnmanaged(currentIdentity, NOW + 1, 'unmanaged-1')).toBe('unmanaged')
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

    expect(authority.acceptUnmanaged(currentIdentity, NOW + 1, 'unmanaged-1')).toBe('lower-version')
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
