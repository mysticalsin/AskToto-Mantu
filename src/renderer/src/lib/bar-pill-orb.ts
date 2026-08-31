/**
 * Sentient 52 glass sphere for the Bar rest.
 * Volume: Jarvis ray-sphere + quiet constellation. Idle: #4CA8E8.
 * Bundled WebGL. No CDN. Never flatten. Same sphere when minimized.
 */

export const BAR_PILL_SIZE_PX = 52
export const BAR_PILL_WIDTH_PX = BAR_PILL_SIZE_PX
export const BAR_PILL_HEIGHT_PX = BAR_PILL_SIZE_PX

/** Same NDC scale on X and Y so the cloud stays a sphere, not a lozenge. */
export const ORB_NDC_SCALE = 0.84
/** Perspective divide on Z. Same k on X and Y. Never a flattened disc. */
export const ORB_PERSPECTIVE_K = 0.42
/** Ray-sphere radius in the glass body (fills the 52 box, never a pill). */
export const SPHERE_RADIUS = 0.9
/** Rec-dot on the glass while listening. Do not paint the sphere this color. */
export const REC_DOT_COLOR = 0xf0717a

export const ORB_MOODS = ['idle', 'thinking', 'factcheck', 'connecting'] as const
export type OrbMood = (typeof ORB_MOODS)[number]
export type BarPillOrbMood = OrbMood

export const ORB_COLOR: Record<OrbMood, number> = {
  idle: 0x4ca8e8,
  thinking: 0x6ec4ff,
  factcheck: 0x5ab8f0,
  connecting: 0x2a6a9a
}

/** Jarvis orb.ts speaking lerp. Blue family only. */
export const JARVIS_SPEAKING_COLOR = 0x5ab8f0

/** Sparse shell. 2000 on a 52px sphere is a snow globe. */
export const JARVIS_ORB_POINTS = 96
/** Jarvis thinking spawn cap. Idle draws none. */
export const JARVIS_ELECTRON_MAX = 3
export const JARVIS_ELECTRON_COUNT = JARVIS_ELECTRON_MAX
/** Jarvis idle / rest. */
export const JARVIS_ORB_COLOR = ORB_COLOR.idle

export function electronCountForMood(mood: OrbMood): number {
  return mood === 'thinking' ? JARVIS_ELECTRON_MAX : 0
}

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
  return jarvisRgb(ORB_COLOR[mood])
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
 * that hitch on a dense cloud fails the Performance hat.
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
  setListening: (listening: boolean) => void
  setHover: (nx: number, ny: number, active: boolean) => void
  setReducedMotion: (reduced: boolean) => void
  destroy: () => void
}

export interface MountBarPillOrbOpts {
  mood?: OrbMood
  listening?: boolean
  reducedMotion?: boolean
}

type MoodParams = { breathAmp: number; speed: number; point: number; line: number; density: number; drift: number; core: number; electron: number }

function moodParams(mood: OrbMood, listening = false): MoodParams {
  let p: MoodParams
  if (mood === 'thinking') p = { breathAmp: 0.024, speed: 0.95, point: 0.28, line: 0.12, density: 0.85, drift: 0.014, core: 0.7, electron: 0.55 }
  else if (mood === 'factcheck') p = { breathAmp: 0.02, speed: 0.7, point: 0.2, line: 0.08, density: 0.75, drift: 0.01, core: 0.72, electron: 0 }
  else if (mood === 'connecting') p = { breathAmp: 0.012, speed: 0.4, point: 0.16, line: 0.06, density: 0.7, drift: 0.006, core: 0.64, electron: 0 }
  else p = { breathAmp: 0.018, speed: 0.55, point: 0.18, line: 0.07, density: 0.72, drift: 0.008, core: 0.68, electron: 0 }
  if (listening && mood !== 'connecting') {
    p = { ...p, breathAmp: Math.max(p.breathAmp, 0.022), density: p.density * 1.04, point: Math.min(1, p.point * 1.06) }
  }
  return p
}

/** Ray-sphere glass body. Volume, fresnel, specular kiss, living core. Never a 2D disc. */
const SPHERE_VS = `
attribute vec2 aQuad;
varying vec2 vUv;
void main() {
  vUv = aQuad;
  gl_Position = vec4(aQuad, 0.0, 1.0);
}
`

