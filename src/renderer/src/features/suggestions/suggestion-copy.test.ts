import { describe, expect, it } from 'vitest'
import { DISMISS_REASONS, type ListResult, type RunView } from '@shared/suggestions'
import { formatWhen } from '../routines/routine-copy'
import {
  DISMISS_REASON_COPY,
  SOURCES_CHANGED_COPY,
  STALE_COPY,
  acceptOutcomeCopy,
  evidenceLine,
  queueHealth
} from './suggestion-copy'

const NOW = Date.UTC(2026, 9, 24, 12, 0)
const run = (over: Partial<RunView>): RunView => ({
  runId: '0123456789abcdef01234567',
  trigger: 'manual',
  state: 'queued',
  enqueuedAt: NOW,
  ...over
})
const listed = (over: Partial<Extract<ListResult, { ok: true }>> = {}): ListResult => ({
  ok: true,
  cards: [],
  lastShownId: null,
  activeRun: null,
  lastRun: null,
  ...over
})

describe('suggestion copy (G69)', () => {
  it('queued, checking and failed are distinct', () => {
    const queued = queueHealth(listed({ activeRun: run({ state: 'queued' }) }))
    const checking = queueHealth(listed({ activeRun: run({ state: 'running' }) }))
    const failed = queueHealth(listed({ lastRun: run({ state: 'failed', errorClass: 'timeout' }) }))
    expect(queued).toEqual({ tone: 'queued', text: 'Queued' })
    expect(checking).toEqual({ tone: 'checking', text: 'Checking' })
    expect(failed).toEqual({ tone: 'failed', text: 'Failed: Timed out' })
    // A queued run is never shown as failed, even when the previous run failed.
    expect(
      queueHealth(listed({ activeRun: run({ state: 'queued' }), lastRun: run({ state: 'failed', errorClass: 'connector' }) }))
        .text
    ).toBe('Queued')
    expect(queueHealth(listed({ lastRun: run({ state: 'succeeded' }) })).text).toBe(
      'No suggestions right now. Check now anytime.'
    )
  })

  it('evidence line separates event time from retrieved time', () => {
    const event = NOW + 2 * 3_600_000
    const line = evidenceLine(
      { sourceKind: 'calendar', label: 'Budget review', eventAt: event, retrievedAt: NOW - 5 * 60_000 },
      NOW
    )
    expect(line).toBe(`Budget review · ${formatWhen(event)} · read 5 min ago`)
    expect(evidenceLine({ sourceKind: 'memory', label: 'Note', eventAt: null, retrievedAt: NOW }, NOW)).toBe(
      'Note · no date · read just now'
    )
  })

  it('disabled reads Suggestions are off', () => {
    expect(queueHealth({ ok: false, reason: 'disabled' }).text).toBe('Suggestions are off')
    expect(queueHealth({ ok: false, reason: 'unavailable' }).tone).toBe('unavailable')
  })

  it('accept and refusal outcomes have their own copy', () => {
    expect(acceptOutcomeCopy({ ok: true, sources: ['Budget review', 'Q3 notes'] })).toBe(
      'Accepted. Sources: Budget review, Q3 notes'
    )
    expect(acceptOutcomeCopy({ ok: false, reason: 'stale' })).toBe(STALE_COPY)
    expect(acceptOutcomeCopy({ ok: false, reason: 'sources_changed' })).toBe(SOURCES_CHANGED_COPY)
    expect(DISMISS_REASONS.map((r) => DISMISS_REASON_COPY[r])).toEqual([
      'Not useful',
      'Wrong',
      'Already done',
      'Other'
    ])
  })
})
