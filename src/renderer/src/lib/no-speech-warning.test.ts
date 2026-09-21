import { describe, expect, it } from 'vitest'
import { shouldShowNoSpeechWarning, type CaptureHealth } from './listen'

const connected: CaptureHealth = {
  requestedDevice: false,
  selectionOutcome: 'system-default',
  inputSampleRate: 48000,
  inputChannelCount: 1,
  processingSampleRate: 16000,
  trackState: 'connected'
}

describe('no-speech warning', () => {
  it('warns for a current connected silent microphone and clears on admitted speech', () => {
    expect(shouldShowNoSpeechWarning(4, 4, connected, false, null)).toBe(true)
    expect(shouldShowNoSpeechWarning(4, 4, connected, true, null)).toBe(false)
  })

  it('does not compete with capture degradation or a stale session event', () => {
    expect(
      shouldShowNoSpeechWarning(4, 4, connected, false, {
        side: 'them',
        note: 'System audio needs Screen Recording permission.',
        permission: true
      })
    ).toBe(false)
    expect(shouldShowNoSpeechWarning(5, 4, connected, false, null)).toBe(false)
  })
})
