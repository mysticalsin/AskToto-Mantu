import { describe, expect, it, vi } from 'vitest'
import { AuditEventRecordSchema } from '@shared/contracts/audit-event'
import { OwnerSessionRefSchema } from '@shared/contracts/owner-session'
import { createLanguageChangeAudit, languageChangeAuditRecord } from './cloud-speech-language-audit'

const ref = OwnerSessionRefSchema.parse({
  v: 1,
  ownerKey: 'ab'.repeat(32),
  authGeneration: 3,
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
  frameOwner: '11:2',
  contextRevision: 1,
  issuedAt: 1_700_000_000_000
})

describe('languageChangeAuditRecord', () => {
  it('records an applied change as allowed/user-selected and a no-op as allowed/unchanged', () => {
    expect(languageChangeAuditRecord(ref, { ok: true, changed: true }, 5)).toEqual({
      v: 1,
      event: 'speech.language.change',
      ownerKey: ref.ownerKey,
      sessionId: ref.sessionId,
      surface: 'cloudSpeech.language',
      outcome: 'allowed',
      reason: 'user-selected',
      privacyClass: 'P1',
      ts: 5
    })
    expect(languageChangeAuditRecord(ref, { ok: true, changed: false }, 5)).toMatchObject({
      outcome: 'allowed',
      reason: 'unchanged'
    })
  })

  it('maps refusals and failures to enum-like reasons', () => {
    expect(languageChangeAuditRecord(ref, { ok: false, code: 'POLICY' }, 5)).toMatchObject({
      outcome: 'refused',
      reason: 'policy'
    })
    expect(languageChangeAuditRecord(ref, { ok: false, code: 'INVALID_REQUEST' }, 5)).toMatchObject({
      outcome: 'refused',
      reason: 'invalid-request'
    })
    expect(languageChangeAuditRecord(ref, { ok: false, code: 'TRANSPORT' }, 5)).toMatchObject({
      outcome: 'failed',
      reason: 'transport'
    })
    expect(languageChangeAuditRecord(ref, { ok: false, code: 'CLOSURE_UNCONFIRMED' }, 5)).toMatchObject({
      outcome: 'failed',
      reason: 'closure-unconfirmed'
    })
  })

  it('is content-free and valid for a signed-out session', () => {
    const record = languageChangeAuditRecord(null, { ok: true, changed: true }, 5)
    expect(record).toMatchObject({ ownerKey: null, sessionId: null })
    expect(AuditEventRecordSchema.safeParse(record).success).toBe(true)
    expect(Object.keys(record ?? {}).sort()).toEqual(
      ['event', 'outcome', 'ownerKey', 'privacyClass', 'reason', 'sessionId', 'surface', 'ts', 'v'].sort()
    )
  })

  it('returns null rather than an invalid record', () => {
    expect(languageChangeAuditRecord(ref, { ok: true, changed: true }, 0)).toBeNull()
  })
})

describe('createLanguageChangeAudit', () => {
  const owner = { binding: { processId: 11, routingId: 2 } } as never

  it('resolves the owner from the capture frame and audits once', () => {
    const audit = vi.fn()
    const resolveOwner = vi.fn(() => ref)
    createLanguageChangeAudit({ resolveOwner, audit, now: () => 9 })(owner, { ok: true, changed: true })
    expect(resolveOwner).toHaveBeenCalledWith({ processId: 11, routingId: 2 })
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(
      'speech.language.change',
      expect.objectContaining({ ownerKey: ref.ownerKey, ts: 9 })
    )
  })

  it('never throws when the resolver or the sink throws', () => {
    const throwing = () => {
      throw new Error('boom')
    }
    expect(() =>
      createLanguageChangeAudit({ resolveOwner: throwing, audit: vi.fn() })(owner, { ok: true, changed: true })
    ).not.toThrow()
    expect(() =>
      createLanguageChangeAudit({ resolveOwner: () => null, audit: throwing })(owner, { ok: true, changed: true })
    ).not.toThrow()
  })
})
