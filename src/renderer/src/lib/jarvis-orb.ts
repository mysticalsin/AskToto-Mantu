/**
 * Jarvis particle orb. Port of tonys-jarvis / jarvis2.0 `frontend/src/orb.ts`
 * (floating cloud + connection lines + electrons along those lines).
 *
 * Fullscreen orb.ts sizes the renderer to window.innerWidth/innerHeight.
 * This mount is the Jarvis Settings pill / Bar rest when style is `obsidian`:
 * 41 host, never fullscreen. Particle count and point size scale with hostPx
 * so the 41 pill is a clean sphere, not 2000 sparkles cropped from orb.ts.
 * DPR is at least 2. Soft disc sprites, not square pixels. No gray box. No Métis M.
 */

import type { OrbMood } from './bar-pill-orb'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Clock,
  Color,
  DataTexture,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  RGBAFormat,
  Scene,
  WebGLRenderer
} from 'three'

export const JARVIS_ORB_COLOR = 0x4ca8e8
export const JARVIS_ORB_STATES = ['idle', 'listening', 'thinking', 'speaking'] as const
export type JarvisOrbState = (typeof JARVIS_ORB_STATES)[number]

/** orb.ts fullscreen count. The 41 pill must thin this. Never crop 2000 into 41px. */
export const JARVIS_PARTICLE_COUNT = 2000
/** Clean sentient sphere at 41. 800+ is sparkly noise. */
export const JARVIS_PILL_PARTICLE_COUNT = 220
export const JARVIS_ELECTRON_COUNT = 3
export const JARVIS_MAX_LINES = 8000
export const JARVIS_CLOUD_SEED_RADIUS = 25
export const JARVIS_CAMERA_Z = 80
export const JARVIS_PILL_CAMERA_Z = 52
export const JARVIS_LINE_DISTANCE = 8
export const JARVIS_HOST_PX = 41
/** orb.ts was tuned on a ~viewport canvas. Scale count and points from this. */
export const JARVIS_SIZE_REF_PX = 900
export const JARVIS_PILL_HOST_PX = 48
export const JARVIS_MIN_DPR = 2

export interface JarvisStateTarget {
  radius: number
  speed: number
  bright: number
  size: number
  lineAmount: number
  electronRate: number
}

/** Idle / listen / think / speak targets from orb.ts. */
export const JARVIS_STATE_TARGET: Record<JarvisOrbState, JarvisStateTarget> = {
  idle: { radius: 28, speed: 0.2, bright: 0.5, size: 0.35, lineAmount: 0.15, electronRate: 0 },
  listening: { radius: 22, speed: 0.3, bright: 0.65, size: 0.4, lineAmount: 0.4, electronRate: 0 },
  thinking: { radius: 16, speed: 0.5, bright: 0.7, size: 0.3, lineAmount: 1, electronRate: 0.015 },
  speaking: { radius: 18, speed: 0.2, bright: 0.7, size: 0.4, lineAmount: 0.8, electronRate: 0 }
}

export function isJarvisOrbState(v: unknown): v is JarvisOrbState {
  return v === 'idle' || v === 'listening' || v === 'thinking' || v === 'speaking'
}

export function resolveJarvisOrbState(input: { mood: OrbMood; listening?: boolean }): JarvisOrbState {
  if (input.listening) return 'listening'
  if (input.mood === 'thinking' || input.mood === 'factcheck' || input.mood === 'connecting') {
    return 'thinking'
  }
  return 'idle'
}

/** orb.ts seed: random spherical cloud, not a fibonacci cage. */
export function seedJarvisCloud(
  count: number,
  radius: number
): { pos: Float32Array; phase: Float32Array } {
  const pos = new Float32Array(count * 3)
  const phase = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = Math.pow(Math.random(), 0.5) * radius
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    pos[i * 3 + 2] = r * Math.cos(phi)
    phase[i] = Math.random() * 1000
  }
  return { pos, phase }
}

