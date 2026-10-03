import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE_PROMPTS } from '@shared/prompts'
import { CONVERSATION_MODES } from '@shared/ipc'
import { ONBOARDING_PERSONAS } from './persona-vibe'

describe('persona-vibe', () => {
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

  it('lists each built-in id once, with general first as the catalog default', () => {
    expect(ONBOARDING_PERSONAS[0]?.id).toBe('general')
    expect(ONBOARDING_PERSONAS.find((p) => p.id === 'sales')?.label).toBe('Sales')
    expect(ONBOARDING_PERSONAS.find((p) => p.id === 'recruiting')?.label).toBe('Recruiting')
    expect(ONBOARDING_PERSONAS.find((p) => p.id === 'meeting')?.id).toBe('meeting')
    expect(new Set(ONBOARDING_PERSONAS.map((p) => p.id)).size).toBe(ONBOARDING_PERSONAS.length)
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
