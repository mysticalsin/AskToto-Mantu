import { MODE_DRAWS, resolvePreset, type OrbSize, type OrbState } from 'thinking-orbs'

/**
 * Paint one orb frame through the package engine before the browser's first
 * paint. thinking-orbs draws in useEffect (after paint), which would leave a
 * blank canvas beside the caption for a frame. We do not rewrite their renderer.
 */
export function paintOrbFirstFrame(
  canvas: HTMLCanvasElement,
  state: OrbState,
  size: OrbSize,
  dark: boolean
): void {
  const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1)
  canvas.width = Math.round(size * dpr)
  canvas.height = Math.round(size * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { mode, speed, opts } = resolvePreset(state, size)
  const draw = MODE_DRAWS[mode]
  if (!draw) return
  const reduced =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const t = reduced ? 0.6 : (performance.now() / 1000) * speed
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)
  draw(ctx, size, t, dark, opts)
}
