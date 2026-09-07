import { describe, expect, it } from 'vitest'
import {
  BACKOFF_SEQUENCE_MS,
  HIDDEN_INTERVAL_MS,
  VISIBLE_INTERVAL_MS,
  badgeCountsFromSnapshot,
  displayLiveState,
  initialPollState,
  liveStatusText,
  nextPollState,
  pollDelayMs
} from './live-client'

const NOW = 1_725_000_000_000

describe('initialPollState', () => {
  it('starts live, at the shortest backoff step, with no etag and no success yet', () => {
    const s = initialPollState()
    expect(s).toEqual({ etag: null, backoffMs: BACKOFF_SEQUENCE_MS[0], state: 'live', lastSuccessAt: null })
  })
})

describe('nextPollState', () => {
  it('a 200 stores the new etag, resets backoff, and marks the connection live', () => {
    const prev = { etag: 'W/"1"', backoffMs: BACKOFF_SEQUENCE_MS[3], state: 'reconnecting' as const, lastSuccessAt: null }
    const next = nextPollState(prev, { kind: 'ok', etag: 'W/"2"' }, NOW)
    expect(next).toEqual({ etag: 'W/"2"', backoffMs: BACKOFF_SEQUENCE_MS[0], state: 'live', lastSuccessAt: NOW })
  })

  it('a 200 with no etag keeps the previous one', () => {
    const prev = { etag: 'W/"1"', backoffMs: BACKOFF_SEQUENCE_MS[0], state: 'live' as const, lastSuccessAt: NOW - 1000 }
    const next = nextPollState(prev, { kind: 'ok', etag: null }, NOW)
    expect(next.etag).toBe('W/"1"')
  })

  it('a 304 (not-modified) resets backoff and marks the connection live without touching the etag', () => {
    const prev = { etag: 'W/"1"', backoffMs: BACKOFF_SEQUENCE_MS[2], state: 'reconnecting' as const, lastSuccessAt: null }
    const next = nextPollState(prev, { kind: 'not-modified' }, NOW)
    expect(next).toEqual({ etag: 'W/"1"', backoffMs: BACKOFF_SEQUENCE_MS[0], state: 'live', lastSuccessAt: NOW })
  })

  it('an error steps the backoff forward one notch and flips to reconnecting', () => {
    let s = initialPollState()
    for (let i = 1; i < BACKOFF_SEQUENCE_MS.length; i++) {
      s = nextPollState(s, { kind: 'error' }, NOW)
      expect(s.backoffMs).toBe(BACKOFF_SEQUENCE_MS[i])
      expect(s.state).toBe('reconnecting')
    }
  })

  it('an error never backs off past the last (60s) step', () => {
    let s = { ...initialPollState(), backoffMs: BACKOFF_SEQUENCE_MS[BACKOFF_SEQUENCE_MS.length - 1] }
    s = nextPollState(s, { kind: 'error' }, NOW)
    expect(s.backoffMs).toBe(BACKOFF_SEQUENCE_MS[BACKOFF_SEQUENCE_MS.length - 1])
  })

  it('a healthy poll after errors recovers immediately to the shortest backoff', () => {
    let s = initialPollState()
    s = nextPollState(s, { kind: 'error' }, NOW)
    s = nextPollState(s, { kind: 'error' }, NOW)
    expect(s.backoffMs).toBe(BACKOFF_SEQUENCE_MS[2])
    s = nextPollState(s, { kind: 'ok', etag: 'W/"3"' }, NOW)
    expect(s.backoffMs).toBe(BACKOFF_SEQUENCE_MS[0])
    expect(s.state).toBe('live')
  })
})

describe('pollDelayMs', () => {
  it('uses the visible/hidden cadence when the connection is healthy', () => {
    const live = { ...initialPollState(), state: 'live' as const }
    expect(pollDelayMs(live, true)).toBe(VISIBLE_INTERVAL_MS)
    expect(pollDelayMs(live, false)).toBe(HIDDEN_INTERVAL_MS)
  })

  it('uses the current backoff step while reconnecting, regardless of visibility', () => {
    const reconnecting = { ...initialPollState(), state: 'reconnecting' as const, backoffMs: BACKOFF_SEQUENCE_MS[3] }
    expect(pollDelayMs(reconnecting, true)).toBe(BACKOFF_SEQUENCE_MS[3])
    expect(pollDelayMs(reconnecting, false)).toBe(BACKOFF_SEQUENCE_MS[3])
  })
})

describe('displayLiveState', () => {
  it('reads Paused whenever the document is not visible, no matter the poll state', () => {
    expect(displayLiveState('live', false)).toBe('paused')
    expect(displayLiveState('reconnecting', false)).toBe('paused')
  })
  it('otherwise reflects the underlying poll state', () => {
    expect(displayLiveState('live', true)).toBe('live')
    expect(displayLiveState('reconnecting', true)).toBe('reconnecting')
  })
})

describe('liveStatusText', () => {
  const formatAge = (ts: number, now: number) => (now - ts < 5000 ? 'now' : `${Math.floor((now - ts) / 1000)}s`)

  it('reads "Live, updated just now" right after a poll lands', () => {
    expect(liveStatusText('live', NOW, NOW, formatAge)).toBe('Live, updated just now')
  })
  it('reads "Live, updated Ns ago" as time passes', () => {
    expect(liveStatusText('live', NOW - 12_000, NOW, formatAge)).toBe('Live, updated 12s ago')
  })
  it('reads plain "Live" before the first poll has landed', () => {
    expect(liveStatusText('live', null, NOW, formatAge)).toBe('Live')
  })
  it('reads "Reconnecting" and "Paused" regardless of lastSuccessAt', () => {
    expect(liveStatusText('reconnecting', NOW, NOW, formatAge)).toBe('Reconnecting')
    expect(liveStatusText('paused', NOW, NOW, formatAge)).toBe('Paused')
  })
})

describe('badgeCountsFromSnapshot', () => {
  it('maps notices to the notifications badge and leaves licenses/connectors out entirely', () => {
    const counts = badgeCountsFromSnapshot({ generation: 1, liveSeats: 4, notices: 3 })
    expect(counts).toEqual({ notifications: 3 })
    expect('licenses' in counts).toBe(false)
    expect('connectors' in counts).toBe(false)
  })
})
