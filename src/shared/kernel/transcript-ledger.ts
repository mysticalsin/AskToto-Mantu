/**
 * Canonical, revision-aware transcript ledger (Métis 2.12 G03; port of the reference kernel's `TranscriptLedger`).
 *
 * Provider adapters normalise to one event contract; the ledger is the only place that decides which text is usable:
 *  - an utterance is keyed by (stream, stream epoch, utteranceId) and only moves forward by revision;
 *  - a reconnect opens a new stream epoch: partials of the old epoch are retired (never usable context), completed
 *    finals stay as history, and late transport events of an older epoch are refused as `stale-epoch`;
 *  - a retraction leaves a tombstone, so a late final cannot resurrect retracted text;
 *  - the same event id or the same revision replayed with identical content is idempotent (no duplicate finals), and
 *    the same id or revision with different content is a collision error.
 *
 * Pure and dependency-free (no I/O, no clock, no randomness). The ledger owns no persistence: the transcript revision
 * store and the live meeting journal keep their own formats, and lines carry the ledger's identity as the additive
 * `utteranceId` and `revision` fields (see `transcript-line-identity.ts`).
 */

export const LEDGER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
export const isLedgerId = (value: unknown): value is string =>
  typeof value === 'string' && LEDGER_ID_PATTERN.test(value)

export type TranscriptLedgerErrorCode =
  | 'SCOPE_SHAPE'
  | 'SCOPE_ID'
  | 'SCOPE_MISMATCH'
  | 'EVENT_LIMIT'
  | 'UTTERANCE_LIMIT'
  | 'STREAM_ID'
  | 'STREAM_EPOCH'
  | 'STREAM_LIMIT'
  | 'STREAM_EPOCH_REGRESSION'
  | 'STREAM_NOT_STARTED'
  | 'FUTURE_STREAM_EPOCH'
  | 'EVENT_SHAPE'
  | 'EVENT_ID'
  | 'EVENT_ID_COLLISION'
  | 'UTTERANCE_REVISION'
  | 'SEGMENT_STATE'
  | 'SEGMENT_TEXT'
  | 'SEGMENT_TIME'
  | 'FINAL_EMPTY'
  | 'RETRACTION_TEXT'
  | 'RETRACTION_UNKNOWN'
  | 'REVISION_COLLISION'
  | 'UTTERANCE_RETRACTED'
  | 'FINAL_REGRESSION'

export class TranscriptLedgerError extends Error {
  readonly code: TranscriptLedgerErrorCode
  constructor(code: TranscriptLedgerErrorCode) {
    super(code)
    this.name = 'TranscriptLedgerError'
    this.code = code
  }
}

function ensure(condition: boolean, code: TranscriptLedgerErrorCode): asserts condition {
  if (!condition) throw new TranscriptLedgerError(code)
}

export interface TranscriptLedgerScope {
  tenantId: string
  userId: string
  sessionId: string
}

export type LedgerSegmentState = 'partial' | 'final' | 'retracted'

export interface TranscriptLedgerEvent {
  eventId: string
  scope: TranscriptLedgerScope
  streamId: string
  streamEpoch: number
  utteranceId: string
  revision: number
  state: LedgerSegmentState
  text: string
  startMs: number
  endMs: number
  speakerId: string
}

export type LedgerUtterance = Omit<TranscriptLedgerEvent, 'scope'> & { scope: TranscriptLedgerScope }

export type LedgerVerdictReason =
  | 'duplicate-event'
  | 'stale-epoch'
  | 'stale-revision'
  | 'duplicate-revision'
  | LedgerSegmentState

export interface LedgerVerdict {
  applied: boolean
  reason: LedgerVerdictReason
  /** The ledger's own change counter after this call (not an utterance revision). */
  revision: number
}

export interface TranscriptLedgerSnapshot {
  scope: TranscriptLedgerScope
  revision: number
  /** Final utterances, ordered by start time, then stream, epoch and utterance id. */
  segments: readonly LedgerUtterance[]
  /** Open partials of the current epochs, same order. Never part of a recap or an answer context. */
  interim: readonly LedgerUtterance[]
}

/**
 * Describes an applied event that replaced or withdrew text a consumer may already have used (a final that was
 * corrected, or a final or partial that was retracted). It is the seam correction-propagation (G15) hangs cache
 * invalidation on; the ledger itself never acts on it.
 */
export interface LedgerCorrection {
  streamId: string
  streamEpoch: number
  utteranceId: string
  previousRevision: number
  revision: number
  kind: 'corrected' | 'retracted'
}

export interface TranscriptLedgerOptions {
  maxEvents?: number
  maxUtterances?: number
  onCorrection?: (correction: LedgerCorrection) => void
}

export const DEFAULT_LEDGER_MAX_EVENTS = 2_048
export const DEFAULT_LEDGER_MAX_UTTERANCES = 512
// Hard ceilings sit above the reference kernel's (100k events, 1,024 utterances): a real meeting commits thousands of
// finals, so the live consumer passes its own limit; the defaults stay the reference's.
const MAX_EVENTS_CEILING = 200_000
const MAX_UTTERANCES_CEILING = 20_000
const MAX_STREAMS = 32
const MAX_TEXT = 16_384