/** Thin the cloud with host size. 41 → ~220. Never keep orb.ts 2000 on the pill. */
export function jarvisParticleCountForHost(hostPx: number): number {
  const h = Math.max(1, hostPx)
  if (h >= JARVIS_SIZE_REF_PX) return JARVIS_PARTICLE_COUNT
  const scaled = Math.round(JARVIS_PARTICLE_COUNT * (h / JARVIS_SIZE_REF_PX) * 2.4)
  return Math.min(JARVIS_PARTICLE_COUNT, Math.max(JARVIS_PILL_PARTICLE_COUNT, scaled))
}

export function jarvisCameraZForHost(hostPx: number): number {
  if (hostPx <= JARVIS_PILL_HOST_PX) return JARVIS_PILL_CAMERA_Z
  if (hostPx <= 96) return 68
  return JARVIS_CAMERA_Z
}

/** Vertical half-height of the 45° view at z=0. Sphere radius must meet this to fill. */
export function jarvisVisibleHalfHeight(cameraZ: number, fovDeg = 45): number {
  return cameraZ * Math.tan((fovDeg * Math.PI) / 360)
}

/**
 * Idle 28 already fills at pill Z. Thinking's fullscreen 16 would sit as a marble
 * in the 41 clip. Keep idle/thinking a dense full sphere on the pill.
 */
export function jarvisStateRadiusForHost(state: JarvisOrbState, hostPx: number): number {
  const base = JARVIS_STATE_TARGET[state].radius
  if (hostPx <= JARVIS_PILL_HOST_PX) return Math.max(26, base)
  return base
}

/** True when the cloud diameter covers the host (not a corner marble). */
export function jarvisCloudFillsHost(input: {
  hostPx: number
  cameraZ: number
  radius: number
}): boolean {
  if (input.hostPx <= 0 || input.cameraZ <= 0 || input.radius <= 0) return false
  return input.radius >= jarvisVisibleHalfHeight(input.cameraZ) * 0.92
}

export function jarvisSizeAttenuationForHost(hostPx: number): boolean {
  return hostPx > 96
}

/** Soft pixel size on the pill. Tiny 1px dots read as sparkle noise. */
export function jarvisPointSizeForHost(baseSize: number, hostPx: number): number {
  if (hostPx <= JARVIS_PILL_HOST_PX) return Math.min(3.8, Math.max(2.4, baseSize * 7.2))
  if (hostPx <= 96) return Math.min(3.4, Math.max(2.0, baseSize * 5.6))
  return baseSize * (JARVIS_SIZE_REF_PX / Math.max(1, hostPx))
}

/** Never muddy 1x. Retina stays 2–3. */
export function jarvisPixelRatio(dpr?: number): number {
  const n =
    dpr && dpr > 0
      ? dpr
      : typeof window !== 'undefined'
        ? window.devicePixelRatio || JARVIS_MIN_DPR
        : JARVIS_MIN_DPR
  return Math.min(3, Math.max(JARVIS_MIN_DPR, n))
}

export function jarvisLineStepForCount(count: number): number {
  if (count <= 320) return Math.max(2, Math.floor(count / 90))
  return Math.max(1, Math.floor(count / 600))
}

function cssBoxSize(el: { clientWidth?: number; clientHeight?: number } | null | undefined): number {
  const w = el?.clientWidth ?? 0
  const h = el?.clientHeight ?? 0
  if (w > 0 && h > 0) return Math.max(1, Math.round(Math.min(w, h)))
  return 0
}

/**
 * CSS host, not the 2x backing attribute. width=82 on a 41 pill must stay 41.
 * Prefer the 41 `.obsidian-orb` parent. A 0×0 pre-layout canvas or a 64
 * `.aw-orb canvas` rule must not size the WebGL viewport — that packs the
 * sphere into the bottom-right of the clip.
 */
export function hostCssSize(canvas: HTMLCanvasElement): number {
  const fromHost = cssBoxSize(canvas.parentElement)
  if (fromHost > 0) return fromHost <= 64 ? JARVIS_HOST_PX : fromHost
  const fromCanvas = cssBoxSize(canvas)
  if (fromCanvas > 0) {
    if (fromCanvas > JARVIS_HOST_PX && fromCanvas <= 64) return JARVIS_HOST_PX
    return fromCanvas
  }
  const attr = Math.min(canvas.width || 0, canvas.height || 0)
  if (attr >= JARVIS_HOST_PX * 2) return JARVIS_HOST_PX
  return JARVIS_HOST_PX
}

