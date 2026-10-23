import { describe, expect, it } from 'vitest'
import { parseWalkthroughIntent } from './walkthrough-intent'

describe('walkthrough intents (G44)', () => {
  it.each([
    ['Walk me through setting up a signature', 'setting up a signature'],
    ['Hey Métis, please walk me through exporting a PDF.', 'exporting a PDF'],
    ['show me how to turn on dark mode', 'turn on dark mode'],
    ['help me change the wallpaper step by step', 'change the wallpaper'],
    ['montre-moi comment ajouter un compte', 'ajouter un compte'],
    ['me mostre como criar uma pasta', 'criar uma pasta'],
    ['muéstrame cómo cambiar la contraseña', 'cambiar la contraseña']
  ])('starts from %s', (text, goal) => {
    expect(parseWalkthroughIntent(text, { active: false })).toEqual({ kind: 'start', goal })
  })

  it('recognises control words only while a walkthrough is live', () => {
    expect(parseWalkthroughIntent("I'm done", { active: false })).toBeNull()
    expect(parseWalkthroughIntent('next', { active: false })).toBeNull()
    expect(parseWalkthroughIntent("I'm done", { active: true })).toEqual({ kind: 'check' })
    expect(parseWalkthroughIntent('Next step.', { active: true })).toEqual({ kind: 'check' })
    expect(parseWalkthroughIntent('pause', { active: true })).toEqual({ kind: 'pause' })
    expect(parseWalkthroughIntent('resume the walkthrough', { active: true })).toEqual({ kind: 'resume' })
    expect(parseWalkthroughIntent('stop the walkthrough', { active: true })).toEqual({ kind: 'stop' })
  })

  it('leaves ordinary questions and actions to the normal router', () => {
    for (const text of [
      'what is on my calendar',
      'open Notes',
      'create a note called x',
      'how do I export a pdf',
      ''
    ]) {
      expect(parseWalkthroughIntent(text, { active: true })).toBeNull()
    }
  })

  it('bounds the goal', () => {
    const intent = parseWalkthroughIntent(`walk me through ${'x'.repeat(2_000)}`, { active: false })
    expect(intent).toBeNull()
    const ok = parseWalkthroughIntent(`walk me through ${'y'.repeat(500)}`, { active: false })
    expect(ok?.kind === 'start' && ok.goal.length).toBe(300)
  })
})
