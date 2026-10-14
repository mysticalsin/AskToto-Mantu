import {
  CLOUD_SPEECH_DISCLOSURE_VERSION,
  CloudSpeechStartRequestSchema,
  type CloudSpeechEvent,
  type CloudSpeechStartRequest
} from '@shared/cloud-speech'
import type { Capture } from '@shared/contracts/speech'
import type { Track } from '@shared/contracts/speech'
import type { CloudSpeechEngine } from '@shared/cloud-speech'
import type { CloudSpeechFailure, CloudSpeechStartResult } from '@shared/cloud-speech'
import type { CloudSpeechController, CloudSpeechControllerBridge } from './cloud-speech-controller'
import { createCloudSpeechController } from './cloud-speech-controller'

export interface CloudSpeechConsentAcknowledgement {
  engine: CloudSpeechEngine
  requestedTracks: Track[]
  disclosureVersion: typeof CLOUD_SPEECH_DISCLOSURE_VERSION
}

export interface CloudSpeechTranscriptSegment {
  text: string
  speaker: 'you' | 'them'
  segmentId: string
  providerLanguage?: string
  speech: Extract<CloudSpeechEvent, { type: 'segment' }>
}

export interface CloudSpeechSessionStart {
  epoch: number
  captureId: string
  capture: Capture
  consent: CloudSpeechConsentAcknowledgement
}

export interface CloudSpeechSessionStartHost {
  bridge: CloudSpeechControllerBridge
  language: string
  isAdmissionOpen(epoch: number): boolean
  setController(controller: CloudSpeechController): void
  setCaptureId(captureId: string): void
  applyEvent(event: CloudSpeechEvent, epoch: number): void
  onFailure(
    code: CloudSpeechFailure['code'],
    identity: { epoch: number; captureId: string },
    controller: CloudSpeechController
  ): void
  onStopped(identity: { epoch: number; captureId: string }, reason: 'user' | 'ceiling', complete: boolean): void
  attachTrack(track: Track, controller: CloudSpeechController): Promise<boolean>
  fail(error: string): void
  setReady(): void
}

export function cloudSpeechListenStopped(
  identity: { epoch: number; captureId: string },
  reason: 'user' | 'ceiling',
  complete: boolean,
  ownerCurrent: boolean,
  fail: (error: string, options?: { cloudCaptureId?: string }) => void
): void {
  if (reason !== 'ceiling' || !ownerCurrent) return
  fail(cloudSpeechCaptureLimitMessage(complete), { cloudCaptureId: identity.captureId })
}

export function cloudSpeechCaptureLimitMessage(complete: boolean): string {
  return complete
    ? 'Cloud speech reached the four-hour capture limit. Listen has stopped.'
    : 'Cloud speech reached the four-hour capture limit, but the final transcript could not be confirmed. Listen has stopped.'
}

export function cloudSpeechListenOwnerCallbacks(
  shouldHandle: (identity: { epoch: number; captureId: string }, reason: 'failure' | 'user' | 'ceiling') => boolean,
  fail: (error: string, options?: { cloudCaptureId?: string }) => void
): Pick<CloudSpeechSessionStartHost, 'onFailure' | 'onStopped'> {
  return {
    onFailure: (code, identity) => {
      if (!shouldHandle(identity, 'failure')) return
      fail(`Cloud speech stopped safely (${code}).`, { cloudCaptureId: identity.captureId })
    },
    onStopped: (identity, reason, complete) => {
      if (!shouldHandle(identity, reason)) return
      cloudSpeechListenStopped(identity, reason, complete, true, fail)
    }
  }
}

