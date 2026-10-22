import { describe, expect, it } from 'vitest'
import {
  TranscriptLedger,
  TranscriptLedgerError,
  type LedgerCorrection,
  type TranscriptLedgerEvent,
  type TranscriptLedgerErrorCode,
  type TranscriptLedgerOptions,
  type TranscriptLedgerScope
} from './transcript-ledger'

// All people, tenants and utterances are synthetic.
const SCOPE: TranscriptLedgerScope = Object.freeze({
  tenantId: 'synthetic-tenant-a',
  userId: 'synthetic-user-a',
  sessionId: 'synthetic-meeting-1'
})

const ev = (overrides: Record<string, unknown> = {}): TranscriptLedgerEvent =>
  ({
    eventId: 'synthetic-event-1',
    scope: SCOPE,
    streamId: 'microphone',
    streamEpoch: 1,
    utteranceId: 'synthetic-utterance-1',
    revision: 1,
    state: 'partial',
    text: 'Synthetic draft',
    startMs: 100,
    endMs: 300,
    speakerId: 'YOU',
    ...overrides
  }) as TranscriptLedgerEvent

const started = (options?: TranscriptLedgerOptions): TranscriptLedger => {
  const ledger = new TranscriptLedger(SCOPE, options)
  ledger.startStream({ scope: SCOPE, streamId: 'microphone', epoch: 1 })
  return ledger
}

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return error instanceof TranscriptLedgerError ? error.code : `unexpected:${String(error)}`
  }
  return undefined
}

describe('TranscriptLedger reference scenarios (ported from the reference kernel)', () => {
  it('partial-to-final normalization keeps one canonical utterance and separates interim text', () => {
    const words = started()
    words.apply(ev())
    expect(words.snapshot().segments).toHaveLength(0)
    expect(words.snapshot().interim).toHaveLength(1)
    words.apply(ev({ eventId: 'synthetic-event-2', revision: 2, state: 'final', text: 'Synthetic final' }))
    expect(words.snapshot().interim).toHaveLength(0)
    expect(words.snapshot().segments).toHaveLength(1)
    expect(words.snapshot().segments[0].text).toBe('Synthetic final')
  })

  it('duplicate provider event IDs and identical utterance revisions are idempotent', () => {
    const words = started()
    const original = ev({ state: 'final' })
    const applied = words.apply(original)
    expect(words.apply(original)).toEqual({ applied: false, reason: 'duplicate-event', revision: applied.revision })
    expect(words.apply({ ...original, eventId: 'synthetic-event-copy' })).toEqual({
      applied: false,
      reason: 'duplicate-revision',
      revision: applied.revision
    })
    expect(words.snapshot().segments).toHaveLength(1)
  })

  it('conflicting reuse of an event ID or an utterance revision is rejected', () => {
    const words = started()
    words.apply(ev())
    expect(codeOf(() => words.apply(ev({ text: 'Conflicting event' })))).toBe('EVENT_ID_COLLISION')
    expect(codeOf(() => words.apply(ev({ eventId: 'synthetic-event-2', text: 'Conflicting revision' })))).toBe(
      'REVISION_COLLISION'
    )
    expect(words.snapshot().interim[0].text).toBe('Synthetic draft')
  })

  it('final corrections replace earlier text; stale revisions and final-to-partial regressions cannot overwrite it', () => {
    const words = started()
    words.apply(ev({ state: 'final', text: 'Synthetic draft final' }))
    words.apply(ev({ eventId: 'synthetic-event-2', revision: 2, state: 'final', text: 'Synthetic corrected final' }))
    expect(words.apply(ev({ eventId: 'synthetic-stale', state: 'final' })).reason).toBe('stale-revision')
    expect(codeOf(() => words.apply(ev({ eventId: 'synthetic-event-3', revision: 3 })))).toBe('FINAL_REGRESSION')
    expect(words.snapshot().segments).toHaveLength(1)
    expect(words.snapshot().segments[0].text).toBe('Synthetic corrected final')
  })

  it('a retraction removes usable text and preserves a tombstone against accidental resurrection', () => {
    const words = started()
    words.apply(ev({ state: 'final' }))
    words.apply(ev({ eventId: 'synthetic-retract', revision: 2, state: 'retracted', text: '' }))
    expect(words.snapshot().segments).toHaveLength(0)
    expect(words.snapshot().interim).toHaveLength(0)
    expect(codeOf(() => words.apply(ev({ eventId: 'synthetic-revive', revision: 3, state: 'final' })))).toBe(
      'UTTERANCE_RETRACTED'
    )
    expect(
      codeOf(() =>
        words.apply(ev({ eventId: 'synthetic-unknown', utteranceId: 'unknown', state: 'retracted', text: '' }))
      )
    ).toBe('RETRACTION_UNKNOWN')
  })

  it('a reconnect retires partials, rejects stale transport events and preserves completed history', () => {
    const words = started()
    words.apply(ev({ state: 'final' }))
    words.apply(ev({ eventId: 'synthetic-partial', utteranceId: 'partial' }))
    words.startStream({ scope: SCOPE, streamId: 'microphone', epoch: 2 })
    expect(words.snapshot().interim).toHaveLength(0)
    expect(words.apply(ev({ eventId: 'synthetic-late', revision: 2, state: 'final' })).reason).toBe('stale-epoch')
    words.apply(ev({ eventId: 'synthetic-new-epoch', streamEpoch: 2, state: 'final' }))
    expect(words.snapshot().segments).toHaveLength(2)
    expect(codeOf(() => words.startStream({ scope: SCOPE, streamId: 'microphone', epoch: 1 }))).toBe(
      'STREAM_EPOCH_REGRESSION'
    )
  })

  it('transcript identity, time and event-capacity failures do not mutate canonical text', () => {
    const words = started({ maxEvents: 1 })
    expect(codeOf(() => words.apply(ev({ scope: { ...SCOPE, tenantId: 'synthetic-tenant-b' } })))).toBe(
      'SCOPE_MISMATCH'
    )
    expect(codeOf(() => words.apply(ev({ endMs: 50 })))).toBe('SEGMENT_TIME')
    expect(codeOf(() => words.apply(ev({ streamEpoch: 2 })))).toBe('FUTURE_STREAM_EPOCH')
    words.apply(ev({ state: 'final' }))
    expect(codeOf(() => words.apply(ev({ eventId: 'synthetic-over-limit', revision: 2, state: 'final' })))).toBe(
      'EVENT_LIMIT'
    )
    expect(words.snapshot().segments[0].revision).toBe(1)
  })
})

