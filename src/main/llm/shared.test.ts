import { describe, it, expect } from 'vitest'
import type { AskStart } from '@shared/ipc'
import { userText } from './shared'

const req = (o: Partial<AskStart>): AskStart =>
  ({ id: 'x', mode: 'answer', prompt: '', history: [], ...o }) as AskStart

describe('userText — screenContext injection (M13 fast-path)', () => {
  it('prepends a labeled, untrusted-data-guarded screen block before the prompt in answer mode', () => {
    const out = userText(req({ mode: 'answer', prompt: 'What should I click?', screenContext: 'A login form with an email field and a blue Sign in button.' }))
    expect(out).toContain('A login form with an email field and a blue Sign in button.')
    expect(out).toMatch(/untrusted data/i) // the injection guard is present
    expect(out.trimEnd().endsWith('What should I click?')).toBe(true) // the question comes last
  })

  it('stacks brain context then screen context, both before the prompt', () => {
    const out = userText(
      req({ mode: 'answer', prompt: 'Q', brainContext: 'FACT A (from meeting X)', screenContext: 'SCREEN DESC' })
    )
    const brainAt = out.indexOf('FACT A')
    const screenAt = out.indexOf('SCREEN DESC')
    const promptAt = out.lastIndexOf('Q')
    expect(brainAt).toBeGreaterThanOrEqual(0)
    expect(screenAt).toBeGreaterThan(brainAt)
    expect(promptAt).toBeGreaterThan(screenAt)
  })

  it('adds nothing when there is no screenContext', () => {
    const out = userText(req({ mode: 'answer', prompt: 'Just a plain question' }))
    expect(out).toBe('Just a plain question')
  })

  it('ignores screenContext in vision mode (a real image is present there, not a text description)', () => {
    const out = userText(req({ mode: 'vision', prompt: 'Describe this', screenContext: 'SHOULD NOT APPEAR' }))
    expect(out).not.toContain('SHOULD NOT APPEAR')
  })
})
