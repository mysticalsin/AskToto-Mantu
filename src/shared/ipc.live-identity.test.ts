import { describe, expect, it } from 'vitest'
import * as ipc from './ipc'

describe('live meeting identity boundary', () => {
  it.each([1, 1_700_000_000_001, 8.64e15])('accepts the exact valid timestamp %s', startedAt => {
    expect(ipc.LiveMeetingStartedAtSchema?.safeParse(startedAt)).toMatchObject({ success: true, data: startedAt })
    expect(ipc.ListeningStatePayloadSchema?.safeParse({ on: true, startedAt })).toMatchObject({
      success: true, data: { on: true, startedAt }
    })
  })

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 8.64e15 + 1, '123', true, null, {}])(
    'rejects malformed explicit identity %s without coercion', startedAt => {
      expect(ipc.LiveMeetingStartedAtSchema?.safeParse(startedAt).success).toBe(false)
      expect(ipc.ListeningStatePayloadSchema?.safeParse({ on: false, startedAt }).success).toBe(false)
    }
  )

  it('allows identity-less legacy state but never treats nonboolean on as true', () => {
    expect(ipc.ListeningStatePayloadSchema?.safeParse({ on: false })).toMatchObject({ success: true, data: { on: false } })
    for (const on of [1, 'false', null, {}, undefined]) {
      expect(ipc.ListeningStatePayloadSchema?.safeParse({ on }).success).toBe(false)
    }
  })
})
