import { describe, expect, it } from 'vitest'
import { expiryReasonAt, MAX_SESSION_AGE_MS, type AuthSession } from './auth-session-policy'
import { SpeechAuthLeaseController } from './auth-speech-lease'

function controllerFixture() {
  let session: AuthSession | null = {
    email: 'owner@example.test',
    domain: 'example.test',
    tid: 'tenant-a',
    at: Date.now()
  }
  let sessionEpoch = 1
  let profilePath = '/private/profile-a'
  const controller = new SpeechAuthLeaseController({
    prepareSession: () => undefined,
    readSession: () => session,
    readSessionEpoch: () => sessionEpoch,
    readProfilePath: () => profilePath,
    readBoundary: async () => null,
    validateSession: () => undefined,
    sessionIsValid: (value, config, now) => expiryReasonAt(value, config, now) === null
  })
  return {
    controller,
    set session(value: AuthSession | null) {
      session = value
    },
    advanceSessionEpoch() {
      sessionEpoch += 1
    },
    changeProfilePath(value: string) {
      profilePath = value
    }
  }
}

const authorizedInput = {
  config: { clientId: 'fixture-client', tenantId: 'tenant-a', allowedDomain: 'example.test' },
  configured: true,
  enforced: true,
  sticky: false,
  authorized: true
}

describe('main persistence auth boundary', () => {
  it('binds hashed principal, original profile and session epoch with a pure current guard', () => {
    const fixture = controllerFixture()
    const boundary = fixture.controller.captureMainPersistenceSessionBoundary(authorizedInput)
    expect(boundary.principalAssociation).toMatch(/^[a-f0-9]{64}$/)
    expect(boundary.principalAssociation).not.toContain('owner@example.test')
    expect(boundary.isCurrent()).toBe(true)
    fixture.advanceSessionEpoch()
    expect(boundary.isCurrent()).toBe(false)
  })

  it('permanently closes when profile/session authority changes or the captured session expires', () => {
    const fixture = controllerFixture()
    const boundary = fixture.controller.captureMainPersistenceSessionBoundary(authorizedInput)
    fixture.changeProfilePath('/private/profile-b')
    expect(boundary.isCurrent()).toBe(false)

    const expired = controllerFixture()
    expired.session = {
      email: 'owner@example.test',
      domain: 'example.test',
      tid: 'tenant-a',
      at: Date.now() - MAX_SESSION_AGE_MS - 1
    }
    const expiredBoundary = expired.controller.captureMainPersistenceSessionBoundary(authorizedInput)
    expect(expiredBoundary.isCurrent()).toBe(false)
  })

  it('closes on main auth invalidation even when the same account signs back in', () => {
    const fixture = controllerFixture()
    const boundary = fixture.controller.captureMainPersistenceSessionBoundary(authorizedInput)
    fixture.controller.invalidate()
    expect(boundary.isCurrent()).toBe(false)
  })

  it('allows only an explicitly unconfigured local profile without a verified account', () => {
    const local = controllerFixture()
    local.session = null
    const boundary = local.controller.captureMainPersistenceSessionBoundary({
      config: null,
      configured: false,
      enforced: false,
      sticky: false,
      authorized: true
    })
    expect(boundary.configured).toBe(false)
    expect(boundary.principalAssociation).toBeNull()
    expect(boundary.isCurrent()).toBe(true)

    const required = local.controller.captureMainPersistenceSessionBoundary({
      config: null,
      configured: false,
      enforced: true,
      sticky: false,
      authorized: false
    })
    expect(required.isCurrent()).toBe(false)
  })
})
