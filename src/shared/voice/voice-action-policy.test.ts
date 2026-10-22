import { describe, expect, it } from 'vitest'
import type { VoiceActionClass } from './catalog'
import {
  decideVoiceAction,
  voiceImmediateRunAllowed,
  type VoiceImmediateRunInput,
  type VoiceTurnSource
} from './voice-action-policy'

const CLASSES: VoiceActionClass[] = ['read', 'reversible', 'create', 'send', 'type', 'delete']
const SOURCES: VoiceTurnSource[] = ['push-to-talk', 'wake', 'panel']

describe('voice action policy matrix (class x source)', () => {
  it('a held chord runs read and reversible actions and confirms the rest', () => {
    expect(CLASSES.map((c) => decideVoiceAction(c, 'push-to-talk'))).toEqual([
      'run',
      'run',
      'confirm',
      'confirm',
      'confirm',
      'confirm'
    ])
  })

  it('a wake word or the panel never runs a desktop action by itself', () => {
    for (const source of SOURCES.filter((s) => s !== 'push-to-talk')) {
      for (const c of CLASSES) expect(decideVoiceAction(c, source), `${c}/${source}`).toBe('confirm')
    }
  })

  it('an unsupported platform is refused for every source', () => {
    for (const source of SOURCES) expect(decideVoiceAction(null, source)).toBe('refuse')
  })
})

describe('immediate run gate', () => {
  const ok: VoiceImmediateRunInput = {
    authenticated: true,
    listenEntitled: true,
    ownerPresent: true,
    ownerVisible: true,
    onboardingExclusive: false,
    lifecycleHooksReady: true,
    meetingReserved: false,
    turnCurrent: true
  }

  it('allows only when every input says yes, and owner focus is not an input', () => {
    expect(voiceImmediateRunAllowed(ok)).toBe(true)
    expect(Object.keys(ok)).not.toContain('ownerFocused')
  })

  it.each<[string, Partial<VoiceImmediateRunInput>]>([
    ['signed out', { authenticated: false }],
    ['no listen entitlement', { listenEntitled: false }],
    ['no owner window', { ownerPresent: false }],
    ['hidden owner window', { ownerVisible: false }],
    ['onboarding exclusive', { onboardingExclusive: true }],
    ['lifecycle hooks not ready', { lifecycleHooksReady: false }],
    ['a meeting is recording', { meetingReserved: true }],
    ['the turn was revoked', { turnCurrent: false }]
  ])('denies when %s', (_label, override) => {
    expect(voiceImmediateRunAllowed({ ...ok, ...override })).toBe(false)
  })

  it('denies on a missing or malformed field (fail closed)', () => {
    expect(voiceImmediateRunAllowed({ ...ok, turnCurrent: undefined } as unknown as VoiceImmediateRunInput)).toBe(false)
    expect(voiceImmediateRunAllowed({ ...ok, meetingReserved: undefined } as unknown as VoiceImmediateRunInput)).toBe(
      false
    )
    expect(voiceImmediateRunAllowed({ ...ok, authenticated: 'yes' } as unknown as VoiceImmediateRunInput)).toBe(false)
  })
})