interface Fixture {
  name: string
  /** Applied (and required to succeed) before the event under test. */
  before?: Array<Record<string, unknown>>
  /** Stream epoch of the ledger before the event under test. */
  epoch?: number
  options?: TranscriptLedgerOptions
  event: Record<string, unknown> | (() => unknown)
  expect: { throws: TranscriptLedgerErrorCode } | { applied: boolean; reason: string }
}

const FINAL = { state: 'final', text: 'Synthetic final' }
const longId = 'u'.repeat(129)
const accessor = (): unknown => {
  const event: Record<string, unknown> = { ...ev() }
  Object.defineProperty(event, 'text', { enumerable: true, get: () => 'Synthetic draft' })
  return event
}
const without = (key: string): unknown => {
  const { [key]: _omitted, ...rest } = ev() as unknown as Record<string, unknown>
  return rest
}

/** The 36 normalization fixtures: every accept, ignore and refuse decision the ledger can make for one event. */
const FIXTURES: Fixture[] = [
  { name: 'refuses an event missing a field', event: () => without('speakerId'), expect: { throws: 'EVENT_SHAPE' } },
  { name: 'refuses an event with an extra field', event: { provider: 'x' }, expect: { throws: 'EVENT_SHAPE' } },
  { name: 'refuses an accessor property', event: accessor, expect: { throws: 'EVENT_SHAPE' } },
  {
    name: 'refuses another tenant',
    event: { scope: { ...SCOPE, tenantId: 'other' } },
    expect: { throws: 'SCOPE_MISMATCH' }
  },
  {
    name: 'refuses another user',
    event: { scope: { ...SCOPE, userId: 'other' } },
    expect: { throws: 'SCOPE_MISMATCH' }
  },
  {
    name: 'refuses another session',
    event: { scope: { ...SCOPE, sessionId: 'other' } },
    expect: { throws: 'SCOPE_MISMATCH' }
  },
  { name: 'refuses an empty event id', event: { eventId: '' }, expect: { throws: 'EVENT_ID' } },
  { name: 'refuses a stream id with a space', event: { streamId: 'micro phone' }, expect: { throws: 'EVENT_ID' } },
  {
    name: 'refuses an utterance id over 128 characters',
    event: { utteranceId: longId },
    expect: { throws: 'EVENT_ID' }
  },
  { name: 'refuses a non-string speaker id', event: { speakerId: 7 }, expect: { throws: 'EVENT_ID' } },
  { name: 'refuses stream epoch 0', event: { streamEpoch: 0 }, expect: { throws: 'STREAM_EPOCH' } },
  { name: 'refuses utterance revision 0', event: { revision: 0 }, expect: { throws: 'UTTERANCE_REVISION' } },
  { name: 'refuses a fractional revision', event: { revision: 1.5 }, expect: { throws: 'UTTERANCE_REVISION' } },
  { name: 'refuses an unknown state', event: { state: 'corrected' }, expect: { throws: 'SEGMENT_STATE' } },
  { name: 'refuses non-string text', event: { text: 12 }, expect: { throws: 'SEGMENT_TEXT' } },
  {
    name: 'refuses text over 16,384 characters',
    event: { text: 'x'.repeat(16_385) },
    expect: { throws: 'SEGMENT_TEXT' }
  },
  {
    name: 'refuses a whitespace-only final',
    event: { state: 'final', text: '  \n' },
    expect: { throws: 'FINAL_EMPTY' }
  },
  {
    name: 'refuses a retraction that carries text',
    event: { state: 'retracted', text: 'x' },
    expect: { throws: 'RETRACTION_TEXT' }
  },
  { name: 'refuses a negative start', event: { startMs: -1 }, expect: { throws: 'SEGMENT_TIME' } },
  { name: 'refuses an end before the start', event: { endMs: 50 }, expect: { throws: 'SEGMENT_TIME' } },
  { name: 'refuses a fractional time', event: { startMs: 1.5, endMs: 3 }, expect: { throws: 'SEGMENT_TIME' } },
  {
    name: 'refuses an event on a stream that never started',
    event: { streamId: 'system' },
    expect: { throws: 'STREAM_NOT_STARTED' }
  },
  {
    name: 'refuses an event from a future epoch',
    event: { streamEpoch: 2 },
    expect: { throws: 'FUTURE_STREAM_EPOCH' }
  },
  {
    name: 'refuses an event id reused with other content',
    before: [{}],
    event: { text: 'Different text' },
    expect: { throws: 'EVENT_ID_COLLISION' }
  },
  {
    name: 'refuses a revision reused with other content',
    before: [{}],
    event: { eventId: 'synthetic-event-2', text: 'Different text' },
    expect: { throws: 'REVISION_COLLISION' }
  },
  {
    name: 'refuses any revision after a retraction',
    before: [FINAL, { eventId: 'e2', revision: 2, state: 'retracted', text: '' }],
    event: { eventId: 'e3', revision: 3, ...FINAL },
    expect: { throws: 'UTTERANCE_RETRACTED' }
  },
  {
    name: 'refuses a partial after a final',
    before: [FINAL],
    event: { eventId: 'e2', revision: 2 },
    expect: { throws: 'FINAL_REGRESSION' }
  },
  {
    name: 'refuses a retraction of an unknown utterance',
    event: { state: 'retracted', text: '' },
    expect: { throws: 'RETRACTION_UNKNOWN' }
  },
  {
    name: 'refuses a new utterance over the utterance limit',
    options: { maxUtterances: 1 },
    before: [{}],
    event: { eventId: 'e2', utteranceId: 'second' },
    expect: { throws: 'UTTERANCE_LIMIT' }
  },
  {
    name: 'refuses an event over the event limit',
    options: { maxEvents: 1 },
    before: [{}],
    event: { eventId: 'e2', revision: 2 },
    expect: { throws: 'EVENT_LIMIT' }
  },
  { name: 'accepts a first partial', event: {}, expect: { applied: true, reason: 'partial' } },
  {
    name: 'accepts a final that completes a partial',
    before: [{}],
    event: { eventId: 'e2', revision: 2, ...FINAL },
    expect: { applied: true, reason: 'final' }
  },
  {
    name: 'ignores a replayed event id as a duplicate event',
    before: [{}],
    event: {},
    expect: { applied: false, reason: 'duplicate-event' }
  },
  {
    name: 'ignores a re-delivered revision under a new event id',
    before: [{}],
    event: { eventId: 'e2' },
    expect: { applied: false, reason: 'duplicate-revision' }
  },
  {
    name: 'ignores an older revision as stale',
    before: [{ revision: 2, state: 'partial' }],
    event: { eventId: 'e2', revision: 1 },
    expect: { applied: false, reason: 'stale-revision' }
  },
  {
    name: 'ignores a late event of a retired epoch as stale',
    epoch: 2,
    event: { eventId: 'e2', streamEpoch: 1, ...FINAL },
    expect: { applied: false, reason: 'stale-epoch' }
  }
]

