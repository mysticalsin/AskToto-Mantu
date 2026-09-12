import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { IdentitySnapshot } from '@shared/ipc'
import { MetisMark } from './MetisMark'
import {
  faceFromFlip,
  nearestFace,
  pointerNormal,
  prefersReducedMotion,
  sheenFromPointer,
  stepSpring,
  tiltFromPointer
} from '../lib/identity-card-motion'

type ManagedTier = 'metis' | 'metis-light' | null

export function passAriaLabel(snap: IdentitySnapshot, managedTier: ManagedTier = null): string {
  return `Métis member pass. Member ${snap.memberNumberLabel}. ${snap.deviceName}. License ${licenseWord(snap, managedTier)}.`
}

function licenseWord(snap: IdentitySnapshot, managedTier: ManagedTier = null): string {
  if (managedTier) return managedTier === 'metis-light' ? 'Métis Light' : 'Métis'
  if (snap.license.state === 'licensed' || snap.license.state === 'grace') {
    if (snap.license.edition === 'enterprise') return 'Enterprise'
    if (snap.license.edition === 'pro') return 'Pro'
  }
  return 'Personal'
}

export function IdentityCard({
  snapshot,
  managedTier = null,
  reducedMotion: reducedMotionProp
}: {
  snapshot: IdentitySnapshot
  managedTier?: ManagedTier
  reducedMotion?: boolean
}): JSX.Element {
  const reduced = reducedMotionProp ?? prefersReducedMotion()
  const labelId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [flipped, setFlipped] = useState(false)
  const spin = useRef(0)
  const spinVel = useRef(0)
  const tilt = useRef({ x: 0, y: 0 })
  const tiltVel = useRef({ x: 0, y: 0 })
  const tiltTarget = useRef({ x: 0, y: 0 })
  const sheen = useRef({ x: 50, y: 40 })
  const dragging = useRef(false)
  const dragLastX = useRef(0)
  const spinningTo = useRef<number | null>(null)
  const wakeAnimation = useRef<() => void>(() => {})
  const [, bump] = useState(0)

  const applyTransform = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    const rx = reduced ? 0 : tilt.current.x
    const ry = (reduced ? faceFromFlip(flipped) : spin.current) + (reduced ? 0 : tilt.current.y)
    el.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`
    const shine = el.querySelector<HTMLElement>('[data-sheen]')
    if (shine) {
      shine.style.background = reduced
        ? 'transparent'
        : `radial-gradient(120% 80% at ${sheen.current.x}% ${sheen.current.y}%, rgba(255,255,255,0.20), rgba(166,77,255,0.08) 36%, transparent 62%)`
    }
  }, [flipped, reduced])

  useEffect(() => {
    if (reduced) {
      spinningTo.current = null
      spin.current = faceFromFlip(flipped)
      spinVel.current = 0
      tilt.current = { x: 0, y: 0 }
      tiltVel.current = { x: 0, y: 0 }
      tiltTarget.current = { x: 0, y: 0 }
      applyTransform()
      return
    }
    let raf = 0
    let disposed = false
    let last = performance.now()
    const wake = (): void => {
      if (disposed || document.hidden || raf) return
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }
    const tick = (now: number): void => {
      raf = 0
      if (disposed || document.hidden) return
      const dt = Math.min(0.032, (now - last) / 1000)
      last = now
      let moving = false
      if (!dragging.current) {
        const tx = spinningTo.current ?? nearestFace(spin.current)
        const s = stepSpring(spin.current, spinVel.current, tx, dt)
        spin.current = s.pos
        spinVel.current = s.vel
        if (Math.abs(s.pos - tx) < 0.15 && Math.abs(s.vel) < 0.15) {
          spin.current = tx
          spinVel.current = 0
          spinningTo.current = null
          setFlipped(tx === 180)
        } else moving = true
      }
      const sx = stepSpring(tilt.current.x, tiltVel.current.x, tiltTarget.current.x, dt)
      const sy = stepSpring(tilt.current.y, tiltVel.current.y, tiltTarget.current.y, dt)
      // Springs approach their targets asymptotically. Snap below the displayed precision so the
      // settled card retains its last transform instead of rewriting two styles every screen refresh.
      const xSettled = Math.abs(sx.pos - tiltTarget.current.x) < 0.01 && Math.abs(sx.vel) < 0.05
      const ySettled = Math.abs(sy.pos - tiltTarget.current.y) < 0.01 && Math.abs(sy.vel) < 0.05
      if (xSettled) { sx.pos = tiltTarget.current.x; sx.vel = 0 }
      if (ySettled) { sy.pos = tiltTarget.current.y; sy.vel = 0 }
      tilt.current = { x: sx.pos, y: sy.pos }
      tiltVel.current = { x: sx.vel, y: sy.vel }
      applyTransform()
      if (moving || !xSettled || !ySettled) raf = requestAnimationFrame(tick)
    }
    const onVisibility = (): void => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0 }
      else wake()
    }
    wakeAnimation.current = wake
    document.addEventListener('visibilitychange', onVisibility)
    wake()
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      wakeAnimation.current = () => {}
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [applyTransform, flipped, reduced])

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect()
    const { nx, ny } = pointerNormal(e.clientX, e.clientY, box)
    const t = tiltFromPointer(nx, ny, reduced)
    tiltTarget.current = { x: t.rotateX, y: t.rotateY }
    sheen.current = sheenFromPointer(nx, ny)
    if (dragging.current && !reduced) {
      const dx = e.clientX - dragLastX.current
      dragLastX.current = e.clientX
      spin.current += dx * 0.55
      spinVel.current = dx * 12
      setFlipped(nearestFace(spin.current) === 180)
    }
    if (reduced) applyTransform()
    else wakeAnimation.current()
  }

  const flip = (): void => {
    const next = !flipped
    setFlipped(next)
    if (reduced) {
      spin.current = faceFromFlip(next)
      applyTransform()
      bump((n) => n + 1)
      return
    }
    spinningTo.current = faceFromFlip(next)
    wakeAnimation.current()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      flip()
    }
  }

  const edition = licenseWord(snapshot, managedTier)
  const serialLabel = snapshot.serialKind === 'hardware' ? 'Serial' : 'Install ID'

  return (
    <div className="metis-pass-stage">
      <div
        ref={rootRef}
        role="button"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-label={passAriaLabel(snapshot, managedTier)}
        aria-pressed={flipped}
        className={`metis-pass no-drag cl-focus${reduced ? ' metis-pass--static' : ''}`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          tiltTarget.current = { x: 0, y: 0 }
          dragging.current = false
          if (!reduced) {
            spinningTo.current = nearestFace(spin.current)
            wakeAnimation.current()
          }
        }}
        onPointerDown={(e) => {
          dragging.current = true
          dragLastX.current = e.clientX
          spinningTo.current = null
          e.currentTarget.setPointerCapture(e.pointerId)
          if (!reduced) wakeAnimation.current()
        }}
        onPointerUp={() => {
          if (dragging.current && reduced) flip()
          dragging.current = false
          if (!reduced) {
            spinningTo.current = nearestFace(spin.current)
            wakeAnimation.current()
          }
        }}
        onKeyDown={onKeyDown}
      >
        <span id={labelId} className="sr-only">
          {passAriaLabel(snapshot, managedTier)}
        </span>
        <div className="metis-pass-face metis-pass-front">
          <div className="metis-pass-top">
            <MetisMark size={22} />
            <span className="metis-pass-eyebrow">Member</span>
          </div>
          <div className="metis-pass-wordmark">Métis</div>
          <div className="metis-pass-number">
            <span className="metis-pass-no">Nº</span>
            <span className="metis-pass-num">{snapshot.memberNumberLabel}</span>
          </div>
          <div className="metis-pass-meta">
            <div className="metis-pass-eyebrow">This device</div>
            <div className="metis-pass-device">{snapshot.deviceName}</div>
            <div className="metis-pass-serial">
              <span className="metis-pass-k">{serialLabel}</span>
              <span className="metis-pass-v">{snapshot.serialDisplay}</span>
            </div>
            <div className="metis-pass-date">{snapshot.installedAtLabel}</div>
          </div>
        </div>
        <div className="metis-pass-face metis-pass-back">
          <div className="metis-pass-top">
            <span className="metis-pass-eyebrow">License</span>
            <span className="metis-pass-edition">{edition}</span>
          </div>
          <p className="metis-pass-copy">
            {managedTier
              ? 'Managed licence verified. Features and AI readiness are shown below.'
              : 'Activate your Métis licence below to connect this device to managed AI.'}
          </p>
          {snapshot.license.managedFilePresent && (
            <p className="metis-pass-copy metis-pass-copy--soft">An offline licence file is on this device. Managed AI uses the Métis licence below.</p>
          )}
          {snapshot.license.seats != null && snapshot.license.state !== 'unlicensed' && (
            <p className="metis-pass-copy metis-pass-copy--soft">
              {snapshot.license.seats} {snapshot.license.seats === 1 ? 'seat' : 'seats'}
            </p>
          )}
        </div>
        <div className="metis-pass-sheen" data-sheen aria-hidden="true" />
        <div className="metis-pass-rim" aria-hidden="true" />
      </div>
    </div>
  )
}
