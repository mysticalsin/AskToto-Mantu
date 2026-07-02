import { useMemo } from 'react'
import { motion } from 'framer-motion'
import type { Category, Commitment, DashboardData, Stance } from '../types/data'
import { categoryLabel } from '../lib/format'
import { meetingsPerWeek, rollingAverage, sentimentSeries } from '../lib/momentum'
import {
  agingBuckets,
  bandDistribution,
  ledgerTotals,
  outcomeDistribution,
  reliabilityByOwner,
  stanceMix,
} from '../lib/ledgerstats'
import { BarRow, Sparkline, StackedBar, StatTile, WeeklyBars } from '../components/charts'

interface Props {
  data: DashboardData
}

const STANCE_ORDER: (Stance | 'unknown')[] = ['positive-signal', 'neutral-observation', 'objection', 'unknown']
const stanceLabel: Record<string, string> = {
  'positive-signal': 'Positive signal',
  'neutral-observation': 'Neutral',
  objection: 'Objection',
  unknown: 'Unknown',
}
const stanceColor: Record<string, string> = {
  'positive-signal': 'var(--color-band-positive)',
  'neutral-observation': 'var(--color-mantu-light)',
  objection: 'var(--color-band-negative)',
  unknown: 'rgba(255,255,255,0.28)',
}

/** Every commitment carries `text` + `by` but not a stable id — dedupe on that pair so a commitment
 *  echoed in both a deal's ledger and a person's ledger (the same promise, seen from two entities)
 *  isn't double-counted. First occurrence wins. */
function dedupeCommitments(commitments: Commitment[]): Commitment[] {
  const seen = new Map<string, Commitment>()
  for (const c of commitments) {
    const key = `${c.text}||${c.by}`
    if (!seen.has(key)) seen.set(key, c)
  }
  return Array.from(seen.values())
}

