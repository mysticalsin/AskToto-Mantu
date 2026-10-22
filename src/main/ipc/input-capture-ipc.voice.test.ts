import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { InputSessionStopRequestSchema } from '@shared/input-session'
import { InputSessionAuthority } from '../input-session-authority'
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
const frame = { webContentsId: 7, frameId: '12:3', isTopFrame: true, url: senderFrame.url }

type Handler = (event: unknown, request?: unknown) => unknown

type GrantKind = 'click' | 'hardware' | 'hardware-dictation'
function setup(grants: { click: boolean; hardware: boolean; 'hardware-dictation'?: boolean }) {
  const handlers = new Map<string, Handler>()
  const revoked: string[] = []
  let token = 0
  const authority = new InputSessionAuthority({
    token: () => (++token).toString(16).padStart(48, '0'),
    now: () => 1,
    onRevoked: (_owner, _lease, reason) => revoked.push(reason)
  })
  const consume = vi.fn((_frame: unknown, kind: GrantKind = 'click') => {
    const available = grants[kind] === true
    grants[kind] = false
    return available
  })
  const hasPending = vi.fn((_frame: unknown, kind: GrantKind = 'click') => grants[kind] === true)
  const setCommandMicActivationLeaseId = vi.fn()
  const armCommandMicLeaseTimeout = vi.fn()
  const never = { safeParse: () => ({ success: false as const }) }
  registerInputCaptureIpc<unknown, unknown>({
    ipcMain: { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) } as never,
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    inputSessionAuthority: authority,
    commandMicActivationAuthority: { mint: vi.fn(() => false), hasPending, consume, revokeAll: vi.fn() },
    getWin: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { getURL: () => senderFrame.url }
    }),
    getCommandMicActivationLeaseId: () => null,
    setCommandMicActivationLeaseId,
    getCommandSpeechCapture: () => null,
    currentInputSessionContext: () => context,
    captureAuthSessionBoundary: () => () => true,
    commandMicAvailability: () => ({ ok: true }),
    commandMicActivationFrameFromEvent: () => frame,
    commandMicOwner: () => owner,
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
    }
  } as never)
  const call = (channel: string, request?: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error('missing handler')
    return handler(event, request)
  }
  return { authority, call, consume, hasPending, revoked, setCommandMicActivationLeaseId, armCommandMicLeaseTimeout }
}

const ptt = { input: { source: 'push-to-talk', purpose: 'command', activation: 'explicit' }, context }
const panel = { input: { source: 'deliberate-talk', purpose: 'command', activation: 'explicit' }, context }
const wake = { input: { source: 'wake', purpose: 'conversation', activation: 'ambient' }, context }

describe('input-capture IPC voice activation provenance', () => {
  it('a push-to-talk command start consumes a hardware grant and never a click grant', () => {
    const { call, consume } = setup({ click: true, hardware: true })
    const result = call(IPC.inputSessionStart, ptt) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume.mock.calls[0]?.[1]).toBe('hardware')
  })

  it('a push-to-talk command start with only a click grant is refused: the renderer cannot self-activate a voice turn', () => {
    const { call, authority } = setup({ click: true, hardware: false })
    expect(call(IPC.inputSessionStart, ptt)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(authority.activeLease).toBeNull()
  })

  it('the panel (deliberate-talk) start consumes a click grant and can never use the hardware grant', () => {
    const { call, consume, authority } = setup({ click: false, hardware: true })
    expect(call(IPC.inputSessionStart, panel)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(consume.mock.calls[0]?.[1] ?? 'click').toBe('click')
    expect(authority.activeLease).toBeNull()
  })

  it('the renderer readiness check only ever sees click grants', () => {
    const { call, hasPending } = setup({ click: false, hardware: true })
    expect(call(IPC.commandMicActivationReady)).toBe(false)
    expect(hasPending.mock.calls.every((c) => (c[1] ?? 'click') === 'click')).toBe(true)
  })

  it('an explicit hardware push-to-talk turn preempts an ambient lease', () => {
    const { call, authority, revoked } = setup({ click: false, hardware: true })
    expect((call(IPC.inputSessionStart, wake) as { ok: boolean }).ok).toBe(true)
    expect(authority.activeLease?.source).toBe('wake')
    const result = call(IPC.inputSessionStart, ptt) as { ok: boolean; lease?: { source: string } }
    expect(result.ok).toBe(true)
    expect(result.lease?.source).toBe('push-to-talk')
    expect(revoked).toEqual(['arbitration-preempted'])
  })
})

const dictationPtt = { input: { source: 'push-to-talk', purpose: 'dictation', activation: 'explicit' }, context }
const dictationPanel = { input: { source: 'deliberate-talk', purpose: 'dictation', activation: 'explicit' }, context }

describe('input-capture IPC dictation activation provenance (G22)', () => {
  it('a push-to-talk dictation start consumes only the dictation grant', () => {
    const { call, consume } = setup({ click: true, hardware: true, 'hardware-dictation': true })
    expect((call(IPC.inputSessionStart, dictationPtt) as { ok: boolean }).ok).toBe(true)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume.mock.calls[0]?.[1]).toBe('hardware-dictation')
  })

  it('a voice-turn or click grant cannot start a dictation capture', () => {
    const { call, authority } = setup({ click: true, hardware: true })
    expect(call(IPC.inputSessionStart, dictationPtt)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(authority.activeLease).toBeNull()
  })

  it('a dictation grant cannot start a voice turn', () => {
    const { call, authority } = setup({ click: false, hardware: false, 'hardware-dictation': true })
    expect(call(IPC.inputSessionStart, ptt)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(authority.activeLease).toBeNull()
  })

  it('the renderer cannot self-activate dictation from the panel source, even with every grant', () => {
    const { call, consume, authority } = setup({ click: true, hardware: true, 'hardware-dictation': true })
    expect(call(IPC.inputSessionStart, dictationPanel)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(consume).not.toHaveBeenCalled()
    expect(authority.activeLease).toBeNull()
  })

  it('an admitted dictation lease is tracked and given the same start deadline as a command lease', () => {
    const { call, setCommandMicActivationLeaseId, armCommandMicLeaseTimeout } = setup({
      click: false,
      hardware: false,
      'hardware-dictation': true
    })
    const result = call(IPC.inputSessionStart, dictationPtt) as { ok: boolean; lease: { sessionId: string } }
    expect(result.ok).toBe(true)
    expect(setCommandMicActivationLeaseId).toHaveBeenCalledWith(result.lease.sessionId)
    expect(armCommandMicLeaseTimeout).toHaveBeenCalledWith(result.lease.sessionId, 15_000)
  })
})
