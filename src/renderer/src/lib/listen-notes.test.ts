import { describe, expect, it } from 'vitest'
import {
  ADMISSION_DENIED_MSG,
  CLOUD_LANGUAGE_NEXT_START_MSG,
  LOADING_DROPPED_MSG,
  MIC_RECOVERY_FAILED_MSG,
  captureStartFailureMessage,
  cloudSpeechStartMessage,
  cloudTrackLostMessage,
  cloudTrackReconnectingMessage,
  revokeReasonAllowsSave,
  revokedCaptureMessage,
  themSilentMessage
} from './listen-notes'

describe('Q03 revokedCaptureMessage (D2-6, D7-4, D7-13)', () => {
  it('names the event that ended the meeting, per platform', () => {
    expect(revokedCaptureMessage('screen-locked', false)).toBe('Listening stopped when your Mac locked.')
    expect(revokedCaptureMessage('screen-locked', true)).toBe('Listening stopped when your PC locked.')
    expect(revokedCaptureMessage('system-suspend', false)).toBe('Listening stopped when your Mac went to sleep.')
    expect(revokedCaptureMessage('system-suspend', true)).toBe('Listening stopped when your PC went to sleep.')
    expect(revokedCaptureMessage('sign-out', false)).toBe('Listening stopped because your sign-in ended.')
    expect(revokedCaptureMessage('auth-revoked', true)).toBe('Listening stopped because your sign-in ended.')
    expect(revokedCaptureMessage('shutdown', false)).toBe('Listening stopped.')
    expect(revokedCaptureMessage(undefined, false)).toBe('Listening stopped.')
  })

  it('never exposes the internal admission wording', () => {
    for (const reason of ['screen-locked', 'system-suspend', 'sign-out', 'auth-revoked', 'window-hidden', 'shutdown'])
      expect(revokedCaptureMessage(reason, false)).not.toMatch(/admission|revoked/i)
  })

  it('does not allow a transcript save when the sign-in ended', () => {
    expect(revokeReasonAllowsSave('screen-locked')).toBe(true)
    expect(revokeReasonAllowsSave('system-suspend')).toBe(true)
    expect(revokeReasonAllowsSave('sign-out')).toBe(false)
    expect(revokeReasonAllowsSave('auth-revoked')).toBe(false)
  })
})

describe('Q03 captureStartFailureMessage (D2-8)', () => {
  const base = { source: 'mic' as const, sysPermDenied: false, windows: false }

  it('classifies a busy microphone', () => {
    for (const micErrorName of ['NotReadableError', 'AbortError'])
      expect(captureStartFailureMessage({ ...base, micErrorName })).toMatch(/another app is using it/)
  })

  it('classifies a missing microphone', () => {
    for (const micErrorName of ['NotFoundError', 'OverconstrainedError'])
      expect(captureStartFailureMessage({ ...base, micErrorName })).toMatch(/No microphone was found/)
  })

  it('keeps the permission copy for NotAllowedError and unknown causes, per platform', () => {
    expect(captureStartFailureMessage({ ...base, micErrorName: 'NotAllowedError' })).toMatch(
      /System Settings → Privacy & Security → Microphone/
    )
    expect(captureStartFailureMessage({ ...base, micErrorName: null, windows: true })).toMatch(
      /Windows microphone access/
    )
  })

  it('says both sides failed in Both mode instead of blaming only the microphone', () => {
    const message = captureStartFailureMessage({
      source: 'both',
      micErrorName: 'NotReadableError',
      sysPermDenied: true,
      windows: false
    })
    expect(message).toMatch(/^Couldn't start the microphone or system audio\./)
    expect(message).toMatch(/another app is using it/)
    expect(message).toMatch(/Screen Recording/)
  })

  it('keeps the system-only copy', () => {
    expect(captureStartFailureMessage({ source: 'system', sysPermDenied: true, windows: false })).toMatch(
      /needs Screen Recording permission/
    )
    expect(captureStartFailureMessage({ source: 'system', sysPermDenied: false, windows: true })).toMatch(
      /default output device/
    )
  })

  it('rewrites an admission denial in plain words', () => {
    expect(ADMISSION_DENIED_MSG).toBe("Métis couldn't start listening. Try again.")
    expect(ADMISSION_DENIED_MSG).not.toMatch(/admission/i)
  })
})

describe('Q03 cloudSpeechStartMessage (D2-11)', () => {
  it('never leaks transport or environment-variable text', () => {
    for (const code of ['CONNECT', 'EGRESS', 'CREDENTIALS', 'UNCONFIGURED', 'CLOUD_ONLY', 'AUTH', undefined])
      expect(cloudSpeechStartMessage(code)).not.toMatch(/WebSocket|CF_AI_GATEWAY|METIS_|getaddrinfo|env/i)
  })

  it('maps codes to fixed, actionable copy', () => {
    expect(cloudSpeechStartMessage('CONNECT')).toMatch(/Couldn't reach the cloud speech service/)
    expect(cloudSpeechStartMessage('EGRESS')).toMatch(/Couldn't reach the cloud speech service/)
    expect(cloudSpeechStartMessage('CREDENTIALS')).toMatch(/isn't set up on this device/)
    expect(cloudSpeechStartMessage('UNCONFIGURED')).toMatch(/ask your administrator/)
    expect(cloudSpeechStartMessage('CLOUD_ONLY')).toMatch(/organization requires cloud speech/)
  })
})

describe('Q03 fixed notes', () => {
  it('words the cloud track states per side', () => {
    expect(cloudTrackReconnectingMessage('you')).toBe('Cloud transcription for your microphone dropped. Reconnecting…')
    expect(cloudTrackReconnectingMessage('them')).toBe('Cloud transcription for the other side dropped. Reconnecting…')
    expect(cloudTrackLostMessage('you')).toBe(
      'Cloud transcription for your microphone stopped. Stop and start listening to reconnect.'
    )
    expect(cloudTrackLostMessage('them')).toMatch(/the other side stopped/)
  })

  it('keeps the other new copy exact', () => {
    expect(MIC_RECOVERY_FAILED_MSG).toBe(
      'Microphone input stopped and could not reconnect. Connect or choose a microphone, and Métis will try again.'
    )
    expect(CLOUD_LANGUAGE_NEXT_START_MSG).toBe('The new speech language applies the next time you start listening.')
    expect(LOADING_DROPPED_MSG).toBe('The speech model is still loading, so early audio was skipped.')
  })

  it('covers both causes of a silent far side on macOS (D2-12)', () => {
    expect(themSilentMessage(false)).toBe(
      "No audio from the other side yet. If they're speaking, check the call volume and that Screen Recording is on."
    )
    expect(themSilentMessage(true)).toMatch(/default output device/)
  })
})
