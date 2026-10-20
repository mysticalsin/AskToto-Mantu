import { describe, expect, it, vi } from 'vitest'
import { CloudSpeechEventSchema } from '@shared/cloud-speech'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import {
  createRelayRevisionTap,
  segmentEventToRevisionEvent,
  type DeliveredSegmentEvent,
  type RevisionTapOwner
} from './relay-revision-adapter'
import { createTranscriptRevisionStore, type TranscriptRevisionStore } from './transcript-revision-store'

const CAPTURE = '11111111-1111-4111-8111-111111111111'
const M = 1_700_000_000_000

interface SegmentOptions {
  sequence: number
  index?: number
  revision?: number
  final?: boolean
  text?: string
  track?: 'microphone' | 'system'
  epoch?: number
  generation?: number
  languages?: string[]
  startMs?: number
}

function segmentEvent(options: SegmentOptions): DeliveredSegmentEvent {
  const generation = options.generation ?? 1
  const parsed = CloudSpeechEventSchema.parse({
    type: 'segment',
    captureId: CAPTURE,
    captureGeneration: generation,
    sequence: options.sequence,
    segment: {
      stream: { generation, track: options.track ?? 'microphone', epoch: options.epoch ?? 1 },
      engine: 'deepgram-nova3',
      index: options.index ?? 1,
      revision: options.revision ?? 1,
      final: options.final ?? false,
      text: options.text ?? 'hello',
      startMs: options.startMs ?? 0,
      endMs: 500
    },
    ...(options.languages ? { languages: options.languages } : {})
  })
  if (parsed.type !== 'segment') throw new Error('expected a segment event')
  return parsed
}

const makeOwner = (over: Partial<RevisionTapOwner> = {}): RevisionTapOwner => ({
  captureId: CAPTURE,
  generation: 1,
  binding: { processId: 12, routingId: 3, frame: {} },
  captureContext: { listenStartedAt: M },
  ...over
})

function fakeStore(over: Partial<TranscriptRevisionStore> = {}): TranscriptRevisionStore {
  return {
    open: () => ({ ok: true }),
    apply: () => ({ ok: false, reason: 'invalid' }),
    snapshot: () => null,
    bindingOf: () => null,
    finalize: () => ({ ok: false, reason: 'invalid' }),
    close: () => undefined,
    onChange: () => () => undefined,
    ...over
  }
}

