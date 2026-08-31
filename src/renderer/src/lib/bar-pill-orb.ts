/**
 * Jarvis-look particle orb for the Bar minimized pill.
 * Look from mysticalsin/tonys-jarvis (2000 points, 0x4ca8e8, additive,
 * connections, electrons, idle drift). Bundled WebGL. No CDN.
 */

export const JARVIS_ORB_COLOR = 0x4ca8e8
export const JARVIS_ORB_POINTS = 2000
export const JARVIS_ELECTRON_COUNT = 8
export const BAR_PILL_WIDTH_PX = 144
export const BAR_PILL_HEIGHT_PX = 52

export type BarPillOrbMood = 'idle' | 'listening' | 'paused' | 'degraded'

export function moodFromListen(listening: boolean, paused: boolean, degraded: boolean): BarPillOrbMood {
  if (!listening) return 'idle'
  if (paused) return 'paused'
  if (degraded) return 'degraded'
  return 'listening'
}

/** Click expands. A real drag must not. */
export function pillClickShouldExpand(didDrag: boolean): boolean {
  return !didDrag
}

/**
 * Orb rAF is allowed only on the mounted Bar pill. Idle full bar, Hide, Island,
 * reduced-motion, and a hidden document must not run a frame loop.
 */
export function shouldRunOrbRaf(input: {
  minimized: boolean
  barLayout: boolean
  reducedMotion: boolean
  documentHidden: boolean
}): boolean {
  return input.minimized && input.barLayout && !input.reducedMotion && !input.documentHidden
}

export function shouldAnimateOrb(reducedMotion: boolean): boolean {
  return !reducedMotion
}

export function jarvisRgb(color = JARVIS_ORB_COLOR): { r: number; g: number; b: number } {
  return { r: ((color >> 16) & 255) / 255, g: ((color >> 8) & 255) / 255, b: (color & 255) / 255 }
}

export function moodTint(mood: BarPillOrbMood): { r: number; g: number; b: number } {
  const base = jarvisRgb()
  if (mood === 'degraded') return { r: 0.98, g: 0.78, b: 0.46 }
  if (mood === 'paused') return { r: base.r * 0.72, g: base.g * 0.72, b: base.b * 0.78 }
  return base
}

/** Fibonacci sphere. Deterministic so reduced-motion still frames match across mounts. */
export function fibonacciSphere(count: number): Float32Array {
  const out = new Float32Array(count * 3)
  const phi = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2
    const radius = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = phi * i
    out[i * 3] = Math.cos(theta) * radius
    out[i * 3 + 1] = y
    out[i * 3 + 2] = Math.sin(theta) * radius
  }
  return out
}

/** Stretch a unit sphere into a capsule so the cloud reads as a pill, not a ball. */
export function fibonacciCapsule(count: number, aspect = 2.28): Float32Array {
  const out = fibonacciSphere(count)
  for (let i = 0; i < count; i++) {
    out[i * 3] *= aspect
    out[i * 3 + 1] *= 0.9
  }
  return out
}

/**
 * O(n) constellation chords (ring + two skips). Never an n² neighbor scan —
 * that hitch on 2000 points fails the Performance hat.
 */
export function connectionIndices(count: number, chords: readonly number[] = [1, 11, 29]): Uint16Array {
  const pairs = new Uint16Array(count * chords.length * 2)
  let w = 0
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < chords.length; c++) {
      pairs[w++] = i
      pairs[w++] = (i + chords[c]) % count
    }
  }
  return pairs
}

export interface BarPillOrbHandle {
  setMood: (mood: BarPillOrbMood) => void
  setHover: (nx: number, ny: number, active: boolean) => void
  setReducedMotion: (reduced: boolean) => void
  destroy: () => void
}

export interface MountBarPillOrbOpts {
  mood?: BarPillOrbMood
  reducedMotion?: boolean
}

type MoodParams = { breathAmp: number; speed: number; point: number; line: number; density: number; drift: number }

function moodParams(mood: BarPillOrbMood): MoodParams {
  if (mood === 'listening') return { breathAmp: 0.05, speed: 1.5, point: 0.94, line: 0.4, density: 1.22, drift: 0.028 }
  if (mood === 'paused') return { breathAmp: 0.016, speed: 0.5, point: 0.52, line: 0.14, density: 0.82, drift: 0.008 }
  if (mood === 'degraded') return { breathAmp: 0.038, speed: 1.12, point: 0.8, line: 0.26, density: 1.04, drift: 0.02 }
  return { breathAmp: 0.026, speed: 0.82, point: 0.7, line: 0.2, density: 1, drift: 0.018 }
}

