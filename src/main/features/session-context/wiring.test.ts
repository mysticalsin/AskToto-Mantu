import { describe, expect, it, vi } from 'vitest'
import { CloudSpeechEventSchema } from '@shared/cloud-speech'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import { SESSION_CONTEXT_IPC } from '@shared/session-context-request'
import type { AuthorizeSender } from '../../ipc/sender-auth'
import { bindMeetingContexts, meetingPermissions, type DeliveredSpeechOwner, type MeetingContextsDeps } from './wiring'
import { transcriptTailText } from './transcript-text'

const STARTED = 1_700_000_000_000
const HEX = 'a'.repeat(64)

function ref(frameOwner: `${number}:${number}` = '12:3'): OwnerSessionRef {
  return {
    v: 1,
    ownerKey: HEX,
    tenantKey: 'b'.repeat(64),
    authGeneration: 1,
    sessionId: '22222222-2222-4222-8222-222222222222',
    frameOwner,
    contextRevision: 1,
    issuedAt: 1_700_000_000_000
  }
}

const event = CloudSpeechEventSchema.parse({
  type: 'segment',
  captureId: '11111111-1111-4111-8111-111111111111',
  captureGeneration: 1,
  sequence: 1,
  segment: {
    stream: { generation: 1, track: 'system', epoch: 1 },
    engine: 'deepgram-nova3',
    index: 1,
    revision: 1,
    final: true,
    text: 'hello from relay',
    startMs: 1_000,
    endMs: 1_500
  }
})

const owner = (over: Partial<DeliveredSpeechOwner> = {}): DeliveredSpeechOwner => ({
  binding: { processId: 12, routingId: 3 },
  captureContext: { listenStartedAt: STARTED },
  ...over
})

function setup(over: Partial<MeetingContextsDeps> = {}) {
  const revoked: Array<(ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void> = []
  const meetingEnd: Array<(startedAt: number) => void> = []
  const handlers = new Map<string, unknown>()
  const privateView = { on: false }
  const onDegraded = vi.fn()
  const contexts = bindMeetingContexts({
    ipcMain: { handle: (channel: string, fn: never) => handlers.set(channel, fn) },
    authorizeSender: vi.fn(() => null) as unknown as AuthorizeSender,
    requireAuth: () => true,
    ownerSession: {
      current: () => ref(),
      mint: () => ref(),
      onRevoked: (cb) => {
        revoked.push(cb)
        return () => undefined
      }
    },
    contextRevision: () => 1,
    privateView: () => privateView.on,
    unsignedAllowed: () => false,
    onMeetingEnd: (cb) => {
      meetingEnd.push(cb)
      return () => undefined
    },
    onDegraded,
    ...over
  })
  return { contexts, revoked, meetingEnd, handlers, privateView, onDegraded }
}

const FRAME = { processId: 12, routingId: 3 }
const read = (w: ReturnType<typeof setup>): string => {
  const handle = w.contexts.registry.acquire(FRAME, 'conversation')
  return handle ? transcriptTailText(handle.snapshot, 6_000) : '<none>'
}

describe('bindMeetingContexts', () => {
  it('feeds delivered relay speech, scoped to the owner session and the meeting', () => {
    const w = setup()
    w.contexts.onSegmentDelivered(owner(), event)
    expect(read(w)).toBe('THEM: hello from relay')
    const snapshot = w.contexts.registry.acquire(FRAME, 'screen')!.snapshot
    expect(snapshot.scope).toEqual({ tenantId: 'b'.repeat(64), userId: HEX, sessionId: `meeting-${STARTED}` })
    expect(snapshot.permissionFingerprint).toBe(JSON.stringify(meetingPermissions(false)))
  })

  it('ignores speech that is not bound to a meeting yet, and never throws into the delivery path', () => {
    const w = setup()
    w.contexts.onSegmentDelivered(owner({ captureContext: null }), event)
    expect(read(w)).toBe('<none>')
    expect(() =>
      w.contexts.onSegmentDelivered({ ...owner(), binding: undefined } as unknown as DeliveredSpeechOwner, event)
    ).not.toThrow()
  })

  it('ends a meeting context when the meeting is finalized', () => {
    const w = setup()
    w.contexts.onSegmentDelivered(owner(), event)
    const handle = w.contexts.registry.acquire(FRAME, 'conversation')!
    w.meetingEnd.forEach((listener) => listener(STARTED))
    expect(handle.check()).toEqual({ state: 'stale', code: 'SESSION_STOPPED' })
    expect(read(w)).toBe('<none>')
  })

  it('ends a frame context when its owner session is revoked (sign-out, renderer reset)', () => {
    const w = setup()
    w.contexts.onSegmentDelivered(owner(), event)
    w.revoked.forEach((listener) => listener(ref('99:1'), 'renderer-reset'))
    expect(read(w)).toBe('THEM: hello from relay')
    w.revoked.forEach((listener) => listener(ref('12:3'), 'sign-out'))
    expect(read(w)).toBe('<none>')
  })

  it('treats Private View as a permission change that stales snapshots taken before it', () => {
    const w = setup()
    w.contexts.onSegmentDelivered(owner(), event)
    const handle = w.contexts.registry.acquire(FRAME, 'screen')!
    w.privateView.on = true
    expect(handle.check()).toEqual({ state: 'stale', code: 'STALE_GENERATION' })
  })

  it('registers the local-line channel with the shared registry', () => {
    const w = setup()
    expect([...w.handlers.keys()]).toEqual([SESSION_CONTEXT_IPC.appendLine])
  })

  it('holds nothing while signed out of a configured app, and uses the local scope only when sign-in is not configured', () => {
    const signedOut = setup({
      ownerSession: { current: () => null, mint: () => null, onRevoked: () => () => undefined }
    })
    signedOut.contexts.onSegmentDelivered(owner(), event)
    expect(read(signedOut)).toBe('<none>')
    const unconfigured = setup({
      ownerSession: { current: () => null, mint: () => null, onRevoked: () => () => undefined },
      unsignedAllowed: () => true
    })
    unconfigured.contexts.onSegmentDelivered(owner(), event)
    expect(read(unconfigured)).toBe('THEM: hello from relay')
  })
})
