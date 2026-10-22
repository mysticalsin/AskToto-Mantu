import { describe, expect, it, vi } from 'vitest'
import type { AuditEventRecord } from '@shared/contracts/audit-event'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import {
  TranscriptRevisionDeltaSchema,
  type RevisionEvent,
  type TranscriptRevisionDelta
} from '@shared/contracts/speech/transcript-revision'
import {
  createTranscriptRevisionStore,
  type CheckpointWriteOutcome,
  type CheckpointWriter,
  type FrameOwner,
  type TranscriptStoreBinding
} from './transcript-revision-store'

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

const binding = (
  owner: OwnerSessionRef | null,
  frameOwner: FrameOwner = '12:3',
  meetingStartedAt = M
): TranscriptStoreBinding => ({ meetingStartedAt, frameOwner, owner })

const partial = (seq: number, lineage = 'cap/1/1'): RevisionEvent => ({
  kind: 'provider-partial',
  relaySessionId: lineage,
  providerSeq: seq,
  channel: 'mic',
  text: 'hello',
  language: 'en',
  startMs: 0,
  endMs: 100
})

function make() {
  const audits: AuditEventRecord[] = []
  const store = createTranscriptRevisionStore({
    now: () => M,
    audit: (_event, detail) => {
      audits.push(detail)
    }
  })
  return { store, audits }
}

describe('transcript revision store', () => {
  it('refuses apply from an OwnerSessionRef that did not open the meeting', () => {
    const { store, audits } = make()
    const a = ref()
    const b = ref({ ownerKey: 'b'.repeat(64), sessionId: '00000000-0000-4000-8000-000000000002' })
    const rotated = ref({ sessionId: '00000000-0000-4000-8000-000000000003', contextRevision: 2 })
    expect(store.open(binding(a))).toEqual({ ok: true })
    expect(store.apply(binding(b), partial(1))).toEqual({ ok: false, reason: 'invalid' })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ reason: 'wrong-owner', ownerKey: b.ownerKey, surface: 'transcript.apply' })
    expect(audits[0]).not.toHaveProperty('text')
    expect(store.apply(binding(rotated), partial(1)).ok).toBe(true)
    expect(store.apply(binding(null), partial(2, 'cap/1/2'))).toEqual({ ok: false, reason: 'invalid' })
    expect(audits).toHaveLength(2)
    expect(audits[1]).toMatchObject({ reason: 'wrong-owner', ownerKey: null, sessionId: null })
  })

  it('close on revocation releases buffers and refuses later events', () => {
    const { store } = make()
    const seen = vi.fn()
    store.onChange(seen)
    store.open(binding(ref()))
    store.close(M, 'auth-revoked')
    expect(store.snapshot(M)).toBeNull()
    expect(store.apply(binding(ref()), partial(1))).toEqual({ ok: false, reason: 'invalid' })
    expect(store.open(binding(ref()))).toEqual({ ok: false, reason: 'closed' })
    expect(seen).not.toHaveBeenCalled()
  })

  it('allows a signed-out session bound to meeting and frame', () => {
    const { store, audits } = make()
    expect(store.open(binding(null))).toEqual({ ok: true })
    expect(store.apply(binding(null), partial(1)).ok).toBe(true)
    expect(store.apply(binding(ref()), partial(2, 'cap/1/2')).ok).toBe(true)
    expect(store.apply(binding(null, '13:4'), partial(3, 'cap/1/3'))).toEqual({ ok: false, reason: 'invalid' })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ reason: 'wrong-frame', ownerKey: null })
  })

  it('emits one delta per accepted event with only the changed segments', () => {
    const { store } = make()
    const deltas: TranscriptRevisionDelta[] = []
    const second = vi.fn()
    store.onChange(() => {
      throw new Error('listener failure')
    })
    store.onChange((delta) => {
      deltas.push(delta)
      second()
    })
    store.open(binding(null))
    const first = store.apply(binding(null), partial(1, 'cap/1/1'))
    const next = store.apply(binding(null), partial(1, 'cap/1/2'))
    if (!first.ok || !next.ok) throw new Error('expected both events to apply')
    expect(deltas).toHaveLength(2)
    for (const delta of deltas) expect(TranscriptRevisionDeltaSchema.parse(delta)).toEqual(delta)
    expect(deltas[1]?.changed.map((segment) => segment.segmentId)).toEqual([...next.changed])
    expect(deltas[1]?.changed).toHaveLength(1)
    expect(store.snapshot(M)?.segments).toHaveLength(2)
    expect(store.apply(binding(null, '13:4'), partial(2, 'cap/1/3')).ok).toBe(false)
    expect(deltas).toHaveLength(2)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('opening a new meeting closes the previous one', () => {
    const { store } = make()
    store.open(binding(null))
    expect(store.open(binding(null, '12:3', M + 1))).toEqual({ ok: true })
    expect(store.snapshot(M)).toBeNull()
    expect(store.snapshot(M + 1)).not.toBeNull()
    expect(store.open(binding(null))).toEqual({ ok: false, reason: 'closed' })
  })

  it('open is idempotent for the same binding and refuses another frame', () => {
    const { store } = make()
    expect(store.open(binding(null))).toEqual({ ok: true })
    expect(store.open(binding(null))).toEqual({ ok: true })
    expect(store.snapshot(M)?.revision).toBe(0)
    expect(store.open(binding(null, '13:4'))).toEqual({ ok: false, reason: 'bound-elsewhere' })
    expect(store.bindingOf(M)).toEqual({ frameOwner: '12:3', ownerKey: null })
  })

  it('finalize refuses later events', () => {
    const { store } = make()
    const deltas: TranscriptRevisionDelta[] = []
    store.onChange((delta) => deltas.push(delta))
    store.open(binding(null))
    store.apply(binding(null), partial(1))
    expect(deltas).toHaveLength(1)
    expect(store.finalize(binding(null)).ok).toBe(true)
    expect(deltas).toHaveLength(2)
    expect(deltas[1]).toMatchObject({ finalized: true, changed: [] })
    expect(store.apply(binding(null), partial(2, 'cap/1/2'))).toEqual({ ok: false, reason: 'finalized' })
  })
})

