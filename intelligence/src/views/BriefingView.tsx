import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import type { Commitment, DashboardData, GoingColdRow } from '../types/data'
import { bandDistribution, ledgerTotals, agingBuckets, type AgeBucketLabel } from '../lib/ledgerstats'
import { COOLING_DAYS } from '../lib/goingCold'
import { StatTile } from '../components/charts'

// framer-motion wrapper around the router Link, so the attention rows animate in like every other
// list on this page while still navigating through HashRouter (raw hash anchors are reserved for
// the cross-frame embed case).
const MotionLink = motion.create(Link)

interface Props {
  data: DashboardData
}

/**
 * Morning Briefing — the "what do I look at first" landing view. Every number and every reason string
 * on this page is read straight off an existing field (win_likelihood_band, commitment status/date,
 * going-cold freshness, single-threaded flag, velocity signal). Nothing here is an LLM-invented
 * explanation — the "Needs attention" score is just a fixed-weight sum over those real facts, used only
 * to order the list, never displayed as a fabricated metric itself.
 */

const AGING_ORDER: AgeBucketLabel[] = ['>90d', '30-90d']
const AGING_AGE_LABEL: Record<string, string> = { '>90d': '90+ days open', '30-90d': '30-90 days open' }

interface AttentionItem {
  bidId: string
  label: string
  account: string
  score: number
  reasons: string[]
}

/** Scores each OPEN deal on real, cited signals only. Closed deals don't need morning attention. */
function buildAttention(data: DashboardData, now: number): AttentionItem[] {
  const nodesById = new Map(data.account_graph.nodes.map((n) => [n.id, n]))
  const items: AttentionItem[] = []

  for (const deal of data.deals) {
    if (deal.outcome !== 'open') continue
    // Defensive: commitments/velocity are type-required but a real brain record can still omit them
    // (same guard DealView.tsx already applies) — read unguarded and one absent field would crash here.
    const commitments = deal.commitments ?? []
    const broken = commitments.filter((c) => c.status === 'broken').length
    const veryOld = agingBuckets(commitments, now).buckets.find((b) => b.label === '>90d')?.items.length ?? 0
    const node = nodesById.get(`deal:${deal.bid_id}`)

    let score = 0
    const reasons: string[] = []

    if (deal.win_likelihood_band === 'concerning') {
      score += 3
      reasons.push('Concerning win likelihood')
    }
    if (broken > 0) {
      score += broken * 2
      reasons.push(`${broken} broken commitment${broken === 1 ? '' : 's'}`)
    }
    if (veryOld > 0) {
      score += veryOld
      reasons.push(`${veryOld} commitment${veryOld === 1 ? '' : 's'} open 90+ days`)
    }
    if (node?.single_threaded) {
      score += 2
      reasons.push('Single-threaded account')
    }
    // freshness/days_quiet on a deal node are computed from THAT DEAL's own meeting list
    // (goingCold.ts) — label it as deal staleness, not account staleness.
    if (node?.freshness === 'cold') {
      score += 2
      reasons.push(`Deal cold · ${node.days_quiet}d quiet`)
    } else if (node?.freshness === 'cooling') {
      score += 1
      reasons.push(`Deal cooling · ${node.days_quiet}d quiet`)
    }
    if (deal.velocity?.signal === 'no-hard-date-found') {
      score += 1
      reasons.push('No hard date on calendar')
    }

    if (score > 0) items.push({ bidId: deal.bid_id, label: deal.display_name, account: deal.account, score, reasons })
  }

  return items.sort((a, b) => b.score - a.score)
}

interface OwnedCommitment {
  commitment: Commitment
  ownerLabel: string
  /** Hash-link href, or null when the owner doesn't resolve to a real node (rendered as plain text then). */
  ownerHref: string | null
}

/** Flattens deal + person commitment ledgers into one list. The same promise can be echoed in both a
 *  deal's ledger and a person's ledger (see StatsView.tsx's dedupeCommitments) — dedupe on
 *  text+by+meeting+date, first occurrence wins, deals checked before people. */
