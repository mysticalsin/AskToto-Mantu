import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_PLACEMENTS } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'

const picker = readFileSync(join(__dirname, './OverlayPlacementPicker.tsx'), 'utf8')
const settings = readFileSync(join(__dirname, './Settings.tsx'), 'utf8')
const onboarding = readFileSync(join(__dirname, './OnboardingAppearance.tsx'), 'utf8')
const experience = readFileSync(join(__dirname, './OnboardingExperience.tsx'), 'utf8')

describe('overlay physical placement controls', () => {
  it('keeps physical placement separate from chrome and exposes exactly the supported positions', () => {
    expect(OVERLAY_PLACEMENTS).toEqual(['top-center', 'right-edge'])
    expect(picker).toMatch(/aria-label="Overlay position"/)
    expect(picker).toMatch(/OVERLAY_PLACEMENTS\.map/)
    expect(picker).toMatch(/parseOverlayPlacement/)
    expect(picker).toMatch(/overlay-placement-diagram--\$\{id\}/)
    expect(picker).toMatch(/Drag it up or down/)
    expect(picker).not.toMatch(/overlayLayout/)
    expect(resolveOverlayPresentation({ placement: 'top-center', layout: 'bar' }).layout).toBe('bar')
    expect(resolveOverlayPresentation({ placement: 'right-edge', layout: 'bar' }).layout).toBe('island')
  })

  it('makes the choice available from Settings and the guided onboarding flow', () => {
    expect(settings).toMatch(/<OverlayPlacementPicker/)
    expect(settings).toMatch(/onChange=\{saveOverlayPlacement\}/)
    expect(settings).toMatch(/persistOverlayPlacement\(id, settings\.overlayLayout, patch\)/)
    expect(settings).toMatch(/Métis couldn't save this position\. Try again\./)
    expect(settings).toMatch(/locked=\{settings\.managedKeys\.includes\('overlayPlacement'\) \|\| overlayPlacementSave\.busy\}/)
    expect(onboarding).toMatch(/<OverlayPlacementPicker/)
    expect(experience).toMatch(/seedOnboardingPlacement/)
    expect(experience).toMatch(/resolveOverlayPresentation\(\{ layout: appearance, placement: id \}\)/)
    expect(experience).toMatch(/persistOverlayPlacement\(id, appearance, patch\)/)
    expect(experience).toMatch(/overlayPlacement/)
  })
})
