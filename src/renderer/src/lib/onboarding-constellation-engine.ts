/**
 * 2D canvas spring-mass constellation grid.
 * Port of Tony's pasted kinetic mesh. Silent bed: no title, no hex readouts, no light theme.
 * Never throws. One context. Dispose rAF on unmount.
 */
import {
  CONSTELLATION_SEED_DT,
  GRID,
  clampDt,
  hexToRgb,
  hookeAccel,
  linkAlpha,
  recedeForce
} from './onboarding-constellation-spec'

export interface ConstellationBed {
  dispose: () => void
}

export interface ConstellationBedOptions {
  reducedMotion?: boolean
  now?: () => number
}

type Node = {
  ox: number
  oy: number
  x: number
  y: number
  vx: number
  vy: number
  col: number
  row: number
}

type Ring = { x: number; y: number; born: number }

const NODE_RGB = hexToRgb(GRID.node)
const LINE_RGB = hexToRgb(GRID.line)
const RING_RGB = hexToRgb(GRID.ring)
const HIGH_RGB = hexToRgb(GRID.highlight)

function viewSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const w = Math.max(1, canvas.clientWidth || canvas.width || window.innerWidth || 1)
  const h = Math.max(1, canvas.clientHeight || canvas.height || window.innerHeight || 1)
  return { w, h }
}

function buildNodes(w: number, h: number): { nodes: Node[]; cols: number } {
  const spacing = GRID.spacing
  const cols = Math.ceil(w / spacing) + 2
  const rows = Math.ceil(h / spacing) + 2
  const ox0 = (w - (cols - 1) * spacing) / 2
  const oy0 = (h - (rows - 1) * spacing) / 2
  const nodes: Node[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const ox = ox0 + col * spacing
      const oy = oy0 + row * spacing
      nodes.push({ ox, oy, x: ox, y: oy, vx: 0, vy: 0, col, row })
    }
  }
  return { nodes, cols }
}

