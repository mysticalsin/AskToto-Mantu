import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PERSONALIZE_LEAD,
  PERSONALIZE_MUST_PICK,
  PERSONALIZE_TITLE
} from './persona-vibe'
import { gooeyFill } from './gooey-motion'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const design = readFileSync(join(__dirname, '../../../../DESIGN.md'), 'utf8')
const contract = readFileSync(join(__dirname, '../../../../docs/design/GOOEY-MOTION.md'), 'utf8')
const vibe = readFileSync(join(__dirname, './persona-vibe.ts'), 'utf8')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function personalizeBlock(): string {
  const start = experience.indexOf("scene === 'personalize'")
  const end = experience.indexOf("scene === 'license'", start)
  return experience.slice(start, end > start ? end : undefined)
}

describe('Act 4 personalize — required pick', () => {
  it('pins punchy must-pick helper under the heading (no em dash)', () => {
    expect(PERSONALIZE_TITLE).toBe('How should Métis show up?')
    expect(PERSONALIZE_MUST_PICK).toBe('Pick one. Continue waits until you do.')
    expect(PERSONALIZE_LEAD).toBe('Change it anytime in Settings.')
    expect(design).toMatch(/Act 4 required pick/)
    expect(design).toMatch(/Pick one\. Continue waits until you do\./)
    expect(stripComments(vibe)).not.toMatch(/\u2014/)
    expect(stripComments(personalizeBlock())).not.toMatch(/\u2014/)
    const block = personalizeBlock()
    expect(block).toMatch(/PERSONALIZE_TITLE/)
    expect(block).toMatch(/onboard-act4-must/)
    expect(block).toMatch(/PERSONALIZE_MUST_PICK/)
    expect(block.indexOf('PERSONALIZE_MUST_PICK')).toBeGreaterThan(block.indexOf('PERSONALIZE_TITLE'))
    expect(block.indexOf('PERSONALIZE_LEAD')).toBeGreaterThan(block.indexOf('PERSONALIZE_MUST_PICK'))
    expect(css).toMatch(/\.onboard-act4-must\s*\{/)
  })

  it('does not pre-select a mode; Continue stays gated until a pick and consent', () => {
    expect(experience).toMatch(/useState<ConversationMode\s*\|\s*null>\(null\)/)
    expect(experience).not.toMatch(/useState<ConversationMode>\('general'\)/)
    const block = personalizeBlock()
    expect(block).toMatch(/disabled=\{\!consent \|\| \!mode\}/)
    expect(block).toMatch(/muted=\{\!consent \|\| \!mode\}/)
    expect(block).toMatch(/if \(!consent \|\| !mode\) return/)
    expect(experience).toMatch(/if \(doneRef\.current \|\| !consent \|\| !mode\) return/)
    expect(block).toMatch(/role="radiogroup"/)
    expect(block).toMatch(/role="radio"/)
    expect(block).toMatch(/aria-checked=\{selected\}/)
  })

  it('selected-state contract: is-selected, purple border/glow, lingering rim, gooey select', () => {
    const block = personalizeBlock()
    expect(block).toMatch(/is-selected/)
    expect(block).toMatch(/<GooeySurface key=\{p\.id\} variant="select">/)
    expect(block).not.toMatch(/persona-select-ring/)
    expect(gooeyFill('select')).toBe('rgba(154, 43, 240, 0.32)')
    expect(contract).toMatch(/variant="select"/)
    expect(css).toMatch(/\.onboard-persona\.is-selected\s*\{/)
    const selected = css.slice(css.indexOf('.onboard-persona.is-selected {'), css.indexOf('.onboard-persona-label'))
    expect(selected).toMatch(/#c084fc/i)
    expect(selected).toMatch(/box-shadow:/)
    expect(selected).toMatch(/127,\s*0,\s*218/)
    expect(selected).toMatch(/opacity:\s*1/)
    expect(selected).toMatch(/::after/)
    expect(css).toMatch(/@keyframes persona-select-rim/)
    expect(css).toMatch(/animation:\s*persona-select-rim/)
    expect(css).toMatch(/\.onboard-persona\s*\{[\s\S]*?opacity:\s*0\.72/)
    expect(css).toMatch(/\.gooey-surface--select/)
    expect(css).toMatch(/\.onboard-persona:hover \{[\s\S]*?scale\(1\.02\)/)
  })
})
