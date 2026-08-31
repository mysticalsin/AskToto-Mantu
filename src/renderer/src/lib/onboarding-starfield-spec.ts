/**
 * Starfield Close contract values — docs/design/ONBOARDING-STARFIELD.md.
 * Pure: no three, no DOM. Engine and tests both import from here.
 */

export const CONFIG = {
  bgColor: '#0a0a24',
  flameColor: '#aee9ff',
  flameColor2: '#c79bff',
  flameAmt: 0.2,
  colorA: '#aef6cf',
  colorB: '#5fe6a0',
  colorC: '#eafff2',
  opacity: 2,
  pointSize: 50,
  brightness: 1.85,
  drift: 2.35,
  twinkle: 1,
  spin: 0.03,
  repelRadius: 5,
  repelStrength: 0.35,
  scrollPush: 8,
  scrollDrift: 6,
  scrollSpin: 0.1,
  parallax: 0.6
} as const

export const LAYERS = {
  NONE: 0,
  TORUS_SCENE: 1,
  BLOOM_SCENE: 2,
  ENTIRE_SCENE: 3
} as const

export const STAR_COUNT = 4200
export const STAR_DEPTH = 30
export const APPEAR_DELAY_MS = 0
export const APPEAR_FADE_MS = 480
export const NEXT_BUMP = 0.16
export const BUMP_DECAY = 2.4
export const DAMP_FAST = 0.1
export const DAMP_SLOW = 0.06
export const POINTER_LERP = 0.12
export const ACTIVITY_EASE = 0.06
export const IDLE_MS = 3000
export const REDUCED_MOTION_SCALE = 0.12
export const POINT_SIZE_INITIAL = 50

export const STARFIELD_SCENES = [
  'hero',
  'problem',
  'reveal',
  'setup',
  'personalize',
  'license',
  'ready',
  'skip'
] as const

export type StarfieldScene = (typeof STARFIELD_SCENES)[number]

export function shouldMountStarfield(scene: string): boolean {
  return (STARFIELD_SCENES as readonly string[]).includes(scene)
}

/** Time-driven dive. t is seconds. Reduced motion: no surge. */
export function breathScrollTarget(tSeconds: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0
  return 0.42 + 0.28 * (0.5 + 0.5 * Math.sin(tSeconds * 0.32))
}

export function decayBump(bump: number, dtSeconds: number): number {
  return bump * Math.exp(-dtSeconds * BUMP_DECAY)
}

export function dampScroll(
  smooth: number,
  scroll: number,
  target: number
): { smooth: number; scroll: number } {
  const nextSmooth = smooth + (target - smooth) * DAMP_FAST
  const nextScroll = scroll + (nextSmooth - scroll) * DAMP_SLOW
  return { smooth: nextSmooth, scroll: nextScroll }
}

/** elapsed / 480, then * CONFIG.opacity so the galaxy is visible from frame one. */
export function appearOpacity(elapsedMs: number): number {
  const progress = Math.min(1, Math.max(0, (elapsedMs - APPEAR_DELAY_MS) / APPEAR_FADE_MS))
  return progress * CONFIG.opacity
}

export const STARFIELD_VERTEX_SHADER = `uniform float uTime; uniform float uSize; uniform float uDrift; uniform float uDepth; uniform float uTwinkle;
uniform vec3 uCursor; uniform float uRepelRadius; uniform float uRepelStrength; uniform float uActivity;
uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uColorC;
attribute float aScale; attribute float aPhase; attribute float aPalette; attribute float aBright;
varying vec3 vColor; varying float vTwinkle;
void main() {
  vec3 pos = position;
  pos.z = mod(pos.z + uDrift + (uDepth * 0.5), uDepth) - (uDepth * 0.5);
  float tw = sin(uTime * 1.6 + aPhase * 6.2831);
  vTwinkle = (1.0 - uTwinkle) + uTwinkle * (0.55 + 0.45 * tw);
  vec4 modelPosition = modelMatrix * vec4(pos, 1.0);
  vec3 toParticle = modelPosition.xyz - uCursor;
  float dist = length(toParticle);
  float falloff = smoothstep(uRepelRadius, 0.0, dist);
  modelPosition.xyz += normalize(toParticle + vec3(0.0001)) * falloff * uRepelStrength * uActivity;
  vec4 viewPosition = viewMatrix * modelPosition;
  gl_Position = projectionMatrix * viewPosition;
  gl_PointSize = uSize * aScale;
  gl_PointSize *= (1.0 / -viewPosition.z);
  vec3 base = aPalette < 0.5 ? uColorA : (aPalette < 1.5 ? uColorB : uColorC);
  vColor = base * aBright;
}`

export const STARFIELD_FRAGMENT_SHADER = `uniform float uOpacity; uniform float uBrightness;
varying vec3 vColor; varying float vTwinkle;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float strength = pow(1.0 - d * 2.0, 4.0);
  vec3 color = mix(vec3(0.0), vColor, strength);
  gl_FragColor = vec4(color * uBrightness, strength * uOpacity * vTwinkle);
}`

export const FINAL_VERTEX_SHADER = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`

export const FINAL_FRAGMENT_SHADER = `uniform float iTime; uniform sampler2D tDiffuse; uniform sampler2D bloomTexture; uniform sampler2D torusTexture; uniform sampler2D haloTexture;
uniform vec3 uBg; uniform vec3 uFlameA; uniform vec3 uFlameB; uniform float uFlameAmt;
varying vec2 vUv;
vec3 warp3d(vec3 pos, float t){ float curv=.8,a=1.9,b=0.7; pos*=2.;
  pos.x+=curv*sin(t+a*pos.y)+t*b; pos.y+=curv*cos(t+a*pos.x);
  pos.y+=curv*sin(t+a*pos.z)+t*b; pos.z+=curv*cos(t+a*pos.y);
  pos.z+=curv*sin(t+a*pos.x)+t*b; pos.x+=curv*cos(t+a*pos.z);
  return 0.5+0.5*cos(pos.xyz+vec3(1,2,4)); }
void main(){
  vec2 uv = 2.*vUv - 1.;
  vec3 w = pow(warp3d(vec3(uv.x, sin(uv.y), uv.y), iTime*1.5), vec3(1.5));
  vec3 flame = 1.5*uFlameA*w.x; flame*=w.y; flame += uFlameB*w.z;
  flame *= smoothstep(0.25, 1., abs(uv.y));
  float md = smoothstep(-0.7, 1., -uv.y*uv.x); flame *= md*md;
  vec3 bg = uBg * (1.0 - 0.4 * length(uv));
  vec3 halo = texture2D(haloTexture, vUv).xyz;
  gl_FragColor = vec4(bg + flame*uFlameAmt + texture2D(bloomTexture, vUv).xyz + texture2D(torusTexture, vUv).xyz + texture2D(tDiffuse, vUv).xyz + halo, 1.);
}`
