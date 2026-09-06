import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hostCssSize,
  JARVIS_CAMERA_Z,
  JARVIS_ELECTRON_COUNT,
  JARVIS_HOST_PX,
  JARVIS_ORB_COLOR,
  JARVIS_ORB_STATES,
  JARVIS_PARTICLE_COUNT,
  JARVIS_STATE_TARGET,
  jarvisPointSizeForHost,
  resolveJarvisOrbState,
  seedJarvisCloud
} from './jarvis-orb'

const engine = readFileSync(join(__dirname, './jarvis-orb.ts'), 'utf8')
const orb = readFileSync(join(__dirname, '../components/ObsidianOrb.tsx'), 'utf8')
const picker = readFileSync(join(__dirname, '../components/OverlayOrbPicker.tsx'), 'utf8')
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
    expect(engine).not.toMatch(/innerWidth/)
    expect(engine).not.toMatch(/innerHeight/)
    expect(engine).not.toMatch(/fibonacciSphere/)
    expect(pkg).toMatch(/"three": "0\.143\.0"/)
    expect(orb).toMatch(/data-orb-engine="jarvis-particles"/)
    expect(orb).toMatch(/obsidian-orb__canvas/)
    expect(orb).not.toMatch(/obsidian-orb__spark/)
    expect(orb).not.toMatch(/obsidian-orb__ring/)
    expect(orb).toMatch(/createJarvisOrb/)
    expect(picker).toMatch(/createJarvisOrb/)
    expect(picker).toMatch(/overlay-orb-diagram__jarvis--live/)
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
    expect(jarvisPointSizeForHost(0.4, 41)).toBeGreaterThan(0.4)
    expect(jarvisPointSizeForHost(0.4, 900)).toBeCloseTo(0.4, 5)
    expect(JARVIS_STATE_TARGET.thinking.lineAmount).toBeGreaterThan(JARVIS_STATE_TARGET.idle.lineAmount)
    expect(JARVIS_STATE_TARGET.thinking.electronRate).toBeGreaterThan(0)
    const canvas = { clientWidth: 41, clientHeight: 41, width: 82, height: 82 } as HTMLCanvasElement
    expect(hostCssSize(canvas)).toBe(41)
  })
})
