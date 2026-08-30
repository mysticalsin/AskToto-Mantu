import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TELL_THE_ROOM_CHECKBOX,
  TELL_THE_ROOM_LEAD,
  TELL_THE_ROOM_QUOTE,
  TELL_THE_ROOM_READY,
  TELL_THE_ROOM_TITLE,
  TELL_THE_ROOM_WHY
} from './onboarding-tell-the-room'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const onboarding = readFileSync(join(__dirname, '../components/Onboarding.tsx'), 'utf8')
const copy = readFileSync(join(__dirname, './onboarding-tell-the-room.ts'), 'utf8')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('tell the room — designed consent on personalize', () => {
  it('pins title, sample quote, GDPR why-line, and checkbox (no U+2014)', () => {
    expect(TELL_THE_ROOM_TITLE).toBe('Tell the room')
    expect(TELL_THE_ROOM_LEAD).toMatch(/keep quality high and actually get things done/)
    expect(TELL_THE_ROOM_LEAD).toMatch(/People on the call deserve to hear that first/)
    expect(TELL_THE_ROOM_QUOTE).toBe(
      "I'm using Métis to capture this for notes, follow-ups, and quality."
    )
    expect(TELL_THE_ROOM_WHY).toBe(
      'Saying it out loud is how we stay transparent and aligned with GDPR.'
    )
    expect(TELL_THE_ROOM_CHECKBOX).toBe("I'll tell everyone on the call before I record.")
    expect(TELL_THE_ROOM_READY).toMatch(
      /Métis is ready\. It starts listening only when you press Listen and tell the room\. Nothing is captured before that\./
    )
    expect(copy).not.toMatch(/\u2014/)
    expect(stripComments(experience)).not.toMatch(/\u2014/)
  })

  it('is one glass card on personalize, after the mode cards, before Continue', () => {
    const personalize = experience.slice(experience.indexOf("scene === 'personalize'"))
    const block = personalize.slice(0, personalize.indexOf("scene === 'license'"))
    expect(block).toMatch(/ONBOARDING_PERSONAS\.map/)
    expect(block.indexOf('onboard-glass onboard-tell-card')).toBeGreaterThan(block.indexOf('ONBOARDING_PERSONAS.map'))
    expect(block.indexOf('TELL_THE_ROOM_CHECKBOX')).toBeGreaterThan(block.indexOf('onboard-tell-card'))
    expect(block.indexOf('Continue')).toBeGreaterThan(block.indexOf('TELL_THE_ROOM_CHECKBOX'))
    expect(block.match(/type="checkbox"/g)?.length).toBe(1)
    expect(block).toMatch(/disabled=\{\!consent\}/)
    expect(block).not.toMatch(/Ready when you are/)
    expect(css).toMatch(/\.onboard-tell-card\s*\{/)
    expect(css).toMatch(/backdrop-filter:\s*blur\(12px\)/)
  })

  it('Continue stays gated; finish still writes recordingConsent; Ready echoes the quote', () => {
    expect(experience).toMatch(/if \(doneRef\.current \|\| !consent\) return/)
    expect(experience).toMatch(/onDone\(\{ mode, recordingConsent: true \}\)/)
    expect(experience).toMatch(/TELL_THE_ROOM_READY/)
    expect(experience).toMatch(/onboard-tell-quote--echo/)
    expect(experience).toMatch(/TELL_THE_ROOM_QUOTE/)
  })

  it('Skip-the-tour still requires the legacy slide 1 consent gate', () => {
    expect(experience).toMatch(/initialStep=\{1\}/)
    expect(experience).toMatch(/legacy-full/)
    expect(onboarding).toMatch(/if \(!recordingConsent\)/)
    expect(onboarding).toMatch(/disabled=\{busy \|\| !recordingConsent\}/)
  })
})
