import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_PLACEMENTS,
  chromeSettingsPatch,
  onboardingChromeForPlacement
} from './onboarding-appearance'

/**
 * onboarding-placement-step.test.ts
 *
 * Two defects in "Where should Métis live?", both reported from the running app.
 *
 * 1. The placement step was a title and a sentence per option, so choosing between Top and Right was
 *    choosing between two words. The chrome step had diagrams; this one did not.
 * 2. The right edge still offered four bar-family options. Bar is an 880-wide horizontal strip, so
 *    "Full bar on the right edge" is not a placement, it is a combination that cannot be built — and
 *    picking one put a top-centre chrome at a right-edge placement, which is how a dock sliver ended up
 *    floating in the middle of the screen.
 */
describe('the placement step shows what it is offering', () => {
  const scene = readFileSync(join(__dirname, '..', 'components', 'OnboardingAppearance.tsx'), 'utf8')

  it('each placement card draws the surface where it will actually sit', () => {
    expect(scene).toMatch(/overlay-placement-diagram overlay-placement-diagram--\$\{id\}/)
    expect(scene).toMatch(/overlay-placement-diagram__desktop/)
    expect(scene).toMatch(/overlay-placement-diagram__mark/)
  })

  it('the diagram is decoration, so it is not announced twice', () => {
    const card = scene.slice(scene.indexOf('overlay-placement-diagram'))
    expect(card.slice(0, 400)).toMatch(/aria-hidden="true"/)
  })

  it('the styles those classes need already exist', () => {
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')
    for (const id of ONBOARDING_PLACEMENTS) {
      expect(css).toContain(`.overlay-placement-diagram--${id}`)
    }
  })
})

describe('the right edge only offers chrome that can live there', () => {
  it('never offers a bar, because a bar cannot be an edge sidecar', () => {
    const right = onboardingChromeForPlacement('right-edge')
    expect(right.length).toBeGreaterThan(0)
    for (const spec of right) {
      expect(spec.layout, spec.id).not.toBe('bar')
    }
    expect(right.map((s) => s.id)).not.toContain('bar-hides')
    expect(right.map((s) => s.id)).not.toContain('bar-stays')
  })

  it('offers the dock, visible or invisible', () => {
    const ids = onboardingChromeForPlacement('right-edge').map((s) => s.id)
    expect(ids).toContain('dock')
    expect(ids).toContain('dock-hidden')
  })

  it('the top keeps every chrome that genuinely works there', () => {
    const top = onboardingChromeForPlacement('top-center').map((s) => s.layout)
    expect(top).toContain('hide')
    expect(top).toContain('bar')
  })
})

describe('the saved patch cannot leave a stale rest behind', () => {
  it('writes dockRest every time, so re-picking the visible dock brings the sliver back', () => {
    expect(chromeSettingsPatch('right-edge', 'dock').dockRest).toBe('sliver')
    expect(chromeSettingsPatch('right-edge', 'dock-hidden').dockRest).toBe('hidden')
  })

  it('a right-edge choice always saves the right-edge placement with it', () => {
    const patch = chromeSettingsPatch('right-edge', 'dock')
    expect(patch.overlayPlacement).toBe('right-edge')
    expect(patch.overlayLayout).toBe('dock')
  })

  it('a top choice never smuggles a dock in', () => {
    const patch = chromeSettingsPatch('top-center', 'hidden')
    expect(patch.overlayPlacement).toBe('top-center')
    expect(patch.overlayLayout).not.toBe('dock')
  })
})
