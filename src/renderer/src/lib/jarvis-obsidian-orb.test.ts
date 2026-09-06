import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  connectionIndices,
  fibonacciSpherePositions,
  JARVIS_CONNECTION_DISTANCE,
  JARVIS_ELECTRON_COUNT,
  JARVIS_HOST_PX,
  JARVIS_ORB_COLOR,
  JARVIS_ORB_MOTION,
  JARVIS_ORB_STATES,
  JARVIS_PARTICLE_COUNT,
  linePositionBuffer,
  resolveJarvisOrbState
} from './jarvis-obsidian-orb'

const engine = readFileSync(join(__dirname, './jarvis-obsidian-orb.ts'), 'utf8')
const orb = readFileSync(join(__dirname, '../components/ObsidianOrb.tsx'), 'utf8')
const pkg = readFileSync(join(__dirname, '../../../../package.json'), 'utf8')

describe('Jarvis particle orb (Bar circle)', () => {
  it('locks Tony color, states, and three-r143 in this tree', () => {
    expect(JARVIS_ORB_COLOR).toBe(0x4ca8e8)
    expect(JARVIS_ORB_STATES).toEqual(['idle', 'listening', 'thinking', 'speaking'])
    expect(JARVIS_PARTICLE_COUNT).toBe(96)
    expect(JARVIS_ELECTRON_COUNT).toBe(3)
    expect(JARVIS_HOST_PX).toBe(41)
    expect(engine).toMatch(/from 'three'/)
    expect(engine).toMatch(/WebGLRenderer/)
    expect(engine).toMatch(/LineSegments/)
    expect(engine).toMatch(/Points/)
    expect(engine).toMatch(/0x4ca8e8/)
    expect(pkg).toMatch(/"three": "0\.143\.0"/)
    expect(orb).toMatch(/data-orb-engine="jarvis-particles"/)
    expect(orb).toMatch(/obsidian-orb__canvas/)
    expect(orb).not.toMatch(/obsidian-orb__spark/)
    expect(orb).not.toMatch(/obsidian-orb__ring/)
  })

  it('maps product mood onto idle / listening / thinking', () => {
    expect(resolveJarvisOrbState({ mood: 'idle' })).toBe('idle')
    expect(resolveJarvisOrbState({ mood: 'idle', listening: true })).toBe('listening')
    expect(resolveJarvisOrbState({ mood: 'thinking' })).toBe('thinking')
    expect(resolveJarvisOrbState({ mood: 'factcheck' })).toBe('thinking')
    expect(resolveJarvisOrbState({ mood: 'connecting' })).toBe('thinking')
  })

  it('builds a sphere cloud and precomputed neighbor lines', () => {
    const pos = fibonacciSpherePositions(JARVIS_PARTICLE_COUNT, 1)
    expect(pos.length).toBe(JARVIS_PARTICLE_COUNT * 3)
    let radiusSum = 0
    for (let i = 0; i < JARVIS_PARTICLE_COUNT; i++) {
      const x = pos[i * 3]
      const y = pos[i * 3 + 1]
      const z = pos[i * 3 + 2]
      radiusSum += Math.hypot(x, y, z)
    }
    expect(radiusSum / JARVIS_PARTICLE_COUNT).toBeCloseTo(1, 2)
    const links = connectionIndices(pos, JARVIS_CONNECTION_DISTANCE)
    expect(links.length).toBeGreaterThan(20)
    expect(links.length % 2).toBe(0)
    const lines = linePositionBuffer(pos, links)
    expect(lines.length).toBe(links.length * 3)
    expect(JARVIS_ORB_MOTION.speaking.pulse).toBeGreaterThan(JARVIS_ORB_MOTION.idle.pulse)
  })
})
