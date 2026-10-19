import { describe, expect, it, vi } from 'vitest'
import { InputSessionAuthority } from './input-session-authority'
import { createInputSessionHandlers } from './input-session-ipc'

const context = { authSessionGeneration: 5, contextRevision: 11 } as const
const event = {
  sender: { id: 7 },
  senderFrame: { parent: null, url: 'app://metis/index.html', processId: 12, routingId: 3 }
}
type TestEvent = {
  sender: { id: number }
  senderFrame?: { parent: unknown | null; url: string; processId: number; routingId: number } | null
}

describe('input-session IPC owner binding', () => {
  it('refuses a command lease when main has not authorized the command start', () => {
    const authorize = vi.fn(() => false)
    const base = {
      authority: new InputSessionAuthority({ token: () => 'd'.repeat(48), now: () => 1 }),
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => true,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => context,
      captureAuthBoundary: () => () => true
    }
    const request = { input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' }, context }
    expect(createInputSessionHandlers<TestEvent>(base).start(event, request)).toEqual({
      ok: false,
      reason: 'unauthorized'
    })
    expect(createInputSessionHandlers<TestEvent>({ ...base, authorizeCommandStart: authorize }).start(event, request)).toEqual({
      ok: false,
      reason: 'unauthorized'
    })
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('derives the session owner from the authenticated top-frame event', () => {
    const handlers = createInputSessionHandlers<TestEvent>({
      authority: new InputSessionAuthority({ token: () => 'a'.repeat(48), now: () => 1 }),
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => true,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => context,
      captureAuthBoundary: () => () => true,
      authorizeCommandStart: () => true
    })
    const started = handlers.start(event, {
      input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
      context
    })
    expect(started.ok && started.lease.actionAuthority).toBe(false)
    if (!started.ok) throw new Error('expected test session')
    expect(handlers.stop({ ...event, sender: { id: 8 } }, { sessionId: started.lease.sessionId, context })).toEqual({
      ok: false,
      reason: 'stale_session'
    })
  })

  it('confirms only the exact permission-authorized lease from the current top frame', () => {
    const authority = new InputSessionAuthority({ token: () => 'c'.repeat(48), now: () => 1 })
    const handlers = createInputSessionHandlers<TestEvent>({
      authority,
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => true,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => context,
      captureAuthBoundary: () => () => true
    })
    const started = handlers.start(event, {
      input: { source: 'push-to-talk', purpose: 'dictation', activation: 'explicit' },
      context
    })
    if (!started.ok) throw new Error('expected test lease')
    expect(
      authority.claimPermissionRequest({
        webContentsId: event.sender.id,
        frameId: '12:3',
        isTopFrame: true,
        ...context
      })
    ).toBe(true)
    expect(handlers.confirm({ ...event, sender: { id: 8 } }, { sessionId: started.lease.sessionId, context })).toBe(
      false
    )
    expect(
      handlers.confirm(event, { sessionId: started.lease.sessionId, context: { ...context, contextRevision: 12 } })
    ).toBe(false)
    expect(handlers.confirm(event, { sessionId: started.lease.sessionId, context })).toBe(true)
    expect(handlers.confirm(event, { sessionId: started.lease.sessionId, context })).toBe(false)
  })

  it('rejects an extra forged owner field under the strict start schema', () => {
    const handlers = createInputSessionHandlers<TestEvent>({
      authority: new InputSessionAuthority(),
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => true,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => context,
      captureAuthBoundary: () => () => true,
      authorizeCommandStart: () => true
    })
    expect(
      handlers.start(event, {
        input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit', webContentsId: 99 },
        context
      })
    ).toEqual({ ok: false, reason: 'invalid_request' })
  })

  it('rejects unauthenticated or non-top-frame requests before granting authority', () => {
    const authority = new InputSessionAuthority()
    const unauthenticated = createInputSessionHandlers<TestEvent>({
      authority,
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => false,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => context,
      captureAuthBoundary: () => () => true,
      authorizeCommandStart: () => true
    })
    expect(
      unauthenticated.start(event, {
        input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
        context
      })
    ).toEqual({ ok: false, reason: 'unauthorized' })
    expect(authority.activeLease).toBeNull()
    const authenticated = createInputSessionHandlers<TestEvent>({
      authority,
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => true,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => context,
      captureAuthBoundary: () => () => true
    })
    expect(
      authenticated.start(
        { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
        {
          input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
          context
        }
      )
    ).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('rejects stale auth/context snapshots and reconciles an older active lease', () => {
    let current: { authSessionGeneration: number; contextRevision: number } = context
    const authority = new InputSessionAuthority({ token: () => 'a'.repeat(48), now: () => 1 })
    const handlers = createInputSessionHandlers<TestEvent>({
      authority,
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => true,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => current,
      captureAuthBoundary: () => () => true,
      authorizeCommandStart: () => true
    })
    const initial = handlers.start(event, {
      input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
      context
    })
    expect(initial.ok).toBe(true)
    current = { authSessionGeneration: 6, contextRevision: 11 }
    expect(
      handlers.start(event, {
        input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
        context
      })
    ).toEqual({ ok: false, reason: 'stale_session' })
    expect(authority.activeLease).toBeNull()
    expect(
      handlers.start(event, {
        input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
        context: current
      }).ok
    ).toBe(true)
  })

  it('rejects work captured before a main-frame context revision change', () => {
    let current: { authSessionGeneration: number; contextRevision: number } = context
    const authority = new InputSessionAuthority({ token: () => 'b'.repeat(48), now: () => 2 })
    const handlers = createInputSessionHandlers<TestEvent>({
      authority,
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => true,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => current,
      captureAuthBoundary: () => () => true
    })
    const initial = handlers.start(event, {
      input: { source: 'push-to-talk', purpose: 'dictation', activation: 'explicit' },
      context
    })
    expect(initial.ok).toBe(true)
    current = { authSessionGeneration: 5, contextRevision: 12 }
    expect(
      handlers.stop(event, {
        sessionId: initial.ok ? initial.lease.sessionId : '0'.repeat(48),
        context
      })
    ).toEqual({ ok: false, reason: 'stale_session' })
    expect(authority.activeLease).toBeNull()
    expect(
      handlers.start(event, {
        input: { source: 'push-to-talk', purpose: 'dictation', activation: 'explicit' },
        context: current
      }).ok
    ).toBe(true)
  })

  it('rejects a captured auth boundary that expires while the renderer context still matches', () => {
    let authBoundaryValid = true
    const authority = new InputSessionAuthority()
    const handlers = createInputSessionHandlers<TestEvent>({
      authority,
      assertMainWindow: vi.fn(),
      isWindowVisible: () => true,
      requireAuth: () => true,
      currentMainUrl: () => 'app://metis/index.html',
      currentContext: () => context,
      captureAuthBoundary: () => () => authBoundaryValid,
      authorizeCommandStart: () => true
    })
    const started = handlers.start(event, {
      input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
      context
    })
    expect(started.ok).toBe(true)
    authBoundaryValid = false
    expect(
      handlers.stop(event, {
        sessionId: started.ok ? started.lease.sessionId : '0'.repeat(48),
        context
      })
    ).toEqual({ ok: false, reason: 'stale_session' })
    expect(authority.activeLease).toBeNull()
  })
})
