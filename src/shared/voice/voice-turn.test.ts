import { describe, expect, it } from 'vitest'
import {
  VOICE_CAPTURE_FAILURES,
  VOICE_REASONS,
  VOICE_REPORT_REASONS,
  VoiceReportSchema,
  commandMicReasonToVoice,
  voiceReasonCopy,
  voiceReasonRecovery
} from './voice-turn'

describe('interactive voice failure taxonomy (G18)', () => {
  it('is one closed list that lives inside the one voice reason vocabulary', () => {
    expect([...VOICE_CAPTURE_FAILURES].sort()).toEqual(
      [
        'device_busy',
        'device_lost',
        'device_missing',
        'microphone_unavailable',
        'no_speech',
        'policy_blocked',
        'recognition_unavailable',
        'speech_unavailable',
        'timeout'
      ].sort()
    )
    for (const reason of VOICE_CAPTURE_FAILURES) expect(VOICE_REASONS).toContain(reason)
    expect(new Set(VOICE_CAPTURE_FAILURES).size).toBe(VOICE_CAPTURE_FAILURES.length)
  })

  it('gives every reason one fixed message in sentence case, with no em dash and no "Error"', () => {
    for (const reason of VOICE_REASONS) {
      const message = voiceReasonCopy(reason)
      expect(message, reason).toMatch(/^[A-ZÉ]/)
      expect(message, reason).toMatch(/[.…]$/)
      expect(message, reason).not.toMatch(/—|–|error/i)
      expect(message.length, reason).toBeLessThanOrEqual(120)
    }
  })

  it('never gives two capture failures the same message, so the person can tell them apart', () => {
    const seen = new Map<string, string>()
    for (const reason of VOICE_CAPTURE_FAILURES) {
      const message = voiceReasonCopy(reason)
      expect(seen.get(message), `${reason} repeats ${seen.get(message)}`).toBeUndefined()
      seen.set(message, reason)
    }
  })

  it('names each capture failure in the words a person would use', () => {
    expect(voiceReasonCopy('device_missing')).toBe('No microphone found. Connect one and try again.')
    expect(voiceReasonCopy('device_lost')).toBe('Your microphone was disconnected. Try again.')
    expect(voiceReasonCopy('device_busy')).toBe('Another app is using the microphone. Close it and try again.')
  })

  it('offers one recovery action where one exists', () => {
    expect(voiceReasonRecovery('microphone_unavailable')).toBe('open_settings')
    for (const reason of [
      'device_missing',
      'device_lost',
      'device_busy',
      'recognition_unavailable',
      'no_speech'
    ] as const) {
      expect(voiceReasonRecovery(reason), reason).toBe('try_again')
    }
    for (const reason of ['policy_blocked', 'speech_unavailable', 'signed_out', 'meeting_recording'] as const) {
      expect(voiceReasonRecovery(reason), reason).toBeNull()
    }
  })

  it('lets the renderer report the new device reasons, and nothing outside the closed list', () => {
    for (const reason of ['device_missing', 'device_lost', 'device_busy'] as const) {
      expect(VOICE_REPORT_REASONS).toContain(reason)
      expect(VoiceReportSchema.safeParse({ turnId: 't', phase: 'failed', reason }).success).toBe(true)
    }
    expect(VoiceReportSchema.safeParse({ turnId: 't', phase: 'failed', reason: 'meeting_started' }).success).toBe(false)
    expect(VoiceReportSchema.safeParse({ turnId: 't', phase: 'failed', reason: 'offline' }).success).toBe(false)
  })

  it('accepts a strict device-changed report that carries only the turn id', () => {
    expect(VoiceReportSchema.safeParse({ turnId: 't', phase: 'device_changed' }).success).toBe(true)
    expect(VoiceReportSchema.safeParse({ turnId: 't', phase: 'device_changed', text: 'hello' }).success).toBe(false)
  })

  it('maps command microphone stop reasons onto the same vocabulary', () => {
    expect(commandMicReasonToVoice('unsupported_engine')).toBe('speech_unavailable')
    expect(commandMicReasonToVoice('device_lost')).toBe('device_lost')
    expect(commandMicReasonToVoice('device_missing')).toBe('device_missing')
    expect(commandMicReasonToVoice('device_busy')).toBe('device_busy')
    expect(commandMicReasonToVoice('no_speech')).toBe('no_speech')
    expect(commandMicReasonToVoice('timeout')).toBe('timeout')
    expect(commandMicReasonToVoice('cancelled')).toBeNull()
    expect(commandMicReasonToVoice('activation_required')).toBe('activation_required')
    expect(commandMicReasonToVoice(undefined)).toBeNull()
  })
})
