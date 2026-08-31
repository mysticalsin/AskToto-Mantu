import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appearOpacity,
  breathScrollTarget,
  CONFIG,
  dampScroll,
  decayBump,
  FINAL_FRAGMENT_SHADER,
  FINAL_VERTEX_SHADER,
  LAYERS,
  NEXT_BUMP,
  shouldMountStarfield,
  STARFIELD_FRAGMENT_SHADER,
  STARFIELD_SCENES,
  STARFIELD_VERTEX_SHADER
} from './onboarding-starfield-spec'

const specSrc = readFileSync(join(__dirname, './onboarding-starfield-spec.ts'), 'utf8')
const engineSrc = readFileSync(join(__dirname, './onboarding-starfield-engine.ts'), 'utf8')
const componentSrc = readFileSync(join(__dirname, '../components/OnboardingStarfield.tsx'), 'utf8')
const experienceSrc = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const html = readFileSync(join(__dirname, '../../index.html'), 'utf8')
const pkg = readFileSync(join(__dirname, '../../../../package.json'), 'utf8')

const slice = [specSrc, engineSrc, componentSrc].join('\n')

describe('Starfield Close — mount after Next/Start only', () => {
  it('does not mount on Act 1 hero or Skip', () => {
    expect(shouldMountStarfield('hero')).toBe(false)
    expect(shouldMountStarfield('skip')).toBe(false)
    for (const scene of STARFIELD_SCENES) {
      expect(shouldMountStarfield(scene)).toBe(true)
    }
    expect(experienceSrc).toMatch(/shouldMountStarfield\(scene\) && !starfieldFailed/)
    expect(experienceSrc).toMatch(/<OnboardingStarfield/)
    expect(experienceSrc).not.toMatch(/scene === 'hero' && <OnboardingStarfield/)
    expect(experienceSrc).toMatch(/bumpStarfield\(\)/)
    expect(experienceSrc).toMatch(/setScene\('problem'\)/)
  })
})

describe('Starfield Close — CONFIG, layers, shaders verbatim', () => {
  it('pins CONFIG and LAYERS', () => {
    expect(CONFIG).toEqual({
      bgColor: '#0a0a24',
      flameColor: '#aee9ff',
      flameColor2: '#c79bff',
      flameAmt: 0.2,
      colorA: '#aef6cf',
      colorB: '#5fe6a0',
      colorC: '#eafff2',
      opacity: 2,
      pointSize: 50,
      brightness: 1.85,
      drift: 2.35,
      twinkle: 1,
      spin: 0.03,
      repelRadius: 5,
      repelStrength: 0.35,
      scrollPush: 8,
      scrollDrift: 6,
      scrollSpin: 0.1,
      parallax: 0.6
    })
    expect(LAYERS).toEqual({ NONE: 0, TORUS_SCENE: 1, BLOOM_SCENE: 2, ENTIRE_SCENE: 3 })
  })

  it('pins all four shader strings', () => {
    expect(STARFIELD_VERTEX_SHADER).toContain('pos.z = mod(pos.z + uDrift + (uDepth * 0.5), uDepth) - (uDepth * 0.5);')
    expect(STARFIELD_VERTEX_SHADER).toContain('normalize(toParticle + vec3(0.0001))')
    expect(STARFIELD_FRAGMENT_SHADER).toContain('gl_FragColor = vec4(color * uBrightness, strength * uOpacity * vTwinkle);')
    expect(FINAL_VERTEX_SHADER).toBe('varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }')
    expect(FINAL_FRAGMENT_SHADER).toContain('vec3 warp3d(vec3 pos, float t)')
    expect(FINAL_FRAGMENT_SHADER).toContain('texture2D(bloomTexture, vUv).xyz + texture2D(torusTexture, vUv).xyz')
  })
})

describe('Starfield Close — time-driven dive, no page scroll', () => {
  it('breath formula and reduced-motion zero surge', () => {
    expect(breathScrollTarget(0, false)).toBeCloseTo(0.42 + 0.28 * 0.5, 8)
    const peak = Math.PI / 2 / 0.32
    expect(breathScrollTarget(peak, false)).toBeCloseTo(0.7, 8)
    expect(breathScrollTarget(peak, true)).toBe(0)
    expect(breathScrollTarget(12, true)).toBe(0)
  })

  it('double-damps 0.10 then 0.06 and fades opacity to 2', () => {
    const step = dampScroll(0, 0, 1)
    expect(step.smooth).toBeCloseTo(0.1, 8)
    expect(step.scroll).toBeCloseTo(0.006, 8)
    expect(appearOpacity(0)).toBe(0)
    expect(appearOpacity(300)).toBe(0)
    expect(appearOpacity(1000)).toBeCloseTo((700 / 1400) * 2, 8)
    expect(appearOpacity(1700)).toBe(2)
    expect(appearOpacity(5000)).toBe(2)
    expect(decayBump(NEXT_BUMP, 0)).toBe(NEXT_BUMP)
    expect(decayBump(NEXT_BUMP, 1)).toBeLessThan(NEXT_BUMP)
  })

  it('has no scroll-host, scroll hint, or overflow scroller', () => {
    expect(slice).not.toMatch(/scroll-host/i)
    expect(slice).not.toMatch(/scroll\s*↓/)
    expect(slice).not.toMatch(/scroll down/i)
    expect(experienceSrc).not.toMatch(/scroll-host/i)
    expect(css).toMatch(/html,\s*\nbody,\s*\n#root \{[\s\S]*?overflow:\s*hidden/)
    const star = css.slice(css.indexOf('.onboard-starfield {'), css.indexOf('.onboard-starfield canvas'))
    expect(star).toMatch(/overflow:\s*hidden/)
    expect(star).toMatch(/pointer-events:\s*none/)
    expect(star).not.toMatch(/overflow:\s*(auto|scroll)/)
    expect(css).toMatch(/\.onboard-starfield canvas \{[\s\S]*?pointer-events:\s*none/)
  })
})

describe('Starfield Close — local three, no CDN', () => {
  it('pins three 0.143.0 and never writes an unpkg or https three URL', () => {
    expect(pkg).toMatch(/"three": "0\.143\.0"/)
    expect(engineSrc).toMatch(/from 'three'/)
    expect(engineSrc).toMatch(/three\/examples\/jsm\/postprocessing\/EffectComposer\.js/)
    expect(slice).not.toMatch(/unpkg/i)
    expect(slice).not.toMatch(/jsdelivr/i)
    expect(slice).not.toMatch(/https?:\/\/[^'"\s]*three/i)
    expect(html).not.toMatch(/unpkg\.com\/three/)
    expect(engineSrc).toMatch(/WebGL1Renderer/)
    expect(engineSrc).toMatch(/VSMShadowMap/)
  })
})

describe('Starfield Close — WebGL fail keeps the video bed', () => {
  it('Experience remounts the hero video when the bed is unavailable', () => {
    expect(experienceSrc).toMatch(/\(scene === 'hero' \|\| starfieldFailed\) && <OnboardingHeroVideo/)
    expect(experienceSrc).toMatch(/onUnavailable=\{\(\) => setStarfieldFailed\(true\)\}/)
    expect(componentSrc).toMatch(/onUnavailableRef\.current\(\)/)
  })
})
