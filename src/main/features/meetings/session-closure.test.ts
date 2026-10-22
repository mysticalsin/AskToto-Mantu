import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, safeStorage: {}, webContents: {} }))
vi.mock('../../auth', () => ({ authStatus: vi.fn(), authSessionGeneration: vi.fn() }))

import { CloudSpeechEventSchema, CloudSpeechSegmentEventSchema, type CloudSpeechEvent } from '@shared/cloud-speech'
import {
  OWNER_SESSION_REVOKE_REASONS,
  type OwnerSessionRef,
  type OwnerSessionRevokeReason
} from '@shared/contracts/owner-session'
import { InputSessionStopReasonSchema } from '@shared/input-session'
import { createOwnerSessionAuthority } from '../../lifecycle/owner-session-authority'
import { createRelayRevisionTap, segmentEventToRevisionEvent, type RevisionTapOwner } from './relay-revision-adapter'
import { finalizeDraftMeeting, onDraftMeetingFinalizing } from '../../infra/storage/draft-transcript-write-state'
import {
  bindMeetingEndClosure,
  bindOwnerRevocationClosure,
  bindRendererResetClosure,
  STOP_REASON_FOR_REVOCATION,
  type RendererResetSource
} from './session-closure'
import { createTranscriptRevisionStore, type CheckpointWriter } from './transcript-revision-store'

const M = 1_700_000_000_000
const CAPTURE = '11111111-1111-4111-8111-111111111111'
const SESSION = '00000000-0000-4000-8000-000000000001'

const ref = (over: Partial<OwnerSessionRef> = {}): OwnerSessionRef => ({
  v: 1,
  ownerKey: 'a'.repeat(64),
  tenantKey: 'b'.repeat(64),
  authGeneration: 1,
  sessionId: SESSION,
  frameOwner: '12:3',
  contextRevision: 1,
  issuedAt: M,
  ...over
})

