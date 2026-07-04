import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DataSet } from 'vis-data'
import { Network } from 'vis-network/standalone'
import type { DashboardData, GraphNode, Reason, ScopeSummary, WinLikelihoodBand } from '../types/data'
import { bandColor, bandLabel } from '../lib/format'

interface Props {
  data: DashboardData
}

// Same categorical palette graphify's own reference output uses (~/Library/Application
// Support/asktoto/graph/graph.html) — keeps this view visually consistent with that template.
const COMMUNITY_PALETTE = [
  '#4E79A7', '#F28E2B', '#59A14F', '#E15759', '#76B7B2',
  '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
]
function communityColor(id: number): string {
  return COMMUNITY_PALETTE[id % COMMUNITY_PALETTE.length]
}

const TYPE_SIZE: Record<GraphNode['type'], number> = {
  account: 34,
  deal: 26,
  person: 16,
  strategic_group: 30,
  sector: 30,
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n}`
}

function emptySummary(key: string, label: string): ScopeSummary {
  return { key, label, deal_count: 0, total_value_usd: null, band_counts: { good: 0, mixed: 0, concerning: 0 }, insight_ids: [] }
}

function mergeSummaries(summaries: ScopeSummary[]): ScopeSummary {
  const merged = emptySummary('all', 'All')
  for (const s of summaries) {
    merged.deal_count += s.deal_count
    // Sum only real values; if no scope has value data the merged total stays null (not $0).
    if (s.total_value_usd !== null) merged.total_value_usd = (merged.total_value_usd ?? 0) + s.total_value_usd
    merged.band_counts.good += s.band_counts.good
    merged.band_counts.mixed += s.band_counts.mixed
    merged.band_counts.concerning += s.band_counts.concerning
    for (const id of s.insight_ids) if (!merged.insight_ids.includes(id)) merged.insight_ids.push(id)
  }
  return merged
}

export function GraphView({ data }: Props) {
  const {
    account_graph: graph,
    account_summaries: accountSummaries,
    sector_summaries: sectorSummaries,
    coaching_insights: insights,
    accounts,
    people,
  } = data
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const networkRef = useRef<Network | null>(null)
  const nodesDsRef = useRef<DataSet<any> | null>(null)

  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [hiddenBands, setHiddenBands] = useState<Set<WinLikelihoodBand>>(new Set())
  // Two independent, simultaneously-applied filter dimensions — "per company, per sector" taken
  // literally: an account filter and a sector filter both narrow the same graph at once (AND), not a
  // single "pick one lens" toggle.
  const [hiddenAccounts, setHiddenAccounts] = useState<Set<string>>(new Set())
  const [hiddenSectors, setHiddenSectors] = useState<Set<string>>(new Set())
  const [hiddenCommunities, setHiddenCommunities] = useState<Set<number>>(new Set())
  const [roiScope, setRoiScope] = useState<{ type: 'all' | 'account' | 'sector'; key?: string }>({ type: 'all' })

  const accountGroups = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of graph.nodes) if (n.account) m.set(n.account, (m.get(n.account) ?? 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [graph.nodes])
  const sectorGroups = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of graph.nodes) if (n.sector) m.set(n.sector, (m.get(n.sector) ?? 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [graph.nodes])
  const communityGroups = useMemo(() => {
    const m = new Map<number, { label: string; count: number }>()
    for (const n of graph.nodes) {
      const cur = m.get(n.community_id)
      if (cur) cur.count += 1
      else m.set(n.community_id, { label: n.community_label, count: 1 })
    }
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0])
  }, [graph.nodes])

  function nodeVisible(n: GraphNode): boolean {
    if (n.account && hiddenAccounts.has(n.account)) return false
    if (n.sector && hiddenSectors.has(n.sector)) return false
    if (hiddenCommunities.has(n.community_id)) return false
    if (n.type === 'deal' && n.win_likelihood_band && hiddenBands.has(n.win_likelihood_band)) return false
    return true
  }

  // Cheap identity for the graph's actual shape (ids + confidence/band/freshness — everything the
  // effect below draws) so a poll tick that reloads the same underlying graph into a new object
  // doesn't blow away and rebuild the vis-network canvas (destroy() resets pan/zoom/physics and
  // flickers every 10s while a backfill is running). Only a real content change re-triggers it.
  const graphSignature = useMemo(() => {
    const nodePart = graph.nodes
      .map((n) => `${n.id}:${n.community_id}:${n.win_likelihood_band ?? ''}:${n.freshness ?? ''}`)
      .join('|')
    const edgePart = graph.edges.map((e) => `${e.from}>${e.to}:${e.relation}:${e.confidence}`).join('|')
    return `${nodePart}##${edgePart}`
  }, [graph])

  useEffect(() => {
    if (!containerRef.current) return

    // Going-Cold rendering: relationships fade as they age (the decay IS the information). Fresh
    // nodes render at full strength; cooling ones dim; cold ones are ghosts you can't unsee.
    const FRESHNESS_OPACITY: Record<string, number> = { fresh: 1, cooling: 0.72, cold: 0.42 }
    const nodeOpacity = (n: GraphNode): number => (n.freshness ? FRESHNESS_OPACITY[n.freshness] : 1)

    const nodesDs = new DataSet(
      graph.nodes.map((n) => {
        const fill = communityColor(n.community_id)
        const ring = n.type === 'deal' && n.win_likelihood_band ? bandColor[n.win_likelihood_band] : fill
        const quiet = n.days_quiet !== undefined ? ` · quiet ${n.days_quiet}d` : ''
        return {
          id: n.id,
          label: n.label,
          title: `${n.label}${quiet}${n.single_threaded ? ' · SINGLE-THREADED' : ''}${n.unmapped ? ' · no people mapped' : ''}`,
          shape: 'dot',
          size: TYPE_SIZE[n.type],
          color: {
            background: fill,
            border: ring,
            highlight: { background: '#ffffff', border: ring },
            opacity: nodeOpacity(n),
          },
          borderWidth: n.type === 'deal' && n.win_likelihood_band ? 3 : 1.5,
          font: { size: 12, color: '#ece6f2' },
          _raw: n,
        }
      }),
    )
    nodesDsRef.current = nodesDs

    // Edge opacity inherits the colder endpoint — a cold relationship's whole thread recedes together.
    const freshnessById = new Map(graph.nodes.map((n) => [n.id, n.freshness]))
    const edgeFade = (from: string, to: string): number => {
      const f = [freshnessById.get(from), freshnessById.get(to)]
      if (f.includes('cold')) return 0.35
      if (f.includes('cooling')) return 0.65
      return 1
    }

    const edgesDs = new DataSet(
      graph.edges.map((e, i) => ({
        id: i,
        from: e.from,
        to: e.to,
        label: '',
        title: `${e.relation} [${e.confidence}]`,
        dashes: e.confidence !== 'EXTRACTED',
        width: e.confidence === 'EXTRACTED' ? 2 : 1,
        color: { opacity: (e.confidence === 'EXTRACTED' ? 0.7 : 0.35) * edgeFade(e.from, e.to), color: '#9645d6' },
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      })),
    )

    const network = new Network(
      containerRef.current,
      { nodes: nodesDs, edges: edgesDs },
      {
        physics: {
          enabled: true,
          solver: 'forceAtlas2Based',
          forceAtlas2Based: {
            gravitationalConstant: -60,
            centralGravity: 0.005,
            springLength: 120,
            springConstant: 0.08,
            damping: 0.4,
            avoidOverlap: 0.8,
          },
          stabilization: { iterations: 200, fit: true },
        },
        interaction: { hover: true, tooltipDelay: 100, hideEdgesOnDrag: true },
        nodes: { shape: 'dot', borderWidth: 1.5 },
        edges: { smooth: { enabled: true, type: 'continuous', roundness: 0.2 } },
      },
    )
    networkRef.current = network

    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } })
    })

    network.on('click', (params: { nodes: string[] }) => {
      if (params.nodes.length > 0) {
        const raw = nodesDs.get(params.nodes[0]) as any
        setSelected(raw._raw)
      }
    })

    return () => {
      network.destroy()
      networkRef.current = null
    }
    // Keyed on the signature (content), not the `graph` object identity — a poll tick that produces
    // an equivalent graph in a freshly-allocated object must NOT rebuild the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSignature])

  // Re-apply combined visibility whenever any filter dimension changes.
  useEffect(() => {
    const ds = nodesDsRef.current
    if (!ds) return
    ds.update(graph.nodes.map((n) => ({ id: n.id, hidden: !nodeVisible(n) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenAccounts, hiddenSectors, hiddenCommunities, hiddenBands, graph.nodes])

  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return graph.nodes.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 20)
  }, [search, graph.nodes])

  function focusNode(id: string) {
    const network = networkRef.current
    if (!network) return
    network.focus(id, { scale: 1.4, animation: true })
    network.selectNodes([id])
    const n = graph.nodes.find((x) => x.id === id) ?? null
    setSelected(n)
    setSearch('')
    setSearchOpen(false)
  }

  function toggleInSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, key: T) {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const neighbors = useMemo(() => {
    if (!selected || !networkRef.current) return []
    const ids = networkRef.current.getConnectedNodes(selected.id) as string[]
    return ids.map((id) => graph.nodes.find((n) => n.id === id)).filter((n): n is GraphNode => Boolean(n))
  }, [selected, graph.nodes])

  const roiSummary = useMemo(() => {
    if (roiScope.type === 'account') return accountSummaries.find((s) => s.key === roiScope.key) ?? emptySummary(roiScope.key ?? '', roiScope.key ?? '')
    if (roiScope.type === 'sector') return sectorSummaries.find((s) => s.key === roiScope.key) ?? emptySummary(roiScope.key ?? '', roiScope.key ?? '')
    return mergeSummaries(accountSummaries)
  }, [roiScope, accountSummaries, sectorSummaries])

  const roiInsights = useMemo(
    () => insights.filter((i) => roiSummary.insight_ids.includes(i.insight_id)),
    [insights, roiSummary],
  )

  // Single-account scope only — the actual cited win/loss reasons for that account, not just band
  // counts. accountSummaries.key === accounts[].slug (both slug(account name) — see brainAdapter.ts).
  const roiAccount = useMemo(() => {
    if (roiScope.type !== 'account' || !roiScope.key) return null
    return accounts.find((a) => a.slug === roiScope.key) ?? null
  }, [roiScope, accounts])

  // Node ids carry a `type:` prefix (e.g. "person:jane-doe"); the bare remainder is the person's slug.
  const selectedPerson = useMemo(() => {
    if (!selected || selected.type !== 'person') return null
    const bare = selected.id.replace(/^[a-z_]+:/, '')
    return people.find((p) => p.slug === bare) ?? null
  }, [selected, people])

  const isThin = accountGroups.length <= 1 && sectorGroups.length <= 1

  return (
    <div className="flex h-[calc(100vh-57px)]">
      <div ref={containerRef} className="flex-1 bg-[var(--color-mantu-bg)]" />

      {/* overflow-y-auto (not -hidden) + every direct child `shrink-0`: the sidebar scrolls as one
          column so no section can be flex-compressed into its neighbour (the old overlap) or clipped
          off the bottom, at any window height. */}
      <aside className="flex w-96 flex-shrink-0 flex-col overflow-y-auto border-l border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)]">
        {/* Search */}
        <div className="relative shrink-0 border-b border-[var(--color-mantu-border)] p-3">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setSearchOpen(true)
            }}
            placeholder="Search nodes..."
            className="w-full rounded-md border border-[var(--color-mantu-border)] bg-black/30 px-3 py-1.5 text-sm text-white/90 outline-none focus:border-mantu"
          />
          {searchOpen && searchMatches.length > 0 && (
            <div className="absolute left-3 right-3 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface-2)] shadow-xl">
              {searchMatches.map((n) => (
                <button
                  key={n.id}
                  onClick={() => focusNode(n.id)}
                  className="block w-full truncate border-l-2 px-3 py-1.5 text-left text-xs text-white/80 hover:bg-white/5"
                  style={{ borderLeftColor: communityColor(n.community_id) }}
                >
                  {n.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Info panel — shrink-0 so a tall node's fields can't be flex-compressed below content
            height (min-h would otherwise defeat min-height:auto), which spilled the neighbors list
            over the "Going cold" panel below. */}
        <div className="min-h-[160px] shrink-0 border-b border-[var(--color-mantu-border)] p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Node info</h3>
          {selected ? (
            <div className="space-y-1 text-xs text-white/70">
              <div className="text-sm font-semibold text-white/90">{selected.label}</div>
              <div>Type: {selected.type}</div>
              {selected.type === 'person' && selectedPerson?.role && <div>Role: {selectedPerson.role}</div>}
              {selected.account && <div>Account: {selected.account}</div>}
              {selected.sector && <div>Sector: {selected.sector}</div>}
              {selected.strategic_group && <div>Strategic group: {selected.strategic_group}</div>}
              <div className="flex items-center gap-1.5">
                Community:
                <span className="h-2 w-2 rounded-full" style={{ background: communityColor(selected.community_id) }} />
                {selected.community_label}
              </div>
              {selected.win_likelihood_band && (
                <div className="flex items-center gap-1.5">
                  Band:
                  <span className="h-2 w-2 rounded-full" style={{ background: bandColor[selected.win_likelihood_band] }} />
                  {bandLabel[selected.win_likelihood_band]}
                </div>
              )}
              {selected.date && <div>Date: {selected.date}</div>}
              {selected.days_quiet !== undefined && (
                <div className="flex items-center gap-1.5">
                  Last touched:
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{
                      // Neutral grey when freshness is unknown — don't default to green ("fresh"), which
                      // would fabricate a healthy signal the data never carried.
                      color: selected.freshness === 'cold' ? '#f7768e' : selected.freshness === 'cooling' ? '#e0af68' : selected.freshness === 'fresh' ? '#9ece6a' : 'rgba(255,255,255,0.5)',
                      background: 'rgba(255,255,255,0.06)',
                    }}
                  >
                    {selected.days_quiet === 0 ? 'today' : `${selected.days_quiet}d ago`}
                    {selected.freshness ? ` · ${selected.freshness}` : ''}
                  </span>
                </div>
              )}
              {selected.single_threaded && (
                <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200/90">
                  Single-threaded — this deal's account has one mapped contact. One departure kills the thread; map a second stakeholder.
                </div>
              )}
              {selected.unmapped && (
                <div className="rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200/90">
                  Unexplored — no people mapped at this account yet. The relationship exists only on paper.
                </div>
              )}
              {selected.is_client_facing !== undefined && (
                <div>{selected.is_client_facing ? 'Client-facing' : 'Internal (not client-facing)'}</div>
              )}
              {selected.ref && <div className="truncate">Source: {selected.ref}</div>}
              <div>Degree: {selected.degree}</div>
              {selected.type === 'deal' && selected.bid_id && (
                <button
                  onClick={() => navigate(`/deals?bid=${selected.bid_id}`)}
                  className="mt-2 rounded-md bg-mantu px-2.5 py-1 text-[11px] font-medium text-white hover:bg-mantu-light"
                >
                  Open in Deal view →
                </button>
              )}
              {neighbors.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[11px] text-white/40">Neighbors ({neighbors.length})</div>
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {neighbors.map((nb) => (
                      <button
                        key={nb.id}
                        onClick={() => focusNode(nb.id)}
                        className="block w-full truncate rounded border-l-2 px-2 py-1 text-left text-[11px] text-white/70 hover:bg-white/5"
                        style={{ borderLeftColor: communityColor(nb.community_id) }}
                      >
                        {nb.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs italic text-white/30">Click a node to inspect it</p>
          )}
        </div>

        {/* Going cold — relationship entropy, named and actionable (innovation #8) */}
        {(data.going_cold?.length ?? 0) > 0 && (
          <div className="shrink-0 border-b border-[var(--color-mantu-border)] p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Going cold</h3>
            <div className="max-h-56 space-y-1.5 overflow-y-auto">
              {data.going_cold!.slice(0, 6).map((r) => (
                <button
                  key={r.nodeId}
                  onClick={() => focusNode(r.nodeId)}
                  className="block w-full rounded-md bg-black/20 px-2 py-1.5 text-left hover:bg-white/5"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="truncate font-medium text-white/85">{r.label}</span>
                    {r.account && <span className="truncate text-[10px] text-white/35">{r.account}</span>}
                    <span
                      className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{ color: r.daysQuiet > 45 ? '#f7768e' : '#e0af68', background: 'rgba(255,255,255,0.06)' }}
                    >
                      {r.daysQuiet}d quiet
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-white/50">{r.hook}</div>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-white/30">
              Hooks come from your own open promises and last real topics — never invented. Faded nodes in
              the graph are these relationships decaying in place.
            </p>
          </div>
        )}

        {/* Win/Loss & ROI intelligence */}
        <div className="shrink-0 border-b border-[var(--color-mantu-border)] p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Win/Loss &amp; ROI</h3>
          <select
            value={roiScope.type === 'all' ? 'all' : `${roiScope.type}:${roiScope.key}`}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'all') setRoiScope({ type: 'all' })
              else {
                const [type, key] = v.split(':') as ['account' | 'sector', string]
                setRoiScope({ type, key })
              }
            }}
            className="mb-2 w-full rounded-md border border-[var(--color-mantu-border)] bg-black/30 px-2 py-1 text-xs text-white/80"
          >
            <option value="all">All accounts &amp; sectors</option>
            {accountSummaries.length > 0 && (
              <optgroup label="By account">
                {accountSummaries.map((s) => (
                  <option key={s.key} value={`account:${s.key}`}>{s.label}</option>
                ))}
              </optgroup>
            )}
            {sectorSummaries.length > 0 && (
              <optgroup label="By sector">
                {sectorSummaries.map((s) => (
                  <option key={s.key} value={`sector:${s.key}`}>{s.label}</option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-black/20 p-2">
              <div className="text-white/40">Deals</div>
              <div className="text-base font-semibold text-white/90">{roiSummary.deal_count}</div>
            </div>
            <div className="rounded-md bg-black/20 p-2">
              <div className="text-white/40">Value at stake</div>
              <div className="text-base font-semibold text-white/90">
                {roiSummary.total_value_usd === null ? '—' : fmtUsd(roiSummary.total_value_usd)}
              </div>
              {roiSummary.total_value_usd === null && (
                <div className="text-[9px] leading-tight text-white/30">no value data in transcripts</div>
              )}
            </div>
          </div>
          <div className="mt-2 flex gap-1.5">
            {(['good', 'mixed', 'concerning'] as WinLikelihoodBand[]).map((b) => (
              <div key={b} className="flex flex-1 items-center gap-1 rounded-md bg-black/20 px-2 py-1 text-[11px]">
                <span className="h-2 w-2 rounded-full" style={{ background: bandColor[b] }} />
                {roiSummary.band_counts[b]} {bandLabel[b]}
              </div>
            ))}
          </div>
          {roiAccount && (roiAccount.win_reasons.length > 0 || roiAccount.loss_reasons.length > 0) && (
            <div className="mt-3 space-y-3">
              <ReasonList title="Why we win" tone="good" reasons={roiAccount.win_reasons} />
              <ReasonList title="Why we lose" tone="concerning" reasons={roiAccount.loss_reasons} />
            </div>
          )}
          {roiInsights.length > 0 ? (
            <div className="mt-3 space-y-1.5">
              <div className="text-[11px] uppercase tracking-wide text-white/40">Why (grounded insights)</div>
              {roiInsights.slice(0, 3).map((i) => (
                <div key={i.insight_id} className="rounded-md border-l-2 border-mantu/60 bg-black/20 px-2 py-1.5 text-[11px] text-white/70">
                  {i.pattern}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-[11px] italic text-white/30">No grounded coaching insights tied to this scope yet.</p>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-white/30">
            Win-likelihood distribution is real, cited data. Deal value shows only when a source
            recorded one — transcripts carry no money data, so the live brain never invents a figure.
            No fabricated ROI % either: there's no cost/spend data to compute one against.
          </p>
        </div>

        {/* Filters + community legend */}
        <div className="shrink-0 p-4">
          {isThin && (
            <p className="mb-3 rounded-md border border-amber-400/20 bg-amber-400/5 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200/80">
              {accountGroups.length} account · {sectorGroups.length} sector · {communityGroups.length} community in
              today's data — filters below are real and ready to scale, there just isn't diversity to filter across
              yet.
            </p>
          )}

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Account</h3>
          <div className="mb-4 space-y-1">
            {accountGroups.map(([key, count]) => (
              <label
                key={key}
                className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-white/5 ${hiddenAccounts.has(key) ? 'opacity-35' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={!hiddenAccounts.has(key)}
                  onChange={() => toggleInSet(setHiddenAccounts, key)}
                  className="accent-mantu"
                />
                <span className="flex-1 truncate text-white/70">{key}</span>
                <span className="text-[10px] text-white/30">{count}</span>
              </label>
            ))}
          </div>

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Sector</h3>
          <div className="mb-4 space-y-1">
            {sectorGroups.map(([key, count]) => (
              <label
                key={key}
                className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-white/5 ${hiddenSectors.has(key) ? 'opacity-35' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={!hiddenSectors.has(key)}
                  onChange={() => toggleInSet(setHiddenSectors, key)}
                  className="accent-mantu"
                />
                <span className="flex-1 truncate text-white/70">{key}</span>
                <span className="text-[10px] text-white/30">{count}</span>
              </label>
            ))}
          </div>

          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-white/40">Communities</h3>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/50 hover:text-white/80">
              <input
                type="checkbox"
                checked={hiddenCommunities.size === 0}
                ref={(el) => {
                  if (el) el.indeterminate = hiddenCommunities.size > 0 && hiddenCommunities.size < communityGroups.length
                }}
                onChange={(e) => setHiddenCommunities(e.target.checked ? new Set() : new Set(communityGroups.map(([id]) => id)))}
                className="accent-mantu"
              />
              Select all
            </label>
          </div>
          <div className="mb-4 space-y-1">
            {communityGroups.map(([id, { label, count }]) => (
              <label
                key={id}
                className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-white/5 ${hiddenCommunities.has(id) ? 'opacity-35' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={!hiddenCommunities.has(id)}
                  onChange={() => toggleInSet(setHiddenCommunities, id)}
                  className="accent-mantu"
                />
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: communityColor(id) }} />
                <span className="flex-1 truncate text-white/70">{label}</span>
                <span className="text-[10px] text-white/30">{count}</span>
              </label>
            ))}
          </div>

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Win-likelihood band</h3>
          <div className="space-y-1">
            {(['good', 'mixed', 'concerning'] as WinLikelihoodBand[]).map((band) => (
              <label
                key={band}
                className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-white/5 ${hiddenBands.has(band) ? 'opacity-35' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={!hiddenBands.has(band)}
                  onChange={() => toggleInSet(setHiddenBands, band)}
                  className="accent-mantu"
                />
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: bandColor[band] }} />
                <span className="flex-1 text-white/70">{bandLabel[band]}</span>
              </label>
            ))}
          </div>

          <p className="mt-4 text-[10px] leading-relaxed text-white/30">
            Node fill = community (real connected-component clustering, not hand-assigned). Deal-node ring =
            win-likelihood band. Solid edges = extracted directly from source. Dashed = inferred or ambiguous.
            Fading = going cold: full strength ≤14 days since last meeting, dimmed ≤45, ghosted beyond —
            relationship entropy made visible.
          </p>
        </div>

        <div className="shrink-0 border-t border-[var(--color-mantu-border)] px-4 py-2 text-[11px] text-white/30">
          {graph.nodes.length} nodes · {graph.edges.length} edges · {communityGroups.length} communit{communityGroups.length === 1 ? 'y' : 'ies'}
        </div>
      </aside>
    </div>
  )
}

/** The actual cited reasons behind an account's win/loss record — statement up front, verbatim
 *  quote in the title tooltip so the row stays scannable. Capped by the caller, not here. */
function ReasonList({ title, tone, reasons }: { title: string; tone: WinLikelihoodBand; reasons: Reason[] }) {
  if (reasons.length === 0) return null
  const shown = reasons.slice(0, 3)
  const extra = reasons.length - shown.length
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-white/40">
        <span className="h-2 w-2 rounded-full" style={{ background: bandColor[tone] }} />
        {title}
      </div>
      <div className="space-y-1.5">
        {shown.map((r, i) => (
          <div
            key={i}
            title={r.quote}
            className="rounded-md border-l-2 bg-black/20 px-2 py-1.5 text-[11px] text-white/70"
            style={{ borderLeftColor: bandColor[tone] }}
          >
            {r.statement}
          </div>
        ))}
        {extra > 0 && <div className="pl-2 text-[10px] text-white/30">+{extra} more</div>}
      </div>
    </div>
  )
}