function flattenCommitments(data: DashboardData, nodeIds: Set<string>): OwnedCommitment[] {
  const seen = new Set<string>()
  const out: OwnedCommitment[] = []

  for (const d of data.deals) {
    for (const c of d.commitments ?? []) {
      const key = `${c.text}||${c.by}||${c.meeting}||${c.date}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ commitment: c, ownerLabel: d.display_name, ownerHref: `/deals?bid=${d.bid_id}` })
    }
  }
  for (const p of data.people) {
    for (const c of p.commitments ?? []) {
      const key = `${c.text}||${c.by}||${c.meeting}||${c.date}`
      if (seen.has(key)) continue
      seen.add(key)
      const nodeId = `person:${p.slug}`
      out.push({ commitment: c, ownerLabel: p.name, ownerHref: nodeIds.has(nodeId) ? `/graph?focus=${nodeId}` : null })
    }
  }
  return out
}

export function BriefingView({ data }: Props) {
  const now = Date.now()

  const allCommitments = useMemo(
    () => [...data.deals.flatMap((d) => d.commitments ?? []), ...data.people.flatMap((p) => p.commitments ?? [])],
    [data.deals, data.people],
  )
  const ledger = useMemo(() => ledgerTotals(allCommitments), [allCommitments])
  const openDeals = useMemo(() => data.deals.filter((d) => d.outcome === 'open'), [data.deals])
  // Open deals only — every other number on this page is scoped to open work, and a lost deal's
  // concerning band is not a "this morning" signal.
  const bands = useMemo(() => bandDistribution(openDeals), [openDeals])
  const goingCold: GoingColdRow[] = data.going_cold ?? []

  const attention = useMemo(() => buildAttention(data, now), [data, now])

  const nodeIds = useMemo(() => new Set(data.account_graph.nodes.map((n) => n.id)), [data.account_graph.nodes])
  const owned = useMemo(() => flattenCommitments(data, nodeIds), [data, nodeIds])
  const broken = useMemo(() => owned.filter((o) => o.commitment.status === 'broken'), [owned])
  const aging = useMemo(() => {
    const open = owned.filter((o) => o.commitment.status === 'open')
    // agingBuckets returns the SAME commitment object references it was given, so a reference-keyed
    // map recovers each bucket item's owner without a second pass or a fragile equality re-derivation.
    const ownedByCommitment = new Map(open.map((o) => [o.commitment, o]))
    const bucketed = agingBuckets(open.map((o) => o.commitment), now)
    const bucketItems = new Map(bucketed.buckets.map((b) => [b.label, b.items]))

    const rows: (OwnedCommitment & { ageLabel: string })[] = []
    for (const label of AGING_ORDER) {
      for (const c of bucketItems.get(label) ?? []) {
        const match = ownedByCommitment.get(c)
        if (match) rows.push({ ...match, ageLabel: AGING_AGE_LABEL[label] })
      }
    }
    // Open commitments whose date can't be parsed never age into a bucket — surface their count so
    // "No open commitments 30+ days old" can't read as an all-clear while undated promises sit open.
    return { rows, undated: bucketed.undated.length }
  }, [owned, now])

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-6">
        <h1 className="text-2xl font-semibold text-white/95">Today</h1>
        <p className="mt-1 text-sm text-white/50">
          What needs your attention this morning, ranked by real signals already sitting in your data.
        </p>
      </motion.div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Open deals" value={openDeals.length} />
        <StatTile label="Needs attention" value={attention.length} />
        <StatTile label="Concerning band" value={bands.concerning} />
        <StatTile label="Going cold" value={goingCold.length} />
        <StatTile label="Broken commitments" value={ledger.broken} />
        <StatTile
          label="Kept rate"
          value={ledger.keptRate === null ? null : Math.round(ledger.keptRate * 100)}
          suffix={ledger.keptRate === null ? '' : '%'}
          hint={ledger.keptRate === null ? 'nothing settled yet' : undefined}
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-8 lg:col-span-2">
          <Section title="Needs attention">
            <Card>
              {attention.length === 0 ? (
                <Empty
                  text={
                    openDeals.length === 0
                      ? 'No open deals tracked yet.'
                      : 'Nothing needs attention right now. Every open deal looks healthy.'
                  }
                />
              ) : (
                <div className="space-y-2">
                  {attention.slice(0, 8).map((item, i) => (
                    <MotionLink
                      key={item.bidId}
                      to={`/deals?bid=${item.bidId}`}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04 }}
                      className="block rounded-lg border border-white/5 bg-black/20 p-3 transition-colors hover:border-mantu/40 hover:bg-white/5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-white/90">{item.label}</span>
                        <span className="truncate text-[11px] text-white/35">{item.account}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {item.reasons.map((r) => (
                          <span
                            key={r}
                            className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/50"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    </MotionLink>
                  ))}
                  {attention.length > 8 && (
                    <p className="pt-1 text-[11px] text-white/30">
                      +{attention.length - 8} more deal{attention.length - 8 === 1 ? '' : 's'} need attention. See
                      the Deals view for the full list.
                    </p>
                  )}
                </div>
              )}
            </Card>
          </Section>

          <Section title="Broken &amp; aging commitments">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardLabel>Broken ({broken.length})</CardLabel>
                {broken.length === 0 ? (
                  <Empty text="No broken commitments." />
                ) : (
                  <div className="space-y-2">
                    {broken.slice(0, 6).map((o, i) => (
                      <CommitmentRow key={i} owned={o} tone="broken" />
                    ))}
                    {broken.length > 6 && (
                      <p className="pt-0.5 text-[11px] text-white/30">+{broken.length - 6} more broken.</p>
                    )}
                  </div>
                )}
              </Card>
              <Card>
                <CardLabel>Aging open ({aging.rows.length})</CardLabel>
                {aging.rows.length === 0 ? (
                  <Empty text="No open commitments 30+ days old." />
                ) : (
                  <div className="space-y-2">
                    {aging.rows.slice(0, 6).map((o, i) => (
                      <CommitmentRow key={i} owned={o} tone="aging" ageLabel={o.ageLabel} />
                    ))}
                    {aging.rows.length > 6 && (
                      <p className="pt-0.5 text-[11px] text-white/30">+{aging.rows.length - 6} more aging.</p>
                    )}
                  </div>
                )}
                {aging.undated > 0 && (
                  <p className="pt-1.5 text-[11px] text-white/30">
                    +{aging.undated} open commitment{aging.undated === 1 ? '' : 's'} with no parseable date, not
                    aged above.
                  </p>
                )}
              </Card>
            </div>
          </Section>
        </div>

        <div className="lg:col-span-1">
          <Section title="Going cold">
            <Card>
              {goingCold.length === 0 ? (
                <Empty text="Nothing going cold. Every mapped relationship has been touched recently." />
              ) : (
                <div className="space-y-1.5">
                  {goingCold.slice(0, 8).map((r) => {
                    const href = nodeIds.has(r.nodeId) ? `/graph?focus=${r.nodeId}` : null
                    const body = (
                      <>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="truncate font-medium text-white/85">{r.label}</span>
                          {r.account && <span className="truncate text-[10px] text-white/35">{r.account}</span>}
                          <span
                            className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                            style={{ color: r.daysQuiet > COOLING_DAYS ? '#f7768e' : '#e0af68', background: 'rgba(255,255,255,0.06)' }}
                          >
                            {r.daysQuiet}d quiet
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-white/50">{r.hook}</div>
                      </>
                    )
                    return href ? (
                      <Link
                        key={r.nodeId}
                        to={href}
                        className="block rounded-md bg-black/20 px-2 py-1.5 hover:bg-white/5"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div key={r.nodeId} className="rounded-md bg-black/20 px-2 py-1.5">
                        {body}
                      </div>
                    )
                  })}
                  {goingCold.length > 8 && (
                    <p className="pt-1 text-[11px] text-white/30">
                      +{goingCold.length - 8} more. See the Relationships view for the full rail.
                    </p>
                  )}
                </div>
              )}
            </Card>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">{title}</h2>
      {children}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
      {children}
    </div>
  )
}

function CardLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-xs font-medium text-white/50">{children}</div>
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs text-white/30">{text}</div>
}

function CommitmentRow({
  owned,
  tone,
  ageLabel,
}: {
  owned: OwnedCommitment
  tone: 'broken' | 'aging'
  ageLabel?: string
}) {
  const { commitment: c, ownerLabel, ownerHref } = owned
  const badge = tone === 'broken' ? 'Broken' : ageLabel ?? 'Aging'
  const badgeStyle = tone === 'broken' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'
  const content = (
    <div className="rounded-lg border border-white/5 bg-black/20 p-2.5" title={c.quote || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badgeStyle}`}>{badge}</span>
        {c.date && <span className="text-[10px] text-white/35">{c.date}</span>}
      </div>
      <p className="mt-1 break-words text-xs text-white/80 [overflow-wrap:anywhere]">{c.text}</p>
      <div className="mt-1 text-[10px] text-white/40">
        {ownerLabel} · by {c.by}
      </div>
    </div>
  )
  return ownerHref ? (
    <Link to={ownerHref} className="block transition-colors hover:brightness-110">
      {content}
    </Link>
  ) : (
    content
  )
}