describe('relay revision adapter', () => {
  it('preserves interleaved provider segments and their identities when finals arrive in reverse order', () => {
    const store = createTranscriptRevisionStore()
    const tap = createRelayRevisionTap({ store })
    const owner = makeOwner()
    tap(owner, segmentEvent({ sequence: 1, index: 1, text: 'first partial' }))
    tap(owner, segmentEvent({ sequence: 2, index: 2, startMs: 100, text: 'second partial' }))
    const partials = store.snapshot(M)!.segments
    expect(partials.map((segment) => segment.text)).toEqual(['first partial', 'second partial'])
    const ids = partials.map((segment) => segment.segmentId)
    tap(owner, segmentEvent({ sequence: 3, index: 2, revision: 2, startMs: 100, final: true, text: 'second final' }))
    tap(owner, segmentEvent({ sequence: 4, index: 1, revision: 2, final: true, text: 'first final' }))
    const finals = store.snapshot(M)!.segments
    expect(finals.map((segment) => segment.segmentId)).toEqual(ids)
    expect(finals.map((segment) => [segment.text, segment.startMs, segment.state])).toEqual([
      ['first final', 0, 'final'],
      ['second final', 100, 'final']
    ])
    expect(store.snapshot(M)!.revision).toBe(4)
  })

  it.each([
    'user-correct',
    'user-retract'
  ] as const)('does not duplicate or replace a partial after %s when its provider final arrives', (kind) => {
    const store = createTranscriptRevisionStore()
    const tap = createRelayRevisionTap({ store })
    const owner = makeOwner()
    tap(owner, segmentEvent({ sequence: 1, index: 1, text: 'partial' }))
    const before = store.snapshot(M)!
    const result = store.apply(
      { meetingStartedAt: M, frameOwner: '12:3', owner: null },
      kind === 'user-correct'
        ? { kind, baseRevision: before.revision, segmentId: before.segments[0].segmentId, text: 'user correction' }
        : { kind, baseRevision: before.revision, segmentId: before.segments[0].segmentId }
    )
    expect(result.ok).toBe(true)
    const corrected = store.snapshot(M)
    tap(owner, segmentEvent({ sequence: 2, index: 1, revision: 2, final: true, text: 'provider final' }))
    expect(store.snapshot(M)).toBe(corrected)
  })

  it('maps relay finals, revisions and retractions to revision events', () => {
    const lineage = `${CAPTURE}/1/1`
    const events = [
      segmentEvent({ sequence: 1, revision: 1, text: 'hel' }),
      segmentEvent({ sequence: 2, revision: 2, text: 'hello wor' }),
      segmentEvent({ sequence: 3, revision: 3, text: 'hello world', final: true })
    ]
    const mapped = events.map(segmentEventToRevisionEvent)
    expect(mapped.map((event) => event.kind)).toEqual(['provider-partial', 'provider-partial', 'provider-final'])
    expect(mapped.map((event) => event.providerSeq)).toEqual([1, 2, 3])
    for (const event of mapped)
      expect(event).toMatchObject({ relaySessionId: lineage, channel: 'mic', language: 'multi' })
    expect(mapped[2]).not.toHaveProperty('speaker')

    const store = createTranscriptRevisionStore()
    const tap = createRelayRevisionTap({ store })
    const owner = makeOwner()
    for (const event of events) tap(owner, event)
    const segments = store.snapshot(M)?.segments ?? []
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ state: 'final', text: 'hello world' })

    // The relay wire has no retraction message, so none is invented: an empty final stays a final.
    const empty = segmentEventToRevisionEvent(segmentEvent({ sequence: 4, index: 2, final: true, text: '' }))
    expect(empty).toMatchObject({ kind: 'provider-final', text: '' })
    expect(segmentEventToRevisionEvent(segmentEvent({ sequence: 5, languages: ['en'] })).language).toBe('en')
  })

  it('ignores non-segment events and owners without a Listen meeting', () => {
    const open = vi.fn(() => ({ ok: true as const }))
    const apply = vi.fn(() => ({ ok: false as const, reason: 'invalid' as const }))
    const tap = createRelayRevisionTap({ store: fakeStore({ open, apply }) })
    tap(makeOwner(), { type: 'ready' } as never)
    tap(makeOwner({ captureContext: null }), segmentEvent({ sequence: 1 }))
    expect(open).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('binds the store once per owner with the meeting id and optional owner ref', () => {
    const open = vi.fn(() => ({ ok: true as const }))
    const apply = vi.fn(() => ({ ok: false as const, reason: 'invalid' as const }))
    const resolveOwner = vi.fn(() => null)
    const tap = createRelayRevisionTap({ store: fakeStore({ open, apply }), resolveOwner })
    const owner = makeOwner()
    for (const sequence of [1, 2, 3]) tap(owner, segmentEvent({ sequence }))
    expect(resolveOwner).toHaveBeenCalledTimes(1)
    expect(resolveOwner).toHaveBeenCalledWith({ processId: 12, routingId: 3 })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({ meetingStartedAt: M, frameOwner: '12:3', owner: null })
    expect(apply).toHaveBeenCalledTimes(3)

    const signedIn: OwnerSessionRef = {
      v: 1,
      ownerKey: 'a'.repeat(64),
      authGeneration: 1,
      sessionId: '00000000-0000-4000-8000-000000000001',
      frameOwner: '12:3',
      contextRevision: 1,
      issuedAt: M
    }
    const openRef = vi.fn(() => ({ ok: true as const }))
    createRelayRevisionTap({ store: fakeStore({ open: openRef }), resolveOwner: () => signedIn })(
      makeOwner(),
      segmentEvent({ sequence: 1 })
    )
    expect(openRef).toHaveBeenCalledWith({ meetingStartedAt: M, frameOwner: '12:3', owner: signedIn })

    const openThrow = vi.fn(() => ({ ok: true as const }))
    createRelayRevisionTap({
      store: fakeStore({ open: openThrow }),
      resolveOwner: () => {
        throw new Error('no authority')
      }
    })(makeOwner(), segmentEvent({ sequence: 1 }))
    expect(openThrow).toHaveBeenCalledWith({ meetingStartedAt: M, frameOwner: '12:3', owner: null })
  })

  it('a refused store open or apply never throws into delivery', () => {
    const apply = vi.fn(() => ({ ok: false as const, reason: 'invalid' as const }))
    const refusedOpen = vi.fn(() => ({ ok: false as const, reason: 'closed' as const }))
    const tap = createRelayRevisionTap({ store: fakeStore({ open: refusedOpen, apply }) })
    const owner = makeOwner()
    expect(() => tap(owner, segmentEvent({ sequence: 1 }))).not.toThrow()
    expect(() => tap(owner, segmentEvent({ sequence: 2 }))).not.toThrow()
    expect(refusedOpen).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()

    const throwingOpen = fakeStore({
      open: () => {
        throw new Error('open failed')
      }
    })
    expect(() =>
      createRelayRevisionTap({ store: throwingOpen })(makeOwner(), segmentEvent({ sequence: 1 }))
    ).not.toThrow()

    const throwingApply = fakeStore({
      apply: () => {
        throw new Error('apply failed')
      }
    })
    expect(() =>
      createRelayRevisionTap({ store: throwingApply })(makeOwner(), segmentEvent({ sequence: 1 }))
    ).not.toThrow()
  })

  it('separates mic and system tracks and stream epochs into their own lineages', () => {
    const mic = segmentEventToRevisionEvent(segmentEvent({ sequence: 1 }))
    const system = segmentEventToRevisionEvent(segmentEvent({ sequence: 1, track: 'system' }))
    const nextEpoch = segmentEventToRevisionEvent(segmentEvent({ sequence: 1, epoch: 36 }))
    const nextGeneration = segmentEventToRevisionEvent(segmentEvent({ sequence: 1, generation: 36 }))
    expect(mic).toMatchObject({ channel: 'mic', relaySessionId: `${CAPTURE}/1/1` })
    expect(system).toMatchObject({ channel: 'system', relaySessionId: `${CAPTURE}/1/1` })
    expect(nextEpoch.relaySessionId).toBe(`${CAPTURE}/1/10`)
    expect(nextGeneration.relaySessionId).toBe(`${CAPTURE}/10/1`)

    const store = createTranscriptRevisionStore()
    const tap = createRelayRevisionTap({ store })
    const owner = makeOwner()
    tap(owner, segmentEvent({ sequence: 1 }))
    tap(owner, segmentEvent({ sequence: 1, track: 'system' }))
    expect(
      store
        .snapshot(M)
        ?.segments.map((segment) => segment.channel)
        .sort()
    ).toEqual(['mic', 'system'])
  })
})
