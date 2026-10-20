import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyRevisionEvent,
  DEFAULT_REVISION_LIMITS,
  emptyTranscriptRevision,
  RevisionEventSchema
} from '@shared/contracts/speech/transcript-revision'
import { RelayResultSequence, type RelayTranscript, relayTranscriptToRevisionEvent } from './relay-results'

const fixture = JSON.parse(readFileSync('scripts/qa/fixtures/speech-relay-protocol-v1.json', 'utf8')) as {
  events: { partial: unknown; final: unknown; terminal: unknown }
}
const expected = {
  protocolVersion: 1 as const,
  sessionId: '00000000-0000-4000-8000-000000000101',
  captureGeneration: 7,
  track: 'microphone' as const,
  streamEpoch: 11
}

describe('RelayResultSequence', () => {
  it('accepts ordered revisions and a terminal only after all result sequences arrive', () => {
    const results = new RelayResultSequence(expected, 60_000)
    expect(results.accept(fixture.events.partial)).toMatchObject({ ok: true, event: { sequence: 1, revision: 1 } })
    expect(results.accept(fixture.events.final)).toMatchObject({
      ok: true,
      event: { sequence: 2, revision: 2, final: true }
    })
    expect(results.accept(fixture.events.terminal)).toMatchObject({
      ok: true,
      event: { type: 'terminal', lastSequence: 2, closeConfirmed: true, tail: 'complete' }
    })
    expect(results.accept(fixture.events.final)).toMatchObject({ ok: false, code: 'AFTER_TERMINAL' })
  })

  it('rejects gaps, duplicate sequences, wrong identities, and revisions after final', () => {
    const results = new RelayResultSequence(expected, 60_000)
    const partial = fixture.events.partial as Record<string, unknown>
    expect(results.accept({ ...partial, sequence: 2 })).toMatchObject({ ok: false, code: 'SEQUENCE' })
    expect(results.accept({ ...partial, sessionId: '00000000-0000-4000-8000-000000000999' })).toMatchObject({
      ok: false,
      code: 'IDENTITY'
    })
    expect(results.accept(partial)).toMatchObject({ ok: true })
    expect(results.accept(partial)).toMatchObject({ ok: false, code: 'SEQUENCE' })
    const final = fixture.events.final as Record<string, unknown>
    expect(results.accept(final)).toMatchObject({ ok: true })
    expect(results.accept({ ...final, final: false, sequence: 3, revision: 3 })).toMatchObject({
      ok: false,
      code: 'AFTER_FINAL'
    })
  })

  it('rejects unknown payload fields, unsafe time ranges, and terminal sequence mismatches', () => {
    const partial = fixture.events.partial as Record<string, unknown>
    expect(
      new RelayResultSequence(expected, 60_000).accept({ ...partial, providerRaw: 'must not escape' })
    ).toMatchObject({
      ok: false,
      code: 'MALFORMED'
    })
    expect(new RelayResultSequence(expected, 60_000).accept({ ...partial, endMs: 60_001 })).toMatchObject({
      ok: false,
      code: 'MALFORMED'
    })
    const results = new RelayResultSequence(expected, 60_000)
    expect(results.accept(fixture.events.partial)).toMatchObject({ ok: true })
    expect(results.accept({ ...(fixture.events.terminal as Record<string, unknown>), lastSequence: 0 })).toMatchObject({
      ok: false,
      code: 'TERMINAL_MISMATCH'
    })
  })

  it('caps cumulative accepted transcript and terminal bytes per stream', () => {
    const partial = fixture.events.partial as Record<string, unknown>
    const results = new RelayResultSequence(expected, 60_000, 100)
    expect(results.accept(partial)).toMatchObject({ ok: false, code: 'OUTPUT_LIMIT' })
  })

  it('caps the number of tracked segments independently of byte accounting', () => {
    const partial = fixture.events.partial as Record<string, unknown>
    const results = new RelayResultSequence(expected, 60_000, 1024 * 1024, 1)
    expect(results.accept(partial)).toMatchObject({ ok: true })
    expect(results.accept({ ...partial, sequence: 2, segmentIndex: 2 })).toMatchObject({
      ok: false,
      code: 'OUTPUT_LIMIT'
    })
  })

  it('accounts actual wire bytes even when JSON contains ignorable whitespace', () => {
    const results = new RelayResultSequence(expected, 60_000, 1_000)
    expect(results.accept(fixture.events.partial, 1_001)).toMatchObject({ ok: false, code: 'OUTPUT_LIMIT' })
  })
})

describe('relayTranscriptToRevisionEvent', () => {
  it('maps a relay final and partial to provider revision events', () => {
    const results = new RelayResultSequence(expected, 60_000)
    const accepted = [fixture.events.partial, fixture.events.final].map((value) => {
      const result = results.accept(value)
      if (!result.ok || result.event.type !== 'transcript') throw new Error('fixture must be an accepted transcript')
      return result.event as RelayTranscript
    })
    const [partial, final] = accepted.map(relayTranscriptToRevisionEvent)
    const lineage = `${expected.sessionId}:${expected.streamEpoch}`
    expect(partial).toMatchObject({ kind: 'provider-partial', channel: 'mic', relaySessionId: lineage, providerSeq: 1 })
    expect(final).toMatchObject({ kind: 'provider-final', channel: 'mic', relaySessionId: lineage, providerSeq: 2 })
    expect(final).not.toHaveProperty('speaker')
    expect(RevisionEventSchema.safeParse(partial).success).toBe(true)
    expect(RevisionEventSchema.safeParse(final).success).toBe(true)

    const first = applyRevisionEvent(emptyTranscriptRevision(1), partial, DEFAULT_REVISION_LIMITS)
    if (!first.ok) throw new Error(first.reason)
    const second = applyRevisionEvent(first.next, final, DEFAULT_REVISION_LIMITS)
    if (!second.ok) throw new Error(second.reason)
    expect(second.next.revision).toBe(2)
    expect(second.next.segments).toHaveLength(1)
    expect(second.next.segments[0]).toMatchObject({ state: 'final', channel: 'mic', relaySessionId: lineage })
  })
})
