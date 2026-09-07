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