const POINT_VS = `
attribute vec3 aPos;
attribute float aSeed;
uniform float uTime;
uniform float uBreath;
uniform float uLeanX;
uniform float uLeanY;
uniform float uPointSize;
uniform float uDrift;
varying float vAlpha;
void main() {
  float ca = cos(uTime * 0.16);
  float sa = sin(uTime * 0.16);
  vec3 p = vec3(aPos.x * ca - aPos.z * sa, aPos.y, aPos.x * sa + aPos.z * ca);
  float s = aSeed * 6.2831853;
  p += vec3(sin(uTime * 0.63 + s) * uDrift, cos(uTime * 0.47 + s * 1.7) * uDrift * 0.72, sin(uTime * 0.39 + s * 0.6) * uDrift);
  p.x += uLeanX * (0.16 + p.z * 0.10);
  p.y += uLeanY * (0.12 + p.z * 0.07);
  p *= uBreath;
  gl_Position = vec4(p.x * 0.42, p.y * 0.88, p.z * 0.14, 1.0);
  float depth = 0.52 + 0.48 * (0.5 + 0.5 * p.z);
  vAlpha = depth;
  gl_PointSize = uPointSize * (0.62 + 0.48 * depth);
}
`

const POINT_FS = `
precision mediump float;
uniform vec3 uColor;
uniform float uAlpha;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float glow = exp(-d * 2.9);
  gl_FragColor = vec4(uColor, uAlpha * vAlpha * glow);
}
`

const LINE_VS = `
attribute vec3 aPos;
attribute float aSeed;
uniform float uTime;
uniform float uBreath;
uniform float uLeanX;
uniform float uLeanY;
uniform float uDrift;
varying float vAlpha;
void main() {
  float ca = cos(uTime * 0.16);
  float sa = sin(uTime * 0.16);
  vec3 p = vec3(aPos.x * ca - aPos.z * sa, aPos.y, aPos.x * sa + aPos.z * ca);
  float s = aSeed * 6.2831853;
  p += vec3(sin(uTime * 0.63 + s) * uDrift, cos(uTime * 0.47 + s * 1.7) * uDrift * 0.72, sin(uTime * 0.39 + s * 0.6) * uDrift);
  p.x += uLeanX * (0.16 + p.z * 0.10);
  p.y += uLeanY * (0.12 + p.z * 0.07);
  p *= uBreath;
  gl_Position = vec4(p.x * 0.42, p.y * 0.88, p.z * 0.14, 1.0);
  vAlpha = 0.32 + 0.4 * (0.5 + 0.5 * p.z);
}
`

const LINE_FS = `
precision mediump float;
uniform vec3 uColor;
uniform float uAlpha;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, uAlpha * vAlpha);
}
`

const ELECTRON_VS = `
attribute vec4 aOrbit;
uniform float uTime;
uniform float uBreath;
uniform float uLeanX;
uniform float uLeanY;
uniform float uPointSize;
varying float vAlpha;
void main() {
  float a = aOrbit.z + uTime * aOrbit.y;
  vec3 p = vec3(cos(a) * aOrbit.x, sin(a) * aOrbit.x * cos(aOrbit.w), sin(a) * aOrbit.x * sin(aOrbit.w));
  p.x += uLeanX * 0.14;
  p.y += uLeanY * 0.10;
  p *= uBreath;
  gl_Position = vec4(p.x * 0.42, p.y * 0.88, p.z * 0.14, 1.0);
  vAlpha = 0.92;
  gl_PointSize = uPointSize;
}
`

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

function program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram | null {
  const v = compile(gl, gl.VERTEX_SHADER, vs)
  const f = compile(gl, gl.FRAGMENT_SHADER, fs)
  if (!v || !f) return null
  const p = gl.createProgram()
  if (!p) return null
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    gl.deleteProgram(p)
    return null
  }
  return p
}

