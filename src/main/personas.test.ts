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

  it("'auto' falls back to the conversation language", () => {
    const s = buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [], 'auto')
    expect(s).toMatch(/main language of the conversation/i)
  })
})
