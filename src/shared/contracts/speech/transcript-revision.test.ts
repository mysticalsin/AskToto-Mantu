import { describe, expect, it } from 'vitest'
import {
  type ApplyResult,
  applyRevisionEvent,
  DEFAULT_REVISION_LIMITS,
  emptyTranscriptRevision,
  type RevisionEvent,
  type RevisionLimits,
  RevisionEventSchema,
  type TranscriptRevision,
  TranscriptRevisionSchema,
  TranscriptSegmentSchema
} from './transcript-revision'

type Span = Extract<RevisionEvent, { kind: 'provider-partial' | 'provider-final' }>
type SpanInput = Partial<Omit<Extract<Span, { kind: 'provider-final' }>, 'kind'>> & { providerSeq: number }

function span(kind: Span['kind'], input: SpanInput): Span {
  return {
    kind,
    relaySessionId: 'r1',
    channel: 'mic',
    text: 'hello',
    language: 'en',
    startMs: 0,
    endMs: 100,
    ...input
  } as Span
}
const partial = (input: SpanInput) => span('provider-partial', input)
const final = (input: SpanInput) => span('provider-final', input)

function accept(result: ApplyResult): { next: TranscriptRevision; changed: readonly string[] } {
  if (!result.ok) throw new Error(`expected acceptance, got ${result.reason}`)
  return result
}

function run(events: RevisionEvent[], limits: RevisionLimits = DEFAULT_REVISION_LIMITS): TranscriptRevision {
  return events.reduce((rev, ev) => accept(applyRevisionEvent(rev, ev, limits)).next, emptyTranscriptRevision(1))
}

describe('stream-end', () => {
  const streamEnd = (relaySessionId: string, channel: 'mic' | 'system'): RevisionEvent => ({
    kind: 'stream-end',
    relaySessionId,
    channel
  })

  it('settles only its lineage and channel and keeps the heard text', () => {
    // The same-lineage system partial comes first, so a channel-blind settle would pick it.
    const rev = run([
      partial({ providerSeq: 1, channel: 'system', text: 'two' }),
      partial({ providerSeq: 1, text: 'one', startMs: 5, endMs: 50 }),
      partial({ providerSeq: 1, relaySessionId: 'r2', text: 'three' })
    ])
    const before = rev.segments[1]
    const { next, changed } = accept(applyRevisionEvent(rev, streamEnd('r1', 'mic'), DEFAULT_REVISION_LIMITS))
    expect(changed).toEqual([before.segmentId])
    expect(next.segments[1]).toMatchObject({
      state: 'final',
      text: 'one',
      language: before.language,
      startMs: 5,
      endMs: 50,
      providerSeq: 1
    })
    expect(next.segments[0]).toMatchObject({ channel: 'system', state: 'partial' })
    expect(next.segments[2]).toMatchObject({ relaySessionId: 'r2', state: 'partial' })
  })

  it('refuses duplicate when nothing is open', () => {
    const empty = emptyTranscriptRevision(1)
    expect(applyRevisionEvent(empty, streamEnd('r1', 'mic'), DEFAULT_REVISION_LIMITS)).toEqual({
      ok: false,
      reason: 'duplicate'
    })
    const settled = run([partial({ providerSeq: 1 }), streamEnd('r1', 'mic')])
    expect(applyRevisionEvent(settled, streamEnd('r1', 'mic'), DEFAULT_REVISION_LIMITS)).toEqual({
      ok: false,
      reason: 'duplicate'
    })
  })

  it('schema refuses extra fields', () => {
    const extra = { ...streamEnd('r1', 'mic'), providerSeq: 1 }
    expect(RevisionEventSchema.safeParse(extra).success).toBe(false)
    const rev = run([partial({ providerSeq: 1 })])
    expect(applyRevisionEvent(rev, extra as unknown as RevisionEvent, DEFAULT_REVISION_LIMITS)).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })
})

const apply = (rev: TranscriptRevision, ev: RevisionEvent, limits: RevisionLimits = DEFAULT_REVISION_LIMITS) =>
  applyRevisionEvent(rev, ev, limits)

