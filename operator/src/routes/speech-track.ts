import { sha256Hex } from '../crypto'
import { hmacHex } from '../hmac'
import { json } from '../http'
import { OPERATOR_LICENSE_HEADER } from '../../../src/shared/operator-hmac'
import { parseSpeechTrackDescriptor } from '../speech/contracts'
import { resolveSpeechReadiness } from '../speech/readiness'
import { authorizedSpeechDevice } from './speech-session'
import type { Env, HandleOpts, SpeechSessionDurableObjectNamespace } from './admin-ctx'
import type { OperatorStore } from '../store'

export async function handleSpeechTrackOpen(input: {
  request: Request
  store: OperatorStore
  env: Env
  opts: HandleOpts
  now: number
  device: { deviceId: string; licenseJti: string }
  sessionId: string
  track: string
  descriptorText: string | null
  grant: string | null
}): Promise<Response> {
  const descriptor = input.descriptorText ? parseSpeechTrackDescriptor(input.descriptorText) : null
  if (
    !descriptor ||
    descriptor.sessionId !== input.sessionId ||
    descriptor.track !== input.track ||
    !input.grant ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.grant)
  )
    return json({ ok: false, code: 'GRANT_REJECTED' }, 403)
  const digest = await sha256Hex(input.grant)
  if (digest !== descriptor.grantDigest) return json({ ok: false, code: 'GRANT_REJECTED' }, 403)
  const auth = await authorizedSpeechDevice(input.store, input.device, input.now)
  if (!auth.ok) return json({ ok: false, code: 'NOT_AUTHORIZED' }, 403)
  const readiness = await resolveSpeechReadiness({
    db: input.env.DB,
    env: input.env,
    now: input.now,
    fetchImpl: input.opts.cfFetch
  })
  if (!readiness.ok)
    return json({ ok: false, code: readiness.code }, readiness.code === 'POLICY_UNAVAILABLE' ? 503 : 403)
  const namespace = input.env.SPEECH_SESSION_DO as SpeechSessionDurableObjectNamespace | undefined
  if (!namespace) return json({ ok: false, code: 'TRANSPORT_UNAVAILABLE' }, 503)
  const secret = input.env.OPERATOR_INGEST_SECRET?.trim() ?? ''
  if (!secret) return json({ ok: false, code: 'TRANSPORT_UNAVAILABLE' }, 503)
  const bodyText = JSON.stringify({
    operation: 'open-track',
    descriptor,
    grant: input.grant,
    deviceId: input.device.deviceId,
    licenseJti: input.device.licenseJti
  })
  const tsText = String(input.now)
  const signature = await hmacHex(secret, `${tsText}\n${bodyText}`)
  const idName = await sha256Hex(`${input.env.SPEECH_TENANT_ID}\n${input.env.SPEECH_AUDIENCE}\n${descriptor.sessionId}`)
  let response: Response
  try {
    const id = namespace.idFromName(idName)
    const stub = namespace.get(id)
    response = await stub.fetch(
      new Request('https://speech-session.internal/open', {
        method: 'GET',
        headers: {
          upgrade: 'websocket',
          'x-metis-speech-internal-payload': bodyText,
          'x-metis-speech-internal-ts': tsText,
          'x-metis-speech-internal-sig': signature
        }
      })
    )
  } catch {
    return json({ ok: false, code: 'TRANSPORT_UNAVAILABLE' }, 503)
  }
  return response
}

export const SPEECH_TRACK_DESCRIPTOR_HEADER = 'x-metis-speech-descriptor'
export const SPEECH_TRACK_GRANT_HEADER = 'x-metis-speech-grant'
export const SPEECH_TRACK_LICENSE_HEADER = OPERATOR_LICENSE_HEADER
