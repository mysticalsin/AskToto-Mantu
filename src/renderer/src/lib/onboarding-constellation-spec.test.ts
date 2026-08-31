import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONSTELLATION_CROSSFADE_MS,
  CONSTELLATION_SCENES,
  GRID,
  clampDt,
  hexToRgb,
  hookeAccel,
  linkAlpha,
  recedeForce,
  shouldMountConstellation,
  shouldMountStarfield
} from './onboarding-constellation-spec'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const engine = readFileSync(join(__dirname, './onboarding-constellation-engine.ts'), 'utf8')
const host = readFileSync(join(__dirname, '../components/OnboardingConstellation.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

describe('constellation-grid bed — mount and palette', () => {
  it('mounts after hero only; three.js starfield stays off', () => {
    expect(shouldMountConstellation('hero')).toBe(false)
    expect(shouldMountConstellation('skip')).toBe(false)
    expect(shouldMountConstellation('reveal')).toBe(true)
    expect(shouldMountConstellation('problem')).toBe(true)
    for (const scene of CONSTELLATION_SCENES) {
      expect(shouldMountConstellation(scene)).toBe(true)
    }
    expect(shouldMountStarfield('problem')).toBe(false)
    expect(shouldMountStarfield('reveal')).toBe(false)
    expect(experience).toMatch(/shouldMountConstellation\(scene\) && !gridFailed/)
    expect(experience).toMatch(/<OnboardingConstellation/)
    expect(experience).not.toMatch(/<OnboardingStarfield/)
    expect(experience).not.toMatch(/shouldMountStarfield\(scene\)/)
    expect(host).toMatch(/createConstellationBed/)
    expect(host).toMatch(/\[\s*\]/)
  })

  it('pins spring-mass GRID: purple on near-black, no cyan', () => {
    expect(GRID).toEqual({
      spacing: 55,
      mouseRadius: 220,
      springK: 18,
      damping: 0.82,
      linkDist: 75,
      dprCap: 2,
      bg: '#05010a',
      bgDeep: '#030407',
      node: '#7F00DA',
      line: '#9A2BF0',
      ring: '#C084FC',
      highlight: '#C084FC'
    })
    expect(engine).not.toMatch(/56,\s*189,\s*248/)
    expect(engine).not.toMatch(/#56b9f8|#38bdf8|sky/i)
    expect(engine).not.toMatch(/prefers-color-scheme/)
    expect(engine).toMatch(/GRID\.springK/)
    expect(engine).toMatch(/GRID\.damping/)
    expect(engine).toMatch(/GRID\.linkDist/)
    expect(engine).toMatch(/setTransform\(1, 0, 0, 1, 0, 0\)/)
    expect(engine).toMatch(/setTransform\(dpr, 0, 0, dpr, 0, 0\)/)
    expect(engine).toMatch(/cancelAnimationFrame\(raf\)/)
    expect(css).toMatch(/\.onboard-constellation/)
    expect(CONSTELLATION_CROSSFADE_MS).toBe(640)
  })

  it('is a silent bed: no demo title, hex readout, or mix-blend overlay', () => {
    expect(engine).not.toMatch(/High-velocity dynamic mesh/)
    expect(engine).not.toMatch(/>\s*Constellation\s*</)
    expect(engine).not.toMatch(/mix-blend-difference/)
    expect(engine).not.toMatch(/cursor:\s*crosshair/)
    expect(host).not.toMatch(/<h1/)
    expect(experience).not.toMatch(/High-velocity dynamic mesh/)
    expect(css).not.toMatch(/mix-blend-difference/)
  })

  it('crossfades the girl clip into the grid on Next', () => {
    expect(experience).toMatch(/onboard-hero-video--out/)
    expect(experience).toMatch(/setHeroFading\(true\)/)
    expect(experience).toMatch(/scene === 'hero' \|\| heroFading/)
    expect(css).toMatch(/\.onboard-hero-video--out/)
    expect(css).toMatch(/onboard-constellation-in 640ms/)
  })
})

describe('constellation-grid physics helpers', () => {
  it('Hooke, recede, link alpha, and dt clamp', () => {
    expect(hookeAccel(0, 10, 18)).toBe(-180)
    expect(recedeForce(0, 220)).toBe(0)
    expect(recedeForce(110, 220)).toBeCloseTo(0.5, 8)
    expect(recedeForce(220, 220)).toBe(0)
    expect(linkAlpha(0, 75)).toBe(0)
    expect(linkAlpha(75, 75)).toBe(0)
    expect(linkAlpha(37.5, 75)).toBeCloseTo(0.5, 8)
    expect(clampDt(0)).toBeCloseTo(1 / 60, 8)
    expect(clampDt(1)).toBe(0.05)
    expect(hexToRgb('#7F00DA')).toEqual({ r: 127, g: 0, b: 218 })
  })
})
