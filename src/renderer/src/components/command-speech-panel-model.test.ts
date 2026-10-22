import { describe, expect, it } from 'vitest'
import { VOICE_CAPTURE_FAILURES, voiceReasonCopy } from '@shared/voice/voice-turn'
import { commandSpeechPanelView } from './command-speech-panel-model'

const ok = { ok: true } as const

describe('command panel view uses the one voice failure taxonomy (G18)', () => {
  it.each([
    ['microphone_unavailable', 'microphone_unavailable'],
    ['device_missing', 'device_missing'],
    ['device_lost', 'device_lost'],
    ['device_busy', 'device_busy'],
    ['no_speech', 'no_speech'],
    ['recognition_unavailable', 'recognition_unavailable'],
    ['timeout', 'timeout']
  ] as const)('an error with reason %s shows the shared fixed message', (reason, voiceReason) => {
    const view = commandSpeechPanelView({ engineSelected: true, availability: ok, status: 'error', reason })
    expect(view.message).toBe(voiceReasonCopy(voiceReason))
  })

  it('shows the shared message for every capture failure the controller can end with', () => {
    for (const reason of VOICE_CAPTURE_FAILURES) {
      const stop = reason === 'speech_unavailable' ? 'unsupported_engine' : reason
      const view = commandSpeechPanelView({ engineSelected: true, availability: ok, status: 'error', reason: stop })
      if (reason === 'speech_unavailable') continue // the engine row has its own precondition copy
      expect(view.message, reason).toBe(voiceReasonCopy(reason))
    }
  })

  it('offers Open System Settings for a denied microphone, and Open Settings on Windows', () => {
    const mac = commandSpeechPanelView({
      engineSelected: true,
      availability: ok,
      status: 'error',
      reason: 'microphone_unavailable',
      windows: false
    })
    expect(mac.recovery).toEqual({ kind: 'open_settings', label: 'Open System Settings' })
    const win = commandSpeechPanelView({
      engineSelected: true,
      availability: ok,
      status: 'error',
      reason: 'microphone_unavailable',
      windows: true
    })
    expect(win.recovery).toEqual({ kind: 'open_settings', label: 'Open Settings' })
  })

  it.each([
    'device_missing',
    'device_lost',
    'device_busy',
    'recognition_unavailable',
    'no_speech'
  ] as const)('offers Try again for %s', (reason) => {
    const view = commandSpeechPanelView({ engineSelected: true, availability: ok, status: 'error', reason })
    expect(view.recovery).toEqual({ kind: 'try_again', label: 'Try again' })
  })

  it('offers nothing for a policy block, and keeps the engine precondition copy', () => {
    const blocked = commandSpeechPanelView({
      engineSelected: true,
      availability: { ok: false, reason: 'policy_blocked' },
      status: 'idle'
    })
    expect(blocked.message).toBe(voiceReasonCopy('policy_blocked'))
    expect(blocked.recovery).toBeNull()
    expect(blocked.unavailable).toBe(true)
    const noEngine = commandSpeechPanelView({ engineSelected: false, availability: ok, status: 'idle' })
    expect(noEngine.message).toBe('Local voice commands require Parakeet. Select Parakeet in Speech settings.')
    expect(noEngine.unavailable).toBe(true)
  })

  it('keeps the click-to-start copy for a missing activation and the in-progress copy', () => {
    expect(
      commandSpeechPanelView({ engineSelected: true, availability: ok, status: 'error', reason: 'activation_required' })
        .message
    ).toBe('Use the Start button to begin a voice command.')
    expect(commandSpeechPanelView({ engineSelected: true, availability: ok, status: 'listening' }).message).toBe(
      'Listening. Speak one command, then stop.'
    )
    expect(commandSpeechPanelView({ engineSelected: true, availability: null, status: 'idle' }).unavailable).toBe(true)
  })

  it('no message uses an em dash or the word Error', () => {
    for (const reason of [
      'microphone_unavailable',
      'device_missing',
      'device_lost',
      'device_busy',
      'no_speech'
    ] as const) {
      expect(
        commandSpeechPanelView({ engineSelected: true, availability: ok, status: 'error', reason }).message
      ).not.toMatch(/—|–|error/i)
    }
  })
})
