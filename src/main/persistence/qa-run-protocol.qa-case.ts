import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, inject, it } from 'vitest'
import { PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT } from './native-key-intent'
import {
  QA_HEARTBEAT_SCHEMA,
  QA_LAUNCH_ENVELOPE_SCHEMA,
  compiledQaPersistenceRunContext,
  newQaPersistenceBootChallenge,
  qaPersistenceCanonical,
  readVerifiedQaPersistenceLaunch,
  verifyQaPersistenceHeartbeat,
  verifyQaPersistenceLaunchEnvelope,
  type QaPersistenceLaunchPayload
} from './qa-run-protocol'

const launchDomain = Buffer.from('metis-persistence-qa-launch/v1\n', 'utf8')
const heartbeatDomain = Buffer.from('metis-persistence-qa-heartbeat/v1\n', 'utf8')
const keyPem = (inject as unknown as (name: string) => unknown)('qaPersistenceFixturePrivateKeyPem') as string

function buildPayload(
  challenge: string,
  overrides: Partial<QaPersistenceLaunchPayload> = {}
): QaPersistenceLaunchPayload {
  const stamp = compiledQaPersistenceRunContext()
  if (!stamp) throw new Error('QA fixture stamp is missing')
  const now = Date.now()
  const profilePath =
    process.platform === 'win32' ? 'C:\\qa-source-fixture\\profile' : '/tmp/metis-qa-source-fixture/profile'
  const parentPath = process.platform === 'win32' ? 'C:\\qa-source-fixture' : '/tmp/metis-qa-source-fixture'
  const owner =
    process.platform === 'win32' ? 'S-1-5-21-111111111-222222222-333333333-1001' : String(process.getuid?.() ?? 1000)
  const payload: QaPersistenceLaunchPayload = {
    purpose: 'isolated-persistence-qualification',
    bootChallenge: challenge,
    sourceCommit: stamp.context.commit,
    buildContext: stamp.context,
    runId: stamp.context.runId,
    runGeneration: 1,
    candidateSha256: stamp.candidateSha256,
    implementationSha256: stamp.implementationSha256,
    profileMeasurementSha256: stamp.profileMeasurementSha256,
    caseRosterSha256: stamp.caseRosterSha256,
    runtime: stamp.runtime,
    qaIdentity: stamp.qaIdentity,
    allowedCases: ['before-show-refusal', 'status-no-side-effects'],
    notBefore: now - 1000,
    expiresAt: now + 60_000,
    profile: {
      path: profilePath,
      device: '1',
      inode: '2',
      birthtimeMs: 1000,
      owner,
      mode: 0o700
    },
    parent: {
      path: parentPath,
      device: '1',
      inode: '1',
      birthtimeMs: 900,
      owner,
      mode: 0o700
    },
    osPrincipalAssociation:
      process.platform === 'win32'
        ? { platform: 'win32', sidAssociationSha256: 'a'.repeat(64) }
        : {
            platform: 'darwin',
            uid: process.getuid?.() ?? 1000,
            effectiveUid: process.geteuid?.() ?? process.getuid?.() ?? 1000
          },
    nativeKeyIntent: PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT,
    ...overrides
  }
  return payload
}

function signLaunch(payload: QaPersistenceLaunchPayload, keyPemOverride = keyPem): Buffer {
  const payloadBytes = Buffer.from(qaPersistenceCanonical(payload), 'utf8')
  const signature = sign(null, Buffer.concat([launchDomain, payloadBytes]), createPrivateKey(keyPemOverride))
  return Buffer.from(
    qaPersistenceCanonical({
      schema: QA_LAUNCH_ENVELOPE_SCHEMA,
      payload: payloadBytes.toString('base64url'),
      signature: signature.toString('base64url')
    }),
    'utf8'
  )
}

