import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { InputSessionStopRequestSchema } from '@shared/input-session'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import { InputSessionAuthority } from '../input-session-authority'
import { createOwnerSessionAuthority } from '../lifecycle/owner-session-authority'
import { registerInputCaptureIpc } from './input-capture-ipc'

vi.mock('electron', () => ({ app: {}, safeStorage: {}, webContents: {} }))
vi.mock('../auth', () => ({ authStatus: vi.fn(), authSessionGeneration: vi.fn() }))

const context = { authSessionGeneration: 5, contextRevision: 11 } as const
const senderFrame = { parent: null, url: 'app://metis/index.html', processId: 12, routingId: 3 }
const event = { sender: { id: 7 }, senderFrame }
const owner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 5,
  contextRevision: 11
} as const
const startRequest = {
  input: { source: 'push-to-talk', purpose: 'conversation', activation: 'explicit' },
  context
}
const commandStartRequest = {
  input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
  context
}

const ref: OwnerSessionRef = Object.freeze({
  v: 1,
  ownerKey: 'a'.repeat(64),
  authGeneration: 5,
  sessionId: '00000000-0000-4000-8000-000000000001',
  frameOwner: '12:3',
  contextRevision: 11,
  issuedAt: 1_700_000_000_000
})

type Handler = (event: unknown, request?: unknown) => unknown

function setup(
  ownerSession?: { mint: ReturnType<typeof vi.fn>; validate: ReturnType<typeof vi.fn> },
  authorizeSender?: ReturnType<typeof vi.fn>,
  options: {
    allowCommandStart?: boolean
    onLeaseRevoked?: NonNullable<ConstructorParameters<typeof InputSessionAuthority>[0]>['onRevoked']
    token?: () => string
  } = {}
) {
  const handlers = new Map<string, Handler>()
  const authority = new InputSessionAuthority({
    token: options.token ?? (() => 'a'.repeat(48)),
    now: () => 1,
    onRevoked: options.onLeaseRevoked
  })
  const never = { safeParse: () => ({ success: false as const }) }
  let commandMicActivationLeaseId: string | null = null
  const setCommandMicActivationLeaseId = vi.fn((id: string | null) => {
    commandMicActivationLeaseId = id
  })
  const armCommandMicLeaseTimeout = vi.fn()
  const consumeCommandMicActivation = vi.fn(() => options.allowCommandStart === true)
  registerInputCaptureIpc<unknown, unknown>({
    ipcMain: { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) } as never,
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    inputSessionAuthority: authority,
    commandMicActivationAuthority: {
      mint: vi.fn(() => false),
      hasPending: vi.fn(() => false),
      consume: consumeCommandMicActivation,
      revokeAll: vi.fn()
    },
    getWin: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { getURL: () => 'app://metis/index.html' }
    }),
    getCommandMicActivationLeaseId: () => commandMicActivationLeaseId,
    setCommandMicActivationLeaseId,
    getCommandSpeechCapture: () => null,
    currentInputSessionContext: () => context,
    captureAuthSessionBoundary: () => () => true,
    commandMicAvailability: () => ({ ok: true }),
    commandMicActivationFrameFromEvent: () => (options.allowCommandStart ? {} : null),
    commandMicOwner: () => (options.allowCommandStart ? {} : null),
    commandSpeechOwnerFromEvent: () => null,
    commandLeaseCurrentAndAllowed: () => null,
    armCommandMicLeaseTimeout,
    clearCommandMicLeaseTimer: vi.fn(),
    schemas: {
      inputSessionStop: InputSessionStopRequestSchema,
      commandSpeechStart: never,
      commandSpeechFrame: never,
      commandSpeechFinish: never,
      commandSpeechCancel: never
    },
    ownerSession,
    authorizeSender
  } as never)
  const call = (channel: string, request?: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error('missing handler')
    return handler(event, request)
  }
  const start = (request: unknown = startRequest) => {
    const result = call(IPC.inputSessionStart, request) as { ok: boolean; lease: { sessionId: string } }
    expect(result.ok).toBe(true)
    return result.lease.sessionId
  }
  return { authority, call, start, armCommandMicLeaseTimeout, setCommandMicActivationLeaseId }
}