/** Soft disc so Points are not square pixels. DataTexture, not a canvas-backed three texture. */
export function createJarvisPointSprite(): DataTexture {
  const s = 64
  const data = new Uint8Array(s * s * 4)
  const cx = (s - 1) / 2
  const r = s / 2
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - cx, y - cx) / r
      const t = Math.max(0, 1 - d)
      const i = (y * s + x) * 4
      const a = Math.round(t * t * 255)
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = a
    }
  }
  const tex = new DataTexture(data, s, s, RGBAFormat)
  tex.needsUpdate = true
  return tex
}

export interface JarvisOrbHandle {
  setState: (state: JarvisOrbState) => void
  setAnalyser: (a: AnalyserNode | null) => void
  dispose: () => void
}

export interface JarvisOrbOptions {
  reducedMotion?: boolean
  state?: JarvisOrbState
  /** Visible CSS host. The 41 pill passes this so a 0×0 first layout cannot mis-fit. */
  hostPx?: number
}

interface Electron {
  sx: number
  sy: number
  sz: number
  ex: number
  ey: number
  ez: number
  t: number
  speed: number
}

/**
 * Mount the sentient particle sphere on a pill/circle canvas.
 * Returns null if WebGL is unavailable so the CSS disc stays, not a gray box.
 */