describe('compiled hosted persistence protocol fixture', () => {
  it('accepts a canonical signed launch for the actual challenge and keeps membership private', () => {
    const challenge = newQaPersistenceBootChallenge()
    const launch = verifyQaPersistenceLaunchEnvelope(signLaunch(buildPayload(challenge)), challenge)

    expect(launch).not.toBeNull()
    expect(readVerifiedQaPersistenceLaunch(launch!)).not.toBeNull()
    expect(readVerifiedQaPersistenceLaunch(Object.freeze({}) as NonNullable<typeof launch>)).toBeNull()
    const wrongChallenge = `${challenge[0] === 'A' ? 'B' : 'A'}${challenge.slice(1)}`
    expect(verifyQaPersistenceLaunchEnvelope(signLaunch(buildPayload(challenge)), wrongChallenge)).toBeNull()
  })

  it.each([
    ['wrong signing key', 'wrong-key'],
    ['wrong purpose', 'purpose'],
    ['wrong build context', 'buildContext'],
    ['wrong source commit', 'sourceCommit'],
    ['wrong run id', 'runId'],
    ['wrong run attempt', 'runAttempt'],
    ['wrong target', 'target'],
    ['wrong runtime', 'runtime'],
    ['wrong QA identity', 'qaIdentity'],
    ['wrong candidate digest', 'candidateSha256'],
    ['wrong implementation digest', 'implementationSha256'],
    ['wrong profile measurement digest', 'profileMeasurementSha256'],
    ['wrong roster digest', 'caseRosterSha256'],
    ['unsupported allowed case', 'allowedCases']
  ] as const)('refuses %s before any profile owner can accept it', (_label, mutation) => {
    const challenge = newQaPersistenceBootChallenge()
    const payload = buildPayload(challenge)
    const changed: QaPersistenceLaunchPayload =
      mutation === 'wrong-key'
        ? payload
        : mutation === 'purpose'
          ? ({ ...payload, purpose: 'other' } as unknown as QaPersistenceLaunchPayload)
          : mutation === 'buildContext'
            ? { ...payload, buildContext: { ...payload.buildContext, commit: '0'.repeat(40) } }
            : mutation === 'sourceCommit'
              ? { ...payload, sourceCommit: '0'.repeat(40) }
              : mutation === 'runId'
                ? { ...payload, runId: 'different-run' }
                : mutation === 'runAttempt'
                  ? { ...payload, buildContext: { ...payload.buildContext, runAttempt: 2 } }
                  : mutation === 'target'
                    ? {
                        ...payload,
                        buildContext: {
                          ...payload.buildContext,
                          target: payload.buildContext.target === 'darwin-arm64' ? 'darwin-x64' : 'darwin-arm64'
                        }
                      }
                    : mutation === 'runtime'
                      ? { ...payload, runtime: { ...payload.runtime, node: '22.0.0' } }
                      : mutation === 'qaIdentity'
                        ? { ...payload, qaIdentity: { ...payload.qaIdentity, executableSha256: '0'.repeat(64) } }
                        : mutation === 'candidateSha256'
                          ? { ...payload, candidateSha256: '0'.repeat(64) }
                          : mutation === 'implementationSha256'
                            ? { ...payload, implementationSha256: '0'.repeat(64) }
                            : mutation === 'profileMeasurementSha256'
                              ? { ...payload, profileMeasurementSha256: '0'.repeat(64) }
                              : mutation === 'caseRosterSha256'
                                ? { ...payload, caseRosterSha256: '0'.repeat(64) }
                                : { ...payload, allowedCases: ['arbitrary-case'] as never }
    const key =
      mutation === 'wrong-key'
        ? generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
        : keyPem
    expect(verifyQaPersistenceLaunchEnvelope(signLaunch(changed, key), challenge)).toBeNull()
  })

  it('refuses a valid fixture signature made under the wrong launch domain', () => {
    const challenge = newQaPersistenceBootChallenge()
    const payloadBytes = Buffer.from(qaPersistenceCanonical(buildPayload(challenge)), 'utf8')
    const wrongDomainSignature = sign(
      null,
      Buffer.concat([Buffer.from('metis-persistence-qa-heartbeat/v1\n', 'utf8'), payloadBytes]),
      createPrivateKey(keyPem)
    )
    const envelope = Buffer.from(
      qaPersistenceCanonical({
        schema: QA_LAUNCH_ENVELOPE_SCHEMA,
        payload: payloadBytes.toString('base64url'),
        signature: wrongDomainSignature.toString('base64url')
      }),
      'utf8'
    )
    expect(verifyQaPersistenceLaunchEnvelope(envelope, challenge)).toBeNull()
  })

  it.each([
    ['duplicate outer key', Buffer.from('{"schema":"x","schema":"y","payload":"e30","signature":"AA"}')],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    [
      'noncanonical base64url payload',
      Buffer.from('{"schema":"metis-persistence-qa-launch-envelope/v1","payload":"e30=","signature":"AA"}')
    ],
    ['noncanonical signed payload', malformedPayload(' {"a":1} ')],
    ['duplicate payload key', malformedPayload('{"a":1,"a":1}')],
    ['missing envelope field', Buffer.from('{"schema":"metis-persistence-qa-launch-envelope/v1","payload":"e30"}')],
    [
      'extra envelope field',
      Buffer.from('{"schema":"metis-persistence-qa-launch-envelope/v1","payload":"e30","signature":"AA","extra":true}')
    ],
    ['excessive depth', malformedPayload('['.repeat(20) + '0' + ']'.repeat(20))],
    [
      'truncated framed body',
      Buffer.from('{"schema":"metis-persistence-qa-launch-envelope/v1","payload":"e30","signature":"AA"')
    ],
    ['oversized payload envelope', Buffer.alloc(65_537, 0x20)]
  ])('refuses malformed protocol input: %s', (_label, bytes) => {
    expect(verifyQaPersistenceLaunchEnvelope(bytes, newQaPersistenceBootChallenge())).toBeNull()
  })

  it('accepts fractional monotonic receipt samples and rejects invalid clock samples and exact expiry', () => {
    const challenge = newQaPersistenceBootChallenge()
    const launch = verifyQaPersistenceLaunchEnvelope(signLaunch(buildPayload(challenge)), challenge)
    expect(launch).not.toBeNull()
    const now = Date.now()
    const claims = readVerifiedQaPersistenceLaunch(launch!)!
    const makeHeartbeat = (issuedAt: number): Buffer => {
      const unsigned = {
        schema: QA_HEARTBEAT_SCHEMA,
        runId: claims.runId,
        runGeneration: claims.runGeneration,
        sequence: 1,
        issuedAt
      }
      const signature = sign(
        null,
        Buffer.concat([heartbeatDomain, Buffer.from(qaPersistenceCanonical(unsigned), 'utf8')]),
        createPrivateKey(keyPem)
      ).toString('base64url')
      return Buffer.from(qaPersistenceCanonical({ ...unsigned, signature }), 'utf8')
    }
    const heartbeat = makeHeartbeat(now)

    expect(verifyQaPersistenceHeartbeat(heartbeat, launch!, 0, 1250.375, now, 1251.625)).not.toBeNull()
    expect(verifyQaPersistenceHeartbeat(heartbeat, launch!, 0, Number.NaN, now, 1251.625)).toBeNull()
    expect(verifyQaPersistenceHeartbeat(heartbeat, launch!, 0, Number.POSITIVE_INFINITY, now, 1251.625)).toBeNull()
    expect(verifyQaPersistenceHeartbeat(heartbeat, launch!, 0, -0.25, now, 1251.625)).toBeNull()
    expect(verifyQaPersistenceHeartbeat(heartbeat, launch!, 0, 1250.375, now, 1250.25)).toBeNull()
    expect(verifyQaPersistenceHeartbeat(heartbeat, launch!, 0, 1250.375, now, Number.NEGATIVE_INFINITY)).toBeNull()
    expect(verifyQaPersistenceHeartbeat(heartbeat, launch!, 0, 1250.375, now, 31_250.375)).toBeNull()

    const atExpiry = makeHeartbeat(claims.expiresAt)
    expect(verifyQaPersistenceHeartbeat(atExpiry, launch!, 0, 1250.375, claims.expiresAt, 1251.625)).toBeNull()
  })
})

function malformedPayload(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8').toString('base64url')
  return Buffer.from(qaPersistenceCanonical({ schema: QA_LAUNCH_ENVELOPE_SCHEMA, payload, signature: 'AA' }), 'utf8')
}
