import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('ObsidianOrb / Circle always animate on Windows reduce', () => {
  it('Jarvis createJarvisOrb never passes OS reducedMotion:true', () => {
    const src = readFileSync(join(__dirname, './ObsidianOrb.tsx'), 'utf8')
    expect(src).toMatch(/reducedMotion:\s*false/)
    expect(src).not.toMatch(/reducedMotion:\s*reduced/)
  })

  it('Circle uses BrandThinkingOrb that ignores prefers-reduced-motion', () => {
    const btn = readFileSync(join(__dirname, './JarvisOrbButton.tsx'), 'utf8')
    const brand = readFileSync(join(__dirname, './BrandThinkingOrb.tsx'), 'utf8')
    expect(btn).toMatch(/BrandThinkingOrb/)
    expect(btn).not.toMatch(/from 'thinking-orbs'/)
    expect(brand).toMatch(/Always animates/)
    expect(brand).toMatch(/MODE_DRAWS/)
    expect(brand).not.toMatch(/prefers-reduced-motion/)
  })
})
