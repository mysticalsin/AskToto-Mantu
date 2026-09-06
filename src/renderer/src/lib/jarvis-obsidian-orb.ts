/**
 * Jarvis particle orb. Port of tonys-jarvis `frontend/src/orb.ts`
 * (Three.js particle cloud + connection lines + electrons, color ~0x4ca8e8).
 *
 * Sized for the Bar / pill 41 host. Uses the tree's three@0.143.0.
 * This is the Bar circle. Do not fall back to a gray thinking-orb box.
 */

import type { OrbMood } from './bar-pill-orb'
import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  SphereGeometry,
  WebGLRenderer
} from 'three'

export const JARVIS_ORB_COLOR = 0x4ca8e8
export const JARVIS_ORB_STATES = ['idle', 'listening', 'thinking', 'speaking'] as const
export type JarvisOrbState = (typeof JARVIS_ORB_STATES)[number]

/** Particle count for a 41 host. Fullscreen tonys-jarvis is denser. */
export const JARVIS_PARTICLE_COUNT = 96
export const JARVIS_ELECTRON_COUNT = 3
export const JARVIS_ORB_RADIUS = 1
export const JARVIS_CONNECTION_DISTANCE = 0.34
export const JARVIS_HOST_PX = 41

export interface JarvisOrbMotion {
  spin: number
  electron: number
  pulse: number
  scale: number
  lineOpacity: number
  pointOpacity: number
}

export const JARVIS_ORB_MOTION: Record<JarvisOrbState, JarvisOrbMotion> = {
  idle: { spin: 0.35, electron: 0.7, pulse: 0.018, scale: 1, lineOpacity: 0.22, pointOpacity: 0.92 },
  listening: { spin: 0.55, electron: 1.1, pulse: 0.05, scale: 1.08, lineOpacity: 0.4, pointOpacity: 1 },
  thinking: { spin: 1.15, electron: 1.85, pulse: 0.035, scale: 1.02, lineOpacity: 0.34, pointOpacity: 0.98 },
  speaking: { spin: 0.72, electron: 1.35, pulse: 0.11, scale: 1.05, lineOpacity: 0.48, pointOpacity: 1 }
}

export function isJarvisOrbState(v: unknown): v is JarvisOrbState {
  return v === 'idle' || v === 'listening' || v === 'thinking' || v === 'speaking'
}

/** Product mood + listen flag → Tony orb states. connecting/factcheck share thinking. */
export function resolveJarvisOrbState(input: { mood: OrbMood; listening?: boolean }): JarvisOrbState {
  if (input.listening) return 'listening'
  if (input.mood === 'thinking' || input.mood === 'factcheck' || input.mood === 'connecting') {
    return 'thinking'
  }
  return 'idle'
}

/** Fibonacci sphere. Same distribution the fullscreen Jarvis orb uses. */
export function fibonacciSpherePositions(count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    out[i * 3] = Math.cos(theta) * r * radius
    out[i * 3 + 1] = y * radius
    out[i * 3 + 2] = Math.sin(theta) * r * radius
  }
  return out
}

/** Neighbor pairs within `maxDist`. Built once. Frame loop is O(connections), not O(n²). */
export function connectionIndices(positions: Float32Array, maxDist: number): Uint16Array {
  const n = positions.length / 3
  const pairs: number[] = []
  const maxSq = maxDist * maxDist
  for (let i = 0; i < n; i++) {
    const ix = i * 3
    const x = positions[ix]
    const y = positions[ix + 1]
    const z = positions[ix + 2]
    for (let j = i + 1; j < n; j++) {
      const jx = j * 3
      const dx = x - positions[jx]
      const dy = y - positions[jx + 1]
      const dz = z - positions[jx + 2]
      if (dx * dx + dy * dy + dz * dz <= maxSq) {
        pairs.push(i, j)
      }
    }
  }
  return Uint16Array.from(pairs)
}

export function linePositionBuffer(positions: Float32Array, indices: Uint16Array): Float32Array {
  const out = new Float32Array(indices.length * 3)
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k] * 3
    const o = k * 3
    out[o] = positions[i]
    out[o + 1] = positions[i + 1]
    out[o + 2] = positions[i + 2]
  }
  return out
}

export interface JarvisObsidianOrbHandle {
  setState: (state: JarvisOrbState) => void
  dispose: () => void
}

export interface JarvisObsidianOrbOptions {
  reducedMotion?: boolean
  state?: JarvisOrbState
  now?: () => number
}

function viewCssSize(canvas: HTMLCanvasElement): number {
  const w = canvas.clientWidth || canvas.width || JARVIS_HOST_PX
  const h = canvas.clientHeight || canvas.height || JARVIS_HOST_PX
  return Math.max(1, Math.round(Math.min(w, h)))
}

