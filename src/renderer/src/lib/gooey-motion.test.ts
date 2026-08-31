import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GOOEY, GOOEY_PACKAGE, GOOEY_PACKAGE_VERSION, gooeyFill, shouldMountGooey } from './gooey-motion'

const pkg = readFileSync(join(__dirname, '../../../../package.json'), 'utf8')
const design = readFileSync(join(__dirname, '../../../../DESIGN.md'), 'utf8')
const contract = readFileSync(join(__dirname, '../../../../docs/design/GOOEY-MOTION.md'), 'utf8')
const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const demo = readFileSync(join(__dirname, '../components/OnboardingDemoScene.tsx'), 'utf8')
const host = readFileSync(join(__dirname, '../components/GooeySurface.tsx'), 'utf8')
const agent = readFileSync(join(__dirname, '../components/AgentStatus.tsx'), 'utf8')
const constellation = readFileSync(join(__dirname, './onboarding-constellation-engine.ts'), 'utf8')
const constellationHost = readFileSync(join(__dirname, '../components/OnboardingConstellation.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

describe('gooey micro-motion — contract and pins', () => {
  it('pins liquid-gooey 0.2.1 and names the official site', () => {
    expect(GOOEY_PACKAGE).toBe('liquid-gooey')
    expect(GOOEY_PACKAGE_VERSION).toBe('0.2.1')
    expect(pkg).toMatch(/"liquid-gooey": "0\.2\.1"/)
    expect(contract).toMatch(/https:\/\/gooey\.jakubantalik\.com\//)
    expect(design).toMatch(/liquid-gooey@0\.2\.1/)
    expect(design).toMatch(/GOOEY-MOTION\.md/)
  })

  it('is quiet Mantu goo, not the playground demo', () => {
    expect(GOOEY).toEqual({
      blur: 5,
      contrast: 16,
      bounce: 0.28,
      speed: 1,
      contentBlur: 0,
      pressScale: 0.96,
      ctaFill: '#f4f4f5',
      ctaMutedFill: 'rgba(244, 244, 245, 0.10)',
      waitFill: 'rgba(192, 132, 252, 0.16)',
      ctaShadow: '0 2px 16px rgba(244, 244, 245, 0.16)'
    })
    expect(gooeyFill('cta')).toBe('#f4f4f5')
    expect(gooeyFill('cta', true)).toBe('rgba(244, 244, 245, 0.10)')
    expect(gooeyFill('wait')).toBe('rgba(192, 132, 252, 0.16)')
    expect(host).not.toMatch(/unsplash/i)
    expect(host).not.toMatch(/PlusMenu|round-btn/)
    expect(experience).not.toMatch(/unsplash/i)
    expect(contract).toMatch(/second particle system/)
  })

  it('wraps CTAs and orb hosts; never the constellation bed', () => {
    expect(experience).toMatch(/<GooeySurface variant="cta">/)
    expect(experience).toMatch(/className="onboard-cta no-drag focus-ring"/)
    expect(demo).toMatch(/<GooeySurface variant="cta">/)
    expect(agent).toMatch(/<GooeySurface variant="wait">/)
    expect(agent).toMatch(/<ThinkingOrb/)
    expect(constellation).not.toMatch(/liquid-gooey/)
    expect(constellationHost).not.toMatch(/liquid-gooey/)
    expect(constellationHost).not.toMatch(/GooeySurface/)
    expect(host).toMatch(/contentBlur: GOOEY\.contentBlur/)
    expect(host).toMatch(/shouldMountGooey/)
  })

  it('scene settle is CSS overshoot, not a filled Liquid panel', () => {
    expect(css).toMatch(/@keyframes scene-enter/)
    expect(css).toMatch(/scale\(0\.985\)/)
    expect(css).toMatch(/\.scene-enter \{[\s\S]*?360ms/)
    expect(experience).not.toMatch(/<GooeySurface variant="scene"/)
    expect(shouldMountGooey({ hasWindow: false })).toBe(false)
    expect(shouldMountGooey({ hasWindow: true, reducedMotion: true })).toBe(false)
    expect(shouldMountGooey({ hasWindow: true, reducedMotion: false })).toBe(true)
  })
})
