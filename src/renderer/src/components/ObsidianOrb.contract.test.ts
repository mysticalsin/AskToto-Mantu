import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const brand = readFileSync(join(__dirname, './BrandThinkingOrb.tsx'), 'utf8')

describe('ObsidianOrb / Circle always animate on Windows reduce', () => {
  it('Jarvis live Bar forces reducedMotion:false; picker may freeze via animate=false', () => {
    const src = readFileSync(join(__dirname, './ObsidianOrb.tsx'), 'utf8')
    expect(src).toMatch(/reducedMotion:\s*!animate/)
    expect(src).not.toMatch(/reducedMotion:\s*reduced/)
    expect(src).not.toMatch(/matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)/)
  })

  it('Circle uses BrandThinkingOrb that ignores prefers-reduced-motion', () => {
    const btn = readFileSync(join(__dirname, './JarvisOrbButton.tsx'), 'utf8')
    expect(btn).toMatch(/BrandThinkingOrb/)
    expect(btn).not.toMatch(/from 'thinking-orbs'/)
    expect(brand).toMatch(/Always animates/)
    expect(brand).toMatch(/MODE_DRAWS/)
    expect(brand).toMatch(/resolvePreset/)
    expect(brand).toMatch(/visibilitychange|visibilityState/)
    expect(brand).not.toMatch(/prefers-reduced-motion/)
  })
})

describe('C30 contract: the resting Bar orb has no unconditional per-vsync loop', () => {
  const orb = brand

  it('BrandThinkingOrb paints through the budgeted frame loop, never its own requestAnimationFrame chain', () => {
    expect(orb).toMatch(/createFrameLoop\(/)
    expect(orb).toMatch(/orbFrameBudget\(\{ resting, engaged: engaged \|\| pointerInside \}\)/)
    expect(orb).toMatch(/const resting = state === ORB_STATE\.idle/)
    expect(orb).not.toMatch(/requestAnimationFrame\(/)
  })

  it('keeps pausing when hidden or off-screen, and tracks focus and pointer for the engaged cadence', () => {
    expect(orb).toMatch(/visibilitychange/)
    expect(orb).toMatch(/IntersectionObserver/)
    expect(orb).toMatch(/addEventListener\('focus', onFocus\)/)
    expect(orb).toMatch(/addEventListener\('blur', onBlur\)/)
    expect(orb).toMatch(/removeEventListener\('blur', onBlur\)/)
  })
})
