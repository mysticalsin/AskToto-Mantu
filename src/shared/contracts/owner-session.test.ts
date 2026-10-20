import { describe, expect, it } from 'vitest'
import {
  OWNER_SESSION_REVOKE_REASONS,
  OwnerSessionHandleSchema,
  OwnerSessionRefSchema,
  OwnerSessionRevokeReasonSchema,
  OwnerSessionStatusSchema
} from './owner-session'

const validRef = {
  v: 1,
  ownerKey: 'ab'.repeat(32),
  authGeneration: 3,
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
  frameOwner: '12:3',
  contextRevision: 7,
  issuedAt: 1_700_000_000_000
}
const validHandle = 'Zk3_-QwErTyUiOpAsDfGhJkLzXcVbNm1234567890xy'

describe('OwnerSessionRefSchema', () => {
  it('rejects refs with unknown version', () => {
    expect(OwnerSessionRefSchema.safeParse(validRef).success).toBe(true)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, v: 0 }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, v: 2 }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, v: '1' }).success).toBe(false)
    const { v: _v, ...withoutVersion } = validRef
    expect(OwnerSessionRefSchema.safeParse(withoutVersion).success).toBe(false)
  })

  it('rejects extra keys on OwnerSessionRef', () => {
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, email: 'a@b.co' }).success).toBe(false)
  })

  it('rejects ownerKey that is not 64 lowercase hex', () => {
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, ownerKey: 'AB'.repeat(32) }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, ownerKey: 'a'.repeat(63) }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, ownerKey: 'user@example.com' }).success).toBe(false)
  })

  it('validates frameOwner as processId:routingId', () => {
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, frameOwner: '12:3' }).success).toBe(true)
    for (const bad of ['12', 'a:1', '1:2:3', '99999999999999999999:1', '1:99999999999999999999']) {
      expect(OwnerSessionRefSchema.safeParse({ ...validRef, frameOwner: bad }).success).toBe(false)
    }
  })

  it('requires a uuid sessionId', () => {
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, sessionId: 'not-a-uuid' }).success).toBe(false)
  })

  it('rejects negative or fractional generations and nonpositive issuedAt', () => {
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, authGeneration: -1 }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, authGeneration: 1.5 }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, contextRevision: -1 }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, contextRevision: 0.5 }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, issuedAt: 0 }).success).toBe(false)
    expect(OwnerSessionRefSchema.safeParse({ ...validRef, issuedAt: -5 }).success).toBe(false)
  })
})

describe('OwnerSessionHandleSchema', () => {
  it('handle schema never contains ownerKey material', () => {
    expect(OwnerSessionHandleSchema.safeParse(validRef.ownerKey).success).toBe(false)
    expect(OwnerSessionHandleSchema.safeParse('ab'.repeat(16)).success).toBe(false)
    expect(OwnerSessionHandleSchema.safeParse({ ownerKey: validRef.ownerKey }).success).toBe(false)
    expect(
      OwnerSessionStatusSchema.safeParse({
        signedIn: true,
        handle: validHandle,
        authGeneration: 1,
        ownerKey: validRef.ownerKey
      }).success
    ).toBe(false)
    expect(
      OwnerSessionStatusSchema.safeParse({
        signedIn: true,
        handle: validHandle,
        authGeneration: 1,
        sessionId: validRef.sessionId
      }).success
    ).toBe(false)
    const parsed = OwnerSessionStatusSchema.parse({ signedIn: true, handle: validHandle, authGeneration: 1 })
    expect(Object.keys(parsed).sort()).toEqual(['authGeneration', 'handle', 'signedIn'])
  })

  it('accepts a random base64url handle and rejects malformed ones', () => {
    expect(validHandle.length).toBe(43)
    expect(OwnerSessionHandleSchema.safeParse(validHandle).success).toBe(true)
    expect(OwnerSessionHandleSchema.safeParse('Zk3_-QwErTyUiOpAsDfGhJkLzXcVbNm').success).toBe(false)
    expect(OwnerSessionHandleSchema.safeParse(`${validHandle}${'Q'.repeat(22)}`).success).toBe(false)
    expect(OwnerSessionHandleSchema.safeParse('Zk3+/QwErTyUiOpAsDfGhJkLzXcVbNm1234567890=').success).toBe(false)
  })
  it('enforces handle length bounds of 32 to 64 characters', () => {
    expect(OwnerSessionHandleSchema.safeParse('Q'.repeat(31)).success).toBe(false)
    expect(OwnerSessionHandleSchema.safeParse('Q'.repeat(32)).success).toBe(true)
    expect(OwnerSessionHandleSchema.safeParse('Q'.repeat(64)).success).toBe(true)
    expect(OwnerSessionHandleSchema.safeParse('Q'.repeat(65)).success).toBe(false)
  })
})

describe('OwnerSessionStatusSchema', () => {
  it('status requires null handle when signed out', () => {
    expect(OwnerSessionStatusSchema.safeParse({ signedIn: false, handle: null, authGeneration: 0 }).success).toBe(true)
    expect(
      OwnerSessionStatusSchema.safeParse({ signedIn: false, handle: validHandle, authGeneration: 0 }).success
    ).toBe(false)
    expect(OwnerSessionStatusSchema.safeParse({ signedIn: true, handle: validHandle, authGeneration: 2 }).success).toBe(
      true
    )
  })
})

describe('OwnerSessionRevokeReasonSchema', () => {
  it('enumerates revoke reasons', () => {
    for (const reason of OWNER_SESSION_REVOKE_REASONS) {
      expect(OwnerSessionRevokeReasonSchema.safeParse(reason).success).toBe(true)
    }
    expect(OWNER_SESSION_REVOKE_REASONS).toHaveLength(6)
    expect(OwnerSessionRevokeReasonSchema.safeParse('auth-revoked').success).toBe(false)
  })
})
