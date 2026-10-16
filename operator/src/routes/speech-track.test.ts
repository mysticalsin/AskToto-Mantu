import { describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../crypto'
import { encodeSpeechTrackDescriptor } from '../speech/contracts'
import { handleSpeechTrackOpen, SPEECH_TRACK_DESCRIPTOR_HEADER } from './speech-track'
import type { OperatorStore } from '../store'
import type { Env } from './admin-ctx'

const deviceId = 'speech-device-1234'
const licenseJti = 'license-jti-1234'
const sessionId = '53f6eb5d-442e-4479-8382-07f340488e43'

function store(): OperatorStore {
  return {
    async getSeat() {
      return { device_id: deviceId, license_jti: licenseJti, approval: 'approved' }
    },
    async getIssuedLicense() {
      return { jti: licenseJti, revoked: 0, exp: Math.floor(Date.now() / 1_000) + 3_600, activated_device: deviceId }
    },
    async listTiers() {
      return [{ id: 'metis', entitlements_json: JSON.stringify(['listen', 'operator_keys']) }]
    }
  } as unknown as OperatorStore
}

describe('speech track route', () => {
  it('rejects malformed descriptors and grant digest mismatches before looking up the consumer', async () => {
    const idFromName = vi.fn(() => 'id')
    const env: Env = {
      OPERATOR_INGEST_SECRET: 'synthetic',
      OPERATOR_PROMPT_KEY: '',
      OPERATOR_SKILL_PRIVATE_KEY: '',
      SPEECH_SESSION_DO: { idFromName, get: vi.fn() }
    }
    const request = new Request('https://operator.invalid/v1/speech/sessions/x/tracks/microphone')
    const invalid = await handleSpeechTrackOpen({
      request,
      store: store(),
      env,
      opts: {},
      now: Date.now(),
      device: { deviceId, licenseJti },
      sessionId,
      track: 'microphone',
      descriptorText: '{not-json',
      grant: 'x'.repeat(43)
    })
    expect(invalid.status).toBe(403)
    expect(idFromName).not.toHaveBeenCalled()

    const grant = 'A'.repeat(43)
    const descriptor = encodeSpeechTrackDescriptor({
      operation: 'open-track',
      sessionId,
      track: 'microphone',
      captureGeneration: 7,
      streamEpoch: 1,
      grantDigest: '0'.repeat(64)
    })
    const mismatch = await handleSpeechTrackOpen({
      request: new Request('https://operator.invalid/v1/speech/sessions/x/tracks/microphone'),
      store: store(),
      env,
      opts: {},
      now: Date.now(),
      device: { deviceId, licenseJti },
      sessionId,
      track: 'microphone',
      descriptorText: descriptor,
      grant
    })
    expect(mismatch.status).toBe(403)
    expect(idFromName).not.toHaveBeenCalled()
    expect(SPEECH_TRACK_DESCRIPTOR_HEADER).toBe('x-metis-speech-descriptor')
  })

  it('refuses a real track before consumer dispatch when route evidence or readiness is absent', async () => {
    const idFromName = vi.fn(() => 'id')
    const get = vi.fn()
    const env: Env = {
      OPERATOR_INGEST_SECRET: 'synthetic',
      OPERATOR_PROMPT_KEY: '',
      OPERATOR_SKILL_PRIVATE_KEY: '',
      SPEECH_TENANT_ID: 'tenant',
      SPEECH_AUDIENCE: 'operator',
      SPEECH_SESSION_DO: { idFromName, get }
    }
    const grant = 'A'.repeat(43)
    const descriptor = encodeSpeechTrackDescriptor({
      operation: 'open-track',
      sessionId,
      track: 'microphone',
      captureGeneration: 7,
      streamEpoch: 1,
      grantDigest: await sha256Hex(grant)
    })
    const response = await handleSpeechTrackOpen({
      request: new Request('https://operator.invalid/v1/speech/sessions/x/tracks/microphone'),
      store: store(),
      env,
      opts: {},
      now: Date.now(),
      device: { deviceId, licenseJti },
      sessionId,
      track: 'microphone',
      descriptorText: descriptor,
      grant
    })
    expect(response.status).toBe(503)
    expect(idFromName).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })
})
