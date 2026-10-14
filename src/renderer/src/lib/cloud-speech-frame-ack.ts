import { CloudSpeechFrameResultSchema, type CloudSpeechFailure, type CloudSpeechFrame } from '@shared/cloud-speech'
import type { CloudSpeechStartRequest } from '@shared/cloud-speech'
import { cloudSpeechIdentityMatches } from './cloud-speech-results'

export function cloudSpeechAckMatches(
  raw: unknown,
  frame: CloudSpeechFrame,
  request: CloudSpeechStartRequest,
  invalidate: (code: CloudSpeechFailure['code']) => void
): boolean {
  const parsed = CloudSpeechFrameResultSchema.safeParse(raw)
  if (!parsed.success) {
    invalidate('TRANSPORT')
    return false
  }
  if (!parsed.data.ok) {
    invalidate(parsed.data.code)
    return false
  }
  const byteLength = frame.pcm16le.byteLength
  const ack = parsed.data
  if (
    !cloudSpeechIdentityMatches(ack, request) ||
    ack.track !== frame.track ||
    ack.sequence !== frame.sequence ||
    ack.nextSequence !== frame.sequence + 1 ||
    ack.nextSampleOffset !== frame.sampleOffset + byteLength / 2
  ) {
    invalidate('ORDER')
    return false
  }
  return true
}