const SPHERE_FS = `
precision mediump float;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uBreath;
uniform float uLeanX;
uniform float uLeanY;
uniform float uTime;
varying vec2 vUv;

void main() {
  vec3 ro = vec3(uLeanX * 0.14, uLeanY * 0.11, 2.18);
  vec3 rd = normalize(vec3(vUv * 0.94, -1.58));
  float ra = 0.90;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - ra * ra;
  float h = b * b - c;
  if (h < 0.0) discard;
  h = sqrt(h);
  float tHit = -b - h;
  vec3 p = ro + rd * tHit;
  vec3 n = normalize(p);
  vec3 view = -rd;
  vec3 light = normalize(vec3(-0.45 + uLeanX * 0.16, 0.72 + uLeanY * 0.12, 0.85));
  float ndl = max(0.0, dot(n, light));
  float wrap = 0.20 + 0.68 * (ndl * 0.62 + 0.38 * max(0.0, n.z));
  float fresnel = pow(1.0 - max(0.0, dot(n, view)), 2.55);
  vec3 hlf = normalize(light + view);
  float spec = pow(max(0.0, dot(n, hlf)), 52.0);
  float caustic = 0.5 + 0.5 * sin(p.x * 7.1 + uTime * 0.58 + p.z * 3.0) * sin(p.y * 6.3 - uTime * 0.41 + p.x * 2.1);
  float core = exp(-dot(p.xy, p.xy) * 3.2) * uBreath;
  vec3 mood = uColor;
  vec3 col = mix(mood * 0.16, mood, wrap);
  col += mood * core * 0.70;
  col += mood * caustic * 0.10 * (0.40 + core);
  col += vec3(1.0) * spec * 0.92;
  col += mix(mood, vec3(0.93, 0.88, 1.0), 0.52) * fresnel * 0.58;
  float alpha = uAlpha * (0.80 + 0.16 * core + 0.12 * fresnel);
  gl_FragColor = vec4(col, alpha);
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
  float persp = 1.0 / (1.0 - p.z * 0.42);
  gl_Position = vec4(p.x * uScale * persp, p.y * uScale * persp, p.z * 0.35, 1.0);
  float depth = 0.52 + 0.48 * (0.5 + 0.5 * p.z);
  vAlpha = depth;
  gl_PointSize = uPointSize * (0.62 + 0.48 * depth) * persp;
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
  float persp = 1.0 / (1.0 - p.z * 0.42);
  gl_Position = vec4(p.x * uScale * persp, p.y * uScale * persp, p.z * 0.35, 1.0);
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
  float persp = 1.0 / (1.0 - p.z * 0.42);
  gl_Position = vec4(p.x * uScale * persp, p.y * uScale * persp, p.z * 0.35, 1.0);
  vAlpha = 0.92;
  gl_PointSize = uPointSize * persp;
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

type SphereLocs = {
  aQuad: number
  uBreath: WebGLUniformLocation
  uLeanX: WebGLUniformLocation
  uLeanY: WebGLUniformLocation
  uTime: WebGLUniformLocation
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

function sphereLocs(gl: WebGLRenderingContext, p: WebGLProgram): SphereLocs | null {
  const uBreath = gl.getUniformLocation(p, 'uBreath')
  const uLeanX = gl.getUniformLocation(p, 'uLeanX')
  const uLeanY = gl.getUniformLocation(p, 'uLeanY')
  const uTime = gl.getUniformLocation(p, 'uTime')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uBreath || !uLeanX || !uLeanY || !uTime || !uColor || !uAlpha) return null
  return { aQuad: gl.getAttribLocation(p, 'aQuad'), uBreath, uLeanX, uLeanY, uTime, uColor, uAlpha }
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
  const sphereProg = program(gl, SPHERE_VS, SPHERE_FS)
  if (!pointProg || !lineProg || !electronProg || !sphereProg) return null
  const pLoc = pointLocs(gl, pointProg)
  const lLoc = lineLocs(gl, lineProg)
  const eLoc = electronLocs(gl, electronProg)
  const sLoc = sphereLocs(gl, sphereProg)
  if (!pLoc || !lLoc || !eLoc || !sLoc) return null

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
  let listening = !!opts.listening
  let params = moodParams(mood, listening)
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
    gl.useProgram(sphereProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, coreBuf)
    gl.enableVertexAttribArray(sLoc.aQuad)
    gl.vertexAttribPointer(sLoc.aQuad, 2, gl.FLOAT, false, 0, 0)
    gl.uniform1f(sLoc.uBreath, breath)
    gl.uniform1f(sLoc.uLeanX, leanX)
    gl.uniform1f(sLoc.uLeanY, leanY)
    gl.uniform1f(sLoc.uTime, time)
    gl.uniform3f(sLoc.uColor, tint.r, tint.g, tint.b)
    gl.uniform1f(sLoc.uAlpha, params.core)
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

    const electrons = electronCountForMood(mood)
    if (electrons > 0) {
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
      gl.drawArrays(gl.POINTS, 0, electrons)
    }
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
      params = moodParams(next, listening)
      tint = moodTint(next)
      if (!loopWanted()) paint(t0)
    },
    setListening(next) {
      listening = next
      params = moodParams(mood, listening)
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
      gl.deleteProgram(sphereProg)
    }
  }
}

function emptyHandle(): BarPillOrbHandle {
  return { setMood() {}, setListening() {}, setHover() {}, setReducedMotion() {}, destroy() {} }
}

/** Reduced-motion / no-GL still frame: shaded sphere, not a single radial blob. */
function mountStill(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, opts: MountBarPillOrbOpts): BarPillOrbHandle {
  let mood: OrbMood = opts.mood ?? 'idle'
  const paint = (): void => {
    sizeOnce(canvas)
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    const tint = moodTint(mood)
    const r = Math.round(tint.r * 255)
    const g = Math.round(tint.g * 255)
    const b = Math.round(tint.b * 255)
    const cx = w * 0.5
    const cy = h * 0.5
    const rad = w * 0.45
    const body = ctx.createRadialGradient(cx - rad * 0.22, cy - rad * 0.28, rad * 0.08, cx, cy + rad * 0.12, rad)
    body.addColorStop(0, `rgba(${Math.min(255, r + 70)},${Math.min(255, g + 40)},${Math.min(255, b + 40)},0.92)`)
    body.addColorStop(0.42, `rgba(${r},${g},${b},0.78)`)
    body.addColorStop(0.78, `rgba(${Math.round(r * 0.35)},${Math.round(g * 0.22)},${Math.round(b * 0.45)},0.62)`)
    body.addColorStop(1, `rgba(${r},${g},${b},0)`)
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, rad, 0, Math.PI * 2)
    ctx.fill()
    const kiss = ctx.createRadialGradient(cx - rad * 0.28, cy - rad * 0.34, 0, cx - rad * 0.28, cy - rad * 0.34, rad * 0.28)
    kiss.addColorStop(0, 'rgba(255,255,255,0.72)')
    kiss.addColorStop(0.45, `rgba(${r},${g},${b},0.18)`)
    kiss.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = kiss
    ctx.beginPath()
    ctx.arc(cx - rad * 0.28, cy - rad * 0.34, rad * 0.28, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = `rgba(${Math.min(255, r + 80)},${Math.min(255, g + 50)},${Math.min(255, b + 60)},0.42)`
    ctx.lineWidth = Math.max(1, w / 52)
    ctx.beginPath()
    ctx.arc(cx, cy, rad * 0.96, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalCompositeOperation = 'lighter'
    const pts = fibonacciSphere(96)
    const color = `rgba(${r},${g},${b},`
    for (let i = 0; i < 96; i++) {
      const z = pts[i * 3 + 2]
      const persp = 1 / (1 - z * ORB_PERSPECTIVE_K)
      const x = (pts[i * 3] * ORB_NDC_SCALE * persp + 1) * 0.5 * w
      const y = (1 - (pts[i * 3 + 1] * ORB_NDC_SCALE * persp + 1) * 0.5) * h
      const a = 0.16 + 0.38 * (0.5 + 0.5 * z)
      ctx.fillStyle = `${color}${a})`
      ctx.beginPath()
      ctx.arc(x, y, Math.max(0.8, (h / 90) * persp), 0, Math.PI * 2)
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
    setListening() {},
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
    if (gl) return mountWebGL(gl, canvas, opts) ?? emptyHandle()
    const ctx = canvas.getContext('2d')
    if (ctx) return mountStill(ctx, canvas, opts)
  } catch {
    // Missing GL / 2D in tests must not throw.
  }
  return emptyHandle()
}
