import { describe, expect, it } from 'vitest'
import type { PlatformPermissions, ScreenDiagnosisState } from '@shared/ipc'
import { MEETING_AUDIO_SCREEN_LABEL, MEETING_AUDIO_SCREEN_WHY } from '../lib/screen-permission-copy'
import {
  ONBOARDING_RESUME_SETUP_KEY,
  markOnboardingResumeSetup,
  screenRowStatus,
  takeOnboardingResumeSetup
} from './OnboardingExperience'

/**
 * M2-0429 — onboarding asks for "Meeting audio & screen" up front, and the row turns green ONLY on a real
 * loopback self-test. A 'granted' status used to paint it green for builds that could not capture at all.
 */
const perms = (state: ScreenDiagnosisState): PlatformPermissions => ({
  microphone: 'granted',
  screenRecording: state === 'granted' || state === 'needs-relaunch' ? 'granted' : 'denied',
  screenDiagnosis: { state, reasons: [], action: 'none', duplicates: [], grantedFor: null, repairFailed: false }
})

describe('screenRowStatus', () => {
  it('granted is not green by itself: it tests, then goes green only when the self-test passed', () => {
    expect(screenRowStatus(perms('granted'), 'idle', false)).toEqual({ state: 'checking', detail: 'testing meeting audio…' })
    expect(screenRowStatus(perms('granted'), 'running', false).state).toBe('checking')
    expect(screenRowStatus(perms('granted'), 'passed', false)).toEqual({ state: 'ready', detail: 'meeting audio works' })
    expect(screenRowStatus(perms('granted'), 'failed', false)).toEqual({ state: 'action', detail: 'meeting audio test failed' })
  })

  it('a self-test that passed earlier cannot turn a non-granted diagnosis green', () => {
    for (const state of ['not-asked', 'denied', 'needs-relaunch', 'not-effective', 'restricted'] as const) {
      expect(screenRowStatus(perms(state), 'passed', false).state).not.toBe('ready')
    }
  })

  it('maps each diagnosis to its row state', () => {
    expect(screenRowStatus(perms('not-asked'), 'idle', false).state).toBe('action')
    expect(screenRowStatus(perms('needs-relaunch'), 'idle', false).state).toBe('restart')
    expect(screenRowStatus(perms('denied'), 'idle', false).state).toBe('blocked')
    expect(screenRowStatus(perms('not-effective'), 'idle', false)).toEqual({
      state: 'blocked',
      detail: 'on in System Settings, but not for this copy of Métis'
    })
    expect(screenRowStatus(perms('restricted'), 'idle', false).detail).toBe('managed by your organization')
  })

  it('without a diagnosis falls back to the status, still gated on the self-test', () => {
    expect(screenRowStatus({ screenRecording: 'granted' }, 'idle', false).state).toBe('checking')
    expect(screenRowStatus({ screenRecording: 'denied' }, 'idle', false).state).toBe('action')
    expect(screenRowStatus(null, 'idle', false).state).toBe('checking')
  })

  it('Windows needs no grant and stays available', () => {
    expect(screenRowStatus(null, 'idle', true)).toEqual({ state: 'ready', detail: 'available' })
  })

  it('the row is named for meeting audio and says why before it asks', () => {
    expect(MEETING_AUDIO_SCREEN_LABEL).toBe('Meeting audio & screen')
    expect(MEETING_AUDIO_SCREEN_WHY).toMatch(/hear the other people in your calls/)
  })
})

describe('resume setup after the grant relaunch', () => {
  function memoryStorage() {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      map
    }
  }

  it('a relaunch while setup is showing resumes setup exactly once', () => {
    const s = memoryStorage()
    markOnboardingResumeSetup(s, true)
    expect(s.map.get(ONBOARDING_RESUME_SETUP_KEY)).toBe('1')
    expect(takeOnboardingResumeSetup(s)).toBe(true)
    expect(takeOnboardingResumeSetup(s)).toBe(false)
  })

  it('leaving setup clears the marker, so an ordinary relaunch starts from the beginning', () => {
    const s = memoryStorage()
    markOnboardingResumeSetup(s, true)
    markOnboardingResumeSetup(s, false)
    expect(takeOnboardingResumeSetup(s)).toBe(false)
  })

  it('unavailable storage never throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      }
    }
    expect(() => markOnboardingResumeSetup(broken, true)).not.toThrow()
    expect(takeOnboardingResumeSetup(broken)).toBe(false)
  })
})
