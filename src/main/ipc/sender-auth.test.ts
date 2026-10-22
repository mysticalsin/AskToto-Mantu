import { describe, expect, it, vi } from 'vitest'
import { AuditEventRecordSchema } from '@shared/contracts/audit-event'
import { createOwnerSessionAuthority } from '../lifecycle/owner-session-authority'
import { fakeAssertMainWindow, senderEvent, validRef } from '../test-helpers/sender-auth-fixtures'
import { SenderRefusal, createSenderAuthorizer } from './sender-auth'

vi.mock('electron', () => ({ app: {}, safeStorage: {}, webContents: {} }))
vi.mock('../auth', () => ({ authStatus: vi.fn(() => ({ signedIn: true })), authSessionGeneration: vi.fn(() => 5) }))
vi.mock('../logger', () => ({ auditLog: vi.fn() }))

const base = { surface: 'test.surface', allowedFrames: 'main-window-top' } as const
const notOwner = { ...base, requireOwner: false } as const
const owner = { ...base, requireOwner: true } as const

function setup(ownerSession?: { mint: ReturnType<typeof vi.fn>; validate: ReturnType<typeof vi.fn> }) {
  const audit = vi.fn()
  const gate = fakeAssertMainWindow()
  const session = ownerSession ?? {
    mint: vi.fn(() => validRef()),
    validate: vi.fn(() => ({ ok: true as const }))
  }
  const authorize = createSenderAuthorizer({
    assertMainWindow: gate.assert,
    ownerSession: session as never,
    currentContextRevision: () => 11,
    audit,
    now: () => 1_700_000_000_000
  })
  return { authorize, audit, gate, session }
}

function refusal(fn: () => unknown): SenderRefusal {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(SenderRefusal)
    return err as SenderRefusal
  }
  throw new Error('expected a refusal')
}

describe('authorizeSender', () => {
  it('refuses a sender from the wrong window', () => {
    const { authorize, audit, gate } = setup()
    const err = refusal(() => authorize(senderEvent('wrong-window'), notOwner))
    expect(err.reason).toBe('wrong-window')
    expect(gate.denials).toEqual(['sender'])
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('refuses a subframe sender', () => {
    const { authorize } = setup()
    expect(refusal(() => authorize(senderEvent('subframe'), notOwner)).reason).toBe('subframe')
  })

  it('refuses a destroyed sender', () => {
    const { authorize } = setup()
    expect(refusal(() => authorize(senderEvent('destroyed-sender'), notOwner)).reason).toBe('destroyed')
  })

  it('refuses a stale auth generation and emits one content-free ipc.refused event', () => {
    const session = {
      mint: vi.fn(() => validRef()),
      validate: vi.fn(() => ({ ok: false as const, reason: 'stale-auth' as const }))
    }
    const { authorize, audit } = setup(session)
    const err = refusal(() => authorize(senderEvent('main'), owner))
    expect(err.reason).toBe('stale-auth')
    expect(audit).toHaveBeenCalledTimes(1)
    const [name, record] = audit.mock.calls[0]
    expect(name).toBe('ipc.refused')
    expect(AuditEventRecordSchema.safeParse(record).success).toBe(true)
    const json = JSON.stringify(record)
    for (const secret of ['person@example.com', 'app://', '12:3']) expect(json).not.toContain(secret)
  })

  it('returns the current OwnerSessionRef for the top main frame', () => {
    const authority = createOwnerSessionAuthority({
      identityId: () => 'person@example.com',
      tenantId: () => 'tenant-a',
      authGeneration: () => 5,
      currentContextRevision: () => 11,
      salt: () => Buffer.alloc(32, 1),
      webContentsIdOf: () => 7
    })
    const audit = vi.fn()
    const gate = fakeAssertMainWindow()
    const authorize = createSenderAuthorizer({
      assertMainWindow: gate.assert,
      ownerSession: authority,
      currentContextRevision: () => 11,
      audit
    })
    const event = senderEvent('main')
    const ref = authorize(event, owner)
    expect(ref.authGeneration).toBe(5)
    expect(ref.contextRevision).toBe(11)
    expect(ref.frameOwner).toBe('12:3')
    expect(authorize(event, owner)).toBe(ref)
    expect(authority.validate(ref, event.senderFrame as never)).toEqual({ ok: true })
    expect(audit).not.toHaveBeenCalled()
  })

  it('audits a subframe refusal with the reason token only', () => {
    const { authorize, audit } = setup()
    refusal(() => authorize(senderEvent('subframe'), notOwner))
    expect(audit).toHaveBeenCalledTimes(1)
    const record = audit.mock.calls[0][1]
    expect(record.reason).toBe('subframe')
    expect(record.surface).toBe('test.surface')
    expect(record.ownerKey).toBeNull()
    expect(record.sessionId).toBeNull()
  })

  it('refuses signed-out when no owner session can be minted', () => {
    const session = { mint: vi.fn(() => null), validate: vi.fn() }
    const { authorize, audit } = setup(session)
    expect(refusal(() => authorize(senderEvent('main'), owner)).reason).toBe('signed-out')
    expect(session.validate).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('requireOwner false returns null without minting', () => {
    const { authorize, session, audit } = setup()
    expect(authorize(senderEvent('main'), notOwner)).toBeNull()
    expect(session.mint).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('refuses destroyed frame and missing frame', () => {
    const { authorize } = setup()
    expect(refusal(() => authorize(senderEvent('destroyed-frame'), notOwner)).reason).toBe('destroyed')
    expect(refusal(() => authorize(senderEvent('no-frame'), notOwner)).reason).toBe('destroyed')
  })

  it('an audit sink failure does not change the refusal', () => {
    const audit = vi.fn(() => {
      throw new Error('sink down')
    })
    const gate = fakeAssertMainWindow()
    const authorize = createSenderAuthorizer({
      assertMainWindow: gate.assert,
      ownerSession: { mint: vi.fn(), validate: vi.fn() } as never,
      currentContextRevision: () => 11,
      audit
    })
    expect(refusal(() => authorize(senderEvent('subframe'), notOwner)).reason).toBe('subframe')
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('main-window-any and overlay-top fail closed until wired', () => {
    const assertMainWindow = vi.fn()
    const authorize = createSenderAuthorizer({
      assertMainWindow,
      ownerSession: { mint: vi.fn(), validate: vi.fn() } as never,
      currentContextRevision: () => 11,
      audit: vi.fn()
    })
    for (const allowedFrames of ['main-window-any', 'overlay-top'] as const) {
      const err = refusal(() => authorize(senderEvent('main'), { ...notOwner, allowedFrames }))
      expect(err.reason).toBe('wrong-window')
    }
    expect(assertMainWindow).not.toHaveBeenCalled()
  })
})
