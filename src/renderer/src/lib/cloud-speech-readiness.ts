import type { CloudSpeechCapability, CloudSpeechEngine } from '@shared/cloud-speech'

export type CloudSpeechRowStatus = { state: 'checking' | 'ready' | 'action'; detail: string }

const REFUSAL_COPY: Record<NonNullable<CloudSpeechCapability['refusal']>, string> = {
  DISABLED: 'Cloud speech is disabled for this profile.',
  AUTH: 'The device is not authorized for cloud speech.',
  POLICY: 'No verified speech policy is available.',
  CONSENT: 'Cloud speech consent is required before a session can start.',
  NOT_READY: 'The approved cloud speech route is not ready.',
  NOT_CONFIGURED: 'The approved cloud speech route is not configured.',
  STALE: 'Cloud speech settings need to be refreshed.',
  CLOSED: 'The cloud speech session is closed.',
  ORDER: 'Cloud speech is waiting for the previous session to close.',
  QUEUE_LIMIT: 'Cloud speech is busy. Try again after pending audio clears.',
  QUEUE_STALE: 'Pending cloud speech audio expired. Start a new session.',
  TRANSPORT: 'The cloud speech connection is unavailable.',
  TIMEOUT: 'The cloud speech connection timed out.',
  CLOSURE_UNCONFIRMED: 'The previous cloud speech connection has not confirmed closure.',
  INVALID_REQUEST: 'Cloud speech settings are invalid.'
}

export function cloudSpeechRowStatus(
  capability: CloudSpeechCapability | null,
  requestedEngine?: CloudSpeechEngine | null
): CloudSpeechRowStatus {
  if (!capability) return { state: 'checking', detail: 'Checking the approved cloud speech route…' }
  if (!capability.ready || !capability.selected || capability.refusal) {
    return {
      state: 'action',
      detail: capability.refusal ? REFUSAL_COPY[capability.refusal] : 'The approved cloud speech route is not ready.'
    }
  }
  if (requestedEngine === null)
    return { state: 'action', detail: 'Choose an allowed cloud speech route to enable cloud transcription.' }
  if (requestedEngine && requestedEngine !== capability.selected.engine)
    return { state: 'action', detail: 'The saved route does not match the currently approved route.' }
  const detail =
    capability.selected.engine === 'cloudflare-nova3'
      ? 'Ready: Cloudflare Workers AI · Nova-3'
      : 'Ready: Deepgram Nova-3 through Cloudflare AI Gateway'
  return { state: 'ready', detail }
}
