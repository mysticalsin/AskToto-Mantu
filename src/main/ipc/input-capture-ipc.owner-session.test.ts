import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { InputSessionStopRequestSchema } from '@shared/input-session'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import { InputSessionAuthority } from '../input-session-authority'
import { registerInputCaptureIpc } from './input-capture-ipc'

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

function setup(ownerSession?: { mint: ReturnType<typeof vi.fn>; validate: ReturnType<typeof vi.fn> }) {
  const handlers = new Map<string, Handler>()
  const authority = new InputSessionAuthority({ token: () => 'a'.repeat(48), now: () => 1 })
  const never = { safeParse: () => ({ success: false as const }) }
  registerInputCaptureIpc<unknown, unknown>({
    ipcMain: { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) } as never,
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    inputSessionAuthority: authority,
    commandMicActivationAuthority: {
      mint: vi.fn(() => false),
      hasPending: vi.fn(() => false),
      consume: vi.fn(() => false),
      revokeAll: vi.fn()
    },
    getWin: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { getURL: () => 'app://metis/index.html' }
    }),
    getCommandMicActivationLeaseId: () => null,
    setCommandMicActivationLeaseId: vi.fn(),
    getCommandSpeechCapture: () => null,
    currentInputSessionContext: () => context,
    captureAuthSessionBoundary: () => () => true,
    commandMicAvailability: () => ({ ok: true }),
    commandMicActivationFrameFromEvent: () => null,
    commandMicOwner: () => null,
    commandSpeechOwnerFromEvent: () => null,
    commandLeaseCurrentAndAllowed: () => null,
    armCommandMicLeaseTimeout: vi.fn(),
    clearCommandMicLeaseTimer: vi.fn(),
    schemas: {
      inputSessionStop: InputSessionStopRequestSchema,
      commandSpeechStart: never,
      commandSpeechFrame: never,
      commandSpeechFinish: never,
      commandSpeechCancel: never
    },
    ownerSession
  } as never)
  const call = (channel: string, request?: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error('missing handler')
    return handler(event, request)
  }
  const start = () => {
    const result = call(IPC.inputSessionStart, startRequest) as { ok: boolean; lease: { sessionId: string } }
    expect(result.ok).toBe(true)
    return result.lease.sessionId
  }
  return { authority, call, start }
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
})