describe('input-capture IPC owner-session admission', () => {
  it('confirm is refused when the owner-session ref no longer validates', () => {
    const ownerSession = { mint: vi.fn(() => ref), validate: vi.fn(() => ({ ok: false, reason: 'revoked' })) }
    const { authority, call, start } = setup(ownerSession)
    const sessionId = start()
    authority.claimPermissionRequest(owner)
    expect(call(IPC.inputSessionConfirm, { sessionId, context })).toBe(false)
    expect(ownerSession.validate).toHaveBeenCalledTimes(1)
    // A retry must not fall through to the unchanged logic: the refusal sticks for this lease.
    expect(call(IPC.inputSessionConfirm, { sessionId, context })).toBe(false)
    expect(ownerSession.validate).toHaveBeenCalledTimes(2)
    expect(authority.activeLease?.sessionId).toBe(sessionId)
  })

  it('confirm proceeds when the ref validates', () => {
    const ownerSession = { mint: vi.fn(() => ref), validate: vi.fn(() => ({ ok: true })) }
    const { authority, call, start } = setup(ownerSession)
    const sessionId = start()
    authority.claimPermissionRequest(owner)
    expect(call(IPC.inputSessionConfirm, { sessionId, context })).toBe(true)
    expect(ownerSession.validate).toHaveBeenCalledWith(ref, senderFrame)
  })

  it('without an owner-session authority confirm behaves as before', () => {
    const { authority, call, start } = setup()
    const sessionId = start()
    authority.claimPermissionRequest(owner)
    expect(call(IPC.inputSessionConfirm, { sessionId, context })).toBe(true)
  })

  it('keeps admission compatible when owner-session mint returns null', () => {
    const ownerSession = { mint: vi.fn(() => null), validate: vi.fn() }
    const { authority, call, start } = setup(ownerSession)
    const sessionId = start()

    expect(ownerSession.mint).toHaveBeenCalledWith(senderFrame, context.contextRevision)
    expect(authority.activeLease?.sessionId).toBe(sessionId)
    expect(authority.claimPermissionRequest(owner)).toBe(true)
    expect(call(IPC.inputSessionConfirm, { sessionId, context })).toBe(true)
    expect(ownerSession.validate).not.toHaveBeenCalled()
  })

  it('start mints a ref bound to the lease and stop releases it', () => {
    const ownerSession = { mint: vi.fn(() => ref), validate: vi.fn(() => ({ ok: true })) }
    const { call, start } = setup(ownerSession)
    const sessionId = start()
    expect(ownerSession.mint).toHaveBeenCalledWith(senderFrame, 11)
    const stopped = call(IPC.inputSessionStop, { sessionId, context }) as { ok: boolean }
    expect(stopped.ok).toBe(true)
    call(IPC.inputSessionConfirm, { sessionId, context })
    expect(ownerSession.validate).not.toHaveBeenCalled()
  })

  it('input-session handlers route through authorizeSender when provided', () => {
    const authorizeSender = vi.fn(() => null)
    const { start } = setup(undefined, authorizeSender)
    start()
    expect(authorizeSender).toHaveBeenCalledWith(event, {
      surface: 'inputSession',
      requireOwner: false,
      allowedFrames: 'main-window-top'
    })
  })

  it('a refusal from authorizeSender propagates and the authority is not reached', () => {
    const ownerSession = { mint: vi.fn(() => ref), validate: vi.fn(() => ({ ok: true })) }
    const authorizeSender = vi.fn(() => {
      throw new Error('IPC refused: wrong-window')
    })
    const { authority, call } = setup(ownerSession, authorizeSender)
    expect(() => call(IPC.inputSessionStart, startRequest)).toThrow('IPC refused: wrong-window')
    expect(authority.activeLease).toBeNull()
    expect(ownerSession.mint).not.toHaveBeenCalled()
  })

  it('rolls back the new lease when owner-session mint throws', () => {
    let authorityForMint: InputSessionAuthority | null = null
    let attemptedSessionId: string | null = null
    const onLeaseRevoked = vi.fn()
    const ownerSession = {
      mint: vi.fn(() => {
        attemptedSessionId = authorityForMint?.activeLease?.sessionId ?? null
        throw new Error('mint failed')
      }),
      validate: vi.fn()
    }
    const { authority, call, armCommandMicLeaseTimeout, setCommandMicActivationLeaseId } = setup(
      ownerSession,
      undefined,
      { allowCommandStart: true, onLeaseRevoked }
    )
    authorityForMint = authority
    const confirmCapture = vi.spyOn(authority, 'confirmCapture')
    const hardStop = vi.spyOn(authority, 'hardStop')

    const result = call(IPC.inputSessionStart, commandStartRequest)

    expect(result).toEqual({ ok: false, reason: 'stale_session' })
    expect(ownerSession.mint).toHaveBeenCalledWith(senderFrame, context.contextRevision)
    expect(attemptedSessionId).toBe('a'.repeat(48))
    expect(authority.activeLease).toBeNull()
    expect(authority.ownsInteractiveOwner(owner.webContentsId)).toBe(false)
    expect(authority.claimPermissionRequest(owner)).toBe(false)
    expect(authority.hasPermissionRequestOwner(owner)).toBe(false)
    expect(authority.hasPermissionCheckOwner(owner)).toBe(false)
    expect(call(IPC.inputSessionConfirm, { sessionId: attemptedSessionId, context })).toBe(false)
    expect(confirmCapture).toHaveBeenCalledTimes(1)
    expect(ownerSession.validate).not.toHaveBeenCalled()
    expect(onLeaseRevoked).not.toHaveBeenCalled()
    expect(hardStop).not.toHaveBeenCalled()
    expect(setCommandMicActivationLeaseId).not.toHaveBeenCalled()
    expect(armCommandMicLeaseTimeout).not.toHaveBeenCalled()
  })

  it('preserves a busy established command lease and its owner without minting another ref', () => {
    const ownerSession = { mint: vi.fn(() => ref), validate: vi.fn(() => ({ ok: true })) }
    const { authority, call, start, armCommandMicLeaseTimeout, setCommandMicActivationLeaseId } = setup(
      ownerSession,
      undefined,
      { allowCommandStart: true }
    )
    const sessionId = start(commandStartRequest)
    expect(authority.claimPermissionRequest(owner)).toBe(true)
    expect(authority.confirmCapture(owner, sessionId)).toBe(true)
    expect(authority.isEstablishedLease(owner, sessionId, 'command')).toBe(true)

    const second = call(IPC.inputSessionStart, commandStartRequest)

    expect(second).toEqual({ ok: false, reason: 'busy' })
    expect(ownerSession.mint).toHaveBeenCalledTimes(1)
    expect(authority.activeLease?.sessionId).toBe(sessionId)
    expect(authority.ownsInteractiveOwner(owner.webContentsId)).toBe(true)
    expect(authority.isEstablishedLease(owner, sessionId, 'command')).toBe(true)
    expect(setCommandMicActivationLeaseId).toHaveBeenCalledTimes(1)
    expect(setCommandMicActivationLeaseId).toHaveBeenCalledWith(sessionId)
    expect(armCommandMicLeaseTimeout).toHaveBeenCalledTimes(1)
    expect(armCommandMicLeaseTimeout).toHaveBeenCalledWith(sessionId, 15_000)
    ownerSession.validate.mockClear()
    expect(call(IPC.inputSessionConfirm, { sessionId, context })).toBe(false)
    expect(ownerSession.validate).toHaveBeenCalledWith(ref, senderFrame)
  })

  it('does not roll back a successor lease created reentrantly during revocation', () => {
    let callStart: (() => unknown) | null = null
    let authorityForMint: InputSessionAuthority | null = null
    let mintCalls = 0
    let attemptedLeaseId: string | null = null
    let tokenCounter = 0
    const ownerSession = {
      mint: vi.fn(() => {
        mintCalls += 1
        if (mintCalls === 1) {
          attemptedLeaseId = authorityForMint?.activeLease?.sessionId ?? null
          authorityForMint?.hardStop('auth-revoked')
          throw new Error('outer mint failed')
        }
        return ref
      }),
      validate: vi.fn(() => ({ ok: false, reason: 'revoked' }))
    }
    const revoked = vi.fn()
    const setupResult = setup(ownerSession, undefined, {
      allowCommandStart: true,
      onLeaseRevoked: (revokedOwner, revokedLease, reason) => {
        revoked(revokedOwner, revokedLease, reason)
        if (!callStart) throw new Error('start callback not initialized')
        callStart()
      },
      token: () => String(++tokenCounter).padStart(48, '0')
    })
    authorityForMint = setupResult.authority
    callStart = () => setupResult.call(IPC.inputSessionStart, commandStartRequest)
    const authority = setupResult.authority
    const hardStop = vi.spyOn(authority, 'hardStop')

    const outer = setupResult.call(IPC.inputSessionStart, commandStartRequest)

    expect(outer).toEqual({ ok: false, reason: 'stale_session' })
    expect(ownerSession.mint).toHaveBeenCalledTimes(2)
    expect(hardStop).toHaveBeenCalledWith('auth-revoked')
    expect(hardStop).toHaveBeenCalledTimes(1)
    expect(revoked).toHaveBeenCalledTimes(1)
    expect(attemptedLeaseId).toBe('1'.padStart(48, '0'))
    expect(authority.activeLease).not.toBeNull()
    expect(authority.ownsInteractiveOwner(owner.webContentsId)).toBe(true)
    expect(authority.activeLease?.sessionId).toBe('2'.padStart(48, '0'))
    expect(authority.activeLease?.sessionId).not.toBe(attemptedLeaseId)
    expect(authority.claimPermissionRequest(owner)).toBe(true)
    ownerSession.validate.mockClear()
    expect(setupResult.call(IPC.inputSessionConfirm, { sessionId: authority.activeLease?.sessionId, context })).toBe(false)
    expect(ownerSession.validate).toHaveBeenCalledWith(ref, senderFrame)
    expect(setupResult.setCommandMicActivationLeaseId).toHaveBeenCalledTimes(1)
    expect(setupResult.setCommandMicActivationLeaseId).toHaveBeenCalledWith('2'.padStart(48, '0'))
    expect(setupResult.armCommandMicLeaseTimeout).toHaveBeenCalledTimes(1)
    expect(setupResult.armCommandMicLeaseTimeout).toHaveBeenCalledWith('2'.padStart(48, '0'), 15_000)
  })

  it('turns real owner-session capacity refusal into stale_session without leaving an input lease', () => {
    let nextId = 0
    const ownerAuthority = createOwnerSessionAuthority({
      identityId: () => 'person@example.com',
      authGeneration: () => context.authSessionGeneration,
      currentContextRevision: () => context.contextRevision,
      salt: () => Buffer.alloc(32, 9),
      webContentsIdOf: () => event.sender.id,
      uuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`
    })
    const revoked = vi.fn()
    ownerAuthority.onRevoked(revoked)
    let current: OwnerSessionRef | null = ownerAuthority.mint(senderFrame, context.contextRevision + 100)
    if (!current) throw new Error('expected initial owner-session ref')
    for (let refresh = 0; refresh < 64; refresh += 1) {
      const next = ownerAuthority.mint(senderFrame, context.contextRevision + 101 + refresh)
      if (!next) throw new Error('expected owner-session refresh')
      current = next
    }
    const validate = vi.fn((candidate: OwnerSessionRef, frame: typeof senderFrame) =>
      ownerAuthority.validate(candidate, frame)
    )
    const realOwnerSession = {
      mint: vi.fn(ownerAuthority.mint),
      validate
    }
    const { authority, call, armCommandMicLeaseTimeout, setCommandMicActivationLeaseId } = setup(realOwnerSession)

    const result = call(IPC.inputSessionStart, startRequest)

    expect(result).toEqual({ ok: false, reason: 'stale_session' })
    expect(authority.activeLease).toBeNull()
    expect(authority.ownsInteractiveOwner(owner.webContentsId)).toBe(false)
    expect(authority.claimPermissionRequest(owner)).toBe(false)
    expect(call(IPC.inputSessionConfirm, { sessionId: 'a'.repeat(48), context })).toBe(false)
    expect(validate).not.toHaveBeenCalled()
    expect(ownerAuthority.current(senderFrame)).toBe(current)
    expect(revoked).not.toHaveBeenCalled()
    expect(setCommandMicActivationLeaseId).not.toHaveBeenCalled()
    expect(armCommandMicLeaseTimeout).not.toHaveBeenCalled()
  })
})