export async function startCloudSpeechSession(
  input: CloudSpeechSessionStart,
  host: CloudSpeechSessionStartHost
): Promise<boolean> {
  const { epoch, captureId, capture, consent } = input
  const request = buildCloudSpeechStartRequest({ captureId, capture, language: host.language, consent })
  if (!request || !host.isAdmissionOpen(epoch)) {
    if (host.isAdmissionOpen(epoch)) host.fail('Broker speech consent or capture details were rejected.')
    return false
  }
  let controller!: CloudSpeechController
  controller = createCloudSpeechController({
    bridge: host.bridge,
    request,
    applyEvent: (event) => host.applyEvent(event, epoch),
    onFailure: (code) => host.onFailure(code, { epoch, captureId }, controller),
    onStopped: (identity, reason, complete) =>
      host.onStopped({ epoch: identity.captureGeneration, captureId: identity.captureId }, reason, complete)
  })
  host.setController(controller)
  host.setCaptureId(captureId)
  let started: CloudSpeechStartResult
  try {
    started = await controller.start()
  } catch {
    started = { ok: false, code: 'TRANSPORT', captureId, captureGeneration: epoch }
  }
  if (!host.isAdmissionOpen(epoch)) {
    void controller.cancel()
    return false
  }
  if (!started.ok) {
    host.fail(`Cloud speech could not start (${started.code}).`)
    return false
  }
  for (const track of capture.capturedTracks) {
    if (!(await host.attachTrack(track, controller))) {
      host.fail(`Cloud ${track === 'microphone' ? 'microphone' : 'system-audio'} stream could not be attached.`)
      return false
    }
  }
  if (!host.isAdmissionOpen(epoch)) {
    void controller.cancel()
    return false
  }
  host.setReady()
  return true
}

/** Keep each provider segment distinct; its text is not normalized or deduplicated. */
export function cloudSpeechTranscriptSegment(event: CloudSpeechEvent): CloudSpeechTranscriptSegment | null {
  if (event.type !== 'segment' || !event.segment.final) return null
  const segment = event.segment
  const languages = new Set([
    ...(event.languages ?? []),
    ...(event.words ?? []).flatMap((word) => (word.language ? [word.language] : []))
  ])
  return {
    text: segment.text,
    speaker: segment.stream.track === 'microphone' ? 'you' : 'them',
    segmentId: `${segment.stream.generation}:${segment.stream.track}:${segment.stream.epoch}:${segment.index}`,
    ...(languages.size === 1 ? { providerLanguage: [...languages][0] } : {}),
    speech: event
  }
}

export function cloudSpeechConsentMatches(
  engine: unknown,
  source: unknown,
  consent: CloudSpeechConsentAcknowledgement | undefined
): boolean {
  const requestedTracks: Track[] = Array.isArray(source)
    ? source
    : source === 'mic'
      ? ['microphone']
      : source === 'system'
        ? ['system']
        : source === 'both'
          ? ['microphone', 'system']
          : []
  return (
    !!consent &&
    consent.engine === engine &&
    consent.disclosureVersion === CLOUD_SPEECH_DISCLOSURE_VERSION &&
    requestedTracks.length > 0 &&
    requestedTracks.length === consent.requestedTracks.length &&
    requestedTracks.every((track, index) => consent.requestedTracks[index] === track)
  )
}

/** Construct only a capture-scoped request backed by the actual acquired-track snapshot. */
export function buildCloudSpeechStartRequest(input: {
  captureId: string
  capture: Capture
  language: string
  consent: CloudSpeechConsentAcknowledgement | undefined
}): CloudSpeechStartRequest | null {
  if (!input.consent || input.consent.engine !== input.capture.engine) return null
  if (input.consent.disclosureVersion !== CLOUD_SPEECH_DISCLOSURE_VERSION) return null
  if (
    input.consent.requestedTracks.length !== input.capture.requestedTracks.length ||
    !input.capture.requestedTracks.every((track, index) => input.consent?.requestedTracks[index] === track)
  )
    return null
  const parsed = CloudSpeechStartRequestSchema.safeParse({
    captureId: input.captureId,
    capture: {
      generation: input.capture.generation,
      engine: input.capture.engine,
      requestedTracks: [...input.capture.requestedTracks],
      capturedTracks: [...input.capture.capturedTracks]
    },
    language: input.language,
    consent: { accepted: true, disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION }
  })
  return parsed.success ? parsed.data : null
}