export function createConstellationBed(
  canvas: HTMLCanvasElement,
  opts: ConstellationBedOptions = {}
): ConstellationBed | null {
  canvas.style.opacity = '0'
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  } catch {
    return null
  }
  if (!ctx) return null

  const reducedMotion = opts.reducedMotion === true
  const nowFn = opts.now ?? (() => performance.now())
  let disposed = false
  let raf = 0
  let w = 1
  let h = 1
  let dpr = 1
  let nodes: Node[] = []
  let cols = 0
  const mouse = { x: -9999, y: -9999, px: -9999, py: -9999 }
  const rings: Ring[] = []
  let lastTick = nowFn()
  let firstFrame = true
  let lastRingAt = 0

  const applySize = (): void => {
    const next = viewSize(canvas)
    w = next.w
    h = next.h
    dpr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      GRID.dprCap
    )
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    } catch {
      return
    }
    const built = buildNodes(w, h)
    nodes = built.nodes
    cols = built.cols
  }

  try {
    applySize()
  } catch {
    return null
  }

  const onPointerMove = (e: PointerEvent): void => {
    mouse.px = mouse.x
    mouse.py = mouse.y
    mouse.x = e.clientX
    mouse.y = e.clientY
    const t = nowFn()
    if (t - lastRingAt > 90) {
      rings.push({ x: mouse.x, y: mouse.y, born: t })
      lastRingAt = t
      if (rings.length > 8) rings.shift()
    }
  }

  const onResize = (): void => {
    if (disposed) return
    try {
      applySize()
    } catch {
      /* keep last grid */
    }
  }

  const step = (dt: number): void => {
    const mx = mouse.x
    const my = mouse.y
    const speedX = (mx - mouse.px) / Math.max(dt, 1 / 120)
    const speedY = (my - mouse.py) / Math.max(dt, 1 / 120)
    const speed = Math.hypot(speedX, speedY)
    const shock = Math.min(2.4, speed * 0.012)

    for (const n of nodes) {
      if (reducedMotion) {
        n.x = n.ox
        n.y = n.oy
        n.vx = 0
        n.vy = 0
        continue
      }
      let ax = hookeAccel(n.ox, n.x, GRID.springK)
      let ay = hookeAccel(n.oy, n.y, GRID.springK)
      const dx = n.x - mx
      const dy = n.y - my
      const dist = Math.hypot(dx, dy)
      const recede = recedeForce(dist, GRID.mouseRadius)
      if (recede > 0 && dist > 0.01) {
        const nx = dx / dist
        const ny = dy / dist
        const push = recede * 1400
        ax += nx * push
        ay += ny * push
        ax += speedX * recede * shock * 0.35
        ay += speedY * recede * shock * 0.35
      }
      n.vx = (n.vx + ax * dt) * GRID.damping
      n.vy = (n.vy + ay * dt) * GRID.damping
      n.x += n.vx * dt * 60
      n.y += n.vy * dt * 60
    }
    mouse.px = mx
    mouse.py = my
  }

  const neighborIndexes = (i: number): number[] => {
    const col = i % cols
    const out: number[] = []
    if (col + 1 < cols) out.push(i + 1)
    if (i + cols < nodes.length) out.push(i + cols)
    if (col + 1 < cols && i + cols + 1 < nodes.length) out.push(i + cols + 1)
    return out
  }

  const paint = (now: number): void => {
    ctx.fillStyle = GRID.bg
    ctx.fillRect(0, 0, w, h)
    const vignette = ctx.createRadialGradient(w * 0.5, h * 0.42, 40, w * 0.5, h * 0.5, Math.max(w, h) * 0.72)
    vignette.addColorStop(0, 'rgba(3, 4, 7, 0)')
    vignette.addColorStop(1, GRID.bgDeep)
    ctx.fillStyle = vignette
    ctx.fillRect(0, 0, w, h)

    ctx.lineWidth = 1
    ctx.lineCap = 'round'
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      for (const j of neighborIndexes(i)) {
        const b = nodes[j]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const alpha = linkAlpha(dist, GRID.linkDist)
        if (alpha <= 0) continue
        ctx.strokeStyle = `rgba(${LINE_RGB.r}, ${LINE_RGB.g}, ${LINE_RGB.b}, ${0.16 + alpha * 0.42})`
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }

    for (const n of nodes) {
      const d = Math.hypot(n.x - mouse.x, n.y - mouse.y)
      const near = recedeForce(d, GRID.mouseRadius)
      const rgb = near > 0.35 ? HIGH_RGB : NODE_RGB
      const r = 1.15 + near * 1.6
      ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.42 + near * 0.5})`
      ctx.beginPath()
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    const live: Ring[] = []
    for (const ring of rings) {
      const age = (now - ring.born) / 1000
      if (age > 1.15) continue
      live.push(ring)
      const radius = 18 + age * 160
      const alpha = Math.max(0, 0.28 * (1 - age / 1.15))
      ctx.strokeStyle = `rgba(${RING_RGB.r}, ${RING_RGB.g}, ${RING_RGB.b}, ${alpha})`
      ctx.lineWidth = 1.25
      ctx.beginPath()
      ctx.arc(ring.x, ring.y, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
    rings.length = 0
    rings.push(...live)
  }

  const tick = (): void => {
    if (disposed) return
    raf = requestAnimationFrame(tick)
    try {
      if (typeof document !== 'undefined' && document.hidden) {
        lastTick = nowFn()
        return
      }
      const now = nowFn()
      const raw = (now - lastTick) / 1000
      lastTick = now
      const dt = firstFrame ? CONSTELLATION_SEED_DT : clampDt(raw)
      step(dt)
      paint(now)
      if (firstFrame) {
        firstFrame = false
        canvas.style.opacity = '1'
      }
    } catch {
      try {
        canvas.style.opacity = '0'
      } catch {
        /* keep the app alive */
      }
    }
  }

  try {
    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', onPointerMove, { passive: true })
      window.addEventListener('resize', onResize)
    }
    tick()
  } catch {
    return null
  }

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      try {
        cancelAnimationFrame(raf)
      } catch {
        /* already dead */
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('resize', onResize)
      }
      try {
        canvas.style.opacity = '0'
      } catch {
        /* unmounted */
      }
    }
  }
}