describe('TranscriptLedger normalization fixtures', () => {
  it('holds exactly the 36 fixtures', () => {
    expect(FIXTURES).toHaveLength(36)
    expect(new Set(FIXTURES.map((fixture) => fixture.name)).size).toBe(36)
  })

  it.each(FIXTURES)('$name', (fixture) => {
    const ledger = started(fixture.options)
    if (fixture.epoch) ledger.startStream({ scope: SCOPE, streamId: 'microphone', epoch: fixture.epoch })
    for (const [index, overrides] of (fixture.before ?? []).entries()) {
      ledger.apply(ev({ eventId: index === 0 ? 'synthetic-event-1' : `before-${index}`, ...overrides }))
    }
    const before = JSON.stringify(ledger.snapshot())
    const input = typeof fixture.event === 'function' ? fixture.event() : ev(fixture.event)
    if ('throws' in fixture.expect) {
      expect(codeOf(() => ledger.apply(input))).toBe(fixture.expect.throws)
      // a refused event never changes canonical text
      expect(JSON.stringify(ledger.snapshot())).toBe(before)
    } else {
      const verdict = ledger.apply(input)
      expect({ applied: verdict.applied, reason: verdict.reason }).toEqual(fixture.expect)
      if (!verdict.applied) expect(JSON.stringify(ledger.snapshot())).toBe(before)
    }
  })
})

