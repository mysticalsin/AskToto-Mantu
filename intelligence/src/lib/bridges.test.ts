import { describe, expect, it } from 'vitest'
import { findBridges, type BridgeEdgeLike, type BridgeNodeLike } from './bridges'

function node(id: string, community_id: number, over: Partial<BridgeNodeLike> = {}): BridgeNodeLike {
  return {
    id,
    label: id,
    type: 'person',
    community_id,
    community_label: `c${community_id}`,
    degree: 0,
    ...over,
  }
}

describe('findBridges', () => {
  it('ignores a node whose neighbours all sit in its own community', () => {
    const nodes = [node('a', 1), node('b', 1), node('c', 1)]
    const edges: BridgeEdgeLike[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
    ]
    expect(findBridges(nodes, edges)).toEqual([])
  })

  it('finds the node joining two communities, and reports both labels', () => {
    const nodes = [node('hub', 1), node('same', 1), node('other', 2)]
    const edges: BridgeEdgeLike[] = [
      { from: 'hub', to: 'same' },
      { from: 'hub', to: 'other' },
    ]
    const bridges = findBridges(nodes, edges)
    // BOTH endpoints of the cross-community edge are bridges — each one sees the other's community —
    // so `other` is here too. `same` is not: its only neighbour is in its own community.
    expect(bridges.map((b) => b.id)).toEqual(['hub', 'other'])
    const hub = bridges[0]
    expect(hub.spans).toBe(2)
    expect(hub.communityLabels).toEqual(['c1', 'c2'])
    // The far side reports the same pair, from its own side first.
    expect(bridges[1].communityLabels).toEqual(['c2', 'c1'])
  })

  it('treats edges as undirected — the connector is found whichever way the arrow points', () => {
    const nodes = [node('hub', 1), node('other', 2)]
    const forward = findBridges(nodes, [{ from: 'hub', to: 'other' }])
    const backward = findBridges(nodes, [{ from: 'other', to: 'hub' }])
    // Both endpoints span the same two communities either way, so both runs return both nodes.
    expect(forward.map((b) => b.id).sort()).toEqual(['hub', 'other'])
    expect(backward.map((b) => b.id).sort()).toEqual(['hub', 'other'])
  })

  it('ranks by spans, then degree, then label — fully deterministic', () => {
    const nodes = [
      node('wide', 1, { degree: 1 }), // touches 1,2,3
      node('deep', 1, { degree: 9 }), // touches 1,2 but heavier
      node('zed', 1, { degree: 5 }), // touches 1,2, ties `also` on spans+degree
      node('also', 1, { degree: 5 }), // touches 1,2
      node('n2', 2),
      node('n3', 3),
    ]
    const edges: BridgeEdgeLike[] = [
      { from: 'wide', to: 'n2' },
      { from: 'wide', to: 'n3' },
      { from: 'deep', to: 'n2' },
      { from: 'zed', to: 'n2' },
      { from: 'also', to: 'n2' },
    ]
    const ranked = findBridges(nodes, edges).map((b) => b.id)
    // `wide` (3 communities) outranks every 2-community node despite the lowest degree; among those,
    // higher degree wins; the 5/5 tie breaks alphabetically (`also` before `zed`), never by input order.
    expect(ranked.slice(0, 4)).toEqual(['wide', 'deep', 'also', 'zed'])
  })

  it('skips edges pointing at filtered-out nodes instead of counting a phantom community', () => {
    const nodes = [node('a', 1), node('b', 1)]
    const edges: BridgeEdgeLike[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'gone' }, // 'gone' was filtered out of `nodes`
    ]
    expect(findBridges(nodes, edges)).toEqual([])
  })

  it('does not let a self-edge manufacture a span', () => {
    const nodes = [node('a', 1)]
    expect(findBridges(nodes, [{ from: 'a', to: 'a' }])).toEqual([])
  })

  it('honours the limit', () => {
    const nodes = [node('n2', 2), node('n3', 3)]
    const edges: BridgeEdgeLike[] = []
    for (let i = 0; i < 10; i++) {
      nodes.push(node(`b${i}`, 1, { degree: i }))
      edges.push({ from: `b${i}`, to: 'n2' })
    }
    expect(findBridges(nodes, edges, 3)).toHaveLength(3)
  })

  it('returns nothing for an empty graph', () => {
    expect(findBridges([], [])).toEqual([])
  })
})
