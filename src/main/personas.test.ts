import { describe, it, expect } from 'vitest'
import { buildSystem } from './personas'
import type { AskStart, Profile } from '@shared/ipc'

const EMPTY_PROFILE: Profile = { name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' }
const req = (mode: AskStart['mode']): AskStart =>
  ({ id: 'x', mode, prompt: 'hello', history: [] }) as AskStart

describe('buildSystem — multilingual language policy', () => {
  it('suggest (live assist) mirrors the speaker’s language', () => {
    const s = buildSystem(req('suggest'), 'meeting', EMPTY_PROFILE, {}, [], 'French')
    expect(s).toMatch(/same language the other person is speaking/i)
  })

  it('recap (final summary) uses the selected output language', () => {
    const s = buildSystem(req('recap'), 'meeting', EMPTY_PROFILE, {}, [], 'French')
    expect(s).toMatch(/respond in French/i)
  })

  it('answer uses the selected output language', () => {
    const s = buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [], 'Spanish')
    expect(s).toMatch(/respond in Spanish/i)
  })

  it("'auto' stays in the spoken language(s) and does not translate away", () => {
    const s = buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [], 'auto')
    expect(s).toMatch(/spoken language/i)
    expect(s).toMatch(/do not translate unless asked/i)
  })

  it('recap auto keeps spoken language(s) including mixed meetings', () => {
    const s = buildSystem(req('recap'), 'meeting', EMPTY_PROFILE, {}, [], 'auto')
    expect(s).toMatch(/spoken language\(s\) of the transcript/i)
    expect(s).toMatch(/do not translate unless the user explicitly asked/i)
  })
})

describe('buildSystem — grounding & trust', () => {
  it('appends the grounding rail to answer + vision, not to the proactive suggest line', () => {
    expect(buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [])).toContain('GROUNDING & HONESTY')
    expect(buildSystem(req('vision'), 'general', EMPTY_PROFILE, {}, [])).toContain('GROUNDING & HONESTY')
    expect(buildSystem(req('suggest'), 'meeting', EMPTY_PROFILE, {}, [])).not.toContain('GROUNDING & HONESTY')
  })

  it('leads untrusted modes with the injection guard; a plain typed answer has none', () => {
    expect(buildSystem(req('suggest'), 'meeting', EMPTY_PROFILE, {}, [])).toContain('SECURITY:')
    expect(buildSystem(req('vision'), 'general', EMPTY_PROFILE, {}, [])).toContain('SECURITY:')
    expect(buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [])).not.toContain('SECURITY:')
  })

  it('includes the user profile for self-performing modes, not neutral observer modes', () => {
    const p: Profile = { name: 'Tony', role: 'Chief of Staff', company: '', resume: '', jobDescription: '', notes: '' }
    expect(buildSystem(req('answer'), 'interview', p, {}, [])).toContain('Chief of Staff')
    expect(buildSystem(req('answer'), 'general', p, {}, [])).not.toContain('Chief of Staff')
  })

  it('summary / recap use their dedicated prompts and skip the grounding rail', () => {
    const summary = buildSystem(req('summary'), 'general', EMPTY_PROFILE, {}, [])
    expect(summary).toContain('Summarize the conversation transcript')
    expect(buildSystem(req('recap'), 'general', EMPTY_PROFILE, {}, [])).toContain('detailed post-meeting document')
    expect(summary).not.toContain('GROUNDING & HONESTY')
  })

  it('recap is mode-aware: the active conversation mode appends its FOCUS block, general stays plain', () => {
    const salesRecap = buildSystem(req('recap'), 'sales', EMPTY_PROFILE, {}, [])
    expect(salesRecap).toContain('detailed post-meeting document') // section skeleton intact
    expect(salesRecap).toContain('MODE FOCUS (Sales)')
    expect(salesRecap).toMatch(/buying signals/i)

    const generalRecap = buildSystem(req('recap'), 'general', EMPTY_PROFILE, {}, [])
    expect(generalRecap).not.toContain('MODE FOCUS')

    const customRecap = buildSystem(req('recap'), 'my-custom-mode', EMPTY_PROFILE, {}, [])
    expect(customRecap).not.toContain('MODE FOCUS')
    expect(customRecap).toContain('detailed post-meeting document')
  })
})
