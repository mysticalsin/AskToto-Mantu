/**
 * Sentient 52 Fit Studio glass sphere for the Bar rest.
 * Volume: ray-sphere, volumetric core, one specular kiss, soft bloom.
 * Idle: #b266e9 / #e15cff / #8a00f8. No particle constellation.
 * Bundled WebGL. No CDN. No Spline. Never flatten. Same sphere when minimized.
 */

export const BAR_PILL_SIZE_PX = 52
export const BAR_PILL_WIDTH_PX = BAR_PILL_SIZE_PX
export const BAR_PILL_HEIGHT_PX = BAR_PILL_SIZE_PX

/** Ray-sphere radius in the glass body (fills the 52 box, never a pill). */
export const SPHERE_RADIUS = 0.9
/** Rec-dot on the glass while listening. Do not paint the sphere this color. */
export const REC_DOT_COLOR = 0xf0717a

/** Fit Studio energy-glass stops (the sphere behind the robot). */
export const FIT_STUDIO_HOT = 0xe15cff
export const FIT_STUDIO_MID = 0xb266e9
export const FIT_STUDIO_DEEP = 0x8a00f8

export const ORB_MOODS = ['idle', 'thinking', 'factcheck', 'connecting'] as const
export type OrbMood = (typeof ORB_MOODS)[number]
export type BarPillOrbMood = OrbMood

export const ORB_COLOR: Record<OrbMood, number> = {
  idle: FIT_STUDIO_MID,
  thinking: FIT_STUDIO_HOT,
  factcheck: 0x5ab8f0,
  connecting: FIT_STUDIO_DEEP
}

export const ORB_HOT: Record<OrbMood, number> = {
  idle: FIT_STUDIO_HOT,
  thinking: 0xf0a0ff,
  factcheck: 0x8ad4ff,
  connecting: FIT_STUDIO_MID
}