type PointLocs = {
  aPos: number
  aSeed: number
  uTime: WebGLUniformLocation
  uBreath: WebGLUniformLocation
  uLeanX: WebGLUniformLocation
  uLeanY: WebGLUniformLocation
  uPointSize: WebGLUniformLocation
  uDrift: WebGLUniformLocation
  uColor: WebGLUniformLocation
  uAlpha: WebGLUniformLocation
}

type LineLocs = {
  aPos: number
  aSeed: number
  uTime: WebGLUniformLocation
  uBreath: WebGLUniformLocation
  uLeanX: WebGLUniformLocation
  uLeanY: WebGLUniformLocation
  uDrift: WebGLUniformLocation
  uColor: WebGLUniformLocation
  uAlpha: WebGLUniformLocation
}

type ElectronLocs = {
  aOrbit: number
  uTime: WebGLUniformLocation
  uBreath: WebGLUniformLocation
  uLeanX: WebGLUniformLocation
  uLeanY: WebGLUniformLocation
  uPointSize: WebGLUniformLocation
  uColor: WebGLUniformLocation
  uAlpha: WebGLUniformLocation
}

function pointLocs(gl: WebGLRenderingContext, p: WebGLProgram): PointLocs | null {
  const uTime = gl.getUniformLocation(p, 'uTime')
  const uBreath = gl.getUniformLocation(p, 'uBreath')
  const uLeanX = gl.getUniformLocation(p, 'uLeanX')
  const uLeanY = gl.getUniformLocation(p, 'uLeanY')
  const uPointSize = gl.getUniformLocation(p, 'uPointSize')
  const uDrift = gl.getUniformLocation(p, 'uDrift')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uTime || !uBreath || !uLeanX || !uLeanY || !uPointSize || !uDrift || !uColor || !uAlpha) return null
  return {
    aPos: gl.getAttribLocation(p, 'aPos'),
    aSeed: gl.getAttribLocation(p, 'aSeed'),
    uTime,
    uBreath,
    uLeanX,
    uLeanY,
    uPointSize,
    uDrift,
    uColor,
    uAlpha
  }
}

function lineLocs(gl: WebGLRenderingContext, p: WebGLProgram): LineLocs | null {
  const uTime = gl.getUniformLocation(p, 'uTime')
  const uBreath = gl.getUniformLocation(p, 'uBreath')
  const uLeanX = gl.getUniformLocation(p, 'uLeanX')
  const uLeanY = gl.getUniformLocation(p, 'uLeanY')
  const uDrift = gl.getUniformLocation(p, 'uDrift')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uTime || !uBreath || !uLeanX || !uLeanY || !uDrift || !uColor || !uAlpha) return null
  return {
    aPos: gl.getAttribLocation(p, 'aPos'),
    aSeed: gl.getAttribLocation(p, 'aSeed'),
    uTime,
    uBreath,
    uLeanX,
    uLeanY,
    uDrift,
    uColor,
    uAlpha
  }
}

function electronLocs(gl: WebGLRenderingContext, p: WebGLProgram): ElectronLocs | null {
  const uTime = gl.getUniformLocation(p, 'uTime')
  const uBreath = gl.getUniformLocation(p, 'uBreath')
  const uLeanX = gl.getUniformLocation(p, 'uLeanX')
  const uLeanY = gl.getUniformLocation(p, 'uLeanY')
  const uPointSize = gl.getUniformLocation(p, 'uPointSize')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uTime || !uBreath || !uLeanX || !uLeanY || !uPointSize || !uColor || !uAlpha) return null
  return {
    aOrbit: gl.getAttribLocation(p, 'aOrbit'),
    uTime,
    uBreath,
    uLeanX,
    uLeanY,
    uPointSize,
    uColor,
    uAlpha
  }
}

function packCloud(count: number): { interleaved: Float32Array; lines: Uint16Array } {
  const pos = fibonacciCapsule(count)
  const interleaved = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    interleaved[i * 4] = pos[i * 3]
    interleaved[i * 4 + 1] = pos[i * 3 + 1]
    interleaved[i * 4 + 2] = pos[i * 3 + 2]
    interleaved[i * 4 + 3] = ((i * 0.61803398875) % 1)
  }
  return { interleaved, lines: connectionIndices(count) }
}

