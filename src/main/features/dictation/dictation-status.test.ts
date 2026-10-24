import { describe, expect, it } from 'vitest'
import { DICTATION_STATUS_MESSAGE_MAX, DictationStatusSchema } from '@shared/dictation-status'
import { DICTATION_REASON_COPY, toDictationStatus } from './dictation-status'
import type { DictationReason, DictationSnapshot } from './dictation-session'

// Typed as the full union so a new DictationReason without copy fails to compile here as well as at the table.
const ALL: Record<DictationReason, true> = Object.fromEntries(
  Object.keys(DICTATION_REASON_COPY).map((k) => [k, true])
) as Record<DictationReason, true>

describe('dictation status copy (G30)', () => {
  it('has fixed sentence-case copy for every reason, none saying Error', () => {
    for (const reason of Object.keys(ALL) as DictationReason[]) {
      const copy = DICTATION_REASON_COPY[reason]
      expect(copy, reason).toBeTruthy()
      expect(copy.length, reason).toBeLessThanOrEqual(DICTATION_STATUS_MESSAGE_MAX)
      expect(copy, reason).toMatch(/^[A-ZÉ]/)
      expect(copy, reason).toMatch(/[.]$/)
      expect(copy.toLowerCase(), reason).not.toContain('error')
    }
  })

  it('uses the agreed wording for the sensitive refusals', () => {
    expect(DICTATION_REASON_COPY.secure_field).toBe("This field is a password, so Métis didn't type into it.")
    expect(DICTATION_REASON_COPY.target_changed).toBe("The window changed, so Métis didn't type.")
    expect(DICTATION_REASON_COPY.meeting_recording).toBe('Dictation is off while Métis records a meeting.')
  })

  it('maps a snapshot to a status that drops the turn id and the raw reason', () => {
    const snapshot: DictationSnapshot = {
      revision: 7,
      state: 'failed',
      turnId: 'turn-secret',
      reason: 'secure_field',
      enabled: true
    }
    const status = toDictationStatus(snapshot)
    expect(status).toEqual({
      revision: 7,
      state: 'failed',
      message: DICTATION_REASON_COPY.secure_field,
      enabled: true
    })
    expect(JSON.stringify(status)).not.toContain('turn-secret')
    expect(DictationStatusSchema.safeParse(status).success).toBe(true)
  })

  it('has no message without a reason', () => {
    expect(
      toDictationStatus({ revision: 1, state: 'idle', turnId: null, reason: null, enabled: true }).message
    ).toBeNull()
  })
})

describe('DictationStatusSchema', () => {
  const ok = { revision: 1, state: 'listening', message: null, enabled: true }
  it('accepts a valid status', () => {
    expect(DictationStatusSchema.safeParse(ok).success).toBe(true)
  })
  it('refuses any extra field, so no text can ride along', () => {
    expect(DictationStatusSchema.safeParse({ ...ok, transcript: 'hello' }).success).toBe(false)
    expect(DictationStatusSchema.safeParse({ ...ok, text: 'x' }).success).toBe(false)
  })
  it('refuses an unknown state, a long message and a missing field', () => {
    expect(DictationStatusSchema.safeParse({ ...ok, state: 'recording' }).success).toBe(false)
    expect(DictationStatusSchema.safeParse({ ...ok, message: 'x'.repeat(121) }).success).toBe(false)
    expect(DictationStatusSchema.safeParse({ revision: 1, state: 'idle', enabled: true }).success).toBe(false)
  })
})
