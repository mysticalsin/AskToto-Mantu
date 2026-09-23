import { describe, expect, it } from 'vitest'
// @ts-expect-error vendored ESM helper without type declarations
import { feature } from './topojson-feature.mjs'

// Regression: the vendored reverse() once decremented `j` twice per swap, scrambling every
// reversed arc into fans of spikes along shared borders (and flipping small island rings into
// their world-sized complement, e.g. Brunei). A reversed arc must come back in exact reverse order.
describe('vendored topojson feature(): arc reversal', () => {
  const arc = [
    [0, 0],
    [1, 0],
    [2, 1],
    [3, 3],
    [4, 6],
    [5, 10],
    [6, 15]
  ]
  const topology = { type: 'Topology', arcs: [arc], objects: {} }

  it('a negative arc index (~0) yields the arc points in exact reverse order', () => {
    const f = feature(topology, { type: 'LineString', arcs: [~0] })
    expect(f.geometry.coordinates).toEqual([...arc].reverse())
  })

  it('reversal works for even and odd point counts', () => {
    for (const n of [2, 3, 4, 5, 8, 9]) {
      const a = Array.from({ length: n }, (_, i) => [i, i * i])
      const f = feature({ type: 'Topology', arcs: [a], objects: {} }, { type: 'LineString', arcs: [~0] })
      expect(f.geometry.coordinates).toEqual([...a].reverse())
    }
  })

  it('stitches a forward and a reversed arc into one continuous line without jumps', () => {
    const a = [
      [0, 0],
      [1, 0],
      [2, 0]
    ]
    const b = [
      [5, 0],
      [4, 0],
      [3, 0],
      [2, 0]
    ]
    const f = feature({ type: 'Topology', arcs: [a, b], objects: {} }, { type: 'LineString', arcs: [0, ~1] })
    expect(f.geometry.coordinates).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0]
    ])
  })
})
