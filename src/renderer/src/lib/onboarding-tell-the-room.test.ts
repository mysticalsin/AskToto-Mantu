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
    expect(block.indexOf('TellTheRoomCard')).toBeGreaterThan(block.indexOf('ONBOARDING_PERSONAS.map'))
    expect(block.indexOf('Continue')).toBeGreaterThan(block.indexOf('TellTheRoomCard'))
    expect(experience.match(/function TellTheRoomCard/g)?.length).toBe(1)
    expect(experience.match(/type="checkbox"/g)?.length).toBe(1)
    expect(block).toMatch(/disabled=\{\!consent\}/)
    expect(block).not.toMatch(/Ready when you are/)
    expect(css).toMatch(/\.onboard-tell-card\s*\{/)
    expect(css).toMatch(/backdrop-filter:\s*blur\(12px\)/)
    const tell = css.slice(css.indexOf('.onboard-tell-card {'), css.indexOf('.onboard-tell-card h3'))
    expect(tell).toMatch(/max-width:\s*540px/)
    expect(tell).toMatch(/min-width:\s*min\(100%,\s*520px\)/)
    expect(tell).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.22\)/)
    expect(css).toMatch(/\.onboard-tell-check-box\s*\{/)
    expect(css).toMatch(/width:\s*18px/)
    expect(css).toMatch(/\.onboard-act4::before/)
    const veil = css.slice(css.indexOf('.onboard-act4::before'), css.indexOf('.onboard-act4 > *'))
    expect(veil).toMatch(/at 50% 1[0-6]%/)
    expect(veil).not.toMatch(/at 50% 42%/)
    const act4Stage = css.slice(css.indexOf('.onboard-stage:has(.onboard-act4)'), css.indexOf('.onboard-act4-kicker'))
    expect(act4Stage).not.toMatch(/78%/)
    expect(experience).toMatch(/onboard-persona/)
    const personalizeSrc = experience.slice(experience.indexOf("scene === 'personalize'"))
    expect(personalizeSrc.slice(0, personalizeSrc.indexOf("scene === 'license'"))).not.toMatch(/bg-white\/\[0\.03\]/)
    expect(experience).toMatch(/onboard-act4-kicker/)
  })

  it('Continue stays gated; finish still writes recordingConsent; Ready echoes the quote', () => {
    expect(experience).toMatch(/if \(doneRef\.current \|\| !consent\) return/)
    expect(experience).toMatch(/onDone\(\{ mode, recordingConsent: true \}\)/)
    expect(experience).toMatch(/TELL_THE_ROOM_READY/)
    expect(experience).toMatch(/onboard-tell-quote--echo/)
    expect(experience).toMatch(/TELL_THE_ROOM_QUOTE/)
  })

  it('Skip-the-tour still requires the tell-the-room checkbox before Get started', () => {
    expect(experience).toMatch(/setScene\('skip'\)/)
    const skip = experience.slice(experience.indexOf("scene === 'skip'"))
    expect(skip).toMatch(/TellTheRoomCard/)
    expect(skip).toMatch(/disabled=\{\!consent\}/)
    expect(experience).not.toMatch(/legacy-full/)
    expect(experience).not.toMatch(/from '\.\/Onboarding'/)
  })
})