const STATES: ReadonlySet<string> = new Set(['partial', 'final', 'retracted'])
const EVENT_KEYS = [
  'eventId',
  'scope',
  'streamId',
  'streamEpoch',
  'utteranceId',
  'revision',
  'state',
  'text',
  'startMs',
  'endMs',
  'speakerId'
].sort()
const SCOPE_KEYS = ['sessionId', 'tenantId', 'userId']

const compareId = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1)
const isSafeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

/** Plain own data properties only: no accessors, no prototype tricks, nothing executable crosses the contract. */
function plainRecord(value: unknown, code: TranscriptLedgerErrorCode): Record<string, unknown> {
  ensure(!!value && typeof value === 'object' && !Array.isArray(value), code)
  ensure(Object.getPrototypeOf(value) === Object.prototype, code)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as object)) {
    ensure(key !== '__proto__' && key !== 'constructor' && key !== 'prototype', code)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    ensure(!!descriptor && 'value' in descriptor, code)
    out[key] = descriptor.value
  }
  return out
}

function parseScope(value: unknown): TranscriptLedgerScope {
  const raw = plainRecord(value, 'SCOPE_SHAPE')
  ensure(Object.keys(raw).sort().join(',') === SCOPE_KEYS.join(','), 'SCOPE_SHAPE')
  for (const field of SCOPE_KEYS) ensure(isLedgerId(raw[field]), 'SCOPE_ID')
  return Object.freeze({
    tenantId: raw.tenantId as string,
    userId: raw.userId as string,
    sessionId: raw.sessionId as string
  })
}

const scopeKey = (scope: TranscriptLedgerScope): string =>
  JSON.stringify([scope.tenantId, scope.userId, scope.sessionId])

function assertSameScope(expected: TranscriptLedgerScope, actual: unknown): void {
  ensure(scopeKey(expected) === scopeKey(parseScope(actual)), 'SCOPE_MISMATCH')
}

/** Order-stable fingerprint of a validated event (field order is fixed, so equal content is an equal string). */
function fingerprint(event: TranscriptLedgerEvent): string {
  return JSON.stringify([
    event.eventId,
    scopeKey(event.scope),
    event.streamId,
    event.streamEpoch,
    event.utteranceId,
    event.revision,
    event.state,
    event.text,
    event.startMs,
    event.endMs,
    event.speakerId
  ])
}

/** Everything except the event id: two events with equal content describe the same revision. */
function contentKey(event: TranscriptLedgerEvent): string {
  return JSON.stringify([
    scopeKey(event.scope),
    event.streamId,
    event.streamEpoch,
    event.utteranceId,
    event.revision,
    event.state,
    event.text,
    event.startMs,
    event.endMs,
    event.speakerId
  ])
}

function parseEvent(input: unknown, scope: TranscriptLedgerScope): TranscriptLedgerEvent {
  const raw = plainRecord(input, 'EVENT_SHAPE')
  ensure(Object.keys(raw).sort().join(',') === EVENT_KEYS.join(','), 'EVENT_SHAPE')
  assertSameScope(scope, raw.scope)
  for (const key of ['eventId', 'streamId', 'utteranceId', 'speakerId'] as const)
    ensure(isLedgerId(raw[key]), 'EVENT_ID')
  ensure(isSafeInt(raw.streamEpoch) && raw.streamEpoch > 0, 'STREAM_EPOCH')
  ensure(isSafeInt(raw.revision) && raw.revision > 0, 'UTTERANCE_REVISION')
  ensure(typeof raw.state === 'string' && STATES.has(raw.state), 'SEGMENT_STATE')
  ensure(typeof raw.text === 'string' && raw.text.length <= MAX_TEXT, 'SEGMENT_TEXT')
  ensure(raw.state !== 'final' || raw.text.trim().length > 0, 'FINAL_EMPTY')
  ensure(raw.state !== 'retracted' || raw.text === '', 'RETRACTION_TEXT')
  ensure(isSafeInt(raw.startMs) && raw.startMs >= 0, 'SEGMENT_TIME')
  ensure(isSafeInt(raw.endMs) && raw.endMs >= raw.startMs, 'SEGMENT_TIME')
  return {
    eventId: raw.eventId as string,
    scope,
    streamId: raw.streamId as string,
    streamEpoch: raw.streamEpoch as number,
    utteranceId: raw.utteranceId as string,
    revision: raw.revision as number,
    state: raw.state as LedgerSegmentState,
    text: raw.text as string,
    startMs: raw.startMs as number,
    endMs: raw.endMs as number,
    speakerId: raw.speakerId as string
  }
}

const utteranceKey = (streamId: string, epoch: number, utteranceId: string): string =>
  JSON.stringify([streamId, epoch, utteranceId])

export class TranscriptLedger {
  private readonly scope: TranscriptLedgerScope
  private readonly maxEvents: number
  private readonly maxUtterances: number
  private readonly onCorrection: ((correction: LedgerCorrection) => void) | undefined
  private changeCounter = 0
  private readonly epochs = new Map<string, number>()
  private readonly utterances = new Map<string, Readonly<TranscriptLedgerEvent>>()
  private readonly events = new Map<string, string>()

