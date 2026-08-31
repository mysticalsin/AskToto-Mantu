import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_BAR_LAND_GAIN,
  ONBOARDING_PORTAL_CLOSE_GAIN,
  ONBOARDING_PORTAL_OPEN_GAIN
} from './onboarding-portal'
import {
  ONBOARDING_MUSIC_ENVELOPE_FLOOR,
  ONBOARDING_MUSIC_GAIN,
  onboardingMusicLoopEnvelope
} from './onboarding-music'
import {
  APPEAR_OPACITY_FLOOR,
  appearOpacity,
  breathScrollTarget,
  STARFIELD_PIXEL_RATIO_CAP,
  STARFIELD_SEED_DT
} from './onboarding-starfield-spec'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const demo = readFileSync(join(__dirname, '../components/OnboardingDemoScene.tsx'), 'utf8')
const engine = readFileSync(join(__dirname, './onboarding-starfield-engine.ts'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

function actSlice(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  const b = src.indexOf(end, a + 1)
  return src.slice(a, b > a ? b : undefined)
}

describe('Apple-grade quality bar — PR 66 re-pass', () => {
  it('starfield is 60fps-class on Retina: pixel cap, seed dt, moving frame 1', () => {
    expect(STARFIELD_PIXEL_RATIO_CAP).toBe(1.5)
    expect(STARFIELD_SEED_DT).toBeCloseTo(1 / 60, 10)
    expect(breathScrollTarget(0, false)).toBeCloseTo(0.56, 8)
    expect(appearOpacity(0)).toBe(APPEAR_OPACITY_FLOOR)
    expect(APPEAR_OPACITY_FLOOR).toBeCloseTo(1.15, 8)
    expect(engine).toMatch(/Math\.min\(dpr, STARFIELD_PIXEL_RATIO_CAP\)/)
    expect(engine).toMatch(/firstFrame \? STARFIELD_SEED_DT/)
    expect(engine).not.toMatch(/setPixelRatio\([\s\S]{0,80}, 2\)/)
  })

  it('Aria is audible under portal OPEN; mute still zeros; portal does not pause the bed', () => {
    const first = onboardingMusicLoopEnvelope(0, 300) * ONBOARDING_MUSIC_GAIN
    expect(ONBOARDING_MUSIC_ENVELOPE_FLOOR).toBeCloseTo(0.48, 8)
    expect(first).toBeGreaterThan(0.12)
    expect(first).toBeLessThan(ONBOARDING_PORTAL_OPEN_GAIN)
    expect(experience).toMatch(/music\.start\(\)\s*playPortalOpen\(music\.muted\)\s*music\.start\(\)/)
    expect(experience).toMatch(/onboard-mute/)
    expect(engine).not.toMatch(/audio\.pause|bed\.stop/)
  })

  it('springs are Vibe Island, not toy CSS; bar-land quieter than OPEN/CLOSE', () => {
    const mark = css.slice(css.indexOf('@keyframes onboard-mark-land'), css.indexOf('.onboard-mark-land {'))
    expect(mark).toMatch(/scale\(0\.9\)/)
    expect(mark).toMatch(/scale\(1\.03\)/)
    expect(mark).not.toMatch(/scale\(0\.72\)/)
    expect(mark).not.toMatch(/scale\(1\.08\)/)
    expect(css).toMatch(/\.onboard-mark-land \{\s*animation: onboard-mark-land 520ms/)
    const pop = css.slice(css.indexOf('@keyframes onboard-pop-in'), css.indexOf('.onboard-pop-in {'))
    expect(pop).toMatch(/translateY\(8px\)/)
    expect(pop).not.toMatch(/scale\(/)
    expect(css).toMatch(/\.onboard-persona:hover \{[\s\S]*?scale\(1\.02\)/)
    expect(css).not.toMatch(/\.onboard-persona:hover \{[\s\S]*?scale\(1\.03\)/)
    const landStart = css.indexOf('@keyframes metis-bar-land')
    const land = css.slice(landStart, css.indexOf('html.metis-bar-land .aw-widget', landStart))
    expect(land).toMatch(/scale\(0\.92\) translateY\(-8px\)/)
    expect(land).not.toMatch(/clip-path/)
    expect(ONBOARDING_BAR_LAND_GAIN).toBeLessThan(ONBOARDING_PORTAL_CLOSE_GAIN)
    expect(ONBOARDING_BAR_LAND_GAIN).toBeLessThan(ONBOARDING_PORTAL_OPEN_GAIN)
  })

  it('Continue / Next / Set me up sit outside scene-enter on first paint of that act', () => {
    const hero = actSlice(experience, 'function HeroWelcome', "export type SetupRowState")
    const heroCta = hero.slice(hero.indexOf('onboard-cta'), hero.indexOf('Skip the tour'))
    expect(heroCta).not.toMatch(/fade-up/)
    expect(heroCta).not.toMatch(/animationDelay/)
    expect(hero.indexOf('scene-enter')).toBeLessThan(hero.indexOf('onboard-cta'))
    expect(hero.lastIndexOf('</div>', hero.indexOf('onboard-cta'))).toBeGreaterThan(hero.indexOf('scene-enter'))

    const problem = actSlice(experience, "scene === 'problem'", "scene === 'reveal'")
    expect(problem).toMatch(/scene-enter/)
    expect(problem.search(/>\s*Continue\s*</)).toBeGreaterThan(problem.lastIndexOf('scene-enter'))

    const nextBlock = demo.slice(demo.indexOf('>Next<') > 0 ? demo.indexOf('>Next<') - 400 : demo.search(/>\s*Next\s*</) - 400)
    expect(demo).toMatch(/scene-enter/)
    expect(demo.search(/>\s*Next\s*</)).toBeGreaterThan(demo.lastIndexOf('scene-enter', demo.search(/>\s*Next\s*</)))
    expect(demo).toMatch(/>\s*Set me up\s*</)
    expect(nextBlock).not.toMatch(/\{hasNext && \(/)
  })

  it('WebGL fail is an instant video bed; canvas never paints black first', () => {
    expect(experience).toMatch(/\(!starfieldReady \|\| starfieldFailed\) && <OnboardingHeroVideo/)
    expect(engine).toMatch(/canvas\.style\.opacity = '0'/)
    expect(engine).toMatch(/onFirstFrame/)
    expect(css).toMatch(/\.onboard-starfield canvas \{[\s\S]*?opacity:\s*0/)
  })
})