export function StatsView({ data }: Props) {
  const now = useMemo(() => Date.now(), [])

  const totalClaims = data.deals.reduce((sum, d) => sum + d.claims.length, 0)
  const recurringInsights = data.coaching_insights.filter((i) => i.n_observations >= 2).length

  const allClaims = useMemo(() => data.deals.flatMap((d) => d.claims), [data.deals])

  const byCategory = useMemo(() => {
    const counts = new Map<Category, number>()
    for (const claim of allClaims) counts.set(claim.category, (counts.get(claim.category) ?? 0) + 1)
    const max = Math.max(1, ...counts.values())
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({ category, count, max }))
  }, [allClaims])

  const stanceByCategory = useMemo(() => stanceMix(allClaims), [allClaims])

  const outcomeDist = useMemo(() => outcomeDistribution(data.deals), [data.deals])
  const bandDist = useMemo(() => bandDistribution(data.deals), [data.deals])
  const pipelineMax = Math.max(1, data.deals.length)

  // momentum.ts's MeetingLike wants `account?: string`; the feed's account is `string | null` — normalize
  // null to undefined rather than widening the shared lib's type for one caller.
  const momentumMeetings = useMemo(
    () => data.meetings_feed.map((m) => ({ ...m, account: m.account ?? undefined })),
    [data.meetings_feed],
  )
  const weekly = useMemo(() => meetingsPerWeek(momentumMeetings, now, 12), [momentumMeetings, now])
  const sentiment = useMemo(() => sentimentSeries(momentumMeetings), [momentumMeetings])
  const sentimentRolling = useMemo(() => rollingAverage(sentiment, 3), [sentiment])

  const allCommitments = useMemo(() => {
    const combined = [...data.deals.flatMap((d) => d.commitments), ...data.people.flatMap((p) => p.commitments)]
    return dedupeCommitments(combined)
  }, [data.deals, data.people])

  const ledger = useMemo(() => ledgerTotals(allCommitments), [allCommitments])
  const aging = useMemo(() => agingBuckets(allCommitments, now), [allCommitments, now])
  const agingTotal = aging.buckets.reduce((sum, b) => sum + b.items.length, 0) + aging.undated.length

  const worstReliability = useMemo(() => {
    const byPerson: Record<string, Commitment[]> = {}
    for (const c of allCommitments) (byPerson[c.by] ??= []).push(c)
    return reliabilityByOwner(byPerson)
      .filter((r) => r.kept + r.broken > 0)
      .slice(0, 5)
  }, [allCommitments])

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">Tracked statistics</h1>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
      >
        <strong className="font-semibold">n = {data.deals.length} — illustrative until more deals close.</strong>{' '}
        These numbers describe a handful of deals, not a portfolio. Treat every stat below as a
        single-point observation, not a trend, until real volume accumulates.
      </motion.div>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Deals tracked" value={data.deals.length} />
        <StatTile label="Claims extracted" value={totalClaims} />
        <StatTile label="Coaching insights" value={data.coaching_insights.length} />
        <StatTile label="Recurring patterns (n≥2)" value={recurringInsights} />
        <StatTile label="People mapped" value={data.status.people} />
        <StatTile label="Accounts mapped" value={data.status.accounts} />
        <StatTile label="Graph nodes · edges" value={`${data.status.nodes} · ${data.status.edges}`} />
      </div>

      {/* Pipeline */}
      <Section title="Pipeline">
        {data.deals.length === 0 ? (
          <Empty text="No deals tracked yet." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardLabel>By outcome</CardLabel>
              <div className="space-y-2">
                <BarRow label="Open" value={outcomeDist.open} max={pipelineMax} color="var(--color-band-stalled)" />
                <BarRow label="Won" value={outcomeDist.won} max={pipelineMax} color="var(--color-band-positive)" />
                <BarRow label="Lost" value={outcomeDist.lost} max={pipelineMax} color="var(--color-band-negative)" />
              </div>
            </Card>
            <Card>
              <CardLabel>By win-likelihood band</CardLabel>
              <div className="space-y-2">
                <BarRow label="Good" value={bandDist.good} max={pipelineMax} color="var(--color-band-positive)" />
                <BarRow label="Mixed" value={bandDist.mixed} max={pipelineMax} color="var(--color-band-stalled)" />
                <BarRow
                  label="Concerning"
                  value={bandDist.concerning}
                  max={pipelineMax}
                  color="var(--color-band-negative)"
                />
                <BarRow
                  label="Unknown"
                  value={bandDist.unknown}
                  max={pipelineMax}
                  color="rgba(255,255,255,0.28)"
                />
              </div>
            </Card>
          </div>
        )}
      </Section>

      {/* Momentum */}
      <Section title="Momentum">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardLabel>Meetings per week (last 12 weeks)</CardLabel>
            <WeeklyBars buckets={weekly.buckets} />
            {weekly.undated > 0 && (
              <p className="mt-2 text-[11px] text-white/30">
                +{weekly.undated} meeting{weekly.undated === 1 ? '' : 's'} with no date, not shown above.
              </p>
            )}
          </Card>
          <Card>
            <CardLabel>Sentiment trend (with rolling average)</CardLabel>
            <Sparkline series={sentiment} rolling={sentimentRolling} />
          </Card>
        </div>
      </Section>

      {/* Follow-through */}
      <Section title="Follow-through">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Open commitments" value={ledger.open} />
          <StatTile label="Kept" value={ledger.kept} />
          <StatTile label="Broken" value={ledger.broken} />
          <StatTile
            label="Kept rate"
            value={ledger.keptRate === null ? null : Math.round(ledger.keptRate * 100)}
            suffix={ledger.keptRate === null ? '' : '%'}
            hint={ledger.keptRate === null ? 'nothing settled yet' : undefined}
          />
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <CardLabel>Age of open commitments</CardLabel>
            {agingTotal === 0 ? (
              <Empty text="No open commitments." />
            ) : (
              <>
                <div className="space-y-2">
                  {aging.buckets.map((b) => (
                    <BarRow key={b.label} label={b.label} value={b.items.length} max={Math.max(1, ledger.open)} />
                  ))}
                </div>
                {aging.undated.length > 0 && (
                  <p className="mt-2 text-[11px] text-white/30">
                    +{aging.undated.length} open commitment{aging.undated.length === 1 ? '' : 's'} with no date, not
                    aged above.
                  </p>
                )}
              </>
            )}
          </Card>
          <Card>
            <CardLabel>Least reliable (kept rate, worst 5)</CardLabel>
            {worstReliability.length === 0 ? (
              <Empty text="No settled commitments to rank yet." />
            ) : (
              <div className="space-y-2">
                {worstReliability.map((r) => {
                  const pct = Math.round((r.keptRate ?? 0) * 100)
                  return (
                    <BarRow
                      key={r.person}
                      label={r.person}
                      value={pct}
                      max={100}
                      color="var(--color-band-negative)"
                      valueLabel={`${pct}% (${r.kept}/${r.kept + r.broken})`}
                    />
                  )
                })}
              </div>
            )}
          </Card>
        </div>
      </Section>

      {/* Claims by category */}
      <Section title="Claims by category">
        <Card>
          {byCategory.length === 0 ? (
            <Empty text="No claims recorded yet." />
          ) : (
            <div className="space-y-4">
              {byCategory.map((row, i) => (
                <div key={row.category}>
                  <BarRow label={categoryLabel[row.category]} value={row.count} max={row.max} delay={i * 0.05} />
                  <div className="mt-1.5 pl-[9.5rem]">
                    <StackedBar
                      title="Stance mix"
                      segments={STANCE_ORDER.map((s) => ({
                        key: s,
                        label: stanceLabel[s],
                        value: stanceByCategory[row.category]?.[s] ?? 0,
                        color: stanceColor[s],
                      }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>

      {/* Brain health */}
      <Section title="Brain health">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardLabel>Warnings</CardLabel>
            {data.warnings.length === 0 ? (
              <Empty text="No warnings." />
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-xs text-white/60">
                {data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardLabel>Ingest errors</CardLabel>
            {data.ingest_errors.length === 0 ? (
              <Empty text={`All ${data.status.meetings} meeting${data.status.meetings === 1 ? '' : 's'} ingested cleanly.`} />
            ) : (
              <ul className="space-y-2 text-xs text-white/60">
                {data.ingest_errors.map((e, i) => (
                  <li key={i}>
                    <span className="text-white/80">{e.file}</span> — {e.error}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Section>

      <p className="mt-6 text-xs text-white/30">{data.meta.note}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8">
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