function electronOrbits(): Float32Array {
  const out = new Float32Array(JARVIS_ELECTRON_COUNT * 4)
  for (let i = 0; i < JARVIS_ELECTRON_COUNT; i++) {
    out[i * 4] = 0.72 + (i % 3) * 0.09
    out[i * 4 + 1] = 0.52 + (i % 4) * 0.16
    out[i * 4 + 2] = (i / JARVIS_ELECTRON_COUNT) * Math.PI * 2
    out[i * 4 + 3] = (i * 0.71) % 1.25
  }
  return out
}

function sizeOnce(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
  canvas.width = Math.round(BAR_PILL_WIDTH_PX * dpr)
  canvas.height = Math.round(BAR_PILL_HEIGHT_PX * dpr)
}

function mountWebGL(gl: WebGLRenderingContext, canvas: HTMLCanvasElement, opts: MountBarPillOrbOpts): BarPillOrbHandle | null {
  const pointProg = program(gl, POINT_VS, POINT_FS)
  const lineProg = program(gl, LINE_VS, LINE_FS)
  const electronProg = program(gl, ELECTRON_VS, POINT_FS)
  if (!pointProg || !lineProg || !electronProg) return null
  const pLoc = pointLocs(gl, pointProg)
  const lLoc = lineLocs(gl, lineProg)
  const eLoc = electronLocs(gl, electronProg)
  if (!pLoc || !lLoc || !eLoc) return null

  sizeOnce(canvas)
  gl.viewport(0, 0, canvas.width, canvas.height)

  const cloud = packCloud(JARVIS_ORB_POINTS)
  const cloudBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuf)
  gl.bufferData(gl.ARRAY_BUFFER, cloud.interleaved, gl.STATIC_DRAW)
  const lineIdx = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIdx)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cloud.lines, gl.STATIC_DRAW)
  const electronBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, electronBuf)
  gl.bufferData(gl.ARRAY_BUFFER, electronOrbits(), gl.STATIC_DRAW)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
  gl.disable(gl.DEPTH_TEST)

  let mood: BarPillOrbMood = opts.mood ?? 'idle'
  let params = moodParams(mood)
  let tint = moodTint(mood)
  let reduced = !!opts.reducedMotion
  let leanX = 0
  let leanY = 0
  let targetLeanX = 0
  let targetLeanY = 0
  let raf = 0
  let alive = true
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0
  const pointPx = canvas.height / 40
  const electronPx = canvas.height / 15
  const stride = 16

  const bindCloud = (pos: number, seed: number): void => {
    gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuf)
    gl.enableVertexAttribArray(pos)
    gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, stride, 0)
    if (seed >= 0) {
      gl.enableVertexAttribArray(seed)
      gl.vertexAttribPointer(seed, 1, gl.FLOAT, false, stride, 12)
    }
  }

  // Frame loop: uniforms from cached locations only. No layout reads. No get*Location.
  const paint = (now: number): void => {
    if (!alive) return
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const elapsed = (now - t0) / 1000
    const time = reduced ? 0.4 : elapsed * params.speed
    const pulse = mood === 'listening' && !reduced ? 1 + Math.sin(elapsed * 3.1) * 0.06 : 1
    const breath = reduced ? 1 : (1 + Math.sin(elapsed * (mood === 'listening' ? 2.35 : 1.32)) * params.breathAmp) * pulse
    leanX += (targetLeanX - leanX) * 0.12
    leanY += (targetLeanY - leanY) * 0.12

    gl.useProgram(lineProg)
    bindCloud(lLoc.aPos, lLoc.aSeed)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIdx)
    gl.uniform1f(lLoc.uTime, time)
    gl.uniform1f(lLoc.uBreath, breath)
    gl.uniform1f(lLoc.uLeanX, leanX)
    gl.uniform1f(lLoc.uLeanY, leanY)
    gl.uniform1f(lLoc.uDrift, params.drift)
    gl.uniform3f(lLoc.uColor, tint.r, tint.g, tint.b)
    gl.uniform1f(lLoc.uAlpha, params.line)
    gl.drawElements(gl.LINES, cloud.lines.length, gl.UNSIGNED_SHORT, 0)

    gl.useProgram(pointProg)
    bindCloud(pLoc.aPos, pLoc.aSeed)
    gl.uniform1f(pLoc.uTime, time)
    gl.uniform1f(pLoc.uBreath, breath)
    gl.uniform1f(pLoc.uLeanX, leanX)
    gl.uniform1f(pLoc.uLeanY, leanY)
    gl.uniform1f(pLoc.uPointSize, pointPx * params.density)
    gl.uniform1f(pLoc.uDrift, params.drift)
    gl.uniform3f(pLoc.uColor, tint.r, tint.g, tint.b)
    gl.uniform1f(pLoc.uAlpha, params.point)
    gl.drawArrays(gl.POINTS, 0, JARVIS_ORB_POINTS)

    gl.useProgram(electronProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, electronBuf)
    gl.enableVertexAttribArray(eLoc.aOrbit)
    gl.vertexAttribPointer(eLoc.aOrbit, 4, gl.FLOAT, false, 0, 0)
    gl.uniform1f(eLoc.uTime, time)
    gl.uniform1f(eLoc.uBreath, breath)
    gl.uniform1f(eLoc.uLeanX, leanX)
    gl.uniform1f(eLoc.uLeanY, leanY)
    gl.uniform1f(eLoc.uPointSize, electronPx * params.density)
    gl.uniform3f(eLoc.uColor, tint.r, tint.g, tint.b)
    gl.uniform1f(eLoc.uAlpha, 0.95)
    gl.drawArrays(gl.POINTS, 0, JARVIS_ELECTRON_COUNT)
  }

  const loopWanted = (): boolean =>
    shouldRunOrbRaf({
      minimized: true,
      barLayout: true,
      reducedMotion: reduced,
      documentHidden: typeof document !== 'undefined' && document.hidden
    })

  const tick = (now: number): void => {
    paint(now)
    raf = 0
    if (alive && loopWanted()) raf = requestAnimationFrame(tick)
  }

  const arm = (): void => {
    if (raf || !alive || !loopWanted()) return
    raf = requestAnimationFrame(tick)
  }

  const onVis = (): void => {
    if (!loopWanted()) {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      return
    }
    arm()
  }

  paint(t0)
  arm()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)

  return {
    setMood(next) {
      mood = next
      params = moodParams(next)
      tint = moodTint(next)
      if (!loopWanted()) paint(t0)
    },
    setHover(nx, ny, active) {
      targetLeanX = active ? Math.max(-1, Math.min(1, nx)) * 0.5 : 0
      targetLeanY = active ? Math.max(-1, Math.min(1, ny)) * -0.4 : 0
    },
    setReducedMotion(next) {
      reduced = next
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      paint(t0)
      arm()
    },
    destroy() {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
      gl.deleteBuffer(cloudBuf)
      gl.deleteBuffer(lineIdx)
      gl.deleteBuffer(electronBuf)
      gl.deleteProgram(pointProg)
      gl.deleteProgram(lineProg)
      gl.deleteProgram(electronProg)
    }
  }
}