describe('transcript revision store checkpoint', () => {
  const written = (): ReturnType<typeof vi.fn<CheckpointWriter>> => vi.fn<CheckpointWriter>(async () => 'written')

  it('checkpoint writes the current revision and reports it', async () => {
    const writer = written()
    const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: writer })
    store.open(binding(null))
    store.apply(binding(null), partial(1))
    const snapshot = store.snapshot(M)
    expect(snapshot).not.toBeNull()
    const result = await store.checkpoint(M)
    expect(result).toEqual({ ok: true, revision: snapshot?.revision })
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(M, snapshot)
  })

  it('checkpoint captures the revision before awaiting the writer', async () => {
    let release: (outcome: CheckpointWriteOutcome) => void = () => {}
    const writer = vi.fn<CheckpointWriter>(
      () =>
        new Promise<CheckpointWriteOutcome>((resolve) => {
          release = resolve
        })
    )
    const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: writer })
    store.open(binding(null))
    store.apply(binding(null), partial(1))
    const before = store.snapshot(M)?.revision as number
    const pending = store.checkpoint(M)
    store.apply(binding(null), partial(2, 'cap/1/2'))
    expect(store.snapshot(M)?.revision).toBeGreaterThan(before)
    release('written')
    const result = await pending
    expect(writer.mock.calls[0][1].revision).toBe(before)
    expect(result).toEqual({ ok: true, revision: before })
  })

  it('checkpoint after seal returns sealed and writes nothing', async () => {
    const writer = written()
    const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: writer })
    store.open(binding(null))
    store.close(M, 'user-stop')
    // close() itself made the one closing checkpoint (WP03-S15); the checkpoint after the seal adds no write.
    expect(writer).toHaveBeenCalledTimes(1)
    expect(await store.checkpoint(M)).toEqual({ ok: false, error: 'sealed' })
    expect(writer).toHaveBeenCalledTimes(1)

    const sealingWriter = vi.fn<CheckpointWriter>(async () => 'sealed')
    const other = createTranscriptRevisionStore({ now: () => M, checkpointWriter: sealingWriter })
    other.open(binding(null))
    expect(await other.checkpoint(M)).toEqual({ ok: false, error: 'sealed' })
    expect(sealingWriter).toHaveBeenCalledTimes(1)
  })

  it('checkpoint refuses when authGeneration changed', async () => {
    let gen = 1
    const writer = written()
    const store = createTranscriptRevisionStore({
      now: () => M,
      checkpointWriter: writer,
      authGeneration: () => gen
    })
    store.open(binding(ref({ authGeneration: 1 })))
    gen = 2
    expect(await store.checkpoint(M)).toEqual({ ok: false, error: 'auth-changed' })
    expect(writer).not.toHaveBeenCalled()
    gen = 1
    expect((await store.checkpoint(M)).ok).toBe(true)
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('a meeting opened signed out is not refused by an auth generation change', async () => {
    let gen = 1
    const writer = written()
    const store = createTranscriptRevisionStore({
      now: () => M,
      checkpointWriter: writer,
      authGeneration: () => gen
    })
    store.open(binding(null))
    gen = 5
    expect((await store.checkpoint(M)).ok).toBe(true)
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('checkpoint maps writer failure, throw and absence', async () => {
    const failing = createTranscriptRevisionStore({
      now: () => M,
      checkpointWriter: vi.fn<CheckpointWriter>(async () => 'failed')
    })
    failing.open(binding(null))
    expect(await failing.checkpoint(M)).toEqual({ ok: false, error: 'write-failed' })

    const throwing = createTranscriptRevisionStore({
      now: () => M,
      checkpointWriter: vi.fn<CheckpointWriter>(async () => {
        throw new Error('boom')
      })
    })
    throwing.open(binding(null))
    expect(await throwing.checkpoint(M)).toEqual({ ok: false, error: 'write-failed' })

    const absent = createTranscriptRevisionStore({
      now: () => M,
      checkpointWriter: vi.fn<CheckpointWriter>(async () => 'absent')
    })
    absent.open(binding(null))
    expect(await absent.checkpoint(M)).toEqual({ ok: false, error: 'absent' })

    const unconfigured = createTranscriptRevisionStore({ now: () => M })
    unconfigured.open(binding(null))
    expect(await unconfigured.checkpoint(M)).toEqual({ ok: false, error: 'write-failed' })
  })
})

describe('transcript revision store closing checkpoint (WP03-S15)', () => {
  it('close checkpoints the closing snapshot once and a second close writes nothing', async () => {
    const writer = vi.fn<CheckpointWriter>(async () => 'written')
    const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: writer })
    store.open(binding(null))
    store.apply(binding(null), partial(1))
    const closing = store.snapshot(M)
    store.close(M, 'renderer-reset')
    store.close(M, 'renderer-reset')
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(M, closing)
  })

  it('closing an owned meeting after its auth generation moved writes nothing', () => {
    let gen = 1
    const writer = vi.fn<CheckpointWriter>(async () => 'written')
    const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: writer, authGeneration: () => gen })
    store.open(binding(ref({ authGeneration: 1 })))
    gen = 2
    expect(store.closeOwnedBy(ref().sessionId, 'sign-out')).toEqual([M])
    expect(writer).not.toHaveBeenCalled()
  })

  it('opening a new meeting checkpoints the replaced one once', () => {
    const writer = vi.fn<CheckpointWriter>(async () => 'written')
    const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: writer })
    store.open(binding(null))
    store.open(binding(null, '12:3', M + 1))
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer.mock.calls[0][0]).toBe(M)
  })

  it('a failing closing checkpoint never throws out of close', () => {
    const store = createTranscriptRevisionStore({
      now: () => M,
      checkpointWriter: async () => {
        throw new Error('disk gone')
      }
    })
    store.open(binding(null))
    expect(() => store.close(M, 'user-stop')).not.toThrow()
    expect(store.snapshot(M)).toBeNull()
  })
})
