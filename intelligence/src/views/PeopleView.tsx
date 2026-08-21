import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Link, useSearchParams } from 'react-router-dom'
import type { DashboardData } from '../types/data'
import { freshnessColor, freshnessLabel } from '../lib/format'
import { ledgerTotals } from '../lib/ledgerstats'
import { slug } from '../lib/slug'
import { Timeline } from '../components/Timeline'
import { AcceptSuggestion } from '../components/AcceptSuggestion'
import { EmptyState } from '../components/EmptyState'

interface Props {
  data: DashboardData
}

// Same chip language DealView.tsx uses for commitment status.
const commitmentStatusStyle: Record<string, string> = {
  open: 'bg-amber-500/15 text-amber-300',
  kept: 'bg-emerald-500/15 text-emerald-300',
  broken: 'bg-rose-500/15 text-rose-300',
}

// Mirrors the kind vocabulary brainAdapter.ts's toDeal() maps signals through ('positive'/'objection'/
// anything else = neutral) — stance_trail entries carry the same raw kind, unmapped here.
const stanceStyle: Record<string, string> = {
  positive: 'bg-emerald-500/15 text-emerald-300',
  objection: 'bg-rose-500/15 text-rose-300',
}
function stanceLabel(kind: string): string {
  if (kind === 'positive') return 'Positive signal'
  if (kind === 'objection') return 'Objection'
  return 'Neutral observation'
}

/** Master-detail person list, mirroring DealView.tsx's structure — a champion's role/account, meeting
 *  history, commitment ledger, and full stance trail across meetings (for spotting a cooling champion). */
export function PeopleView({ data }: Props) {
  const [params, setParams] = useSearchParams()
  const personParam = params.get('person')
  const [selected, setSelected] = useState(personParam ?? data.people[0]?.slug ?? '')

  useEffect(() => {
    if (personParam && personParam !== selected) setSelected(personParam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personParam])

  const person = useMemo(
    () => data.people.find((p) => p.slug === selected) ?? data.people[0],
    [data.people, selected],
  )

  const nodeById = useMemo(
    () => new Map(data.account_graph.nodes.map((n) => [n.id, n])),
    [data.account_graph.nodes],
  )

  function selectPerson(personSlug: string) {
    setSelected(personSlug)
    setParams({ person: personSlug })
  }

  if (!person) {
    return (
      <EmptyState
        title="People"
        standfirst="Every mapped contact — role, commitments, and the stances they've taken."
        headline="No people mapped yet."
        body="People appear here as Métis extracts them from your meetings. Record or import a meeting where attendees are named, and each one shows up with their role, the commitments they made, and the positions they took."
      />
    )
  }

  const node = nodeById.get(`person:${person.slug}`)
  const commitments = person.commitments ?? []
  const commitmentTotals = ledgerTotals(commitments)
  const sortedCommitments = [...commitments].sort((a, b) => {
    if (a.status === 'open' && b.status !== 'open') return -1
    if (a.status !== 'open' && b.status === 'open') return 1
    return (b.date ?? '').localeCompare(a.date ?? '')
  })
  // StanceTrailEntry carries no date field (see types/data.ts) — there is no honest key to sort by,
  // so this only reverses the ingest-appended order (oldest→newest as recorded) to read newest-first,
  // the same convention every dated list on this page uses. Never fabricates a date to sort on.
  const sortedStanceTrail = [...person.stance_trail].reverse()

  const accountSlug = person.account ? slug(person.account) : null
  const accountLinkId = accountSlug ? `account:${accountSlug}` : null
  const accountIsLinkable = accountLinkId !== null && nodeById.has(accountLinkId)

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">People</h1>
      <p className="mt-1 text-sm text-white/50">Every mapped contact — role, commitments, and the stances they've taken.</p>

      <div className="mt-6 flex flex-wrap gap-2">
        {data.people.map((p) => {
          const n = nodeById.get(`person:${p.slug}`)
          return (
            <button
              key={p.slug}
              onClick={() => selectPerson(p.slug)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                p.slug === person.slug
                  ? 'border-mantu bg-mantu text-white'
                  : 'border-white/10 bg-white/5 text-white/60 hover:border-mantu/40'
              }`}
            >
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                style={{ background: freshnessColor(n?.freshness) }}
                title={n?.freshness ? `${freshnessLabel(n.freshness)} · ${n.days_quiet}d quiet` : undefined}
              />
              {p.name}
            </button>
          )
        })}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={person.slug}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
          className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3"
        >
          <div className="lg:col-span-1 space-y-4">
            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <h2 className="text-lg font-semibold text-white/90">{person.name}</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <Row
                  label="Role"
                  value={person.role ?? 'Unknown'}
                  extra={
                    person.field_state?.role === 'extracted' && (
                      <AcceptSuggestion entityKind="person" entityId={person.slug} field="role" />
                    )
                  }
                />
                <Row
                  label="Account"
                  value={person.account ?? 'Unmapped'}
                  linkTo={accountIsLinkable ? `/accounts?acct=${accountSlug}` : undefined}
                  linkTitle={person.account ? `Open ${person.account} in Accounts` : undefined}
                  extra={
                    person.field_state?.org === 'extracted' && (
                      <AcceptSuggestion entityKind="person" entityId={person.slug} field="org" />
                    )
                  }
                />
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
              <Timeline meetings={person.meetings ?? []} emptyText="No meetings mapped to this person yet." />
            </div>

            <div className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-white/60">Commitments</h3>
                <span className="text-[11px] text-white/40">
                  {commitmentTotals.open} open · {commitmentTotals.kept} kept · {commitmentTotals.broken} broken
                </span>
              </div>
              <div className="space-y-3">
                {sortedCommitments.map((c, i) => (
                  <div key={i} className="rounded-lg border border-white/5 bg-black/20 p-3" title={c.quote || undefined}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${commitmentStatusStyle[c.status] ?? ''}`}>
                        {c.status}
                      </span>
                      <span className="text-[11px] text-white/40">{c.date}</span>
                    </div>
                    <p className="mt-1.5 break-words text-xs text-white/80 [overflow-wrap:anywhere]">{c.text}</p>
                    {c.due_hint && <div className="mt-1 text-[11px] text-white/40">Due {c.due_hint}</div>}
                  </div>
                ))}
                {commitments.length === 0 && (
                  <div className="text-xs text-white/30">No commitments captured for this person yet.</div>
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
              Stance trail ({sortedStanceTrail.length})
            </h3>
            <div className="space-y-3">
              {sortedStanceTrail.map((entry, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="rounded-lg border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-4"
                >
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${stanceStyle[entry.kind] ?? 'bg-white/10 text-white/60'}`}>
                    {stanceLabel(entry.kind)}
                  </span>
                  <p className="mt-2 break-words text-sm text-white/85 [overflow-wrap:anywhere]">{entry.statement}</p>
                  <div className="mt-2 font-mono text-[10px] text-mantu-light/80">{entry.meeting}</div>
                </motion.div>
              ))}
              {sortedStanceTrail.length === 0 && (
                <div className="rounded-lg border border-dashed border-white/15 p-6 text-center text-xs text-white/30">
                  No stance trail recorded for this person yet.
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
