import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hostCssSize,
  JARVIS_CAMERA_Z,
  JARVIS_ELECTRON_COUNT,
  JARVIS_HOST_PX,
  JARVIS_MIN_DPR,
  JARVIS_ORB_COLOR,
  JARVIS_ORB_STATES,
  JARVIS_PARTICLE_COUNT,
  JARVIS_PILL_CAMERA_Z,
  JARVIS_PILL_PARTICLE_COUNT,
  JARVIS_STATE_TARGET,
  jarvisCameraZForHost,
  jarvisCloudFillsHost,
  jarvisLineStepForCount,
  jarvisParticleCountForHost,
  jarvisPixelRatio,
  jarvisPointSizeForHost,
  jarvisSizeAttenuationForHost,
  jarvisStateRadiusForHost,
  jarvisVisibleHalfHeight,
  resolveJarvisOrbState,
  seedJarvisCloud
} from './jarvis-orb'

const engine = readFileSync(join(__dirname, './jarvis-orb.ts'), 'utf8')
const orb = readFileSync(join(__dirname, '../components/ObsidianOrb.tsx'), 'utf8')
const picker = readFileSync(join(__dirname, '../components/OverlayOrbPicker.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const pkg = readFileSync(join(__dirname, '../../../../package.json'), 'utf8')

describe('Jarvis particle orb (Bar Circle / second pill)', () => {
  it('locks Tony color, orb.ts cloud, and three-r143; never fullscreen', () => {
    expect(JARVIS_ORB_COLOR).toBe(0x4ca8e8)
    expect(JARVIS_ORB_STATES).toEqual(['idle', 'listening', 'thinking', 'speaking'])
    expect(JARVIS_PARTICLE_COUNT).toBe(2000)
    expect(JARVIS_ELECTRON_COUNT).toBe(3)
    expect(JARVIS_HOST_PX).toBe(41)
    expect(JARVIS_CAMERA_Z).toBe(80)
    expect(engine).toMatch(/from 'three'/)
    expect(engine).toMatch(/WebGLRenderer/)
    expect(engine).toMatch(/LineSegments/)
    expect(engine).toMatch(/Points/)
    expect(engine).toMatch(/0x4ca8e8/)
    expect(engine).not.toMatch(/setSize\(\s*window\.innerWidth/)
    expect(engine).not.toMatch(/setSize\(\s*window\.innerHeight/)
    expect(engine).toMatch(/setSize\(css, css, false\)/)
    expect(engine).toMatch(/setClearColor\(0x050508, 0\)/)
    expect(engine).toMatch(/createJarvisPointSprite/)
    expect(engine).toMatch(/jarvisPixelRatio/)
    expect(engine).toMatch(/DataTexture/)
    expect(engine).not.toMatch(/\bCanvasTexture\b/)
    expect(engine).not.toMatch(/does not thin the cloud/)
    expect(engine).not.toMatch(/crops the camera/)
    expect(engine).not.toMatch(/fibonacciSphere/)
    expect(pkg).toMatch(/"three": "0\.143\.0"/)
    expect(orb).toMatch(/data-orb-engine="jarvis-particles"/)
    expect(orb).toMatch(/obsidian-orb__canvas/)
    expect(orb).not.toMatch(/obsidian-orb__spark/)
    expect(orb).not.toMatch(/obsidian-orb__ring/)
    expect(orb).toMatch(/createJarvisOrb/)
    expect(picker).toMatch(/<ObsidianOrb/)
    expect(picker).toMatch(/preview/)
    expect(picker).not.toMatch(/overlay-orb-diagram__jarvis--live/)
  })

  it('maps product mood onto idle / listening / thinking', () => {
    expect(resolveJarvisOrbState({ mood: 'idle' })).toBe('idle')
    expect(resolveJarvisOrbState({ mood: 'idle', listening: true })).toBe('listening')
    expect(resolveJarvisOrbState({ mood: 'thinking' })).toBe('thinking')
    expect(resolveJarvisOrbState({ mood: 'factcheck' })).toBe('thinking')
    expect(resolveJarvisOrbState({ mood: 'connecting' })).toBe('thinking')
  })

  it('seeds a spherical cloud and scales point size for the 41 host', () => {
    const { pos, phase } = seedJarvisCloud(JARVIS_PARTICLE_COUNT, 25)
    expect(pos.length).toBe(JARVIS_PARTICLE_COUNT * 3)
    expect(phase.length).toBe(JARVIS_PARTICLE_COUNT)
    let inside = 0
    for (let i = 0; i < JARVIS_PARTICLE_COUNT; i++) {
      const r = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
      if (r <= 25 + 1e-6) inside++
    }
    expect(inside).toBe(JARVIS_PARTICLE_COUNT)
    expect(jarvisPointSizeForHost(0.4, 41)).toBeGreaterThanOrEqual(2.4)
    expect(jarvisPointSizeForHost(0.4, 41)).toBeLessThanOrEqual(3.8)
    expect(jarvisPointSizeForHost(0.4, 900)).toBeCloseTo(0.4, 5)
    expect(JARVIS_PILL_PARTICLE_COUNT).toBe(220)
    expect(jarvisParticleCountForHost(41)).toBe(JARVIS_PILL_PARTICLE_COUNT)
    expect(jarvisParticleCountForHost(41)).toBeLessThan(400)
    expect(jarvisParticleCountForHost(41)).toBeLessThan(JARVIS_PARTICLE_COUNT)
    expect(jarvisParticleCountForHost(900)).toBe(JARVIS_PARTICLE_COUNT)
    expect(jarvisCameraZForHost(41)).toBe(JARVIS_PILL_CAMERA_Z)
    expect(jarvisCameraZForHost(41)).toBeLessThan(JARVIS_CAMERA_Z)
    expect(jarvisSizeAttenuationForHost(41)).toBe(false)
    expect(jarvisSizeAttenuationForHost(900)).toBe(true)
    expect(jarvisPixelRatio(1)).toBe(JARVIS_MIN_DPR)
    expect(jarvisPixelRatio(2)).toBe(2)
    expect(jarvisPixelRatio(3)).toBe(3)
    expect(jarvisLineStepForCount(220)).toBeGreaterThan(1)
    expect(JARVIS_STATE_TARGET.thinking.lineAmount).toBeGreaterThan(JARVIS_STATE_TARGET.idle.lineAmount)
    expect(JARVIS_STATE_TARGET.thinking.electronRate).toBeGreaterThan(0)
    const laidOut = { clientWidth: 41, clientHeight: 41, width: 82, height: 82 } as HTMLCanvasElement
    expect(hostCssSize(laidOut)).toBe(41)
    const backingOnly = { clientWidth: 0, clientHeight: 0, width: 82, height: 82 } as HTMLCanvasElement
    expect(hostCssSize(backingOnly)).toBe(41)
  })

  it('cameraZ + host sizing fill the 41 circle, not a 64 bottom-right pack', () => {
    expect(JARVIS_PILL_CAMERA_Z).toBe(52)
    expect(jarvisCameraZForHost(41)).toBe(52)
    expect(jarvisCameraZForHost(0)).toBe(52)
    expect(jarvisCameraZForHost(64)).toBe(68)
    expect(jarvisVisibleHalfHeight(52)).toBeLessThan(28)
    expect(
      jarvisCloudFillsHost({
        hostPx: 41,
        cameraZ: jarvisCameraZForHost(41),
        radius: jarvisStateRadiusForHost('idle', 41)
      })
    ).toBe(true)
    expect(
      jarvisCloudFillsHost({
        hostPx: 41,
        cameraZ: jarvisCameraZForHost(41),
        radius: jarvisStateRadiusForHost('thinking', 41)
      })
    ).toBe(true)
    expect(jarvisStateRadiusForHost('thinking', 41)).toBeGreaterThanOrEqual(26)
    expect(jarvisStateRadiusForHost('idle', 41)).toBe(28)
    expect(jarvisStateRadiusForHost('thinking', 900)).toBe(16)

    const preLayout = {
      clientWidth: 0,
      clientHeight: 0,
      width: 0,
      height: 0,
      parentElement: null
    } as unknown as HTMLCanvasElement
    expect(hostCssSize(preLayout)).toBe(41)

    const thinkingOrbRule = {
      clientWidth: 64,
      clientHeight: 64,
      width: 128,
      height: 128,
      parentElement: { clientWidth: 41, clientHeight: 41 }
    } as unknown as HTMLCanvasElement
    expect(hostCssSize(thinkingOrbRule)).toBe(41)

    const canvas64NoParent = {
      clientWidth: 64,
      clientHeight: 64,
      width: 128,
      height: 128,
      parentElement: null
    } as unknown as HTMLCanvasElement
    expect(hostCssSize(canvas64NoParent)).toBe(41)

    expect(engine).toMatch(/setViewport\(0, 0, css, css\)/)
    expect(engine).toMatch(/opts\.hostPx/)
    expect(engine).toMatch(/jarvisStateRadiusForHost/)
    expect(orb).toMatch(/hostPx: BAR_PILL_VISIBLE_PX/)
    expect(orb).toMatch(/useLayoutEffect/)
  })

  it('visual contract: Jarvis canvas is 41, not the thinking-orb 64 rule', () => {
    expect(css).toMatch(/\.obsidian-orb__canvas \{[\s\S]*?width:\s*41px !important/)
    expect(css).toMatch(/\.obsidian-orb__canvas \{[\s\S]*?height:\s*41px !important/)
    expect(css).toMatch(/\.obsidian-orb__canvas \{[\s\S]*?inset:\s*0/)
    expect(css).toMatch(/\.obsidian-orb \{[\s\S]*?width:\s*41px/)
    expect(css).toMatch(/\.obsidian-orb \{[\s\S]*?clip-path:\s*circle\(50% at 50% 50%\)/)
    expect(css).toMatch(/\.aw-orb__canvas \{[\s\S]*?width:\s*64px !important/)
    expect(css).not.toMatch(/\.aw-orb canvas \{/)
  })
})
