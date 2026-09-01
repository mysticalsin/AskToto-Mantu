import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStarfieldBed } from './onboarding-starfield-engine'

const engineSrc = readFileSync(join(__dirname, './onboarding-starfield-engine.ts'), 'utf8')
const componentSrc = readFileSync(join(__dirname, '../components/OnboardingStarfield.tsx'), 'utf8')

describe('Starfield Close engine — dispose, fail, reduced-motion, no fetch', () => {
  it('WebGL1 failure returns null so the tour can keep the video bed', () => {
    const canvas = {
      width: 64,
      height: 64,
      clientWidth: 64,
      clientHeight: 64,
      getContext: () => null,
      style: {},
      addEventListener: () => {},
      removeEventListener: () => {}
    } as unknown as HTMLCanvasElement
    expect(createStarfieldBed(canvas)).toBeNull()
    expect(createStarfieldBed(canvas, { reducedMotion: true })).toBeNull()
  })

  it('disposes rAF, composers, and renderer on the React unmount path', () => {
    expect(componentSrc).toMatch(/bed\.dispose\(\)/)
    expect(componentSrc).toMatch(/return \(\) => \{\s*bed\.dispose\(\)/)
    expect(engineSrc).toMatch(/setActive: \(on: boolean\)/)
    expect(engineSrc).toMatch(/cancelAnimationFrame\(raf\)/)
    expect(engineSrc).toMatch(/disposeComposer\(torusComposer\)/)
    expect(engineSrc).toMatch(/disposeComposer\(bloomComposer\)/)
    expect(engineSrc).toMatch(/disposeComposer\(finalComposer\)/)
    expect(engineSrc).toMatch(/geometry\.dispose\(\)/)
    expect(engineSrc).toMatch(/material\.dispose\(\)/)
    expect(engineSrc).toMatch(/haloTexture\.dispose\(\)/)
    expect(engineSrc).toMatch(/renderer\.dispose\(\)/)
    expect(engineSrc).toMatch(/removeEventListener\('pointermove'/)
    expect(engineSrc).toMatch(/removeEventListener\('resize'/)
  })

  it('pauses while hidden and still runs drift + spin every visible frame', () => {
    expect(engineSrc).toMatch(/document\.hidden/)
    expect(engineSrc).toMatch(/uDrift/)
    expect(engineSrc).toMatch(/group\.rotation\.z \+= dt/)
    expect(engineSrc).toMatch(/breathScrollTarget\(t, reducedMotion\)/)
    expect(engineSrc).toMatch(/reducedMotion \? CONFIG\.drift \* REDUCED_MOTION_SCALE/)
    expect(engineSrc).not.toMatch(/scrollY|pageYOffset|wheel|scrollTo/)
    expect(engineSrc).not.toMatch(/unpkg|jsdelivr/)
  })

  it('caps pixel ratio, seeds the dive, and composes frame 1 before the next rAF', () => {
    expect(engineSrc).toMatch(/STARFIELD_PIXEL_RATIO_CAP/)
    expect(engineSrc).toMatch(/STARFIELD_SEED_DT/)
    expect(engineSrc).toMatch(/powerPreference: 'high-performance'/)
    expect(engineSrc).toMatch(/alpha: false/)
    expect(engineSrc).toMatch(/breathScrollTarget\(0, reducedMotion\)/)
    expect(engineSrc).toMatch(/const dt = firstFrame \? STARFIELD_SEED_DT : rawDt/)
    expect(engineSrc).toMatch(/opts\.onFirstFrame\?\.\(\)/)
    expect(engineSrc).toMatch(/window\.addEventListener\('resize', onResize\)\s*tick\(\)/)
  })

  it('wires three composers, ENTIRE_SCENE points, and a 1x1 black halo', () => {
    expect(engineSrc).toMatch(/torusComposer\.renderToScreen = false/)
    expect(engineSrc).toMatch(/bloomComposer\.renderToScreen = false/)
    expect(engineSrc).toMatch(/UnrealBloomPass\(bloomSize, 0\.22, 0\.2, 0\)/)
    expect(engineSrc).toMatch(/UnrealBloomPass\(new Vector2\(w, h\), 0\.4, 0\.55, 0\)/)
    expect(engineSrc).toMatch(/layers\.set\(LAYERS\.ENTIRE_SCENE\)/)
    expect(engineSrc).toMatch(/layers\.set\(LAYERS\.TORUS_SCENE\)/)
    expect(engineSrc).toMatch(/layers\.set\(LAYERS\.BLOOM_SCENE\)/)
    expect(engineSrc).toMatch(/new DataTexture\(new Uint8Array\(\[0, 0, 0, 255\]\), 1, 1, RGBAFormat\)/)
    expect(engineSrc).toMatch(/STAR_COUNT \* 3/)
  })
})