  constructor(scope: TranscriptLedgerScope, options: TranscriptLedgerOptions = {}) {
    this.scope = parseScope(scope)
    const maxEvents = options.maxEvents ?? DEFAULT_LEDGER_MAX_EVENTS
    const maxUtterances = options.maxUtterances ?? DEFAULT_LEDGER_MAX_UTTERANCES
    ensure(isSafeInt(maxEvents) && maxEvents > 0 && maxEvents <= MAX_EVENTS_CEILING, 'EVENT_LIMIT')
    ensure(isSafeInt(maxUtterances) && maxUtterances > 0 && maxUtterances <= MAX_UTTERANCES_CEILING, 'UTTERANCE_LIMIT')
    this.maxEvents = maxEvents
    this.maxUtterances = maxUtterances
    this.onCorrection = options.onCorrection
  }

  /** Only the trusted session owner calls this, once per new transport connection of a stream. */
  startStream(input: { scope: TranscriptLedgerScope; streamId: string; epoch: number }): void {
    assertSameScope(this.scope, input.scope)
    ensure(isLedgerId(input.streamId), 'STREAM_ID')
    ensure(isSafeInt(input.epoch) && input.epoch > 0, 'STREAM_EPOCH')
    const previous = this.epochs.get(input.streamId)
    ensure(previous !== undefined || this.epochs.size < MAX_STREAMS, 'STREAM_LIMIT')
    ensure(previous === undefined || input.epoch > previous, 'STREAM_EPOCH_REGRESSION')
    this.epochs.set(input.streamId, input.epoch)
    // Retired partials are not usable context. Completed finals remain historical facts.
    for (const [key, value] of [...this.utterances]) {
      if (value.streamId === input.streamId && value.state === 'partial') this.utterances.delete(key)
    }
    this.changeCounter += 1
  }

  apply(input: unknown): LedgerVerdict {
    const event = parseEvent(input, this.scope)
    const print = fingerprint(event)
    const known = this.events.get(event.eventId)
    if (known !== undefined) {
      ensure(known === print, 'EVENT_ID_COLLISION')
      return this.verdict(false, 'duplicate-event')
    }
    const epoch = this.epochs.get(event.streamId)
    ensure(epoch !== undefined, 'STREAM_NOT_STARTED')
    if (event.streamEpoch < epoch) return this.verdict(false, 'stale-epoch')
    ensure(event.streamEpoch === epoch, 'FUTURE_STREAM_EPOCH')
    const key = utteranceKey(event.streamId, event.streamEpoch, event.utteranceId)
    const previous = this.utterances.get(key)
    if (previous) {
      if (event.revision < previous.revision) return this.verdict(false, 'stale-revision')
      if (event.revision === previous.revision) {
        ensure(contentKey(event) === contentKey(previous), 'REVISION_COLLISION')
        this.remember(event.eventId, print)
        return this.verdict(false, 'duplicate-revision')
      }
      ensure(previous.state !== 'retracted', 'UTTERANCE_RETRACTED')
      ensure(previous.state !== 'final' || event.state !== 'partial', 'FINAL_REGRESSION')
    } else {
      ensure(this.utterances.size < this.maxUtterances, 'UTTERANCE_LIMIT')
      ensure(event.state !== 'retracted', 'RETRACTION_UNKNOWN')
    }
    this.remember(event.eventId, print)
    this.utterances.set(key, Object.freeze(event))
    this.changeCounter += 1
    const verdict = this.verdict(true, event.state)
    if (previous && (previous.state === 'final' || event.state === 'retracted')) {
      this.notify({
        streamId: event.streamId,
        streamEpoch: event.streamEpoch,
        utteranceId: event.utteranceId,
        previousRevision: previous.revision,
        revision: event.revision,
        kind: event.state === 'retracted' ? 'retracted' : 'corrected'
      })
    }
    return verdict
  }

  snapshot(): TranscriptLedgerSnapshot {
    const ordered = [...this.utterances.values()].sort(
      (a, b) =>
        a.startMs - b.startMs ||
        compareId(a.streamId, b.streamId) ||
        a.streamEpoch - b.streamEpoch ||
        compareId(a.utteranceId, b.utteranceId)
    )
    return Object.freeze({
      scope: this.scope,
      revision: this.changeCounter,
      segments: Object.freeze(ordered.filter((item) => item.state === 'final')),
      interim: Object.freeze(ordered.filter((item) => item.state === 'partial'))
    })
  }

  private remember(id: string, print: string): void {
    ensure(this.events.size < this.maxEvents, 'EVENT_LIMIT')
    this.events.set(id, print)
  }

  private verdict(applied: boolean, reason: LedgerVerdictReason): LedgerVerdict {
    return { applied, reason, revision: this.changeCounter }
  }

  private notify(correction: LedgerCorrection): void {
    try {
      this.onCorrection?.(correction)
    } catch {
      // a throwing observer never changes the canonical text
    }
  }
}