describe('TranscriptLedger stream epochs and construction', () => {
  it.each([
    ['a bad stream id', { streamId: 'a b', epoch: 1 }, 'STREAM_ID'],
    ['epoch 0', { streamId: 'microphone', epoch: 0 }, 'STREAM_EPOCH'],
    ['a non-integer epoch', { streamId: 'microphone', epoch: 1.5 }, 'STREAM_EPOCH'],
    ['the same epoch again', { streamId: 'microphone', epoch: 1 }, 'STREAM_EPOCH_REGRESSION']
  ] as const)('startStream refuses %s', (_name, input, code) => {
    const ledger = started()
    expect(codeOf(() => ledger.startStream({ scope: SCOPE, ...input }))).toBe(code)
  })

  it('startStream refuses another scope and a 33rd stream', () => {
    const ledger = started()
    expect(
      codeOf(() => ledger.startStream({ scope: { ...SCOPE, userId: 'other' }, streamId: 'system', epoch: 1 }))
    ).toBe('SCOPE_MISMATCH')
    for (let index = 0; index < 31; index += 1) ledger.startStream({ scope: SCOPE, streamId: `s${index}`, epoch: 1 })
    expect(codeOf(() => ledger.startStream({ scope: SCOPE, streamId: 'one-too-many', epoch: 1 }))).toBe('STREAM_LIMIT')
  })

  it("retires only the reconnecting stream's partials and keeps the other stream open", () => {
    const ledger = started()
    ledger.startStream({ scope: SCOPE, streamId: 'system', epoch: 1 })
    ledger.apply(ev({ eventId: 'mic-partial' }))
    ledger.apply(ev({ eventId: 'sys-partial', streamId: 'system', speakerId: 'THEM' }))
    ledger.startStream({ scope: SCOPE, streamId: 'microphone', epoch: 2 })
    expect(ledger.snapshot().interim.map((item) => item.streamId)).toEqual(['system'])
  })

  it('keeps the same utterance id in two epochs as two utterances', () => {
    const ledger = started()
    ledger.apply(ev({ ...FINAL }))
    ledger.startStream({ scope: SCOPE, streamId: 'microphone', epoch: 2 })
    ledger.apply(
      ev({ eventId: 'e2', streamEpoch: 2, ...FINAL, text: 'Synthetic second epoch', startMs: 400, endMs: 500 })
    )
    expect(ledger.snapshot().segments.map((item) => item.text)).toEqual(['Synthetic final', 'Synthetic second epoch'])
  })

  it('orders finals by start time, then stream, epoch and utterance id', () => {
    const ledger = started()
    ledger.startStream({ scope: SCOPE, streamId: 'system', epoch: 1 })
    ledger.apply(ev({ eventId: 'a', utteranceId: 'b', startMs: 50, endMs: 60, ...FINAL }))
    ledger.apply(ev({ eventId: 'b', utteranceId: 'a', startMs: 50, endMs: 60, ...FINAL }))
    ledger.apply(ev({ eventId: 'c', streamId: 'system', utteranceId: 'z', startMs: 50, endMs: 60, ...FINAL }))
    ledger.apply(ev({ eventId: 'd', utteranceId: 'early', startMs: 10, endMs: 20, ...FINAL }))
    expect(ledger.snapshot().segments.map((item) => `${item.streamId}/${item.utteranceId}`)).toEqual([
      'microphone/early',
      'microphone/a',
      'microphone/b',
      'system/z'
    ])
  })

  it('returns an immutable snapshot that a later apply does not change', () => {
    const ledger = started()
    ledger.apply(ev({ ...FINAL }))
    const snapshot = ledger.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.segments)).toBe(true)
    expect(Object.isFrozen(snapshot.segments[0])).toBe(true)
    ledger.apply(ev({ eventId: 'e2', revision: 2, ...FINAL, text: 'Synthetic corrected' }))
    expect(snapshot.segments[0].text).toBe('Synthetic final')
    expect(ledger.snapshot().revision).toBeGreaterThan(snapshot.revision)
  })

  it("does not hold on to the caller's event object", () => {
    const ledger = started()
    const input = ev({ ...FINAL })
    ledger.apply(input)
    ;(input as { text: string }).text = 'mutated afterwards'
    expect(ledger.snapshot().segments[0].text).toBe('Synthetic final')
  })

  it.each([
    ['a missing scope field', { tenantId: 'a', userId: 'b' }, 'SCOPE_SHAPE'],
    ['an extra scope field', { ...SCOPE, role: 'admin' }, 'SCOPE_SHAPE'],
    ['a bad scope id', { ...SCOPE, userId: 'a b' }, 'SCOPE_ID']
  ] as const)('refuses a ledger scope with %s', (_name, scope, code) => {
    expect(codeOf(() => new TranscriptLedger(scope as unknown as TranscriptLedgerScope))).toBe(code)
  })

  it.each([
    [{ maxEvents: 0 }, 'EVENT_LIMIT'],
    [{ maxEvents: 200_001 }, 'EVENT_LIMIT'],
    [{ maxUtterances: 0 }, 'UTTERANCE_LIMIT'],
    [{ maxUtterances: 20_001 }, 'UTTERANCE_LIMIT']
  ] as const)('refuses the limits %j', (options, code) => {
    expect(codeOf(() => new TranscriptLedger(SCOPE, options))).toBe(code)
  })
})

