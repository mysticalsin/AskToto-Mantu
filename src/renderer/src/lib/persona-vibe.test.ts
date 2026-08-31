import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE_PROMPTS } from '@shared/prompts'
import { CONVERSATION_MODES } from '@shared/ipc'
import {
  ONBOARDING_PERSONAS,
  PERSONALIZE_LEAD,
  PERSONALIZE_MUST_PICK,
  PERSONALIZE_TITLE,
  personaVibe
} from './persona-vibe'

describe('persona-vibe', () => {
  it('pins Act 4 required-pick copy (no em dash)', () => {
    expect(PERSONALIZE_TITLE).toBe('How should Métis show up?')
    expect(PERSONALIZE_MUST_PICK).toBe('Pick one. Continue waits until you do.')
    expect(PERSONALIZE_LEAD).toBe('Change it anytime in Settings.')
    expect(PERSONALIZE_MUST_PICK).not.toMatch(/\u2014/)
    expect(PERSONALIZE_LEAD).not.toMatch(/\u2014/)
    expect(PERSONALIZE_TITLE).not.toMatch(/\u2014/)
  })

  it('offers every built-in mode, so each role has a summary to demo', () => {
    expect(ONBOARDING_PERSONAS.map((p) => p.id).sort()).toEqual([...CONVERSATION_MODES].sort())
  })

  it('every persona resolves to a real, non-empty label/vibe/changes line', () => {
    for (const p of ONBOARDING_PERSONAS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.vibe.length).toBeGreaterThan(0)
      expect(p.changes.length).toBeGreaterThan(0)
    }
  })

  it('personaVibe resolves each real id and falls back to general for an unrecognized one', () => {
    expect(personaVibe('general').label).toBe('General')
    expect(personaVibe('sales').label).toBe('Sales')
    expect(personaVibe('recruiting').label).toBe('Recruiting')
    expect(personaVibe('meeting').id).toBe('meeting')
    // @ts-expect-error deliberately probing the fallback path with an id outside the union
    expect(personaVibe('not-a-mode').id).toBe('general')
  })

  it('MQA-280: each changes line is backed by the real mode prompt', () => {
    const sales = DEFAULT_MODE_PROMPTS.sales.toLowerCase()
    expect(sales).toContain('objection')
    expect(sales).toContain('next step')

    const recruiting = DEFAULT_MODE_PROMPTS.recruiting
    expect(recruiting).toContain('STAR')
    expect(recruiting.toLowerCase()).toContain('challenge')

    expect(DEFAULT_MODE_PROMPTS.general.toLowerCase()).toContain('always-on copilot')
    expect(DEFAULT_MODE_PROMPTS.meeting.toLowerCase()).toContain('decisions')
    expect(DEFAULT_MODE_PROMPTS.interview.toLowerCase()).toContain('first person')
    expect(DEFAULT_MODE_PROMPTS.negotiation).toContain('Never concede for free')
    expect(DEFAULT_MODE_PROMPTS.presentation.toLowerCase()).toContain('audience')
    expect(DEFAULT_MODE_PROMPTS.support.toLowerCase()).toContain('resolve the issue')
    expect(DEFAULT_MODE_PROMPTS['cold-call'].toLowerCase()).toContain('objection')
    expect(DEFAULT_MODE_PROMPTS['cold-call'].toLowerCase()).toContain('booked meeting')
  })
})