describe('applyRevisionEvent', () => {
  it('increments revision by exactly one per accepted event', () => {
    let rev = emptyTranscriptRevision(1)
    const events: RevisionEvent[] = [
      partial({ providerSeq: 1 }),
      final({ providerSeq: 2 }),
      { kind: 'user-correct', baseRevision: 2, segmentId: 'seg-0', text: 'fixed' },
      { kind: 'finalize' }
    ]
    events.forEach((ev, index) => {
      rev = accept(apply(rev, ev)).next
      expect(rev.revision).toBe(index + 1)
    })
    const one = run([partial({ providerSeq: 1 })])
    expect(apply(one, partial({ providerSeq: 1 }))).toEqual({ ok: false, reason: 'duplicate' })
    expect(one.revision).toBe(1)
  })

  it('refuses user-correct with a stale baseRevision', () => {
    const rev = run([final({ providerSeq: 1 }), final({ providerSeq: 2, startMs: 200, endMs: 300 })])
    expect(apply(rev, { kind: 'user-correct', baseRevision: 1, segmentId: 'seg-0', text: 'x' })).toEqual({
      ok: false,
      reason: 'stale-base'
    })
    const fresh = accept(apply(rev, { kind: 'user-correct', baseRevision: 2, segmentId: 'seg-0', text: 'x' }))
    expect(fresh.next.segments[0]).toMatchObject({ state: 'corrected', source: 'user', text: 'x' })
  })

  it('refuses every event after finalize', () => {
    const rev = run([final({ providerSeq: 1 }), { kind: 'finalize' }])
    expect(rev.finalized).toBe(true)
    const events: RevisionEvent[] = [
      partial({ providerSeq: 9, startMs: 500, endMs: 600 }),
      final({ providerSeq: 10, startMs: 500, endMs: 600 }),
      { kind: 'provider-revise', relaySessionId: 'r1', providerSeq: 11, segmentId: 'seg-0', text: 'x' },
      { kind: 'provider-retract', relaySessionId: 'r1', providerSeq: 12, segmentId: 'seg-0' },
      { kind: 'user-correct', baseRevision: rev.revision, segmentId: 'seg-0', text: 'x' },
      { kind: 'user-retract', baseRevision: rev.revision, segmentId: 'seg-0' },
      { kind: 'language-change', language: 'fr', atMs: 700, origin: 'user' },
      { kind: 'finalize' }
    ]
    for (const ev of events) expect(apply(rev, ev)).toEqual({ ok: false, reason: 'finalized' })
  })

  it('retract stores empty text and keeps segmentId', () => {
    const rev = run([final({ providerSeq: 1 }), final({ providerSeq: 2, startMs: 200, endMs: 300 })])
    const byProvider = accept(
      apply(rev, { kind: 'provider-retract', relaySessionId: 'r1', providerSeq: 3, segmentId: 'seg-0' })
    )
    expect(byProvider.changed).toEqual(['seg-0'])
    expect(byProvider.next.segments[0]).toMatchObject({ segmentId: 'seg-0', seq: 0, state: 'retracted', text: '' })
    const byUser = accept(apply(rev, { kind: 'user-retract', baseRevision: rev.revision, segmentId: 'seg-1' }))
    expect(byUser.changed).toEqual(['seg-1'])
    expect(
      apply(byProvider.next, {
        kind: 'provider-revise',
        relaySessionId: 'r1',
        providerSeq: 4,
        segmentId: 'seg-0',
        text: 'back'
      })
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(byUser.next.segments[1]).toMatchObject({
      segmentId: 'seg-1',
      seq: 1,
      state: 'retracted',
      source: 'user',
      text: ''
    })
    expect(TranscriptRevisionSchema.safeParse(byUser.next).success).toBe(true)
  })

  it('drops duplicate providerSeq within a relay lineage', () => {
    const rev = run([final({ providerSeq: 5 })])
    expect(apply(rev, final({ providerSeq: 5, startMs: 200, endMs: 300 }))).toEqual({ ok: false, reason: 'duplicate' })
    expect(apply(rev, final({ providerSeq: 4, startMs: 200, endMs: 300 }))).toEqual({ ok: false, reason: 'duplicate' })
    expect(apply(rev, final({ providerSeq: 5, relaySessionId: 'r2' })).ok).toBe(true)
    expect(apply(rev, final({ providerSeq: 5, channel: 'system' })).ok).toBe(true)
    expect(
      apply(rev, { kind: 'provider-revise', relaySessionId: 'r1', providerSeq: 5, segmentId: 'seg-0', text: 'x' })
    ).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('refuses over-limit segments, chars and total bytes', () => {
    const limits = { maxSegments: 2, maxSegmentChars: 5, maxTotalBytes: 12 }
    const two = run(
      [final({ providerSeq: 1, text: 'abc' }), final({ providerSeq: 2, text: 'def', startMs: 200, endMs: 300 })],
      limits
    )
    expect(apply(two, final({ providerSeq: 3, text: 'g', startMs: 400, endMs: 500 }), limits)).toEqual({
      ok: false,
      reason: 'over-limit'
    })
    const one = run([final({ providerSeq: 1, text: 'abcde' })], limits)
    expect(apply(one, final({ providerSeq: 2, text: 'abcdef', startMs: 200, endMs: 300 }), limits)).toEqual({
      ok: false,
      reason: 'over-limit'
    })
    expect(apply(one, final({ providerSeq: 2, text: 'abcd', startMs: 200, endMs: 300 }), limits).ok).toBe(true)
    // 'é' is 1 char but 2 UTF-8 bytes: 'abcde' + 'ééé' is 11 bytes and fits; 5 + 10 and 5 + 8 bytes do not.
    const withAccents = accept(apply(one, final({ providerSeq: 2, text: 'ééé', startMs: 200, endMs: 300 }), limits))
    expect(
      apply(
        withAccents.next,
        { kind: 'user-correct', baseRevision: withAccents.next.revision, segmentId: 'seg-1', text: 'ééééé' },
        limits
      )
    ).toEqual({ ok: false, reason: 'over-limit' })
    expect(apply(one, final({ providerSeq: 2, text: 'éééé', startMs: 200, endMs: 300 }), limits)).toEqual({
      ok: false,
      reason: 'over-limit'
    })
  })

  it('language-change applies to later segments only', () => {
    const rev = run([
      final({ providerSeq: 1, language: 'en' }),
      { kind: 'language-change', language: 'de', atMs: 150, origin: 'user' }
    ])
    expect(rev.segments[0].language).toBe('en')
    const later = accept(apply(rev, final({ providerSeq: 2, language: 'multi', startMs: 200, endMs: 300 })))
    expect(later.next.segments[0].language).toBe('en')
    expect(later.next.segments[1].language).toBe('de')
    const change = accept(apply(later.next, { kind: 'language-change', language: 'fr', atMs: 400, origin: 'provider' }))
    expect(change.changed).toEqual([])
    expect(change.next.segments.map((segment) => segment.language)).toEqual(['en', 'de'])
    expect(change.next.languages.at(-1)).toBe('fr')
    expect(apply(change.next, { kind: 'language-change', language: 'fr', atMs: 500, origin: 'user' })).toEqual({
      ok: false,
      reason: 'duplicate'
    })
    expect(apply(change.next, { kind: 'language-change', language: 'multi', atMs: 500, origin: 'user' })).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('a provider language seen earlier becomes current again', () => {
    const rev = run([
      final({ providerSeq: 1, language: 'en', startMs: 0, endMs: 100 }),
      final({ providerSeq: 2, language: 'fr', startMs: 200, endMs: 300 }),
      final({ providerSeq: 3, language: 'en', startMs: 400, endMs: 500 }),
      final({ providerSeq: 4, language: 'multi', startMs: 600, endMs: 700 })
    ])
    expect(rev.segments.map((segment) => segment.language)).toEqual(['en', 'fr', 'en', 'en'])
    expect(rev.languages.at(-1)).toBe('en')
    expect(rev.segments[0].language).toBe('en')
  })

  it('a final commits the open partial for the same relay session and channel', () => {
    const rev = run([
      partial({ providerSeq: 1, text: 'hel', startMs: 10, endMs: 50 }),
      partial({ providerSeq: 2, text: 'hello wor', startMs: 10, endMs: 90 }),
      final({ providerSeq: 3, text: 'hello world', startMs: 5, endMs: 120, speaker: 'Ana' })
    ])
    expect(rev.segments).toHaveLength(1)
    expect(rev.segments[0]).toMatchObject({
      segmentId: 'seg-0',
      state: 'final',
      text: 'hello world',
      startMs: 5,
      endMs: 120,
      speaker: 'Ana',
      providerSeq: 3
    })
  })

  it('partials on different channels stay separate', () => {
    const rev = run([
      partial({ providerSeq: 1, channel: 'mic' }),
      partial({ providerSeq: 1, channel: 'system' }),
      partial({ providerSeq: 1, relaySessionId: 'r2' })
    ])
    expect(rev.segments.map((segment) => segment.segmentId)).toEqual(['seg-0', 'seg-1', 'seg-2'])
    expect(rev.segments.map((segment) => segment.state)).toEqual(['partial', 'partial', 'partial'])
  })

  it('provider-revise never overwrites a user correction', () => {
    const rev = run([
      final({ providerSeq: 1 }),
      { kind: 'user-correct', baseRevision: 1, segmentId: 'seg-0', text: 'mine' }
    ])
    expect(
      apply(rev, { kind: 'provider-revise', relaySessionId: 'r1', providerSeq: 2, segmentId: 'seg-0', text: 'theirs' })
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(rev.segments[0].text).toBe('mine')
    const own = run([final({ providerSeq: 1 })])
    const revised = accept(
      apply(own, { kind: 'provider-revise', relaySessionId: 'r1', providerSeq: 2, segmentId: 'seg-0', text: 'better' })
    )
    expect(revised.next.segments[0]).toMatchObject({ text: 'better', state: 'final', providerSeq: 2 })
  })

  it('provider-retract never erases a user correction', () => {
    const rev = run([
      final({ providerSeq: 1 }),
      { kind: 'user-correct', baseRevision: 1, segmentId: 'seg-0', text: 'mine' }
    ])
    expect(apply(rev, { kind: 'provider-retract', relaySessionId: 'r1', providerSeq: 2, segmentId: 'seg-0' })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(rev.segments[0]).toMatchObject({ state: 'corrected', source: 'user', text: 'mine' })
  })

  it('multi language resolves to the current language', () => {
    const empty = run([final({ providerSeq: 1, language: 'multi' })])
    expect(empty.segments[0].language).toBe('und')
    expect(empty.languages).toEqual([])
    const rev = run([
      final({ providerSeq: 1, language: 'en' }),
      final({ providerSeq: 2, language: 'multi', startMs: 200, endMs: 300 })
    ])
    expect(rev.segments[1].language).toBe('en')
    expect(rev.languages).toEqual(['en'])
  })

  it('schemas reject extra keys and a retracted segment with text', () => {
    const rev = run([final({ providerSeq: 1 })])
    const segment = rev.segments[0]
    expect(TranscriptSegmentSchema.safeParse(segment).success).toBe(true)
    expect(TranscriptSegmentSchema.safeParse({ ...segment, extra: 1 }).success).toBe(false)
    expect(TranscriptSegmentSchema.safeParse({ ...segment, state: 'retracted' }).success).toBe(false)
    expect(TranscriptSegmentSchema.safeParse({ ...segment, state: 'retracted', text: '' }).success).toBe(true)
    expect(TranscriptRevisionSchema.safeParse(rev).success).toBe(true)
    expect(TranscriptRevisionSchema.safeParse({ ...rev, extra: 1 }).success).toBe(false)
    expect(RevisionEventSchema.safeParse({ kind: 'finalize', extra: 1 }).success).toBe(false)
    const backwards = final({ providerSeq: 2, startMs: 300, endMs: 200 })
    expect(RevisionEventSchema.safeParse(backwards).success).toBe(false)
    expect(apply(rev, backwards)).toEqual({ ok: false, reason: 'invalid' })
    expect(apply(rev, final({ providerSeq: 2, relaySessionId: 'x'.repeat(65) }))).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('apply never mutates its inputs', () => {
    const rev = run([partial({ providerSeq: 1 })])
    const ev = final({ providerSeq: 2, text: 'done' })
    const revBefore = structuredClone(rev)
    const evBefore = structuredClone(ev)
    const { next, changed } = accept(apply(rev, ev))
    expect(rev).toEqual(revBefore)
    expect(ev).toEqual(evBefore)
    expect(changed).toEqual(['seg-0'])
    expect(Object.isFrozen(next)).toBe(true)
    expect(Object.isFrozen(next.segments)).toBe(true)
    expect(Object.isFrozen(next.segments[0])).toBe(true)
    expect(Object.isFrozen(next.languages)).toBe(true)
  })

  it('refuses unknown segments for revise, retract and user edits', () => {
    const rev = run([final({ providerSeq: 1 })])
    const events: RevisionEvent[] = [
      { kind: 'provider-revise', relaySessionId: 'r1', providerSeq: 2, segmentId: 'nope', text: 'x' },
      { kind: 'provider-retract', relaySessionId: 'r1', providerSeq: 2, segmentId: 'nope' },
      { kind: 'user-correct', baseRevision: rev.revision, segmentId: 'nope', text: 'x' },
      { kind: 'user-retract', baseRevision: rev.revision, segmentId: 'nope' }
    ]
    for (const ev of events) expect(apply(rev, ev)).toEqual({ ok: false, reason: 'unknown-segment' })
  })

  it('refuses an out-of-order provider segment', () => {
    const rev = run([final({ providerSeq: 1, startMs: 1000, endMs: 2000 })])
    expect(apply(rev, partial({ providerSeq: 2, startMs: 500, endMs: 900 }))).toEqual({
      ok: false,
      reason: 'out-of-order'
    })
    expect(apply(rev, partial({ providerSeq: 2, startMs: 500, endMs: 900, channel: 'system' })).ok).toBe(true)
  })
})
