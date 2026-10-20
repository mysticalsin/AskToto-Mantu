import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { createOwnerSessionAuthority } from '../lifecycle/owner-session-authority'
import { fakeAssertMainWindow, senderEvent } from '../test-helpers/sender-auth-fixtures'
import { registerOwnerSessionIpc } from './register-owner-session'
import { SenderRefusal } from './sender-auth'

vi.mock('electron', () => ({ app: {}, safeStorage: {}, webContents: {} }))
vi.mock('../auth', () => ({ authStatus: vi.fn(() => ({ signedIn: true })), authSessionGeneration: vi.fn(() => 5) }))
vi.mock('../logger', () => ({ auditLog: vi.fn() }))

type Handler = (event: unknown, payload?: unknown) => unknown

function setup() {
  const state = { identity: 'person@example.com' as string | null, auth: 5, ctx: 11 }
  const authority = createOwnerSessionAuthority({
    identityId: () => state.identity,
    authGeneration: () => state.auth,
    currentContextRevision: () => state.ctx,
    salt: () => Buffer.alloc(32, 1),
    webContentsIdOf: () => 7
  })
  const handlers = new Map<string, Handler>()
  const audit = vi.fn()
  const gate = fakeAssertMainWindow()
  registerOwnerSessionIpc({
    ipcMain: { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) } as never,
    assertMainWindow: gate.assert,
    ownerSession: authority,
    currentInputSessionContext: () => ({ authSessionGeneration: state.auth, contextRevision: state.ctx }),
    audit,
    signedIn: () => state.identity !== null
  })
  const call = (kind: Parameters<typeof senderEvent>[0] = 'main', payload?: unknown) => {
    const handler = handlers.get(IPC.ownerSessionStatus)
    if (!handler) throw new Error('missing handler')
    return handler(senderEvent(kind), payload) as { signedIn: boolean; handle: string | null; authGeneration: number }
  }
  return { state, authority, audit, call }
}

describe('ownerSession:status', () => {
  it('status returns a stable opaque handle for one ref', () => {
    const { call } = setup()
    const first = call()
    const second = call()
    expect(first.signedIn).toBe(true)
    expect(first.handle).not.toBeNull()
    expect(second.handle).toBe(first.handle)
    expect(first.handle).toHaveLength(43)
    expect(first.handle).not.toMatch(/^[0-9a-fA-F]+$/)
    expect(first.authGeneration).toBe(5)
  })

  it('status never exposes the ref, ownerKey or sessionId', () => {
    const { call, authority } = setup()
    const result = call()
    const ref = authority.mint({ processId: 12, routingId: 3 }, 11)
    expect(ref).not.toBeNull()
    const json = JSON.stringify(result)
    expect(json).not.toContain(ref?.ownerKey as string)
    expect(json).not.toContain(ref?.sessionId as string)
    expect(Object.keys(result).sort()).toEqual(['authGeneration', 'handle', 'signedIn'])
  })

  it('status is signed out with a null handle when no ref can be minted', () => {
    const { call, state } = setup()
    state.identity = null
    const result = call()
    expect(result.signedIn).toBe(false)
    expect(result.handle).toBeNull()
  })

  it('a revoked ref drops its handle and the next status issues a new one', () => {
    const { call, authority } = setup()
    const first = call()
    authority.revokeAll('test' as never)
    const second = call()
    expect(second.handle).not.toBeNull()
    expect(second.handle).not.toBe(first.handle)
  })

  it('refuses a wrong-window sender and audits once', () => {
    const { call, audit } = setup()
    expect(() => call('wrong-window')).toThrow(SenderRefusal)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit.mock.calls[0][1].surface).toBe('ownerSession.status')
  })

  it('rejects a non-undefined payload', () => {
    const { call, authority } = setup()
    const mint = vi.spyOn(authority, 'mint')
    expect(() => call('main', { anything: true })).toThrow('invalid_request')
    expect(mint).not.toHaveBeenCalled()
  })
})
