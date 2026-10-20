import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CloudSpeechEventSchema, type CloudSpeechEvent } from '@shared/cloud-speech'
import {
  OWNER_SESSION_REVOKE_REASONS,
  type OwnerSessionRef,
  type OwnerSessionRevokeReason
} from '@shared/contracts/owner-session'
import { InputSessionStopReasonSchema } from '@shared/input-session'
import { createRelayRevisionTap, type RevisionTapOwner } from './relay-revision-adapter'
import {
  bindOwnerRevocationClosure,
  bindRendererResetClosure,
  STOP_REASON_FOR_REVOCATION,
  type RendererResetSource
} from './session-closure'
import { createTranscriptRevisionStore } from './transcript-revision-store'

const M = 1_700_000_000_000
const CAPTURE = '11111111-1111-4111-8111-111111111111'
const SESSION = '00000000-0000-4000-8000-000000000001'

const ref = (over: Partial<OwnerSessionRef> = {}): OwnerSessionRef => ({
  v: 1,
  ownerKey: 'a'.repeat(64),
  authGeneration: 1,
  sessionId: SESSION,
  frameOwner: '12:3',
  contextRevision: 1,
  issuedAt: M,
  ...over
})

function segment(sequence: number): CloudSpeechEvent {
  return CloudSpeechEventSchema.parse({
    type: 'segment',
    captureId: CAPTURE,
    captureGeneration: 1,
    sequence,
    segment: {
      stream: { generation: 1, track: 'microphone', epoch: 1 },
      engine: 'deepgram-nova3',
      index: 1,
      revision: 1,
      final: false,
      text: 'hello',
      startMs: 0,
      endMs: 500
    }
  })
}

const terminal = (): CloudSpeechEvent =>
  CloudSpeechEventSchema.parse({
    type: 'terminal',
    captureId: CAPTURE,
    captureGeneration: 1,
    stream: { generation: 1, track: 'microphone', epoch: 1 },
    lastSequence: 1,
    closeConfirmed: true,
    tail: 'complete',
    reason: 'normal'
  })

function fakeAuthority() {
  const callbacks: Array<(ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void> = []
  return {
    authority: {
      onRevoked(cb: (ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void) {
        callbacks.push(cb)
        return () => undefined
      }
    },
    fire: (value: OwnerSessionRef, reason: OwnerSessionRevokeReason) => {
      for (const cb of callbacks) cb(value, reason)
    }
  }
}

const makeOwner = (sender: RendererResetSource, listenStartedAt: number): RevisionTapOwner => ({
  captureId: CAPTURE,
  generation: 1,
  binding: { processId: 12, routingId: 3, frame: {}, sender },
  captureContext: { listenStartedAt }
})

const emitter = (): EventEmitter & RendererResetSource => new EventEmitter() as EventEmitter & RendererResetSource

describe('session closure', () => {
  it('owner revocation and renderer reset each close the store once', () => {
    const store = createTranscriptRevisionStore({ now: () => M })
    const close = vi.spyOn(store, 'close')
    const tap = createRelayRevisionTap({ store, resolveOwner: () => ref() })
    const { authority, fire } = fakeAuthority()
    bindOwnerRevocationClosure(authority, store)

    tap(makeOwner(emitter(), M), segment(1))
    expect(store.snapshot(M)).not.toBeNull()
    // The tap bound the meeting to the resolved owner, so the revocation closes it through closeOwnedBy.
    expect(store.bindingOf(M)).toEqual({ frameOwner: '12:3', ownerKey: ref().ownerKey })
    const closeOwnedBy = vi.spyOn(store, 'closeOwnedBy')
    fire(ref(), 'sign-out')
    expect(closeOwnedBy).toHaveBeenCalledWith(SESSION, 'sign-out')
    expect(closeOwnedBy).toHaveReturnedWith([M])
    expect(store.snapshot(M)).toBeNull()
    expect(store.open({ meetingStartedAt: M, frameOwner: '12:3', owner: ref() })).toEqual({
      ok: false,
      reason: 'closed'
    })

    const sender = emitter()
    tap(makeOwner(sender, M + 1), segment(1))
    expect(store.snapshot(M + 1)).not.toBeNull()
    sender.emit('destroyed')
    sender.emit('render-process-gone')
    sender.emit('destroyed')
    expect(store.snapshot(M + 1)).toBeNull()
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(M + 1, 'renderer-reset')
  })

  it('maps every owner-session revoke reason to an input-session stop reason', () => {
    for (const reason of OWNER_SESSION_REVOKE_REASONS) {
      expect(InputSessionStopReasonSchema.safeParse(STOP_REASON_FOR_REVOCATION[reason]).success).toBe(true)
    }
    expect(STOP_REASON_FOR_REVOCATION).toEqual({
      'sign-out': 'sign-out',
      'auth-changed': 'auth-revoked',
      'renderer-reset': 'renderer-reset',
      'lock-screen': 'screen-locked',
      suspend: 'system-suspend',
      quit: 'shutdown'
    })
  })

  it('a revocation for another session or a signed-out meeting leaves the store open', () => {
    const store = createTranscriptRevisionStore({ now: () => M })
    const { authority, fire } = fakeAuthority()
    bindOwnerRevocationClosure(authority, store)

    store.open({ meetingStartedAt: M, frameOwner: '12:3', owner: ref() })
    fire(ref({ sessionId: '00000000-0000-4000-8000-000000000002' }), 'sign-out')
    expect(store.snapshot(M)).not.toBeNull()
    expect(store.closeOwnedBy('00000000-0000-4000-8000-000000000002', 'sign-out')).toEqual([])

    const signedOut = createTranscriptRevisionStore({ now: () => M })
    signedOut.open({ meetingStartedAt: M, frameOwner: '12:3', owner: null })
    expect(signedOut.closeOwnedBy(SESSION, 'sign-out')).toEqual([])
    expect(signedOut.snapshot(M)).not.toBeNull()
  })

  it('renderer reset ignores in-place and subframe navigations', () => {
    const store = createTranscriptRevisionStore({ now: () => M })
    const tap = createRelayRevisionTap({ store, resolveOwner: () => ref() })
    const sender = emitter()
    tap(makeOwner(sender, M), segment(1))

    sender.emit('did-start-navigation', {}, 'about:blank', true, true)
    sender.emit('did-start-navigation', {}, 'about:blank', false, false)
    expect(store.snapshot(M)).not.toBeNull()
    sender.emit('did-start-navigation', {}, 'about:blank', false, true)
    expect(store.snapshot(M)).toBeNull()
  })

  it('later events after closure are refused and never reopen the meeting', () => {
    const store = createTranscriptRevisionStore({ now: () => M })
    const tap = createRelayRevisionTap({ store, resolveOwner: () => ref() })
    const sender = emitter()
    const owner = makeOwner(sender, M)
    tap(owner, segment(1))
    sender.emit('destroyed')
    expect(store.snapshot(M)).toBeNull()

    tap(owner, segment(2))
    tap(owner, terminal())
    tap(makeOwner(sender, M), segment(1))
    expect(store.snapshot(M)).toBeNull()
    expect(store.open({ meetingStartedAt: M, frameOwner: '12:3', owner: ref() })).toEqual({
      ok: false,
      reason: 'closed'
    })
  })

  it('a throwing reset callback never reaches the emitter', () => {
    const sender = emitter()
    bindRendererResetClosure(sender, () => {
      throw new Error('boom')
    })
    expect(() => sender.emit('destroyed')).not.toThrow()
  })
})