/**
 * Mount the particle orb on a 41 host canvas. Returns null if WebGL is unavailable
 * so the button can keep a first-paint CSS disc instead of an empty hole.
 */
export function createJarvisObsidianOrb(
  canvas: HTMLCanvasElement,
  opts: JarvisObsidianOrbOptions = {}
): JarvisObsidianOrbHandle | null {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power'
    })
    if (!renderer.getContext()) return null
  } catch {
    return null
  }

  renderer.setClearColor(0x000000, 0)
  const css = viewCssSize(canvas)
  const dpr =
    typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 2
  renderer.setPixelRatio(Math.max(2, dpr))
  renderer.setSize(css, css, false)

  const scene = new Scene()
  const camera = new PerspectiveCamera(40, 1, 0.1, 20)
  camera.position.z = 2.55

  const group = new Group()
  scene.add(group)

  const base = fibonacciSpherePositions(JARVIS_PARTICLE_COUNT, JARVIS_ORB_RADIUS)
  const pointsGeo = new BufferGeometry()
  pointsGeo.setAttribute('position', new Float32BufferAttribute(base.slice(), 3))
  const pointsMat = new PointsMaterial({
    color: JARVIS_ORB_COLOR,
    size: 0.045,
    sizeAttenuation: true,
    transparent: true,
    opacity: JARVIS_ORB_MOTION.idle.pointOpacity,
    depthWrite: false,
    blending: AdditiveBlending
  })
  const cloud = new Points(pointsGeo, pointsMat)
  group.add(cloud)

  const links = connectionIndices(base, JARVIS_CONNECTION_DISTANCE)
  const lineGeo = new BufferGeometry()
  lineGeo.setAttribute('position', new Float32BufferAttribute(linePositionBuffer(base, links), 3))
  const lineMat = new LineBasicMaterial({
    color: JARVIS_ORB_COLOR,
    transparent: true,
    opacity: JARVIS_ORB_MOTION.idle.lineOpacity,
    depthWrite: false
  })
  const lines = new LineSegments(lineGeo, lineMat)
  group.add(lines)

  const electronGeo = new SphereGeometry(0.045, 8, 8)
  const electronMat = new MeshBasicMaterial({
    color: JARVIS_ORB_COLOR,
    transparent: true,
    opacity: 0.95
  })
  const electrons: Mesh[] = []
  for (let i = 0; i < JARVIS_ELECTRON_COUNT; i++) {
    const mesh = new Mesh(electronGeo, electronMat)
    electrons.push(mesh)
    group.add(mesh)
  }

  let state: JarvisOrbState = opts.state && isJarvisOrbState(opts.state) ? opts.state : 'idle'
  let raf = 0
  let disposed = false
  const nowFn = opts.now ?? (() => performance.now())
  const reduced = opts.reducedMotion === true
  const t0 = nowFn()

  const placeElectrons = (t: number, motion: JarvisOrbMotion): void => {
    for (let i = 0; i < electrons.length; i++) {
      const a = t * motion.electron + (i * (Math.PI * 2)) / JARVIS_ELECTRON_COUNT
      const tilt = 0.45 + i * 0.35
      const r = JARVIS_ORB_RADIUS * 1.18
      electrons[i].position.set(
        Math.cos(a) * r,
        Math.sin(a * 0.7 + tilt) * r * 0.42,
        Math.sin(a) * r
      )
    }
  }

  const paint = (tSec: number): void => {
    const motion = JARVIS_ORB_MOTION[state]
    const pulse = 1 + Math.sin(tSec * (state === 'speaking' ? 7 : 2.2)) * motion.pulse
    const s = motion.scale * pulse
    group.scale.setScalar(s)
    group.rotation.y = tSec * motion.spin
    group.rotation.x = Math.sin(tSec * 0.35) * 0.12
    pointsMat.opacity = motion.pointOpacity
    lineMat.opacity = motion.lineOpacity
    placeElectrons(tSec, motion)
    renderer.render(scene, camera)
  }

  const tick = (): void => {
    if (disposed) return
    paint((nowFn() - t0) / 1000)
    if (!reduced) raf = requestAnimationFrame(tick)
  }

  paint(0)
  if (!reduced) raf = requestAnimationFrame(tick)

  return {
    setState(next) {
      if (isJarvisOrbState(next)) state = next
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      group.remove(cloud, lines)
      for (const mesh of electrons) group.remove(mesh)
      scene.remove(group)
      pointsGeo.dispose()
      lineGeo.dispose()
      electronGeo.dispose()
      pointsMat.dispose()
      lineMat.dispose()
      electronMat.dispose()
      renderer.dispose()
    }
  }
}
