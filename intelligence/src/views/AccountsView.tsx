import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link, useSearchParams } from 'react-router-dom'
import type { DashboardData } from '../types/data'
import { freshnessColor, freshnessLabel } from '../lib/format'
import { slug } from '../lib/slug'
import { Timeline } from '../components/Timeline'

interface Props {
  data: DashboardData
}

/** Master-detail account list, mirroring DealView.tsx's structure (chip picker + detail grid) so an
 *  account reads with the same shape a deal does — sector/strategic overview, meeting history, mapped
 *  people, associated deals, and the cited reasons this account has won/lost on. */
export function AccountsView({ data }: Props) {
  const [params, setParams] = useSearchParams()
  const acctParam = params.get('acct')
  const [selected, setSelected] = useState(acctParam ?? data.accounts[0]?.slug ?? '')

  useEffect(() => {
    if (acctParam && acctParam !== selected) setSelected(acctParam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acctParam])

  const account = useMemo(
    () => data.accounts.find((a) => a.slug === selected) ?? data.accounts[0],
    [data.accounts, selected],
  )

  const nodeById = useMemo(
    () => new Map(data.account_graph.nodes.map((n) => [n.id, n])),
    [data.account_graph.nodes],
  )
  const graphNodeIds = useMemo(() => new Set(nodeById.keys()), [nodeById])

  function selectAccount(acctSlug: string) {
    setSelected(acctSlug)
    setParams({ acct: acctSlug })
  }

  if (!account) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-8 text-sm text-white/50">No accounts available.</div>
    )
  }

  const node = nodeById.get(`account:${account.slug}`)
  // Joined by slug, not raw name equality — deal.account/person.account and account.name are
  // independently frozen at different first-creation timestamps in ingest.ts, so casing/punctuation
  // drift between two extractions of the same account name must still resolve to the same account
  // (same join convention brainAdapter.ts's accountSummaries already uses).
  const dealsHere = data.deals.filter((d) => slug(d.account) === account.slug)
  const peopleHere = data.people.filter((p) => p.account && slug(p.account) === account.slug)

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">Accounts</h1>
      <p className="mt-1 text-sm text-white/50">Every mapped account — relationships, deals, and why you win or lose.</p>

      <div className="mt-6 flex flex-wrap gap-2">
        {data.accounts.map((a) => {
          const n = nodeById.get(`account:${a.slug}`)
          return (
            <button
              key={a.slug}
              onClick={() => selectAccount(a.slug)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                a.slug === account.slug
                  ? 'border-mantu bg-mantu text-white'
                  : 'border-white/10 bg-white/5 text-white/60 hover:border-mantu/40'
              }`}
            >
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                style={{ background: freshnessColor(n?.freshness) }}
                title={n?.freshness ? `${freshnessLabel(n.freshness)} · ${n.days_quiet}d quiet` : undefined}
              />
              {n?.unmapped && (
                <span
                  className="mr-1.5 inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full align-middle text-[8px] font-bold text-black/80"
                  style={{ background: '#e05a6b' }}
                  title="Unexplored: no people mapped at this account"
                >
                  !
                </span>
              )}
              {a.name}
            </button>
          )
        })}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={account.slug}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
          className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3"
        >
          <div className="lg:col-span-1 space-y-4">
            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <h2 className="text-lg font-semibold text-white/90">{account.name}</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <Row label="Sector" value={account.sector} />
                <Row label="Strategic account" value={account.strategic ? 'Yes' : 'No'} />
                <Row label="Deals" value={String(dealsHere.length)} />
                <Row label="People mapped" value={String(peopleHere.length)} />
                {node?.freshness && (
                  <Row
                    label="Last touched"
                    value={node.days_quiet === 0 ? 'today' : `${node.days_quiet}d ago`}
                    dot={freshnessColor(node.freshness)}
                    title={freshnessLabel(node.freshness)}
                  />
                )}
              </dl>
            </div>

            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
                Meeting history
              </h3>
              <Timeline meetings={account.meetings ?? []} emptyText="No meetings mapped to this account yet." />
            </div>

            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
                Mapped people
              </h3>
              <div className="space-y-2">
                {peopleHere.map((p) => {
                  const personId = `person:${p.slug}`
                  const linkable = graphNodeIds.has(personId)
                  return (
                    <Link
                      key={p.slug}
                      to={linkable ? `/people?person=${p.slug}` : '/people'}
                      className="flex items-center justify-between rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-xs transition-colors hover:border-mantu/40 hover:bg-white/5"
                    >
                      <span className="text-white/80">{p.name}</span>
                      {p.role && <span className="truncate text-white/40">{p.role}</span>}
                    </Link>
                  )
                })}
                {peopleHere.length === 0 && (
                  <div className="text-xs text-white/30">No people mapped at this account yet.</div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">Deals</h3>
              <div className="space-y-2">
                {dealsHere.map((d) => (
                  <Link
                    key={d.bid_id}
                    to={`/deals?bid=${d.bid_id}`}
                    className="flex items-center justify-between rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-xs transition-colors hover:border-mantu/40 hover:bg-white/5"
                  >
                    <span className="text-white/80">{d.display_name}</span>
                    <span className="text-white/40">{d.stage}</span>
                  </Link>
                ))}
                {dealsHere.length === 0 && (
                  <div className="text-xs text-white/30">No deals tracked for this account yet.</div>
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 space-y-6">
            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
                Why you win ({account.win_reasons.length})
              </h3>
              {account.win_reasons.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/15 p-6 text-center text-xs text-white/30">
                  No cited win reasons for this account yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {account.win_reasons.map((r, i) => (
                    <ReasonCard key={i} statement={r.statement} quote={r.quote} meeting={r.meeting} tone="win" delay={i * 0.05} />
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
                Why you lose ({account.loss_reasons.length})
              </h3>
              {account.loss_reasons.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/15 p-6 text-center text-xs text-white/30">
                  No cited loss reasons for this account yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {account.loss_reasons.map((r, i) => (
                    <ReasonCard key={i} statement={r.statement} quote={r.quote} meeting={r.meeting} tone="loss" delay={i * 0.05} />
                  ))}
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
}: {
  label: string
  value: string
  dot?: string
  title?: string
}) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 pb-1.5">
      <dt className="text-white/40">{label}</dt>
      <dd className="flex items-center gap-1.5 font-medium text-white/85" title={title}>
        {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} />}
        {value}
      </dd>
    </div>
  )
}

function ReasonCard({
  statement,
  quote,
  meeting,
  tone,
  delay,
}: {
  statement: string
  quote: string
  meeting: string
  tone: 'win' | 'loss'
  delay: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="rounded-lg border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-4"
    >
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            tone === 'win' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
          }`}
        >
          {tone === 'win' ? 'Won on' : 'Lost on'}
        </span>
      </div>
      <p className="mt-2 break-words text-sm text-white/85 [overflow-wrap:anywhere]">{statement}</p>
      <div className="mt-2 rounded-md bg-black/20 p-2 text-xs text-white/50">
        <div className="mb-1 font-mono text-[10px] text-mantu-light/80">{meeting}</div>
        {quote && <div className="break-words italic [overflow-wrap:anywhere]">&ldquo;{quote}&rdquo;</div>}
      </div>
    </motion.div>
  )
}
