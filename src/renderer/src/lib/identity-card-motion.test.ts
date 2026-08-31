import { describe, expect, it } from 'vitest'
import {
  faceFromFlip,
  nearestFace,
  pointerNormal,
  prefersReducedMotion,
  sheenFromPointer,
  stepSpring,
  tiltFromPointer
} from './identity-card-motion'

describe('member-pass motion', () => {
  it('spring steps toward the target instead of leaping linearly', () => {
    let pos = 0
    let vel = 0
    for (let i = 0; i < 40; i++) {
      const s = stepSpring(pos, vel, 180, 1 / 60)
      pos = s.pos
      vel = s.vel
    }
    expect(pos).toBeGreaterThan(40)
    expect(pos).toBeLessThan(180)
    expect(vel).toBeGreaterThan(0)
  })

  it('reduced motion produces no tilt', () => {
    expect(tiltFromPointer(1, 1, true)).toEqual({ rotateX: 0, rotateY: 0 })
    expect(tiltFromPointer(0.5, -0.5, false).rotateY).toBeCloseTo(6)
    expect(tiltFromPointer(0.5, -0.5, false).rotateX).toBeCloseTo(4)
  })

  it('nearest face snaps to 0 or 180 for a full spin', () => {
    expect(nearestFace(10)).toBe(0)
    expect(nearestFace(95)).toBe(180)
    expect(nearestFace(200)).toBe(180)
    expect(nearestFace(300)).toBe(0)
    expect(faceFromFlip(true)).toBe(180)
    expect(faceFromFlip(false)).toBe(0)
  })

  it('sheen tracks the pointer in percent', () => {
    expect(sheenFromPointer(0, 0)).toEqual({ x: 50, y: 40 })
    expect(sheenFromPointer(1, 0).x).toBeGreaterThan(50)
  })

  it('pointerNormal maps the card box to [-1, 1]', () => {
    expect(pointerNormal(50, 25, { left: 0, width: 100, top: 0, height: 50 })).toEqual({ nx: 0, ny: 0 })
  })

  it('prefersReducedMotion is honest when matchMedia says reduce', () => {
    expect(prefersReducedMotion(() => true)).toBe(true)
    expect(prefersReducedMotion(() => false)).toBe(false)
  })
})
