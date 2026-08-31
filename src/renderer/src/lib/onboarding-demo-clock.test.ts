import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const demo = readFileSync(join(__dirname, '../components/OnboardingDemoScene.tsx'), 'utf8')
const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

describe('Act 2 demo clock — DOM cursor, not setState every rAF', () => {
  it('does not call setLocalMs on every rAF tick; cursor is a ref + transform', () => {
    expect(demo).toMatch(/export const DEMO_COMMIT_MS = 100/)
    expect(demo).toMatch(/cursorRef/)
    expect(demo).toMatch(/cursorEl\.style\.transform/)
    expect(demo).toMatch(/setLocalMs\(next\.localMs\)/)
    // The rAF tick must not setState every frame. Commit only at beat hold or DEMO_COMMIT_MS.
    expect(demo).not.toMatch(/const tick = \(now: number\): void => \{\s*const local = now - t0\s*\n\s*setLocalMs\(local\)/)
    expect(demo).toMatch(/local - lastCommitRef\.current >= DEMO_COMMIT_MS/)
    expect(demo).toMatch(/prefetchOnboardingDemoChunks/)
    expect(experience).toMatch(/prefetchOnboardingDemoChunks\(\)/)
    expect(demo).not.toMatch(/setTimeout\(/)
    expect(demo).toMatch(/demoPlaybackAfterNext/)
  })

  it('onboard-stage has no filter:blur drifting orbs; scene-enter is opacity + translate', () => {
    expect(css).not.toMatch(/onboard-stage::before/)
    expect(css).not.toMatch(/onboard-stage::after/)
    expect(css).not.toMatch(/filter:\s*blur\(40px\)/)
    expect(css).not.toMatch(/onboard-purple-drift/)
    expect(css).toMatch(/\.onboard-stripes/)
    expect(css).toMatch(/onboard-stripe-spin/)
    expect(css).toMatch(/transform:\s*rotate/)
    expect(css).toMatch(/mix-blend-mode:\s*(overlay|screen)/)
    expect(css).toMatch(/\.onboard-stripes,\s*\n\s*\.onboard-stripes--b \{\s*[\s\S]*?animation:\s*none;/)
    const scene = css.slice(css.indexOf('@keyframes scene-enter'))
    const from = scene.slice(scene.indexOf('from {'), scene.indexOf('68% {') > 0 ? scene.indexOf('68% {') : scene.indexOf('to {'))
    expect(from).toMatch(/opacity:\s*0/)
    expect(from).toMatch(/translateY/)
    expect(from).toMatch(/scale\(0\.985\)/)
    expect(from).not.toMatch(/filter/)
    expect(css).toMatch(/\.scene-enter \{\s*animation: scene-enter 360ms/)
    expect(css).toMatch(/\.onboard-stage \.develop-in \{\s*animation: none;\s*filter: none;/)
    expect(css).toMatch(/\.onboard-cta:hover:not\(:disabled\) \{\s*transform: scale\(1\.02\);/)
    expect(css).not.toMatch(/\.onboard-cta:hover:not\(:disabled\) \{\s*filter:/)
  })
})