export const ORB_DEEP: Record<OrbMood, number> = {
  idle: FIT_STUDIO_DEEP,
  thinking: FIT_STUDIO_MID,
  factcheck: 0x3a88c8,
  connecting: 0x5a00a8
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

export function hexRgb(color: number): { r: number; g: number; b: number } {
  return { r: ((color >> 16) & 255) / 255, g: ((color >> 8) & 255) / 255, b: (color & 255) / 255 }
}

export function moodTint(mood: OrbMood): { r: number; g: number; b: number } {
  return hexRgb(ORB_COLOR[mood])
}

export function moodGlass(mood: OrbMood): {
  mid: { r: number; g: number; b: number }
  hot: { r: number; g: number; b: number }
  deep: { r: number; g: number; b: number }
} {
  return { mid: hexRgb(ORB_COLOR[mood]), hot: hexRgb(ORB_HOT[mood]), deep: hexRgb(ORB_DEEP[mood]) }
}

export function isPurpleFamilyIdle(color = ORB_COLOR.idle): boolean {
  const t = hexRgb(color)
  return color === FIT_STUDIO_MID && t.r > 0.55 && t.b > 0.7 && t.g < t.r && color !== 0x4ca8e8
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

type MoodParams = { breathAmp: number; speed: number; density: number; core: number }

function moodParams(mood: OrbMood, listening = false): MoodParams {
  let p: MoodParams
  if (mood === 'thinking') p = { breathAmp: 0.024, speed: 0.95, density: 0.78, core: 0.86 }
  else if (mood === 'factcheck') p = { breathAmp: 0.02, speed: 0.7, density: 0.68, core: 0.8 }
  else if (mood === 'connecting') p = { breathAmp: 0.012, speed: 0.4, density: 0.62, core: 0.72 }
  else p = { breathAmp: 0.018, speed: 0.55, density: 0.62, core: 0.82 }
  if (listening && mood !== 'connecting') {
    p = { ...p, breathAmp: Math.max(p.breathAmp, 0.022), density: p.density * 1.04, core: Math.min(1, p.core * 1.04) }
  }
  return p
}

/** Ray-sphere glass body. Volume, fresnel, specular kiss, living core, soft bloom. Never a 2D disc. */
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
uniform vec3 uHot;
uniform vec3 uDeep;
uniform float uAlpha;
uniform float uBreath;
uniform float uLeanX;
uniform float uLeanY;
uniform float uTime;
varying vec2 vUv;

void main() {
  vec3 ro = vec3(uLeanX * 0.10, uLeanY * 0.08, 2.20);
  vec3 rd = normalize(vec3(vUv * 0.94, -1.58));
  float ra = 0.90;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - ra * ra;
  float h = b * b - c;
  float r2 = dot(vUv, vUv);
  float ang = atan(vUv.y, vUv.x);
  float rays = pow(max(0.0, sin(ang * 3.0 + 0.35)), 22.0);
  rays += pow(max(0.0, sin(ang * 3.0 + 1.40)), 26.0) * 0.62;
  float flare = rays * exp(-r2 * 1.65) * 0.34;
  if (h < 0.0) {
    float bloom = exp(h * 6.2);
    float halo = bloom * 0.78 + flare * 0.95;
    if (halo < 0.014) discard;
    gl_FragColor = vec4(mix(uDeep, uHot, 0.38 + flare), halo * uAlpha);
    return;
  }
  h = sqrt(h);
  float tHit = -b - h;
  float tExit = -b + h;
  vec3 p = ro + rd * tHit;
  vec3 n = normalize(p);
  vec3 view = -rd;
  vec3 light = normalize(vec3(-0.38 + uLeanX * 0.12, 0.52 + uLeanY * 0.10, 0.80));
  float thickness = max(0.0, tExit - tHit);
  float vol = 1.0 - exp(-thickness * 1.12);
  float ndl = max(0.0, dot(n, light));
  float wrap = 0.46 + 0.50 * (ndl * 0.48 + 0.52 * max(0.0, n.z));
  float fresnel = pow(1.0 - max(0.0, dot(n, view)), 2.55);
  vec3 hlf = normalize(light + view);
  float spec = pow(max(0.0, dot(n, hlf)), 64.0);
  float kiss = pow(max(0.0, dot(n, hlf)), 180.0);
  float caustic = 0.5 + 0.5 * sin(p.x * 4.2 + uTime * 0.28 + p.z * 1.8) * sin(p.y * 3.4 - uTime * 0.18 + p.x * 1.2);
  float core = exp(-dot(p.xy, p.xy) * 1.85) * uBreath;
  vec3 col = mix(uDeep * 1.08, uColor * 1.14, wrap * 0.50 + vol * 0.42);
  col = mix(col, uHot * 1.12, core * 0.86 + wrap * wrap * 0.12);
  col += uHot * core * 0.58;
  col += uColor * caustic * 0.03 * core;
  col += vec3(1.0, 1.0, 1.0) * spec * 0.58;
  col += vec3(1.0, 1.0, 1.0) * kiss * 0.52;
  col += mix(uHot, vec3(1.0, 0.92, 1.0), 0.28) * fresnel * 0.18;
  col += uHot * flare * 0.48;
  float alpha = uAlpha * (0.58 + 0.28 * vol + 0.22 * core + 0.06 * fresnel);
  gl_FragColor = vec4(col, min(1.0, alpha));
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

type SphereLocs = {
  aQuad: number
  uBreath: WebGLUniformLocation
  uLeanX: WebGLUniformLocation
  uLeanY: WebGLUniformLocation
  uTime: WebGLUniformLocation
  uColor: WebGLUniformLocation
  uHot: WebGLUniformLocation
  uDeep: WebGLUniformLocation
  uAlpha: WebGLUniformLocation
}

function sphereLocs(gl: WebGLRenderingContext, p: WebGLProgram): SphereLocs | null {
  const uBreath = gl.getUniformLocation(p, 'uBreath')
  const uLeanX = gl.getUniformLocation(p, 'uLeanX')
  const uLeanY = gl.getUniformLocation(p, 'uLeanY')
  const uTime = gl.getUniformLocation(p, 'uTime')
  const uColor = gl.getUniformLocation(p, 'uColor')
  const uHot = gl.getUniformLocation(p, 'uHot')
  const uDeep = gl.getUniformLocation(p, 'uDeep')
  const uAlpha = gl.getUniformLocation(p, 'uAlpha')
  if (!uBreath || !uLeanX || !uLeanY || !uTime || !uColor || !uHot || !uDeep || !uAlpha) return null
  return { aQuad: gl.getAttribLocation(p, 'aQuad'), uBreath, uLeanX, uLeanY, uTime, uColor, uHot, uDeep, uAlpha }
}

function sizeOnce(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
  canvas.width = Math.round(BAR_PILL_SIZE_PX * dpr)
  canvas.height = Math.round(BAR_PILL_SIZE_PX * dpr)
}

function mountWebGL(gl: WebGLRenderingContext, canvas: HTMLCanvasElement, opts: MountBarPillOrbOpts): BarPillOrbHandle | null {
  const sphereProg = program(gl, SPHERE_VS, SPHERE_FS)
  if (!sphereProg) return null
  const sLoc = sphereLocs(gl, sphereProg)
  if (!sLoc) return null

  sizeOnce(canvas)
  gl.viewport(0, 0, canvas.width, canvas.height)

  // One quad. No particle buffers. Never an n² neighbor scan.
  const coreBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, coreBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.disable(gl.DEPTH_TEST)

  let mood: OrbMood = opts.mood ?? 'idle'
  let listening = !!opts.listening
  let params = moodParams(mood, listening)
  let glass = moodGlass(mood)
  let reduced = !!opts.reducedMotion
  let leanX = 0
  let leanY = 0
  let targetLeanX = 0
  let targetLeanY = 0
  let raf = 0
  let alive = true
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0

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

    gl.useProgram(sphereProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, coreBuf)
    gl.enableVertexAttribArray(sLoc.aQuad)
    gl.vertexAttribPointer(sLoc.aQuad, 2, gl.FLOAT, false, 0, 0)
    gl.uniform1f(sLoc.uBreath, breath)
    gl.uniform1f(sLoc.uLeanX, leanX)
    gl.uniform1f(sLoc.uLeanY, leanY)
    gl.uniform1f(sLoc.uTime, time)
    gl.uniform3f(sLoc.uColor, glass.mid.r, glass.mid.g, glass.mid.b)
    gl.uniform3f(sLoc.uHot, glass.hot.r, glass.hot.g, glass.hot.b)
    gl.uniform3f(sLoc.uDeep, glass.deep.r, glass.deep.g, glass.deep.b)
    gl.uniform1f(sLoc.uAlpha, Math.max(params.core, 0.94))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
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
      glass = moodGlass(next)
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
      gl.deleteBuffer(coreBuf)
      gl.deleteProgram(sphereProg)
    }
  }
}

function emptyHandle(): BarPillOrbHandle {
  return { setMood() {}, setListening() {}, setHover() {}, setReducedMotion() {}, destroy() {} }
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`
}

/** Reduced-motion / no-GL still frame: energy volume, not a single radial blob, not a point cloud. */
function mountStill(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, opts: MountBarPillOrbOpts): BarPillOrbHandle {
  let mood: OrbMood = opts.mood ?? 'idle'
  const paint = (): void => {
    sizeOnce(canvas)
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    const glass = moodGlass(mood)
    const cx = w * 0.5
    const cy = h * 0.5
    const rad = w * 0.45
    const bloom = ctx.createRadialGradient(cx, cy, rad * 0.28, cx, cy, rad * 1.16)
    bloom.addColorStop(0, rgba(glass.hot.r, glass.hot.g, glass.hot.b, 0.42))
    bloom.addColorStop(0.5, rgba(glass.mid.r, glass.mid.g, glass.mid.b, 0.36))
    bloom.addColorStop(1, rgba(glass.deep.r, glass.deep.g, glass.deep.b, 0))
    ctx.fillStyle = bloom
    ctx.beginPath()
    ctx.arc(cx, cy, rad * 1.16, 0, Math.PI * 2)
    ctx.fill()
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = rgba(glass.hot.r, glass.hot.g, glass.hot.b, 0.36)
    ctx.lineWidth = Math.max(0.8, w / 90)
    ctx.lineCap = 'round'
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 + 0.18
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(a) * rad * 0.98, cy + Math.sin(a) * rad * 0.98)
      ctx.stroke()
    }
    ctx.restore()
    const body = ctx.createRadialGradient(cx - rad * 0.08, cy - rad * 0.12, rad * 0.04, cx, cy + rad * 0.06, rad)
    body.addColorStop(0, rgba(1, Math.min(1, glass.hot.g + 0.18), 1, 0.98))
    body.addColorStop(0.22, rgba(glass.hot.r, glass.hot.g, glass.hot.b, 0.96))
    body.addColorStop(0.58, rgba(glass.mid.r, glass.mid.g, glass.mid.b, 0.88))
    body.addColorStop(1, rgba(glass.deep.r, glass.deep.g, glass.deep.b, 0.1))
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, rad, 0, Math.PI * 2)
    ctx.fill()
    const kissX = cx - rad * 0.28
    const kissY = cy - rad * 0.4
    const kiss = ctx.createRadialGradient(kissX, kissY, 0, kissX, kissY, rad * 0.28)
    kiss.addColorStop(0, 'rgba(255,248,255,0.78)')
    kiss.addColorStop(0.42, rgba(glass.hot.r, glass.hot.g, glass.hot.b, 0.16))
    kiss.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = kiss
    ctx.beginPath()
    ctx.arc(kissX, kissY, rad * 0.28, 0, Math.PI * 2)
    ctx.fill()
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