function segment(sequence: number): ReturnType<typeof CloudSpeechSegmentEventSchema.parse> {
  return CloudSpeechSegmentEventSchema.parse({
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

function realOwnerAuthority(identity: string | null = 'owner-a') {
  const state = { identity, authGeneration: 1, contextRevision: 1 }
  const frame = { processId: 12, routingId: 3 }
  let nextSession = 0
  const authority = createOwnerSessionAuthority({
    identityId: () => state.identity,
    tenantId: () => 'tenant-a',
    authGeneration: () => state.authGeneration,
    currentContextRevision: () => state.contextRevision,
    salt: () => Buffer.alloc(32, 9),
    webContentsIdOf: () => 1,
    now: () => M,
    uuid: () => `00000000-0000-4000-8000-${String(++nextSession).padStart(12, '0')}`
  })
  return { state, frame, authority }
}

function openMeetingUnderOwnerSession() {
  const { state, frame, authority } = realOwnerAuthority()
  const first = authority.mint(frame, state.contextRevision)
  if (!first) throw new Error('expected first owner session')
  const checkpoint = vi.fn<CheckpointWriter>(async () => 'written')
  const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: checkpoint })
  const closeOwnedBy = vi.spyOn(store, 'closeOwnedBy')
  bindOwnerRevocationClosure(authority, store)
  const binding = { meetingStartedAt: M, frameOwner: '12:3' as const, owner: first }
  expect(store.open(binding)).toEqual({ ok: true })
  expect(store.apply(binding, segmentEventToRevisionEvent(segment(1))).ok).toBe(true)

  state.contextRevision++
  const second = authority.mint(frame, state.contextRevision)
  if (!second) throw new Error('expected refreshed owner session')
  const refreshedBinding = { ...binding, owner: second }
  return { authority, frame, first, second, binding, refreshedBinding, closeOwnedBy, checkpoint, store }
}

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

  it('a context refresh does not orphan an A1 meeting from later revokeAll closure', () => {
    const { authority, first, second, binding, refreshedBinding, closeOwnedBy, checkpoint, store } =
      openMeetingUnderOwnerSession()
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(store.apply(refreshedBinding, segmentEventToRevisionEvent(segment(2))).ok).toBe(true)
    expect(store.snapshot(M)).not.toBeNull()

    authority.revokeAll('sign-out')
    authority.revokeAll('sign-out')

    const firstRevocation = closeOwnedBy.mock.calls.findIndex(([sessionId]) => sessionId === first.sessionId)
    expect(firstRevocation).toBeGreaterThanOrEqual(0)
    expect(closeOwnedBy.mock.results[firstRevocation]).toMatchObject({ type: 'return', value: [M] })
    expect(
      closeOwnedBy.mock.results.filter((result) => result.type === 'return' && result.value.includes(M))
    ).toHaveLength(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(store.snapshot(M)).toBeNull()
    expect(store.apply(binding, segmentEventToRevisionEvent(segment(2)))).toEqual({ ok: false, reason: 'invalid' })
    expect(store.closeOwnedBy(first.sessionId, 'sign-out')).toEqual([])
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })

  it('a context refresh does not orphan an A1 meeting from later revokeFrame closure', () => {
    const { authority, frame, first, second, binding, refreshedBinding, closeOwnedBy, checkpoint, store } =
      openMeetingUnderOwnerSession()
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(store.apply(refreshedBinding, segmentEventToRevisionEvent(segment(2))).ok).toBe(true)
    expect(store.snapshot(M)).not.toBeNull()

    authority.revokeFrame(1, 'renderer-reset')
    authority.revokeFrame(1, 'renderer-reset')

    const firstRevocation = closeOwnedBy.mock.calls.findIndex(([sessionId]) => sessionId === first.sessionId)
    expect(firstRevocation).toBeGreaterThanOrEqual(0)
    expect(closeOwnedBy.mock.results[firstRevocation]).toMatchObject({ type: 'return', value: [M] })
    expect(
      closeOwnedBy.mock.results.filter((result) => result.type === 'return' && result.value.includes(M))
    ).toHaveLength(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(store.snapshot(M)).toBeNull()
    expect(store.apply(binding, segmentEventToRevisionEvent(segment(2)))).toEqual({ ok: false, reason: 'invalid' })
    expect(store.closeOwnedBy(first.sessionId, 'renderer-reset')).toEqual([])
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(authority.current(frame)).toBeNull()
  })

  it('real owner revocations leave a meeting opened while signed out available', () => {
    const { state, authority, frame } = realOwnerAuthority(null)
    expect(authority.mint(frame, 1)).toBeNull()
    const store = createTranscriptRevisionStore({ now: () => M })
    const closeOwnedBy = vi.spyOn(store, 'closeOwnedBy')
    bindOwnerRevocationClosure(authority, store)
    const revoked = vi.fn()
    authority.onRevoked(revoked)
    const binding = { meetingStartedAt: M, frameOwner: '12:3' as const, owner: null }
    expect(store.open(binding)).toEqual({ ok: true })
    expect(store.apply(binding, segmentEventToRevisionEvent(segment(1))).ok).toBe(true)

    state.identity = 'owner-a'
    const signedIn = authority.mint(frame, state.contextRevision)
    if (!signedIn) throw new Error('expected signed-in owner session')
    authority.revokeAll('sign-out')

    expect(revoked).toHaveBeenCalledWith(signedIn, 'sign-out')
    expect(closeOwnedBy).toHaveBeenCalledWith(signedIn.sessionId, 'sign-out')
    expect(closeOwnedBy.mock.results[0]).toMatchObject({ type: 'return', value: [] })
    expect(store.snapshot(M)).not.toBeNull()
    expect(store.apply(binding, segmentEventToRevisionEvent(segment(2))).ok).toBe(true)
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

  it('stop, sign-out and renderer reset each close the store and checkpoint once', async () => {
    // Quit is not wired: its revokeAll caller is WP02-S06's lifecycle controller.
    const writer = vi.fn<CheckpointWriter>(async () => 'written')
    const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: writer })
    const tap = createRelayRevisionTap({ store, resolveOwner: () => ref() })
    const { authority, fire } = fakeAuthority()
    bindOwnerRevocationClosure(authority, store)
    const unbindEnd = bindMeetingEndClosure(onDraftMeetingFinalizing, store)
    try {
      // stop: the meeting's draft cleanup finalizes its identity
      tap(makeOwner(emitter(), M), segment(1))
      const atStop = store.snapshot(M)
      await finalizeDraftMeeting(M)
      await finalizeDraftMeeting(M)
      expect(store.snapshot(M)).toBeNull()
      expect(writer.mock.calls).toEqual([[M, atStop]])

      // sign-out
      tap(makeOwner(emitter(), M + 1), segment(1))
      const atSignOut = store.snapshot(M + 1)
      fire(ref(), 'sign-out')
      fire(ref(), 'sign-out')
      expect(store.snapshot(M + 1)).toBeNull()
      expect(writer.mock.calls.slice(1)).toEqual([[M + 1, atSignOut]])

      // renderer reset
      const sender = emitter()
      tap(makeOwner(sender, M + 2), segment(1))
      const atReset = store.snapshot(M + 2)
      sender.emit('render-process-gone')
      sender.emit('destroyed')
      expect(store.snapshot(M + 2)).toBeNull()
      expect(writer.mock.calls.slice(2)).toEqual([[M + 2, atReset]])
    } finally {
      unbindEnd()
    }
  })
})
