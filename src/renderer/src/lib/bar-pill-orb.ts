/**
 * Sentient particle circle for the Bar minimized rest.
 * Shape: Fit Studio bottom-right orb (fixed sphere). Craft: tonys-jarvis.
 * Bundled WebGL. No CDN. Never flatten.
 */

export const BAR_PILL_SIZE_PX = 52
export const BAR_PILL_WIDTH_PX = BAR_PILL_SIZE_PX
export const BAR_PILL_HEIGHT_PX = BAR_PILL_SIZE_PX

/** Same NDC scale on X and Y so the cloud stays a sphere, not a lozenge. */
export const ORB_NDC_SCALE = 0.78

export const ORB_MOODS = ['idle', 'thinking', 'factcheck', 'connecting'] as const
export type OrbMood = (typeof ORB_MOODS)[number]
export type BarPillOrbMood = OrbMood

export const ORB_COLOR: Record<OrbMood, number> = {
  idle: 0x7f00da,
  thinking: 0x9a2bf0,
  factcheck: 0x4ca8e8,
  connecting: 0x2a0a4a
}

export const JARVIS_ORB_POINTS = 2000
export const JARVIS_ELECTRON_COUNT = 8
/** Fact-check mood only. Rest is Mantu purple. */
export const JARVIS_ORB_COLOR = ORB_COLOR.factcheck

export function isFixedCircle(width: number, height: number): boolean {
  return width === height && width === BAR_PILL_SIZE_PX
}

export function orbBoxForMood(_mood: OrbMood): { width: number; height: number } {
  return { width: BAR_PILL_SIZE_PX, height: BAR_PILL_SIZE_PX }
}

export function orbAspectRatio(width = BAR_PILL_WIDTH_PX, height = BAR_PILL_HEIGHT_PX): number {
  return height === 0 ? 0 : width / height
}

export function resolveOrbMood(input: {
  connecting?: boolean
  factcheck?: boolean
  thinking?: boolean
}): OrbMood {
  if (input.connecting) return 'connecting'
  if (input.factcheck) return 'factcheck'
  if (input.thinking) return 'thinking'
  return 'idle'
}

/** Click expands. A real drag must not. */
export function pillClickShouldExpand(didDrag: boolean): boolean {
  return !didDrag
}

/**
 * Orb rAF is allowed only on a mounted Bar circle (docked idle or minimized rest).
 * Hide, Island, reduced-motion, and a hidden document must not run a frame loop.
 */
export function shouldRunOrbRaf(input: {
  minimized: boolean
  barLayout: boolean
  reducedMotion: boolean
  documentHidden: boolean
}): boolean {
  void input.minimized
  return input.barLayout && !input.reducedMotion && !input.documentHidden
}

export function shouldAnimateOrb(reducedMotion: boolean): boolean {
  return !reducedMotion
}

export function jarvisRgb(color: number): { r: number; g: number; b: number } {
  return { r: ((color >> 16) & 255) / 255, g: ((color >> 8) & 255) / 255, b: (color & 255) / 255 }
}

export function moodTint(mood: OrbMood): { r: number; g: number; b: number } {
  const c = jarvisRgb(ORB_COLOR[mood])
  if (mood === 'factcheck') return { r: c.r * 0.72, g: c.g * 0.82, b: Math.min(1, c.b * 1.05) }
  return c
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
  setMood: (mood: OrbMood) => void
  setHover: (nx: number, ny: number, active: boolean) => void
  setReducedMotion: (reduced: boolean) => void
  destroy: () => void
}

export interface MountBarPillOrbOpts {
  mood?: OrbMood
  reducedMotion?: boolean
}

type MoodParams = { breathAmp: number; speed: number; point: number; line: number; density: number; drift: number; core: number; electron: number }

function moodParams(mood: OrbMood): MoodParams {
  if (mood === 'thinking') return { breathAmp: 0.028, speed: 1.32, point: 0.64, line: 0.24, density: 1.08, drift: 0.022, core: 0.78, electron: 0.7 }
  if (mood === 'factcheck') return { breathAmp: 0.024, speed: 1.05, point: 0.22, line: 0.1, density: 0.92, drift: 0.018, core: 0.9, electron: 0.35 }
  if (mood === 'connecting') return { breathAmp: 0.014, speed: 0.46, point: 0.36, line: 0.1, density: 0.86, drift: 0.008, core: 0.72, electron: 0.28 }
  return { breathAmp: 0.022, speed: 0.8, point: 0.48, line: 0.16, density: 1, drift: 0.016, core: 0.82, electron: 0.55 }
}