describe('TranscriptLedger correction hook (the seam correction propagation hangs invalidation on)', () => {
  const collect = (): { ledger: TranscriptLedger; seen: LedgerCorrection[] } => {
    const seen: LedgerCorrection[] = []
    return { ledger: started({ onCorrection: (correction) => seen.push(correction) }), seen }
  }

  it('reports a corrected final and a retraction, never a first final or a partial update', () => {
    const { ledger, seen } = collect()
    ledger.apply(ev({ eventId: 'e1', text: 'Synthetic draft' }))
    ledger.apply(ev({ eventId: 'e2', revision: 2, text: 'Synthetic draft longer' }))
    ledger.apply(ev({ eventId: 'e3', revision: 3, ...FINAL }))
    expect(seen).toEqual([])
    ledger.apply(ev({ eventId: 'e4', revision: 4, ...FINAL, text: 'Synthetic corrected final' }))
    ledger.apply(ev({ eventId: 'e5', revision: 5, state: 'retracted', text: '' }))
    expect(seen).toEqual([
      {
        streamId: 'microphone',
        streamEpoch: 1,
        utteranceId: 'synthetic-utterance-1',
        previousRevision: 3,
        revision: 4,
        kind: 'corrected'
      },
      {
        streamId: 'microphone',
        streamEpoch: 1,
        utteranceId: 'synthetic-utterance-1',
        previousRevision: 4,
        revision: 5,
        kind: 'retracted'
      }
    ])
  })

  it('does not report duplicates, stale events or refused events', () => {
    const { ledger, seen } = collect()
    ledger.apply(ev({ ...FINAL }))
    ledger.apply(ev({ ...FINAL }))
    ledger.apply(ev({ eventId: 'e2', ...FINAL }))
    expect(codeOf(() => ledger.apply(ev({ eventId: 'e3', revision: 2 })))).toBe('FINAL_REGRESSION')
    expect(seen).toEqual([])
  })

  it('never lets a throwing observer change canonical text', () => {
    const ledger = started({
      onCorrection: () => {
        throw new Error('observer failure')
      }
    })
    ledger.apply(ev({ ...FINAL }))
    expect(ledger.apply(ev({ eventId: 'e2', revision: 2, ...FINAL, text: 'Synthetic corrected' })).applied).toBe(true)
    expect(ledger.snapshot().segments[0].text).toBe('Synthetic corrected')
  })
})
