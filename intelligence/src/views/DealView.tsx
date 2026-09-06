import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link, useSearchParams } from 'react-router-dom'
import type { Commitment, DashboardData, GraphNode, Grounding } from '../types/data'
import {
  bandColor,
  bandLabel,
  categoryLabel,
  fmtAmount,
  groundingColor,
  groundingLabel,
  outcomeLabel,
} from '../lib/format'
import { ledgerTotals } from '../lib/ledgerstats'
import { slug } from '../lib/slug'
import { Timeline } from '../components/Timeline'
import { AcceptSuggestion } from '../components/AcceptSuggestion'
import { EmptyState } from '../components/EmptyState'

interface Props {
  data: DashboardData
}

// Internal-only calls (prep, dry-runs, debriefs) are deliberately never graded as if they were client
// interactions — 'not-applicable' is a real, expected value, not a missing one.
const gradeColor: Record<string, string> = {
  good: '#35c98f',
  mixed: '#e0a836',
  concerning: '#e05a6b',
  'not-applicable': '#4a4a5e',
}
const gradeGlyph: Record<string, string> = {
  good: '✓',
  mixed: '~',
  concerning: '!',
  'not-applicable': '–',
}

// Humanized labels for the brain's velocity-signal vocabulary (deal.velocity.signal).
const velocityLabel: Record<string, string> = {
  'hard-calendar-gate': 'Hard date on calendar',
  'soft-organizational-gate': 'Soft organizational gate',
  'no-hard-date-found': 'No hard date found',
}

// Same chip language as StanceTag below — open/kept/broken commitment status.
const commitmentStatusStyle: Record<string, string> = {
  open: 'bg-amber-500/15 text-amber-300',
  kept: 'bg-emerald-500/15 text-emerald-300',
  broken: 'bg-rose-500/15 text-rose-300',
}

// Deep-link contract: `account:<slug>` / `person:<slug>` match the id convention minted at ingest
// (src/main/brain/ingest.ts) and carried through unchanged in account_graph.nodes — only link when
// that exact node exists, otherwise a mention stays the plain text it is today. 'you'/'them' are the
// ledger's own sentinels for the rep and the counterparty, never real people to link to.
const MENTION_SENTINELS = new Set(['you', 'them'])

function personNodeId(name: string | null | undefined): string | null {
  const trimmed = name?.trim()
  if (!trimmed || MENTION_SENTINELS.has(trimmed.toLowerCase())) return null
  return `person:${slug(trimmed)}`
}

function accountNodeId(name: string | null | undefined): string | null {
  const trimmed = name?.trim()
  if (!trimmed) return null
  return `account:${slug(trimmed)}`
}

interface DealRisk {
  score: number
  reasons: string[]
}

// Signals the chip row doesn't already show via its win-likelihood dot: the account_graph's own read
// on this deal's relationship health (freshness/single-threaded, from goingCold's build-time analysis)
// plus the commitment ledger's broken-promise count. A clean deal with none of these fires no badge.
function dealRisk(commitments: Commitment[], node: GraphNode | undefined): DealRisk {
  const broken = ledgerTotals(commitments).broken
  let score = 0
  const reasons: string[] = []
  if (node?.freshness === 'cold') {
    score += 3
    reasons.push('going cold')
  } else if (node?.freshness === 'cooling') {
    score += 1
    reasons.push('cooling')
  }
  if (node?.single_threaded) {
    score += 2
    reasons.push('single-threaded')
  }
  if (broken > 0) {
    score += broken * 2
    reasons.push(`${broken} broken commitment${broken > 1 ? 's' : ''}`)
  }
  return { score, reasons }
}

