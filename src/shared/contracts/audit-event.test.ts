import { describe, expect, it } from 'vitest'
import { AuditEventRecordSchema, CONTRACT_AUDIT_EVENTS } from './audit-event'

const base = {
  v: 1,
  event: 'ipc.refused',
  ownerKey: null,
  sessionId: null,
  surface: 'inputSession.start',
  outcome: 'refused',
  reason: 'wrong-window',
  privacyClass: 'P1',
  ts: 1_700_000_000_000
}

describe('AuditEventRecordSchema', () => {
  it('accepts a minimal content-free ipc.refused record', () => {
    expect(AuditEventRecordSchema.safeParse(base).success).toBe(true)
  })

  it('accepts every reserved contract event name', () => {
    expect(CONTRACT_AUDIT_EVENTS).toHaveLength(8)
    for (const event of CONTRACT_AUDIT_EVENTS) {
      expect(AuditEventRecordSchema.safeParse({ ...base, event }).success).toBe(true)
    }
    expect(AuditEventRecordSchema.safeParse({ ...base, event: 'auth.signin' }).success).toBe(false)
  })

  it('accepts populated owner and session identifiers', () => {
    const record = { ...base, ownerKey: 'ab'.repeat(32), sessionId: '123e4567-e89b-42d3-a456-426614174000' }
    expect(AuditEventRecordSchema.safeParse(record).success).toBe(true)
    expect(AuditEventRecordSchema.safeParse({ ...record, ownerKey: 'user@example.com' }).success).toBe(false)
  })

  it('rejects free-text reasons', () => {
    for (const reason of ['User said hello', 'has space', 'UPPER', 'a'.repeat(49), '']) {
      expect(AuditEventRecordSchema.safeParse({ ...base, reason }).success).toBe(false)
    }
  })

  it('rejects content-bearing extra keys', () => {
    for (const key of ['prompt', 'path', 'transcript', 'payload']) {
      expect(AuditEventRecordSchema.safeParse({ ...base, [key]: 'x' }).success).toBe(false)
    }
  })

  it('rejects P2, P3 and P4 privacy classes', () => {
    for (const privacyClass of ['P2', 'P3', 'P4']) {
      expect(AuditEventRecordSchema.safeParse({ ...base, privacyClass }).success).toBe(false)
    }
    for (const privacyClass of ['P0', 'P1']) {
      expect(AuditEventRecordSchema.safeParse({ ...base, privacyClass }).success).toBe(true)
    }
  })

  it('rejects invalid surface and outcome values', () => {
    expect(AuditEventRecordSchema.safeParse({ ...base, surface: '1bad' }).success).toBe(false)
    expect(AuditEventRecordSchema.safeParse({ ...base, surface: 'has space' }).success).toBe(false)
    expect(AuditEventRecordSchema.safeParse({ ...base, surface: `a${'b'.repeat(64)}` }).success).toBe(false)
    expect(AuditEventRecordSchema.safeParse({ ...base, outcome: 'maybe' }).success).toBe(false)
    expect(AuditEventRecordSchema.safeParse({ ...base, v: 2 }).success).toBe(false)
    expect(AuditEventRecordSchema.safeParse({ ...base, ts: 0 }).success).toBe(false)
  })

  it('enforces the surface length bound', () => {
    expect(AuditEventRecordSchema.safeParse({ ...base, surface: `s${'a'.repeat(63)}` }).success).toBe(true)
    expect(AuditEventRecordSchema.safeParse({ ...base, surface: `s${'a'.repeat(64)}` }).success).toBe(false)
  })
})