/** Fit Studio luminous disc. Same X/Y scale. Lives inside the fixed circle. */
const CORE_VS = `
attribute vec2 aQuad;
uniform float uBreath;
uniform float uLeanX;
uniform float uLeanY;
varying vec2 vUv;
void main() {
  vec2 p = aQuad * 0.84 * uBreath;
  p += vec2(uLeanX, uLeanY) * 0.05;
  gl_Position = vec4(p, 0.0, 1.0);
  vUv = aQuad;
}
`

const CORE_FS = `
precision mediump float;
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float core = exp(-d * d * 2.35);
  gl_FragColor = vec4(uColor, core * uAlpha);
}
`

const POINT_VS = `
attribute vec3 aPos;
attribute float aSeed;
uniform float uTime;
uniform float uBreath;
uniform float uLeanX;
uniform float uLeanY;
uniform float uPointSize;
uniform float uDrift;
uniform float uScale;
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
  gl_Position = vec4(p.x * uScale, p.y * uScale, p.z * 0.16, 1.0);
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
uniform float uScale;
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
  gl_Position = vec4(p.x * uScale, p.y * uScale, p.z * 0.16, 1.0);
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
uniform float uScale;
varying float vAlpha;
void main() {
  float a = aOrbit.z + uTime * aOrbit.y;
  vec3 p = vec3(cos(a) * aOrbit.x, sin(a) * aOrbit.x * cos(aOrbit.w), sin(a) * aOrbit.x * sin(aOrbit.w));
  p.x += uLeanX * 0.14;
  p.y += uLeanY * 0.10;
  p *= uBreath;
  gl_Position = vec4(p.x * uScale, p.y * uScale, p.z * 0.16, 1.0);
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
  uScale: WebGLUniformLocation
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
  uScale: WebGLUniformLocation
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
  uScale: WebGLUniformLocation
  uColor: WebGLUniformLocation
  uAlpha: WebGLUniformLocation
}

type CoreLocs = {
  aQuad: number
  uBreath: WebGLUniformLocation
  uLeanX: WebGLUniformLocation
  uLeanY: WebGLUniformLocation
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
  const uScale = gl.getUniformLocation(p, 'uScale')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uTime || !uBreath || !uLeanX || !uLeanY || !uPointSize || !uDrift || !uScale || !uColor || !uAlpha) return null
  return {
    aPos: gl.getAttribLocation(p, 'aPos'),
    aSeed: gl.getAttribLocation(p, 'aSeed'),
    uTime,
    uBreath,
    uLeanX,
    uLeanY,
    uPointSize,
    uDrift,
    uScale,
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
  const uScale = gl.getUniformLocation(p, 'uScale')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uTime || !uBreath || !uLeanX || !uLeanY || !uDrift || !uScale || !uColor || !uAlpha) return null
  return {
    aPos: gl.getAttribLocation(p, 'aPos'),
    aSeed: gl.getAttribLocation(p, 'aSeed'),
    uTime,
    uBreath,
    uLeanX,
    uLeanY,
    uDrift,
    uScale,
    uColor,
    uAlpha
  }
}

function coreLocs(gl: WebGLRenderingContext, p: WebGLProgram): CoreLocs | null {
  const uBreath = gl.getUniformLocation(p, 'uBreath')
  const uLeanX = gl.getUniformLocation(p, 'uLeanX')
  const uLeanY = gl.getUniformLocation(p, 'uLeanY')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uBreath || !uLeanX || !uLeanY || !uColor || !uAlpha) return null
  return { aQuad: gl.getAttribLocation(p, 'aQuad'), uBreath, uLeanX, uLeanY, uColor, uAlpha }
}

function electronLocs(gl: WebGLRenderingContext, p: WebGLProgram): ElectronLocs | null {
  const uTime = gl.getUniformLocation(p, 'uTime')
  const uBreath = gl.getUniformLocation(p, 'uBreath')
  const uLeanX = gl.getUniformLocation(p, 'uLeanX')
  const uLeanY = gl.getUniformLocation(p, 'uLeanY')
  const uPointSize = gl.getUniformLocation(p, 'uPointSize')
  const uScale = gl.getUniformLocation(p, 'uScale')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uTime || !uBreath || !uLeanX || !uLeanY || !uPointSize || !uScale || !uColor || !uAlpha) return null
  return {
    aOrbit: gl.getAttribLocation(p, 'aOrbit'),
    uTime,
    uBreath,
    uLeanX,
    uLeanY,
    uPointSize,
    uScale,
    uColor,
    uAlpha
  }
}

function packCloud(count: number): { interleaved: Float32Array; lines: Uint16Array } {
  const pos = fibonacciSphere(count)
  const interleaved = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    interleaved[i * 4] = pos[i * 3]
    interleaved[i * 4 + 1] = pos[i * 3 + 1]
    interleaved[i * 4 + 2] = pos[i * 3 + 2]
    interleaved[i * 4 + 3] = (i * 0.61803398875) % 1
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
  canvas.width = Math.round(BAR_PILL_SIZE_PX * dpr)
  canvas.height = Math.round(BAR_PILL_SIZE_PX * dpr)
}

function mountWebGL(gl: WebGLRenderingContext, canvas: HTMLCanvasElement, opts: MountBarPillOrbOpts): BarPillOrbHandle | null {
  const pointProg = program(gl, POINT_VS, POINT_FS)
  const lineProg = program(gl, LINE_VS, LINE_FS)
  const electronProg = program(gl, ELECTRON_VS, POINT_FS)
  const coreProg = program(gl, CORE_VS, CORE_FS)
  if (!pointProg || !lineProg || !electronProg || !coreProg) return null
  const pLoc = pointLocs(gl, pointProg)
  const lLoc = lineLocs(gl, lineProg)
  const eLoc = electronLocs(gl, electronProg)
  const cLoc = coreLocs(gl, coreProg)
  if (!pLoc || !lLoc || !eLoc || !cLoc) return null

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
  const coreBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, coreBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
  gl.disable(gl.DEPTH_TEST)

  let mood: OrbMood = opts.mood ?? 'idle'
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
  const pointPx = canvas.height / 36
  const electronPx = canvas.height / 14
  const stride = 16
  const ndc = ORB_NDC_SCALE

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
    const breath = reduced ? 1 : 1 + Math.sin(elapsed * (mood === 'thinking' ? 2.2 : 1.28)) * params.breathAmp
    leanX += (targetLeanX - leanX) * 0.12
    leanY += (targetLeanY - leanY) * 0.12

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(coreProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, coreBuf)
    gl.enableVertexAttribArray(cLoc.aQuad)
    gl.vertexAttribPointer(cLoc.aQuad, 2, gl.FLOAT, false, 0, 0)
    gl.uniform1f(cLoc.uBreath, breath)
    gl.uniform1f(cLoc.uLeanX, leanX)
    gl.uniform1f(cLoc.uLeanY, leanY)
    gl.uniform3f(cLoc.uColor, tint.r, tint.g, tint.b)
    gl.uniform1f(cLoc.uAlpha, params.core)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
    gl.useProgram(lineProg)
    bindCloud(lLoc.aPos, lLoc.aSeed)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIdx)
    gl.uniform1f(lLoc.uTime, time)
    gl.uniform1f(lLoc.uBreath, breath)
    gl.uniform1f(lLoc.uLeanX, leanX)
    gl.uniform1f(lLoc.uLeanY, leanY)
    gl.uniform1f(lLoc.uDrift, params.drift)
    gl.uniform1f(lLoc.uScale, ndc)
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
    gl.uniform1f(pLoc.uScale, ndc)
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
    gl.uniform1f(eLoc.uScale, ndc)
    gl.uniform3f(eLoc.uColor, tint.r, tint.g, tint.b)
    gl.uniform1f(eLoc.uAlpha, params.electron)
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
      gl.deleteBuffer(coreBuf)
      gl.deleteProgram(pointProg)
      gl.deleteProgram(lineProg)
      gl.deleteProgram(electronProg)
      gl.deleteProgram(coreProg)
    }
  }
}

function mountStill(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, opts: MountBarPillOrbOpts): BarPillOrbHandle {
  let mood: OrbMood = opts.mood ?? 'idle'
  const paint = (): void => {
    sizeOnce(canvas)
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    const tint = moodTint(mood)
    const cx = w * 0.5
    const cy = h * 0.5
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.48)
    glow.addColorStop(0, `rgba(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)},0.72)`)
    glow.addColorStop(0.45, `rgba(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)},0.28)`)
    glow.addColorStop(1, `rgba(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)},0)`)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, w * 0.48, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'lighter'
    const pts = fibonacciSphere(96)
    const color = `rgba(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)},`
    for (let i = 0; i < 96; i++) {
      const x = (pts[i * 3] * ORB_NDC_SCALE + 1) * 0.5 * w
      const y = (1 - (pts[i * 3 + 1] * ORB_NDC_SCALE + 1) * 0.5) * h
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
