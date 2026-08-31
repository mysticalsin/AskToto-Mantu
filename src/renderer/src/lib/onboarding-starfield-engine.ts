/**
 * Layers.ai Starfield Close — WebGL1 bed. Shaders and CONFIG come from
 * onboarding-starfield-spec.ts (docs/design/ONBOARDING-STARFIELD.md).
 * three@0.143.0 is imported from the local package and bundled; never fetched.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DataTexture,
  Float32BufferAttribute,
  Fog,
  Group,
  PerspectiveCamera,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGL1Renderer
} from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js'
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js'
import {
  ACTIVITY_EASE,
  appearOpacity,
  breathScrollTarget,
  CONFIG,
  dampScroll,
  decayBump,
  FINAL_FRAGMENT_SHADER,
  FINAL_VERTEX_SHADER,
  IDLE_MS,
  LAYERS,
  NEXT_BUMP,
  POINTER_LERP,
  REDUCED_MOTION_SCALE,
  STAR_COUNT,
  STAR_DEPTH,
  STARFIELD_FRAGMENT_SHADER,
  STARFIELD_PIXEL_RATIO_CAP,
  STARFIELD_SEED_DT,
  STARFIELD_VERTEX_SHADER
} from './onboarding-starfield-spec'

export interface StarfieldBed {
  nudge: () => void
  dispose: () => void
}

export interface StarfieldBedOptions {
  reducedMotion?: boolean
  now?: () => number
  onFirstFrame?: () => void
}

function viewSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const w = Math.max(1, canvas.clientWidth || canvas.width || window.innerWidth || 1)
  const h = Math.max(1, canvas.clientHeight || canvas.height || window.innerHeight || 1)
  return { w, h }
}

function disposeComposer(composer: EffectComposer): void {
  composer.renderTarget1.dispose()
  composer.renderTarget2.dispose()
  for (const pass of composer.passes) {
    pass.dispose?.()
  }
}

export function createStarfieldBed(
  canvas: HTMLCanvasElement,
  opts: StarfieldBedOptions = {}
): StarfieldBed | null {
  const reducedMotion = opts.reducedMotion === true
  const nowFn = opts.now ?? (() => performance.now())
  canvas.style.opacity = '0'

  let renderer: WebGL1Renderer
  try {
    renderer = new WebGL1Renderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    })
    if (!renderer.getContext()) return null
  } catch {
    return null
  }

  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = VSMShadowMap
  renderer.setClearColor(0x0a0a24, 1)
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  renderer.setPixelRatio(Math.min(dpr, STARFIELD_PIXEL_RATIO_CAP))

  const scene = new Scene()
  scene.background = new Color(CONFIG.bgColor)
  scene.fog = new Fog(0x0a0a24, 0, 15)

  let { w, h } = viewSize(canvas)
  const camera = new PerspectiveCamera(45, w / h, 0.1, 80)
  camera.position.set(0, 0, 5)

  const positions = new Float32Array(STAR_COUNT * 3)
  const scales = new Float32Array(STAR_COUNT)
  const phases = new Float32Array(STAR_COUNT)
  const palettes = new Float32Array(STAR_COUNT)
  const brights = new Float32Array(STAR_COUNT)
  for (let i = 0; i < STAR_COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 24
    positions[i * 3 + 1] = (Math.random() - 0.5) * 16
    positions[i * 3 + 2] = (Math.random() - 0.5) * 30
    palettes[i] = Math.floor(Math.random() * 3)
    brights[i] = 0.7 + Math.random() * 0.6
    scales[i] = 0.5 + Math.pow(Math.random(), 1.4) * 2.5
    phases[i] = Math.random()
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aScale', new Float32BufferAttribute(scales, 1))
  geometry.setAttribute('aPhase', new Float32BufferAttribute(phases, 1))
  geometry.setAttribute('aPalette', new Float32BufferAttribute(palettes, 1))
  geometry.setAttribute('aBright', new Float32BufferAttribute(brights, 1))

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: CONFIG.pointSize },
      uOpacity: { value: appearOpacity(0) },
      uDrift: { value: 0 },
      uDepth: { value: STAR_DEPTH },
      uTwinkle: { value: CONFIG.twinkle },
      uCursor: { value: new Vector3() },
      uRepelRadius: { value: CONFIG.repelRadius },
      uRepelStrength: { value: CONFIG.repelStrength },
      uActivity: { value: 0 },
      uColorA: { value: new Color(CONFIG.colorA) },
      uColorB: { value: new Color(CONFIG.colorB) },
      uColorC: { value: new Color(CONFIG.colorC) },
      uBrightness: { value: CONFIG.brightness }
    },
    vertexShader: STARFIELD_VERTEX_SHADER,
    fragmentShader: STARFIELD_FRAGMENT_SHADER
  })

  const points = new Points(geometry, material)
  points.layers.set(LAYERS.ENTIRE_SCENE)
  const group = new Group()
  group.layers.set(LAYERS.ENTIRE_SCENE)
  group.add(points)
  scene.add(group)

  const haloTexture = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat)
  haloTexture.needsUpdate = true

  const bloomSize = new Vector2(w, h)
  const renderScene = (): RenderPass => new RenderPass(scene, camera)

  const torusComposer = new EffectComposer(renderer)
  torusComposer.renderToScreen = false
  torusComposer.addPass(renderScene())
  torusComposer.addPass(new ShaderPass(GammaCorrectionShader))
  torusComposer.addPass(new UnrealBloomPass(bloomSize, 0.22, 0.2, 0))
  torusComposer.addPass(new ShaderPass(CopyShader))

  const bloomComposer = new EffectComposer(renderer)
  bloomComposer.renderToScreen = false
  bloomComposer.addPass(renderScene())
  bloomComposer.addPass(new UnrealBloomPass(new Vector2(w, h), 0.4, 0.55, 0))
  bloomComposer.addPass(new ShaderPass(GammaCorrectionShader))

  const finalPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      bloomTexture: { value: null },
      torusTexture: { value: null },
      haloTexture: { value: haloTexture },
      iTime: { value: 0 },
      uBg: { value: new Color(CONFIG.bgColor) },
      uFlameA: { value: new Color(CONFIG.flameColor) },
      uFlameB: { value: new Color(CONFIG.flameColor2) },
      uFlameAmt: { value: CONFIG.flameAmt }
    },
    vertexShader: FINAL_VERTEX_SHADER,
    fragmentShader: FINAL_FRAGMENT_SHADER
  })
  const finalComposer = new EffectComposer(renderer)
  finalComposer.addPass(renderScene())
  finalComposer.addPass(finalPass)
  finalPass.uniforms.bloomTexture.value = bloomComposer.renderTarget1.texture
  finalPass.uniforms.torusTexture.value = torusComposer.renderTarget1.texture

  const applySize = (): void => {
    const next = viewSize(canvas)
    w = next.w
    h = next.h
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
    torusComposer.setSize(w, h)
    bloomComposer.setSize(w, h)
    finalComposer.setSize(w, h)
  }
  applySize()

  const ndc = { x: 0, y: 0 }
  const cursorWorld = new Vector3()
  const unprojectScratch = new Vector3()
  const hitScratch = new Vector3()
  let activity = 0
  let lastMove = nowFn()
  let bump = 0
  const seeded = breathScrollTarget(0, reducedMotion)
  let smooth = seeded
  let scroll = seeded
  let raf = 0
  let disposed = false
  let firstFrame = true
  const started = nowFn()
  let lastTick = started

  const onPointerMove = (e: PointerEvent): void => {
    ndc.x = (e.clientX / w) * 2 - 1
    ndc.y = -(e.clientY / h) * 2 + 1
    lastMove = nowFn()
  }

  const onResize = (): void => {
    applySize()
  }

  const tick = (): void => {
    if (disposed) return
    raf = requestAnimationFrame(tick)
    if (typeof document !== 'undefined' && document.hidden) {
      lastTick = nowFn()
      return
    }
    const now = nowFn()
    const rawDt = Math.min(0.05, Math.max(0, (now - lastTick) / 1000))
    const dt = firstFrame ? STARFIELD_SEED_DT : rawDt
    lastTick = now
    const elapsedMs = firstFrame ? 0 : now - started
    const t = firstFrame ? STARFIELD_SEED_DT : elapsedMs / 1000

    bump = decayBump(bump, dt)
    const target = breathScrollTarget(t, reducedMotion) + bump
    const damped = dampScroll(smooth, scroll, target)
    smooth = damped.smooth
    scroll = damped.scroll

    unprojectScratch.set(ndc.x, ndc.y, 0.5).unproject(camera)
    unprojectScratch.sub(camera.position)
    const len = Math.hypot(unprojectScratch.x, unprojectScratch.y, unprojectScratch.z) || 1
    unprojectScratch.x /= len
    unprojectScratch.y /= len
    unprojectScratch.z /= len
    if (Math.abs(unprojectScratch.z) > 1e-6) {
      const dist = -camera.position.z / unprojectScratch.z
      hitScratch.copy(camera.position).add(unprojectScratch.multiplyScalar(dist))
      cursorWorld.lerp(hitScratch, POINTER_LERP)
    }
    const idle = now - lastMove > IDLE_MS
    activity += ((idle ? 0 : 1) - activity) * ACTIVITY_EASE

    const driftBase = reducedMotion ? CONFIG.drift * REDUCED_MOTION_SCALE : CONFIG.drift
    const spinBase = reducedMotion ? CONFIG.spin * REDUCED_MOTION_SCALE : CONFIG.spin
    material.uniforms.uTime.value = t
    material.uniforms.uDrift.value =
      (material.uniforms.uDrift.value as number) + dt * (driftBase + scroll * CONFIG.scrollDrift)
    material.uniforms.uOpacity.value = appearOpacity(elapsedMs)
    material.uniforms.uActivity.value = activity
    ;(material.uniforms.uCursor.value as Vector3).copy(cursorWorld)
    finalPass.uniforms.iTime.value = t

    camera.position.set(ndc.x * CONFIG.parallax, ndc.y * CONFIG.parallax, 5 - scroll * CONFIG.scrollPush)
    camera.lookAt(ndc.x * CONFIG.parallax, ndc.y * CONFIG.parallax, -10)
    group.rotation.z += dt * (spinBase + scroll * CONFIG.scrollSpin)

    camera.layers.set(LAYERS.TORUS_SCENE)
    torusComposer.render()
    camera.layers.set(LAYERS.BLOOM_SCENE)
    bloomComposer.render()
    camera.layers.set(LAYERS.ENTIRE_SCENE)
    finalComposer.render()

    if (firstFrame) {
      firstFrame = false
      canvas.style.opacity = '1'
      opts.onFirstFrame?.()
    }
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('resize', onResize)
  tick()

  return {
    nudge: () => {
      bump += NEXT_BUMP
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('resize', onResize)
      disposeComposer(torusComposer)
      disposeComposer(bloomComposer)
      disposeComposer(finalComposer)
      geometry.dispose()
      material.dispose()
      haloTexture.dispose()
      renderer.dispose()
    }
  }
}