export function createJarvisOrb(
  canvas: HTMLCanvasElement,
  opts: JarvisOrbOptions = {}
): JarvisOrbHandle | null {
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

  const fit = (): number => {
    const measured = hostCssSize(canvas)
    const css =
      opts.hostPx && opts.hostPx > 0
        ? Math.max(1, Math.round(opts.hostPx))
        : measured
    renderer.setPixelRatio(jarvisPixelRatio())
    renderer.setSize(css, css, false)
    renderer.setViewport(0, 0, css, css)
    canvas.style.setProperty('width', `${css}px`, 'important')
    canvas.style.setProperty('height', `${css}px`, 'important')
    return css
  }

  // Transparent clear: the CSS disc is the dark circle. An opaque canvas was a muddy gray box.
  renderer.setClearColor(0x050508, 0)
  let hostPx = fit()

  const scene = new Scene()
  const camera = new PerspectiveCamera(45, 1, 1, 1000)
  camera.position.z = jarvisCameraZForHost(hostPx)

  const N = jarvisParticleCountForHost(hostPx)
  const { pos, phase } = seedJarvisCloud(N, JARVIS_CLOUD_SEED_RADIUS)
  const vel = new Float32Array(N * 3)
  const attenuate = jarvisSizeAttenuationForHost(hostPx)
  const pointSprite = createJarvisPointSprite()

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  const mat = new PointsMaterial({
    color: JARVIS_ORB_COLOR,
    size: jarvisPointSizeForHost(0.4, hostPx),
    map: pointSprite,
    transparent: true,
    opacity: hostPx <= JARVIS_PILL_HOST_PX ? 0.82 : 0.6,
    sizeAttenuation: attenuate,
    blending: AdditiveBlending,
    depthWrite: false
  })
  const points = new Points(geo, mat)
  scene.add(points)

  const linePos = new Float32Array(JARVIS_MAX_LINES * 6)
  const lineGeo = new BufferGeometry()
  lineGeo.setAttribute('position', new BufferAttribute(linePos, 3))
  lineGeo.setDrawRange(0, 0)
  const lineMat = new LineBasicMaterial({
    color: JARVIS_ORB_COLOR,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false
  })
  const lines = new LineSegments(lineGeo, lineMat)
  scene.add(lines)

  const electronGeo = new BufferGeometry()
  const electronPos = new Float32Array(JARVIS_ELECTRON_COUNT * 3)
  electronGeo.setAttribute('position', new BufferAttribute(electronPos, 3))
  electronGeo.setDrawRange(0, 0)
  const electronMat = new PointsMaterial({
    color: 0xffffff,
    size: jarvisPointSizeForHost(0.8, hostPx),
    map: pointSprite,
    transparent: true,
    opacity: 1,
    sizeAttenuation: attenuate,
    blending: AdditiveBlending,
    depthWrite: false
  })
  const electrons = new Points(electronGeo, electronMat)
  scene.add(electrons)

  const activeElectrons: Electron[] = []
  let electronSpawnRate = 0
  let targetElectronRate = 0
  let lastElectronSpawn = 0
  let activeConnections: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }[] =
    []

  let state: JarvisOrbState = opts.state && isJarvisOrbState(opts.state) ? opts.state : 'idle'
  let targetRadius = 25
  let currentRadius = 25
  let targetSpeed = 0.3
  let currentSpeed = 0.3
  let targetBright = 0.6
  let currentBright = 0.6
  let targetSize = 0.4
  let currentSize = 0.4
  let lineAmount = 0
  let targetLineAmount = 0
  const lineDistance = JARVIS_LINE_DISTANCE

  let spinX = 0
  let spinY = 0
  let spinZ = 0
  let transitionEnergy = 0
  let lastState: JarvisOrbState = state

  let cloudZ = 0
  let cloudZVel = 0

  let analyser: AnalyserNode | null = null
  let freqData = new Uint8Array(64)
  let bass = 0
  let mid = 0

  const clock = new Clock()
  let raf = 0
  let disposed = false
  const reduced = opts.reducedMotion === true

  const applyTargets = (): void => {
    const next = JARVIS_STATE_TARGET[state]
    targetRadius = jarvisStateRadiusForHost(state, hostPx)
    targetSpeed = next.speed
    targetBright = next.bright
    targetSize = next.size
    targetLineAmount = next.lineAmount
    targetElectronRate = next.electronRate
  }
  applyTargets()

  const paint = (): void => {
    if (disposed) return
    const t = clock.getElapsedTime()
    applyTargets()

    currentRadius += (targetRadius - currentRadius) * 0.02
    currentSpeed += (targetSpeed - currentSpeed) * 0.02
    currentBright += (targetBright - currentBright) * 0.02
    currentSize += (targetSize - currentSize) * 0.02
    lineAmount += (targetLineAmount - lineAmount) * 0.02
    electronSpawnRate += (targetElectronRate - electronSpawnRate) * 0.02

    if (state !== lastState) {
      transitionEnergy = 1
      lastState = state
    }
    transitionEnergy *= 0.985
    if (transitionEnergy > 0.05) {
      spinX += transitionEnergy * 0.012 * Math.sin(t * 1.7)
      spinY += transitionEnergy * 0.015
      spinZ += transitionEnergy * 0.008 * Math.cos(t * 1.3)
    }

    bass = 0
    mid = 0
    if (analyser) {
      analyser.getByteFrequencyData(freqData)
      let bSum = 0
      let mSum = 0
      for (let i = 0; i < 8; i++) bSum += freqData[i]
      for (let i = 8; i < 24; i++) mSum += freqData[i]
      bass = bSum / (8 * 255)
      mid = mSum / (16 * 255)
    }

    const zAmp = hostPx <= JARVIS_PILL_HOST_PX ? 0.28 : 1
    let zTarget = Math.sin(t * 0.12) * 8 * zAmp
    if (state === 'thinking') zTarget = (Math.sin(t * 0.3) * 15 + Math.sin(t * 0.9) * 6) * zAmp
    else if (state === 'speaking') zTarget = (Math.sin(t * 0.15) * 6 - bass * 10) * zAmp
    cloudZVel += (zTarget - cloudZ) * 0.008
    cloudZVel *= 0.94
    cloudZ += cloudZVel

    points.rotation.x = spinX
    points.rotation.y = spinY
    points.rotation.z = spinZ
    points.position.z = cloudZ
    lines.rotation.x = spinX
    lines.rotation.y = spinY
    lines.rotation.z = spinZ
    lines.position.z = cloudZ

    const p = geo.getAttribute('position')
    const a = p.array

    for (let i = 0; i < N; i++) {
      const i3 = i * 3
      const x = a[i3]
      const y = a[i3 + 1]
      const z = a[i3 + 2]
      const px = phase[i]

      vel[i3] += Math.sin(t * 0.05 + px) * 0.001 * currentSpeed
      vel[i3 + 1] += Math.cos(t * 0.06 + px * 1.3) * 0.001 * currentSpeed
      vel[i3 + 2] += Math.sin(t * 0.055 + px * 0.7) * 0.001 * currentSpeed
      vel[i3] += Math.sin(t * 0.02 + px * 2.1 + y * 0.1) * 0.0008 * currentSpeed
      vel[i3 + 1] += Math.cos(t * 0.025 + px * 1.7 + z * 0.1) * 0.0008 * currentSpeed
      vel[i3 + 2] += Math.sin(t * 0.022 + px * 0.9 + x * 0.1) * 0.0008 * currentSpeed

      const dist = Math.sqrt(x * x + y * y + z * z) || 0.01
      const pull = Math.max(0, dist - currentRadius) * 0.002 + 0.0003
      vel[i3] -= (x / dist) * pull
      vel[i3 + 1] -= (y / dist) * pull
      vel[i3 + 2] -= (z / dist) * pull

      if (bass > 0.05) {
        vel[i3] += (x / dist) * bass * 0.02
        vel[i3 + 1] += (y / dist) * bass * 0.02
        vel[i3 + 2] += (z / dist) * bass * 0.02
      }
      if (state === 'speaking' && mid > 0.1) {
        const pulse = Math.sin(t * 8 + px)
        vel[i3] += (x / dist) * mid * 0.012 * pulse
        vel[i3 + 1] += (y / dist) * mid * 0.012 * pulse
      }

      vel[i3] *= 0.992
      vel[i3 + 1] *= 0.992
      vel[i3 + 2] *= 0.992
      a[i3] += vel[i3]
      a[i3 + 1] += vel[i3 + 1]
      a[i3 + 2] += vel[i3 + 2]
    }
    p.needsUpdate = true

    if (lineAmount > 0.01) {
      const lp = lineGeo.getAttribute('position')
      const la = lp.array
      let lineCount = 0
      const maxDist = lineDistance * (1 + bass * 0.5)
      const maxDistSq = maxDist * maxDist
      const step = jarvisLineStepForCount(N)

      for (let i = 0; i < N && lineCount < JARVIS_MAX_LINES; i += step) {
        const i3 = i * 3
        const x1 = a[i3]
        const y1 = a[i3 + 1]
        const z1 = a[i3 + 2]
        for (let j = i + step; j < N && lineCount < JARVIS_MAX_LINES; j += step) {
          const j3 = j * 3
          const dx = a[j3] - x1
          const dy = a[j3 + 1] - y1
          const dz = a[j3 + 2] - z1
          if (dx * dx + dy * dy + dz * dz < maxDistSq) {
            const idx = lineCount * 6
            la[idx] = x1
            la[idx + 1] = y1
            la[idx + 2] = z1
            la[idx + 3] = a[j3]
            la[idx + 4] = a[j3 + 1]
            la[idx + 5] = a[j3 + 2]
            lineCount++
          }
        }
      }
      lineGeo.setDrawRange(0, lineCount * 2)
      lp.needsUpdate = true
      lineMat.opacity = lineAmount * (hostPx <= JARVIS_PILL_HOST_PX ? 0.2 : 0.12)

      activeConnections = []
      for (let c = 0; c < Math.min(lineCount, 500); c++) {
        const ci = c * 6
        activeConnections.push({
          x1: la[ci],
          y1: la[ci + 1],
          z1: la[ci + 2],
          x2: la[ci + 3],
          y2: la[ci + 4],
          z2: la[ci + 5]
        })
      }
    } else {
      lineGeo.setDrawRange(0, 0)
      activeConnections = []
    }

    if (activeConnections.length > 0 && electronSpawnRate > 0.005) {
      if (activeElectrons.length < JARVIS_ELECTRON_COUNT && t - lastElectronSpawn > 1) {
        const conn = activeConnections[Math.floor(Math.random() * activeConnections.length)]
        activeElectrons.push({
          sx: conn.x1,
          sy: conn.y1,
          sz: conn.z1,
          ex: conn.x2,
          ey: conn.y2,
          ez: conn.z2,
          t: 0,
          speed: 0.003 + Math.random() * 0.003
        })
        lastElectronSpawn = t
      }
    }

    const ep = electronGeo.getAttribute('position')
    const ea = ep.array
    let aliveCount = 0
    for (let e = activeElectrons.length - 1; e >= 0; e--) {
      const el = activeElectrons[e]
      el.t += el.speed
      if (el.t >= 1) {
        activeElectrons.splice(e, 1)
        continue
      }
      const ei = aliveCount * 3
      ea[ei] = el.sx + (el.ex - el.sx) * el.t
      ea[ei + 1] = el.sy + (el.ey - el.sy) * el.t
      ea[ei + 2] = el.sz + (el.ez - el.sz) * el.t
      aliveCount++
    }
    electronGeo.setDrawRange(0, aliveCount)
    ep.needsUpdate = true
    electrons.rotation.x = spinX
    electrons.rotation.y = spinY
    electrons.rotation.z = spinZ
    electrons.position.z = cloudZ

    mat.opacity = currentBright + bass * 0.08
    mat.size = jarvisPointSizeForHost(currentSize + bass * 0.05, hostPx)
    electronMat.size = jarvisPointSizeForHost(0.8, hostPx)

    if (state === 'thinking') {
      mat.color.lerp(new Color(0x6ec4ff), 0.015)
      lineMat.color.lerp(new Color(0x6ec4ff), 0.015)
    } else if (state === 'speaking') {
      mat.color.lerp(new Color(0x5ab8f0), 0.015)
      lineMat.color.lerp(new Color(0x5ab8f0), 0.015)
    } else {
      mat.color.lerp(new Color(JARVIS_ORB_COLOR), 0.015)
      lineMat.color.lerp(new Color(JARVIS_ORB_COLOR), 0.015)
    }

    const drift = hostPx <= JARVIS_PILL_HOST_PX ? 0.35 : 1
    camera.position.x = Math.sin(t * 0.02) * 5 * drift
    camera.position.y = Math.cos(t * 0.03) * 3 * drift
    camera.position.z = jarvisCameraZForHost(hostPx)
    camera.lookAt(0, 0, cloudZ * 0.2)
    renderer.render(scene, camera)
  }

  const tick = (): void => {
    if (disposed) return
    paint()
    if (!reduced) raf = requestAnimationFrame(tick)
  }

  const onHostResize = (): void => {
    if (disposed) return
    hostPx = fit()
    camera.aspect = 1
    camera.position.z = jarvisCameraZForHost(hostPx)
    camera.updateProjectionMatrix()
    mat.size = jarvisPointSizeForHost(currentSize, hostPx)
    electronMat.size = jarvisPointSizeForHost(0.8, hostPx)
  }

  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(onHostResize)
    ro.observe(canvas)
  }

  paint()
  if (!reduced) raf = requestAnimationFrame(tick)
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (!disposed) onHostResize()
    })
  }

  return {
    setState(next) {
      if (isJarvisOrbState(next)) state = next
    },
    setAnalyser(a) {
      analyser = a
      if (a) freqData = new Uint8Array(a.frequencyBinCount)
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      scene.remove(points, lines, electrons)
      geo.dispose()
      lineGeo.dispose()
      electronGeo.dispose()
      mat.dispose()
      lineMat.dispose()
      electronMat.dispose()
      pointSprite.dispose()
      renderer.dispose()
    }
  }
}

/** @deprecated Tony 2026-09-06: persist key may still say obsidian. Use createJarvisOrb. */
export const createJarvisObsidianOrb = createJarvisOrb
