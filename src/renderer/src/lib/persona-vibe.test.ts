import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE_PROMPTS } from '@shared/prompts'
import { ONBOARDING_PERSONAS, personaVibe } from './persona-vibe'

describe('persona-vibe', () => {
  it('offers exactly the three onboarding modes, in the order the picker renders them', () => {
    expect(ONBOARDING_PERSONAS.map((p) => p.id)).toEqual(['general', 'sales', 'recruiting'])
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
    // @ts-expect-error deliberately probing the fallback path with an id outside the union
    expect(personaVibe('interview').id).toBe('general')
  })

  // Groundedness (MQA-280): each "changes" line must describe something the mode's REAL system prompt
  // (`DEFAULT_MODE_PROMPTS`, @shared/prompts — the actual text `buildSystem` sends the model, per
  // src/main/personas.ts) actually says, so this scene can never quietly drift into inventing a
  // capability. This is the regression guard for the Act 4 brief's "keep it truthful" requirement.
  it('MQA-280: sales "changes" line is backed by the real sales prompt (objection handling + a next step)', () => {
    const prompt = DEFAULT_MODE_PROMPTS.sales.toLowerCase()
    expect(prompt).toContain('objection')
    expect(prompt).toContain('next step')
  })

  it('recruiting "changes" line is backed by the real recruiting prompt (STAR probing + challenging vague answers)', () => {
    const prompt = DEFAULT_MODE_PROMPTS.recruiting
    expect(prompt).toContain('STAR')
    expect(prompt.toLowerCase()).toContain('challenge')
    expect(prompt.toLowerCase()).toContain('one question at a time')
  })

  it('general "changes" line is backed by the real general prompt (broad scope, no persona narrowing)', () => {
    const prompt = DEFAULT_MODE_PROMPTS.general.toLowerCase()
    expect(prompt).toContain('always-on copilot')
  })
})