function mountStill(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, opts: MountBarPillOrbOpts): BarPillOrbHandle {
  let mood: BarPillOrbMood = opts.mood ?? 'idle'
  const paint = (): void => {
    sizeOnce(canvas)
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'lighter'
    const tint = moodTint(mood)
    const pts = fibonacciCapsule(96)
    const color = `rgba(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)},`
    for (let i = 0; i < 96; i++) {
      const x = (pts[i * 3] * 0.42 + 1) * 0.5 * w
      const y = (1 - (pts[i * 3 + 1] * 0.88 + 1) * 0.5) * h
      const z = pts[i * 3 + 2]
      const a = 0.18 + 0.35 * (0.5 + 0.5 * z)
      ctx.fillStyle = `${color}${a})`
      ctx.beginPath()
      ctx.arc(x, y, Math.max(0.8, h / 90), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  paint()
  return {
    setMood(next) {
      mood = next
      paint()
    },
    setHover() {},
    setReducedMotion() {
      paint()
    },
    destroy() {}
  }
}

export function mountBarPillOrb(canvas: HTMLCanvasElement, opts: MountBarPillOrbOpts = {}): BarPillOrbHandle {
  try {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true })
    if (gl) return mountWebGL(gl, canvas, opts) ?? { setMood() {}, setHover() {}, setReducedMotion() {}, destroy() {} }
    const ctx = canvas.getContext('2d')
    if (ctx) return mountStill(ctx, canvas, opts)
  } catch {
    // Missing GL / 2D in tests must not throw.
  }
  return { setMood() {}, setHover() {}, setReducedMotion() {}, destroy() {} }
}
