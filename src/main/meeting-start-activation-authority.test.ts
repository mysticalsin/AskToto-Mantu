import { describe, expect, it } from 'vitest'
import {
  MEETING_START_ACTION,
  MeetingStartActivationAuthority,
  type MeetingStartAction,
  type MeetingStartActivationState,
  type MeetingStartActivationFrame
} from './meeting-start-activation-authority'

describe('MeetingStartActivationAuthority', () => {
  const make = () => {
    let now = 100
    const current: MeetingStartActivationState = {
      mainWebContentsId: 7,
      mainFrameId: '1:2',
      isWindowVisible: true,
      isAuthenticated: true,
      isStartAllowed: true,
      currentUrl: 'app://metis/index.html',
      context: { authSessionGeneration: 3, contextRevision: 4 }
    }
    const authority = new MeetingStartActivationAuthority({ state: () => current, now: () => now, ttlMs: 500 })
    const frame: MeetingStartActivationFrame = {
      webContentsId: 7,
      frameId: '1:2',
      isTopFrame: true,
      url: 'app://metis/index.html'
    }
    return {
      authority,
      current,
      frame,
      setNow: (next: number) => {
        now = next
      }
    }
  }

  it('keeps the grant main-owned, readiness-only, and consumes once at the meeting start boundary', () => {
    const { authority, frame } = make()
    expect(authority.mint(frame, MEETING_START_ACTION)).toBe(true)
    expect(authority.hasPending(frame)).toBe(true)
    expect(authority.consume(frame, MEETING_START_ACTION)).toBe(true)
    expect(authority.hasPending(frame)).toBe(false)
    expect(authority.consume(frame, MEETING_START_ACTION)).toBe(false)
  })

  it('rejects hidden, unauthenticated, stale-context, stale-url, non-main-frame, and expired grants', () => {
    const { authority, current, frame, setNow } = make()
    const hidden = new MeetingStartActivationAuthority({ state: () => ({ ...current, isWindowVisible: false }) })
    expect(hidden.mint(frame, MEETING_START_ACTION)).toBe(false)
    expect(
      new MeetingStartActivationAuthority({ state: () => ({ ...current, isStartAllowed: false }) }).mint(
        frame,
        MEETING_START_ACTION
      )
    ).toBe(false)
    expect(
      new MeetingStartActivationAuthority({ state: () => ({ ...current, isAuthenticated: false }) }).mint(
        frame,
        MEETING_START_ACTION
      )
    ).toBe(false)
    const wrongFrame = { ...frame, frameId: '1:9' }
    expect(authority.mint(wrongFrame, MEETING_START_ACTION)).toBe(false)
    expect(authority.mint({ ...frame, isTopFrame: false }, MEETING_START_ACTION)).toBe(false)
    expect(authority.mint(frame, 'meeting.stop' as unknown as MeetingStartAction)).toBe(false)
    expect(authority.mint(frame, MEETING_START_ACTION)).toBe(true)
    current.context.contextRevision += 1
    expect(authority.hasPending(frame)).toBe(false)
    current.context.contextRevision -= 1
    expect(authority.mint(frame, MEETING_START_ACTION)).toBe(true)
    setNow(601)
    expect(authority.consume(frame, MEETING_START_ACTION)).toBe(false)
  })

  it('reuses one pending grant for rapid duplicate mint events and clears it on revocation', () => {
    const { authority, frame } = make()
    const first = authority.mint(frame, MEETING_START_ACTION)
    const second = authority.mint(frame, MEETING_START_ACTION)
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(authority.hasPending(frame)).toBe(true)
    authority.revokeAll()
    expect(authority.hasPending(frame)).toBe(false)
  })

  it('names why a mint is refused, in the order the checks run, without changing what mint does', () => {
    const { authority, current, frame } = make()
    const denial = (override: Partial<MeetingStartActivationState>, f = frame) => {
      const probe = new MeetingStartActivationAuthority({ state: () => ({ ...current, ...override }) })
      const reason = probe.mintDenial(f, MEETING_START_ACTION)
      expect(probe.mint(f, MEETING_START_ACTION)).toBe(reason === null)
      return reason
    }
    expect(authority.mintDenial(frame, MEETING_START_ACTION)).toBeNull()
    expect(authority.mintDenial(frame, 'other' as MeetingStartAction)).toBe('wrong-action')
    expect(denial({})).toBeNull()
    expect(denial({ isWindowVisible: false })).toBe('window-not-visible')
    expect(denial({ isAuthenticated: false })).toBe('not-authenticated')
    expect(denial({ isStartAllowed: false })).toBe('start-not-allowed')
    expect(denial({ mainWebContentsId: 9 })).toBe('frame-not-current')
    expect(denial({ currentUrl: 'app://metis/other.html' })).toBe('frame-not-current')
    expect(denial({}, { ...frame, isTopFrame: false })).toBe('frame-not-current')
    // A hidden window is reported as hidden only for the current frame: a stale frame is the more basic fault.
    expect(denial({ isWindowVisible: false, mainFrameId: '9:9' })).toBe('frame-not-current')
  })
})
