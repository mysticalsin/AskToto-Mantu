/**
 * Bridges — "surprising connections", borrowed from graphify (github.com/Graphify-Labs/graphify),
 * whose report ranks "links between things that live in different files or modules ... by how
 * unexpected they are". Communities are this graph's modules: brainAdapter already partitions the
 * relationship graph with label propagation, so a node whose NEIGHBOURS sit in more than one
 * community is exactly that cross-module link — the contact who spans two otherwise-separate parts
 * of your world.
 *
 * Why this earns its own panel: every other sidebar list answers "what is decaying" (Going cold) or
 * "what is structurally thin" (Relationship risk). Neither can surface a connector, because a
 * well-connected bridge looks healthy by both measures. It is the one genuinely non-obvious thing
 * the graph's own shape knows and no per-node view can show.
 *
 * Pure and dependency-free (same contract as momentum.ts / ledgerstats.ts): minimal structural
 * interfaces, no imports from types/data.ts, no clock. Nothing here infers a relationship — it only
 * counts the communities of edges the extraction pipeline already wrote.
 */

export interface BridgeNodeLike {
  id: string
  label: string
  type: string
  account?: string
  community_id: number
  community_label: string
  degree: number
}

export interface BridgeEdgeLike {
  from: string
  to: string
}

export interface Bridge {
  id: string
  label: string
  type: string
  account?: string
  /** Distinct communities this node touches, counting its own and every neighbour's. Always >= 2. */
  spans: number
  /** Labels of those communities, de-duplicated, for the "connects X and Y" caption. */
  communityLabels: string[]
  degree: number
}

/**
 * Nodes that connect two or more communities, most-surprising first.
 *
 * Ranking: `spans` descending (a node touching four communities is a more surprising connector than
 * one touching two), then `degree` descending as the tie-break — among equal spans, the one carrying
 * more of the graph is the more load-bearing bridge — then `label` ascending so the order is fully
 * deterministic for a given graph rather than dependent on node insertion order.
 *
 * Edges are treated as UNDIRECTED: `relation` direction is an artifact of which side the extractor
 * happened to write first, and a connector is a connector whichever way the arrow points. Edges
 * naming an id that is not in `nodes` (a filtered-out node) are skipped rather than counted against
 * a phantom community — the caller passes already-filtered nodes, so this keeps the panel consistent
 * with what the canvas is actually drawing.
 */
export function findBridges(nodes: BridgeNodeLike[], edges: BridgeEdgeLike[], limit = 6): Bridge[] {
  const byId = new Map<string, BridgeNodeLike>()
  for (const n of nodes) byId.set(n.id, n)

  // Undirected adjacency, restricted to nodes actually present.
  const neighbours = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    let set = neighbours.get(a)
    if (!set) {
      set = new Set<string>()
      neighbours.set(a, set)
    }
    set.add(b)
  }
  for (const e of edges) {
    if (e.from === e.to) continue // a self-edge spans nothing
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    link(e.from, e.to)
    link(e.to, e.from)
  }

  const out: Bridge[] = []
  for (const node of nodes) {
    const seen = new Map<number, string>([[node.community_id, node.community_label]])
    for (const neighbourId of neighbours.get(node.id) ?? []) {
      const nb = byId.get(neighbourId)
      if (nb && !seen.has(nb.community_id)) seen.set(nb.community_id, nb.community_label)
    }
    if (seen.size < 2) continue
    out.push({
      id: node.id,
      label: node.label,
      type: node.type,
      account: node.account,
      spans: seen.size,
      communityLabels: Array.from(seen.values()),
      degree: node.degree,
    })
  }

  out.sort((a, b) => b.spans - a.spans || b.degree - a.degree || a.label.localeCompare(b.label))
  return out.slice(0, limit)
}
