import { describe, expect, it, vi } from 'vitest'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { RevisionEvent } from '@shared/contracts/speech/transcript-revision'
import { TranscriptRevisionDeltaSchema } from '@shared/transcript-revision-ipc'
import {
  createTranscriptRevisionStore,
  type FrameOwner,
  type TranscriptRevisionStore,
  type TranscriptStoreBinding
} from '../features/meetings/transcript-revision-store'
import { registerTranscriptRevisionPush, type TranscriptRevisionPushFrame } from './register-transcript-revision'

const M = 1_700_000_000_000

const ref = (over: Partial<OwnerSessionRef> = {}): OwnerSessionRef => ({
  v: 1,
  ownerKey: 'a'.repeat(64),
  tenantKey: 'b'.repeat(64),
  authGeneration: 1,
  sessionId: '00000000-0000-4000-8000-000000000001',
  frameOwner: '12:3',
  contextRevision: 1,
  issuedAt: M,
  ...over
})

const binding = (frameOwner: FrameOwner = '12:3'): TranscriptStoreBinding => ({
  meetingStartedAt: M,
  frameOwner,
  owner: ref()
})

const final = (seq: number): RevisionEvent => ({
  kind: 'provider-final',
  relaySessionId: 'cap/1/1',
  providerSeq: seq,
  channel: 'mic',
  text: 'hello',
  language: 'en',
  startMs: 0,
  endMs: 100
})

function fakeFrame(over: Omit<Partial<TranscriptRevisionPushFrame>, 'send'> = {}) {
  return {
    parent: null,
    isDestroyed: vi.fn(() => false),
    ...over,
    send: vi.fn<(channel: string, ...args: unknown[]) => void>()
  }
}

function setup(frameFor: (p: number, r: number) => TranscriptRevisionPushFrame | null | undefined) {
  const store = createTranscriptRevisionStore({ now: () => M })
  const dispose = registerTranscriptRevisionPush({ store, frameFor })
  const b = binding()
  expect(store.open(b)).toEqual({ ok: true })
  return { store, dispose, b }
}

describe('registerTranscriptRevisionPush', () => {
  it('sends transcript:revision only to the bound frameOwner', () => {
    const bound = fakeFrame()
    const other = fakeFrame()
    const frames: Record<string, ReturnType<typeof fakeFrame>> = { '12:3': bound, '12:4': other }
    const frameFor = vi.fn((p: number, r: number) => frames[`${p}:${r}`])
    const { store, b } = setup(frameFor)
    const result = store.apply(b, final(1))
    expect(result.ok).toBe(true)
    expect(bound.send).toHaveBeenCalledTimes(1)
    const [channel, payload] = bound.send.mock.calls[0] as [string, unknown]
    expect(channel).toBe('transcript:revision')
    expect(TranscriptRevisionDeltaSchema.safeParse(payload).success).toBe(true)
    expect(other.send).not.toHaveBeenCalled()
    expect(frameFor.mock.calls.length).toBeGreaterThan(0)
    for (const call of frameFor.mock.calls) expect(call).toEqual([12, 3])
  })

  it('drops deltas for destroyed, missing and subframe targets', () => {
    const destroyed = fakeFrame({ isDestroyed: vi.fn(() => true) })
    const a = setup(() => destroyed)
    expect(a.store.apply(a.b, final(1)).ok).toBe(true)
    expect(destroyed.send).not.toHaveBeenCalled()

    const missing = vi.fn(() => undefined)
    const b1 = setup(missing)
    expect(b1.store.apply(b1.b, final(1)).ok).toBe(true)
    expect(missing).toHaveBeenCalledWith(12, 3)
    const gone = vi.fn(() => null)
    const b2 = setup(gone)
    expect(b2.store.apply(b2.b, final(1)).ok).toBe(true)
    expect(gone).toHaveBeenCalledWith(12, 3)

    const sub = fakeFrame({ parent: {} })
    const c = setup(() => sub)
    expect(c.store.apply(c.b, final(1)).ok).toBe(true)
    expect(sub.send).not.toHaveBeenCalled()
  })

  it('a throwing frame lookup or send never throws into the store', () => {
    const a = setup(() => {
      throw new Error('lookup')
    })
    expect(() => a.store.apply(a.b, final(1))).not.toThrow()
    expect(a.store.apply(a.b, final(2)).ok).toBe(true)

    const frame = fakeFrame()
    frame.send.mockImplementation(() => {
      throw new Error('send')
    })
    const b = setup(() => frame)
    expect(() => b.store.apply(b.b, final(1))).not.toThrow()
    expect(b.store.apply(b.b, final(2)).ok).toBe(true)
    expect(frame.send).toHaveBeenCalled()
  })

  it('stops sending after dispose and after the meeting closes', () => {
    const frame = fakeFrame()
    const a = setup(() => frame)
    a.store.apply(a.b, final(1))
    expect(frame.send).toHaveBeenCalledTimes(1)
    a.dispose()
    a.store.apply(a.b, final(2))
    expect(frame.send).toHaveBeenCalledTimes(1)

    const frame2 = fakeFrame()
    const b = setup(() => frame2)
    b.store.apply(b.b, final(1))
    expect(frame2.send).toHaveBeenCalledTimes(1)
    b.store.close(M, 'user-stop')
    expect(b.store.bindingOf(M)).toBeNull()
    const afterClose = frame2.send.mock.calls.length
    b.store.apply(b.b, final(2))
    b.store.finalize(b.b)
    expect(frame2.send.mock.calls.length).toBe(afterClose)
  })

  it('never sends a delta that fails the schema', () => {
    let listener: ((delta: never) => void) | null = null
    const store: Pick<TranscriptRevisionStore, 'onChange' | 'bindingOf'> = {
      onChange: (l) => {
        listener = l as (delta: never) => void
        return () => {}
      },
      bindingOf: () => ({ frameOwner: '12:3', ownerKey: null })
    }
    const frame = fakeFrame()
    registerTranscriptRevisionPush({ store, frameFor: () => frame })
    const segment = (i: number) => ({
      segmentId: `s${i}`,
      seq: i,
      channel: 'mic' as const,
      startMs: 0,
      endMs: 1,
      language: 'en',
      text: 'x',
      state: 'final' as const,
      source: 'provider' as const,
      relaySessionId: 'r'
    })
    const make = (n: number) => ({
      meetingStartedAt: M,
      revision: 1,
      changed: Array.from({ length: n }, (_, i) => segment(i)),
      finalized: false
    })
    expect(listener).not.toBeNull()
    const emit = listener as unknown as (delta: unknown) => void
    emit(make(201))
    expect(frame.send).not.toHaveBeenCalled()
    emit(make(1))
    expect(frame.send).toHaveBeenCalledTimes(1)
  })
})