export function DealView({ data }: Props) {
  const [params, setParams] = useSearchParams()
  const bidParam = params.get('bid')
  const [selected, setSelected] = useState(bidParam ?? data.deals[0]?.bid_id ?? '')

  useEffect(() => {
    if (bidParam && bidParam !== selected) setSelected(bidParam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bidParam])

  const deal = useMemo(
    () => data.deals.find((d) => d.bid_id === selected),
    [data.deals, selected],
  )

  // Real node ids from the same graph the Relationships tab renders — a mention only becomes a link
  // when a matching node genuinely exists.
  const graphNodeIds = useMemo(
    () => new Set(data.account_graph.nodes.map((n) => n.id)),
    [data.account_graph.nodes],
  )

  // Chip picker, risk-first: join each deal to its own account_graph node (by type + bid_id) for the
  // relationship-health signals, score it alongside its broken-commitment count, and put the deal that
  // most needs attention leftmost — no separate screen required to find it.
  const rankedDeals = useMemo(() => {
    const dealNodeByBidId = new Map<string, GraphNode>()
    for (const n of data.account_graph.nodes) {
      if (n.type === 'deal' && n.bid_id) dealNodeByBidId.set(n.bid_id, n)
    }
    return data.deals
      .map((d) => ({ deal: d, risk: dealRisk(d.commitments ?? [], dealNodeByBidId.get(d.bid_id)) }))
      .sort((a, b) => b.risk.score - a.risk.score)
  }, [data.deals, data.account_graph.nodes])

  function selectDeal(bidId: string) {
    setSelected(bidId)
    setParams({ bid: bidId })
  }

  if (!deal) {
    // Deep-link to a bid_id that no longer exists (renamed/merged deal, stale bookmark) is a different
    // case from a genuinely empty brain — the old `?? data.deals[0]` silently showed the WRONG deal instead.
    if (bidParam && data.deals.length > 0) {
      return (
        <div className="mx-auto max-w-7xl px-6 py-8">
          <h1 className="text-2xl font-semibold text-white/95">Deal breakdown</h1>
          <div className="mt-6 rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-6 text-sm text-white/60">
            No deal named &ldquo;{bidParam}&rdquo;. It may have been renamed or merged. {' '}
            <button
              onClick={() => selectDeal(data.deals[0].bid_id)}
              className="text-mantu-light hover:underline"
            >
              Go to {data.deals[0].display_name}
            </button>
            .
          </div>
        </div>
      )
    }
    return (
      <EmptyState
        title="Deals"
        standfirst="Every mapped deal, with stage, commitments, and the meetings that named it."
        headline="No deals mapped yet."
        body="Deals appear here as Métis extracts them from your meetings. Save a client-facing meeting that names an opportunity, then use Update Intelligence. If this brain looks empty, reconnect OneDrive in Settings → Brain."
      />
    )
  }

  // Defensive: velocity/commitments are type-required but a real brain record (or a hand-built data.json)
  // can omit them — read them unguarded and one absent field would crash the whole view (now also caught
  // by the route ErrorBoundary, but degrade in place rather than blanking the view).
  const commitments = deal.commitments ?? []
  const commitmentTotals = ledgerTotals(commitments)
  // Open commitments surface first (they need attention); within each group, newest first.
  const sortedCommitments = [...commitments].sort((a, b) => {
    if (a.status === 'open' && b.status !== 'open') return -1
    if (a.status !== 'open' && b.status === 'open') return 1
    return (b.date ?? '').localeCompare(a.date ?? '')
  })

  const accountLinkId = accountNodeId(deal.account)
  const accountIsLinkable = accountLinkId !== null && graphNodeIds.has(accountLinkId)

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">Deal breakdown</h1>
      <p className="mt-1 text-sm text-white/50">
        Per-deal psychology claims and call-grade timeline.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        {rankedDeals.map(({ deal: d, risk }) => (
          <button
            key={d.bid_id}
            onClick={() => selectDeal(d.bid_id)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              d.bid_id === deal.bid_id
                ? 'border-mantu bg-mantu text-white'
                : 'border-white/10 bg-white/5 text-white/60 hover:border-mantu/40'
            }`}
          >
            <span
              className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
              style={{ background: d.win_likelihood_band ? bandColor[d.win_likelihood_band] : 'rgba(255,255,255,0.28)' }}
            />
            {risk.score > 0 && (
              <span
                className="mr-1.5 inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full align-middle text-[8px] font-bold text-black/80"
                style={{ background: gradeColor.concerning }}
                title={`At risk: ${risk.reasons.join(', ')}`}
              >
                !
              </span>
            )}
            {d.display_name}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={deal.bid_id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
          className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3"
        >
          <div className="lg:col-span-1 space-y-4">
            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <h2 className="text-lg font-semibold text-white/90">{deal.display_name}</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <Row
                  label="Account"
                  value={deal.account}
                  linkTo={accountIsLinkable ? `/graph?focus=${accountLinkId}` : undefined}
                  linkTitle={accountIsLinkable ? `Open ${deal.account} in Relationships` : undefined}
                />
                {deal.strategic_group && <Row label="Strategic group" value={deal.strategic_group} />}
                <Row label="Sector" value={deal.sector} />
                <Row
                  label="Stage"
                  value={deal.stage}
                  extra={
                    deal.field_state?.stage === 'extracted' && (
                      <AcceptSuggestion entityKind="deal" entityId={deal.bid_id} field="stage" />
                    )
                  }
                />
                <Row label="Outcome" value={outcomeLabel[deal.outcome]} />
                {deal.amount ? (
                  <Row
                    label="Value"
                    value={fmtAmount(deal.amount.currency, deal.amount.value)}
                    title={deal.amount.quote || undefined}
                  />
                ) : (
                  deal.amount_pending && (
                    <Row
                      label="Value"
                      value={`${fmtAmount(deal.amount_pending.currency, deal.amount_pending.value)} (unconfirmed)`}
                      title={deal.amount_pending.quote || 'Extracted from a meeting, not yet reviewed.'}
                      extra={<AcceptSuggestion entityKind="deal" entityId={deal.bid_id} field="amount" />}
                    />
                  )
                )}
                {deal.close_date ? (
                  <Row label="Close date" value={deal.close_date} />
                ) : (
                  deal.close_date_pending && (
                    <Row
                      label="Close date"
                      value={`${deal.close_date_pending.value} (unconfirmed)`}
                      title={deal.close_date_pending.quote || 'Extracted from a meeting, not yet reviewed.'}
                      extra={<AcceptSuggestion entityKind="deal" entityId={deal.bid_id} field="close_date" />}
                    />
                  )
                )}
                <Row
                  label="Win likelihood"
                  value={deal.win_likelihood_band ? bandLabel[deal.win_likelihood_band] : 'Ungraded (no cited evidence)'}
                  dot={deal.win_likelihood_band ? bandColor[deal.win_likelihood_band] : 'rgba(255,255,255,0.28)'}
                  extra={
                    deal.field_state?.win_likelihood_band === 'extracted' && (
                      <AcceptSuggestion entityKind="deal" entityId={deal.bid_id} field="win_likelihood_band" />
                    )
                  }
                />
                {deal.band_evidence && (
                  <div className="border-b border-white/5 pb-1.5 text-[11px] italic text-white/40">
                    Why this band: &ldquo;{deal.band_evidence}&rdquo;
                  </div>
                )}
                {deal.velocity && (
                  <>
                    <Row
                      label="Velocity"
                      value={velocityLabel[deal.velocity.signal] ?? deal.velocity.signal}
                      title={deal.velocity.evidence || undefined}
                      extra={
                        deal.field_state?.velocity === 'extracted' && (
                          <AcceptSuggestion entityKind="deal" entityId={deal.bid_id} field="velocity" />
                        )
                      }
                    />
                    {deal.velocity.evidence && (
                      <div className="text-[11px] text-white/40">{deal.velocity.evidence}</div>
                    )}
                  </>
                )}
              </dl>
            </div>

            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
                Meeting history
              </h3>
              <Timeline meetings={deal.meetings ?? []} emptyText="No meetings mapped to this deal yet." />
            </div>

            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-white/60">
                  Commitments
                </h3>
                <span className="text-[11px] text-white/40">
                  {commitmentTotals.open} open · {commitmentTotals.kept} kept ·{' '}
                  {commitmentTotals.broken} broken
                </span>
              </div>
              <div className="space-y-3">
                {sortedCommitments.map((c, i) => {
                  const byId = personNodeId(c.by)
                  const byIsLinkable = byId !== null && graphNodeIds.has(byId)
                  return (
                    <div
                      key={i}
                      className="rounded-lg border border-white/5 bg-black/20 p-3"
                      title={c.quote || undefined}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${commitmentStatusStyle[c.status] ?? ''}`}
                        >
                          {c.status}
                        </span>
                        <span className="text-[11px] text-white/40">{c.date}</span>
                      </div>
                      <p className="mt-1.5 break-words text-xs text-white/80 [overflow-wrap:anywhere]">{c.text}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-white/40">
                        <span>
                          By{' '}
                          {byIsLinkable ? (
                            <Link
                              to={`/graph?focus=${byId}`}
                              title={`Open ${c.by} in Relationships`}
                              className="hover:text-mantu-light hover:underline"
                            >
                              {c.by}
                            </Link>
                          ) : (
                            c.by
                          )}
                        </span>
                        {c.due_hint && <span>· Due {c.due_hint}</span>}
                      </div>
                    </div>
                  )
                })}
                {commitments.length === 0 && (
                  <div className="text-xs text-white/30">
                    No commitments captured on this deal yet.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
                Call-grade timeline
              </h3>
              <div className="space-y-3">
                {deal.call_grades.map((cg, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.08 }}
                    className="flex items-start gap-3"
                  >
                    <div
                      className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-black/80"
                      style={{ background: gradeColor[cg.grade] }}
                      title={cg.grade}
                    >
                      {gradeGlyph[cg.grade]}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-white/80">
                        {cg.label}
                        {/* `=== false` on purpose: undefined means the extraction never named an
                            account, which is missing attribution, not proof of an internal call. */}
                        {cg.is_client_facing === false && (
                          <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-normal uppercase tracking-wide text-white/40">
                            internal
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-white/40">{cg.date}</div>
                      <div className="mt-0.5 text-xs text-white/50">{cg.note}</div>
                    </div>
                  </motion.div>
                ))}
                {deal.call_grades.length === 0 && (
                  <div className="text-xs text-white/30">No call grades recorded.</div>
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
              Psychology claims ({deal.claims.length})
            </h3>
            <div className="space-y-3">
              {deal.claims.map((claim, i) => {
                const raisedById = personNodeId(claim.raised_by)
                const raisedByIsLinkable = raisedById !== null && graphNodeIds.has(raisedById)
                return (
                  <motion.div
                    key={claim.claim_id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="rounded-lg border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-mantu/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-mantu-light">
                          {categoryLabel[claim.category]}
                        </span>
                        <StanceTag stance={claim.stance} />
                      </div>
                      <GroundingBadge g={claim.source.grounding} />
                    </div>
                    <p className="mt-2 break-words text-sm text-white/85 [overflow-wrap:anywhere]">{claim.statement}</p>
                    <div className="mt-2 rounded-md bg-black/20 p-2 text-xs text-white/50">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-mono text-[10px] text-mantu-light/80">
                          {claim.source.file}
                        </span>
                        {claim.raised_by && (
                          <span className="text-[10px]">
                            Raised by{' '}
                            {raisedByIsLinkable ? (
                              <Link
                                to={`/graph?focus=${raisedById}`}
                                title={`Open ${claim.raised_by} in Relationships`}
                                className="hover:text-mantu-light hover:underline"
                              >
                                {claim.raised_by}
                              </Link>
                            ) : (
                              claim.raised_by
                            )}
                          </span>
                        )}
                      </div>
                      <div className="break-words italic [overflow-wrap:anywhere]">&ldquo;{claim.source.quote_or_paraphrase}&rdquo;</div>
                    </div>
                  </motion.div>
                )
              })}
              {deal.claims.length === 0 && (
                <div className="rounded-lg border border-dashed border-white/15 p-6 text-center text-xs text-white/30">
                  No claims extracted for this deal yet.
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function Row({
  label,
  value,
  dot,
  title,
  linkTo,
  linkTitle,
  extra,
}: {
  label: string
  value: string
  dot?: string
  title?: string
  linkTo?: string
  linkTitle?: string
  // Rendered after the value — the dashboard's Accept-suggestion affordance, when a caller has one.
  extra?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 pb-1.5">
      <dt className="text-white/40">{label}</dt>
      <dd className="flex items-center gap-1.5 font-medium text-white/85" title={title}>
        {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} />}
        {linkTo ? (
          <Link to={linkTo} title={linkTitle} className="hover:text-mantu-light hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
        {extra}
      </dd>
    </div>
  )
}

function StanceTag({ stance }: { stance: string }) {
  const styles: Record<string, string> = {
    objection: 'bg-rose-500/15 text-rose-300',
    'positive-signal': 'bg-emerald-500/15 text-emerald-300',
    'neutral-observation': 'bg-white/10 text-white/60',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${styles[stance] ?? ''}`}>
      {stance.replace('-', ' ')}
    </span>
  )
}

function GroundingBadge({ g }: { g: Grounding }) {
  return (
    <div className="flex items-center gap-1 text-[10px] text-white/50">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: groundingColor[g] }} />
      {groundingLabel[g]}
    </div>
  )
}
