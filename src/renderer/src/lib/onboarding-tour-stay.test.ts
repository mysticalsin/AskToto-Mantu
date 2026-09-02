import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_BAR_LAND_GAIN,
  ONBOARDING_PORTAL_CLOSE_GAIN,
  ONBOARDING_PORTAL_OPEN_GAIN
} from './onboarding-portal'
import { shouldMountKineticGrid } from './onboarding-kinetic-grid'
import { shouldMountStarfield } from './onboarding-starfield-spec'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const demo = readFileSync(join(__dirname, '../components/OnboardingDemoScene.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const portal = readFileSync(join(__dirname, './onboarding-portal.ts'), 'utf8')

describe('Mac-show tour stay-visible + quieter bar land', () => {
  it('KineticGrid mounts after the lady beat, never starfield', () => {
    expect(shouldMountStarfield('hero')).toBe(false)
    expect(shouldMountStarfield('problem')).toBe(false)
    expect(shouldMountKineticGrid('hero')).toBe(false)
    expect(shouldMountKineticGrid('problem')).toBe(true)
    expect(experience).toMatch(/shouldMountKineticGrid\(scene\) && <KineticGrid/)
    expect(experience).not.toMatch(/shouldMountStarfield/)
  })

  it('problem Continue is present at t=0 and lines stay with both', () => {
    const problem = experience.slice(experience.indexOf("scene === 'problem'"), experience.indexOf("scene === 'reveal'"))
    expect(problem).toMatch(/>\s*Continue\s*</)
    expect(problem).not.toMatch(/PROBLEM_STORY\.length \* 1100/)
    expect(problem).toMatch(/animationFillMode: 'both'/)
    expect(problem).not.toMatch(/animationFillMode: 'forwards'/)
    expect(problem).not.toMatch(/animationFillMode: 'backwards'/)
    const continueAt = problem.indexOf('>Continue<') >= 0 ? problem.indexOf('>Continue<') : problem.search(/>\s*Continue\s*</)
    const sceneEnterAt = problem.indexOf('scene-enter')
    expect(sceneEnterAt).toBeGreaterThanOrEqual(0)
    expect(continueAt).toBeGreaterThan(sceneEnterAt)
    expect(css).toMatch(/\.fade-up \{\s*animation: fade-up 180ms[^;]*forwards/)
  })

  it('demo Next and Set me up stay mounted after beats', () => {
    expect(demo).toMatch(/>\s*Next\s*</)
    expect(demo).toMatch(/>\s*Set me up\s*</)
    expect(demo).not.toMatch(/\{hasNext && \(/)
    expect(demo).toMatch(/demoNextLeavesTour\(beat\)/)
    expect(demo).toMatch(/onContinue\(\)/)
    expect(demo).toMatch(/Here’s what that looks like/)
  })

  it('no white Act 4 top wash; tell-the-room is centered', () => {
    expect(css).not.toMatch(/\.onboard-act4::before/)
    expect(css).not.toMatch(/\.onboard-stage:has\(\.onboard-act4\)/)
    const tell = css.slice(css.indexOf('.onboard-tell-card {'), css.indexOf('.onboard-tell-card h3'))
    expect(tell).toMatch(/text-align:\s*center/)
    expect(tell).toMatch(/align-items:\s*center/)
  })

  it('music start is invoked on mount and retried on Next', () => {
    expect(experience).toMatch(/music\.start\(\)/)
    expect(experience).toMatch(/onPointerDown=\{music\.start\}/)
    const beginAt = experience.indexOf('onBegin={() => {')
    const begin = experience.slice(beginAt, beginAt + 280)
    expect(begin).toMatch(/music\.start\(\)/)
    expect(experience).toMatch(/const playHero[\s\S]*music\.start\(\)/)
  })

  it('bar-land is quieter than portal open; open/close stay the loud pair', () => {
    expect(ONBOARDING_PORTAL_OPEN_GAIN).toBe(0.16)
    expect(ONBOARDING_PORTAL_CLOSE_GAIN).toBe(0.12)
    expect(ONBOARDING_BAR_LAND_GAIN).toBeCloseTo(0.16 * 0.45, 8)
    expect(ONBOARDING_BAR_LAND_GAIN).toBeGreaterThanOrEqual(0.16 * 0.4)
    expect(ONBOARDING_BAR_LAND_GAIN).toBeLessThanOrEqual(0.16 * 0.5)
    expect(portal).toMatch(/function sciFiBarLand/)
    expect(portal).toMatch(/playBarLand/)
    expect(experience).toMatch(/playBarLand\(music\.muted\)/)
    expect(experience).toMatch(/requestBarLand\(\)/)
    expect(css).toMatch(/html\.metis-bar-land \.aw-widget/)
    expect(css).toMatch(/@keyframes metis-bar-land/)
    const landStart = css.indexOf('@keyframes metis-bar-land')
    const land = css.slice(landStart, css.indexOf('html.metis-bar-land .aw-widget', landStart))
    expect(land).toMatch(/scale\(0\.92\) translateY\(-8px\)/)
    expect(land).not.toMatch(/clip-path/)
    expect(css).toMatch(/html\.metis-bar-land \.aw-widget \{[\s\S]*?transform-origin:\s*top center/)
    expect(css).toMatch(/html\.metis-bar-land \.aw-widget \{[\s\S]*?animation: metis-bar-land 360ms/)
  })
})
