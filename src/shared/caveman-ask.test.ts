import { describe, expect, it } from 'vitest'
import {
  AUTO_CLARITY_DIRECTIVE,
  DEFAULT_ASK_CAVEMAN,
  applyCaveman,
  autoClarityDropCaveman,
  parseCavemanAskPrompt
} from './caveman-ask'

describe('parseCavemanAskPrompt', () => {
  it('defaults slash /caveman to full and strips the command', () => {
    expect(parseCavemanAskPrompt('/caveman Why React re-render?')).toEqual({
      visiblePrompt: 'Why React re-render?',
      next: 'full'
    })
  })

  it('accepts lite, full, ultra, and wenyan variants', () => {
    expect(parseCavemanAskPrompt('/caveman lite keep articles')).toEqual({
      visiblePrompt: 'keep articles',
      next: 'lite'
    })
    expect(parseCavemanAskPrompt('/caveman ultra')).toEqual({ visiblePrompt: '', next: 'ultra' })
    expect(parseCavemanAskPrompt('/caveman wenyan-lite 組件')).toEqual({
      visiblePrompt: '組件',
      next: 'wenyan-lite'
    })
    expect(parseCavemanAskPrompt('/caveman wenyan')).toEqual({
      visiblePrompt: '',
      next: 'wenyan-full'
    })
    expect(parseCavemanAskPrompt('/caveman off')).toEqual({ visiblePrompt: '', next: 'off' })
  })

  it('stop caveman and normal mode turn off and strip the phrase', () => {
    expect(parseCavemanAskPrompt('stop caveman')).toEqual({ visiblePrompt: '', next: 'off' })
    expect(parseCavemanAskPrompt('normal mode')).toEqual({ visiblePrompt: '', next: 'off' })
    expect(parseCavemanAskPrompt('stop caveman Why React re-render?')).toEqual({
      visiblePrompt: 'Why React re-render?',
      next: 'off'
    })
    expect(parseCavemanAskPrompt('Normal mode. Explain pooling.')).toEqual({
      visiblePrompt: 'Explain pooling.',
      next: 'off'
    })
  })

  it('does not treat a question about normal mode as a switch', () => {
    expect(parseCavemanAskPrompt('what is normal mode in vim')).toEqual({
      visiblePrompt: 'what is normal mode in vim',
      next: null
    })
    expect(parseCavemanAskPrompt('normal mode is what vim uses')).toEqual({
      visiblePrompt: 'normal mode is what vim uses',
      next: null
    })
  })

  it('leaves an ordinary question alone', () => {
    const q = 'Why does this React component re-render?'
    expect(parseCavemanAskPrompt(q)).toEqual({ visiblePrompt: q, next: null })
    expect(DEFAULT_ASK_CAVEMAN).toBe('full')
  })
})

describe('applyCaveman', () => {
  it('defaults enabled=true intensity=full and strips slash commands', () => {
    const session = applyCaveman('Why React re-render?')
    expect(session.enabled).toBe(true)
    expect(session.intensity).toBe('full')
    expect(session.next).toBe('full')
    expect(session.changed).toBe(false)
    const lite = applyCaveman('/caveman lite Why React re-render?', 'full')
    expect(lite.enabled).toBe(true)
    expect(lite.intensity).toBe('lite')
    expect(lite.visiblePrompt).toBe('Why React re-render?')
    expect(lite.changed).toBe(true)
  })

  it('stop caveman / normal mode turn the session off', () => {
    expect(applyCaveman('stop caveman', 'full')).toMatchObject({
      enabled: false,
      next: 'off',
      visiblePrompt: '',
      changed: true
    })
    expect(applyCaveman('normal mode', 'lite')).toMatchObject({ enabled: false, next: 'off' })
  })

  it('Auto-Clarity helper returns drop for an irreversible warning', () => {
    const applied = applyCaveman('Write SQL that will permanently delete the users table', 'full')
    expect(applied.dropClarity).toBe(true)
    expect(autoClarityDropCaveman(applied.visiblePrompt)).toBe(true)
  })
})

describe('autoClarityDropCaveman', () => {
  it('drops caveman for irreversible / security warning cases', () => {
    expect(autoClarityDropCaveman('Write SQL that will permanently delete the users table')).toBe(true)
    expect(autoClarityDropCaveman('DROP TABLE users — this cannot be undone, right?')).toBe(true)
    expect(autoClarityDropCaveman('Please confirm this irreversible wipe')).toBe(true)
    expect(autoClarityDropCaveman('Security warning: are you sure we should rm -rf the backup?')).toBe(true)
  })

  it('drops caveman when the user asks to clarify', () => {
    expect(autoClarityDropCaveman('Can you clarify that?')).toBe(true)
    expect(autoClarityDropCaveman('What do you mean')).toBe(true)
    expect(autoClarityDropCaveman('Say that again in plain English')).toBe(true)
  })

  it('drops caveman for multi-step fragment / compression ambiguity', () => {
    expect(autoClarityDropCaveman('migrate table drop column backup first')).toBe(true)
    expect(autoClarityDropCaveman('Give me the multi-step order')).toBe(true)
  })

  it('does not drop for an ordinary short question', () => {
    expect(autoClarityDropCaveman('Why React component re-render?')).toBe(false)
    expect(AUTO_CLARITY_DIRECTIVE).toMatch(/Drop caveman/)
  })
})
