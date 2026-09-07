import { describe, expect, it } from 'vitest'
import { buildWorldData } from '../../scripts/build-world.mjs'
import { CENTROIDS_1152, CENTROIDS_520, WORLD_1152, WORLD_520 } from './paths.generated'

describe('generated world paths are not stale', () => {
  it('committed paths.generated.ts matches a fresh build-world.mjs run', async () => {
    const fresh = await buildWorldData()
    expect(WORLD_1152, 'run npm run build:operator-world').toEqual(fresh.world1152.entries)
    expect(WORLD_520, 'run npm run build:operator-world').toEqual(fresh.world520.entries)
    expect(CENTROIDS_1152, 'run npm run build:operator-world').toEqual(fresh.world1152.centroids)
    expect(CENTROIDS_520, 'run npm run build:operator-world').toEqual(fresh.world520.centroids)
  }, 30000)

  it('WORLD_1152 stays under the 350 KB budget', async () => {
    const fresh = await buildWorldData()
    expect(fresh.bytes1152).toBeLessThan(350 * 1024)
  }, 30000)

  it('WORLD_520 stays under the 120 KB budget', async () => {
    const fresh = await buildWorldData()
    expect(fresh.bytes520).toBeLessThan(120 * 1024)
  }, 30000)
})

/** Regression guard for the wedge-artifact bug: independently of build-world.mjs's own
 * build-time validation, re-check every committed ring here too, so a hand-edit or a
 * future generator change that reintroduces invalid rings fails this suite, not just a
 * screenshot. Mirrors operator/scripts/build-world.mjs's isBandBox/degenerate-ring checks. */
describe('committed world paths have no degenerate or band-shaped rings', () => {
  function splitSubpaths(d: string): string[] {
    return d.match(/[Mm][^Mm]*/g) ?? []
  }
  function pointsFromSubpath(subpath: string): [number, number][] {
    const body = subpath.replace(/^[Mm]\s*/, '').replace(/[Zz]\s*$/, '')
    return body
      .split(/[Ll]/)
      .map((chunk) => chunk.trim().split(/[\s,]+/).map(Number) as [number, number])
      .filter((p) => p.length === 2 && p.every(Number.isFinite))
  }
  function isBandBox(points: [number, number][]): boolean {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [x, y] of points) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    return maxX - minX >= 700 && maxY - minY <= 10
  }

  it('WORLD_1152 rings all have >= 4 points and no band-shaped bbox', () => {
    for (const entry of WORLD_1152) {
      for (const subpath of splitSubpaths(entry.d)) {
        const pts = pointsFromSubpath(subpath)
        expect(pts.length, `${entry.alpha2 || entry.id} ring`).toBeGreaterThanOrEqual(4)
        expect(isBandBox(pts), `${entry.alpha2 || entry.id} ring should not be a band artifact`).toBe(false)
      }
    }
  })

  it('WORLD_520 rings all have >= 4 points and no band-shaped bbox', () => {
    for (const entry of WORLD_520) {
      for (const subpath of splitSubpaths(entry.d)) {
        const pts = pointsFromSubpath(subpath)
        expect(pts.length, `${entry.alpha2 || entry.id} ring`).toBeGreaterThanOrEqual(4)
        expect(isBandBox(pts), `${entry.alpha2 || entry.id} ring should not be a band artifact`).toBe(false)
      }
    }
  })
})

/**
 * Regression guard for the fan/starburst bug (a ring that folds back through itself —
 * see build-world.mjs's file doc comment): independently re-checks every committed ring
 * for self-intersection, the numeric test the original bug could only be caught by
 * (screenshots show the symptom, not the cause). A self-crossing ring is never a real
 * coastline at any simplification level, however small the fold — this is a correctness
 * property, not a visual-fidelity judgement call.
 */
describe('committed world paths have no self-intersecting rings', () => {
  function splitSubpaths(d: string): string[] {
    return d.match(/[Mm][^Mm]*/g) ?? []
  }
  function pointsFromSubpath(subpath: string): [number, number][] {
    const body = subpath.replace(/^[Mm]\s*/, '').replace(/[Zz]\s*$/, '')
    return body
      .split(/[Ll]/)
      .map((chunk) => chunk.trim().split(/[\s,]+/).map(Number) as [number, number])
      .filter((p) => p.length === 2 && p.every(Number.isFinite))
  }
  function ccw(a: [number, number], b: [number, number], c: [number, number]): number {
    return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])
  }
  function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
    const d1 = ccw(c, d, a)
    const d2 = ccw(c, d, b)
    const d3 = ccw(a, b, c)
    const d4 = ccw(a, b, d)
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  }
  /** Closed-ring self-intersection: every pair of non-adjacent edges (the wraparound edge
   * counts as adjacent to edge 0) must not cross. */
  function findSelfIntersection(points: [number, number][]): [number, number] | null {
    const n = points.length
    if (n < 4) return null
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue
        if (segmentsIntersect(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return [i, j]
      }
    }
    return null
  }

  it('WORLD_1152 rings never cross themselves', () => {
    for (const entry of WORLD_1152) {
      for (const subpath of splitSubpaths(entry.d)) {
        const pts = pointsFromSubpath(subpath)
        const hit = findSelfIntersection(pts)
        expect(hit, `${entry.alpha2 || entry.id} ring self-intersects at edges ${hit?.[0]}/${hit?.[1]}`).toBeNull()
      }
    }
  })

  it('WORLD_520 rings never cross themselves', () => {
    for (const entry of WORLD_520) {
      for (const subpath of splitSubpaths(entry.d)) {
        const pts = pointsFromSubpath(subpath)
        const hit = findSelfIntersection(pts)
        expect(hit, `${entry.alpha2 || entry.id} ring self-intersects at edges ${hit?.[0]}/${hit?.[1]}`).toBeNull()
      }
    }
  })
})

/**
 * Regression guard for simplification silently distorting a country's shape: build-world.mjs's
 * own buildVariant() already asserts, at build time, that every simplified feature's geoArea
 * stays under AREA_SANITY_MAX and within AREA_RATIO_MAX of its raw (unsimplified) geoArea —
 * falling back to the raw geometry for the rare feature that fails, and recording which ones
 * did in `fellBackToRaw`. Asserting that list is empty here turns that build-time safety net
 * into a hard, permanent regression test: nobody can loosen the simplification thresholds (or
 * reintroduce a bug that distorts a ring's area) without this test naming the exact country.
 */
describe('no committed country needed the raw-geometry area-sanity fallback', () => {
  it('every WORLD_1152 / WORLD_520 feature\'s simplified geoArea passed the sanity/ratio check unaided', async () => {
    const fresh = await buildWorldData()
    expect(fresh.world1152.fellBackToRaw, '1152: run npm run build:operator-world and investigate the named countries').toEqual([])
    expect(fresh.world520.fellBackToRaw, '520: run npm run build:operator-world and investigate the named countries').toEqual([])
  }, 30000)
})
