import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
const design = readFileSync(join(__dirname, '../../../DESIGN.md'), 'utf8')
const css = readFileSync(join(__dirname, '../../renderer/src/styles.css'), 'utf8')

function functionBody(name: string): string {
  const marker = `function ${name}(`
  const start = index.indexOf(marker)
  expect(start, `${name} missing`).toBeGreaterThan(-1)
  const braceOpen = index.indexOf('{', start)
  let depth = 0
  let i = braceOpen
  for (; i < index.length; i++) {
    if (index[i] === '{') depth++
    else if (index[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return index.slice(start, i + 1)
}

describe('onboarding tour is a visible window, not Hide/Island', () => {
  it('DESIGN.md requires a findable full-display tour', () => {
    expect(design).toMatch(/Visible tour window \(HARD\)/)
    expect(design).toMatch(/exclusiveOnboardingBounds/)
    expect(design).toMatch(/setIgnoreMouseEvents\(true\)/)
    expect(design).toMatch(/Mission Control/)
    expect(design).toMatch(/Cmd-Tab/)
    expect(design).toMatch(/setSimpleFullScreen\(true\)/)
    expect(design).toMatch(/ONBOARDING_HERO_VIDEO_SRC/)
    expect(design).toMatch(/Do not start the open as a 120×36 notch pill/)
  })

  it('applyExclusiveOnboardingStage covers the display and is discoverable', () => {
    const apply = functionBody('applyExclusiveOnboardingStage')
    expect(apply).toMatch(/exclusiveOnboardingBounds/)
    expect(apply).toMatch(/setIgnoreMouseEvents\(false\)/)
    expect(apply).toMatch(/setOpacity\(1\)/)
    expect(apply).toMatch(/setSkipTaskbar\(false\)/)
    expect(apply).toMatch(/setHiddenInMissionControl\?\.\(false\)/)
    expect(apply).toMatch(/setActivationPolicy\?\.\('regular'\)/)
    expect(apply).toMatch(/showOnboardingStage/)
    expect(apply).not.toMatch(/setSimpleFullScreen\(true\)/)
    expect(apply).not.toMatch(/setKiosk\(true\)/)
    expect(apply).not.toMatch(/parkAfterExclusiveOnboarding/)
    expect(apply).not.toMatch(/OVERLAY_HIDE_PARK/)
  })

  it('exit restores accessory Hide/Island park; Hide math stays off this path', () => {
    const exit = functionBody('exitExclusiveOnboardingStage')
    expect(exit).toMatch(/setSkipTaskbar\(true\)/)
    expect(exit).toMatch(/setHiddenInMissionControl\?\.\(true\)/)
    expect(exit).toMatch(/setActivationPolicy\?\.\('accessory'\)/)
    expect(exit).toMatch(/parkAfterExclusiveOnboarding/)
    expect(exit).toMatch(/applyHideClickThrough/)
    expect(index).toMatch(/function showOnboardingStage/)
    const showTour = functionBody('showOnboardingStage')
    expect(showTour).toMatch(/\.show\(\)/)
    expect(showTour).toMatch(/\.focus\(\)/)
  })

  it('first paint of the stage is full-visible, close still uses the island pill mask', () => {
    const stage = css.slice(css.indexOf('.onboard-stage {'), css.indexOf('@keyframes onboard-portal-open'))
    expect(stage).not.toMatch(/mask-size:\s*120px 36px/)
    expect(css).toMatch(/\.onboard-stage--portal-close/)
    expect(css).toMatch(/@keyframes onboard-portal-close/)
    expect(css).toMatch(/mask-size:\s*120px 36px/)
  })
})
