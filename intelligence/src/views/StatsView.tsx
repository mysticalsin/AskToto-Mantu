import { useMemo } from 'react'
import { motion } from 'framer-motion'
import type { Category, DashboardData } from '../types/data'
import { CountUp } from '../components/CountUp'
import { categoryLabel } from '../lib/format'

interface Props {
  data: DashboardData
}

export function StatsView({ data }: Props) {
  const totalClaims = data.deals.reduce((sum, d) => sum + d.claims.length, 0)
  const recurringInsights = data.coaching_insights.filter((i) => i.n_observations >= 2).length

  const byCategory = useMemo(() => {
    const counts = new Map<Category, number>()
    for (const deal of data.deals) {
      for (const claim of deal.claims) {
        counts.set(claim.category, (counts.get(claim.category) ?? 0) + 1)
      }
    }
    const max = Math.max(1, ...counts.values())
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({ category, count, pct: (count / max) * 100 }))
  }, [data.deals])

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
        <StatCard label="Deals tracked" value={data.deals.length} />
        <StatCard label="Claims extracted" value={totalClaims} />
        <StatCard label="Coaching insights" value={data.coaching_insights.length} />
        <StatCard label="Recurring patterns (n≥2)" value={recurringInsights} />
      </div>

      <div className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">
          Claims by category
        </h2>
        <div className="space-y-2 rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5">
          {byCategory.length === 0 && (
            <div className="text-xs text-white/30">No claims recorded yet.</div>
          )}
          {byCategory.map((row, i) => (
            <div key={row.category} className="flex items-center gap-3">
              <div className="w-32 flex-shrink-0 text-xs text-white/60">
                {categoryLabel[row.category]}
              </div>
              <div className="h-5 flex-1 overflow-hidden rounded bg-white/5">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${row.pct}%` }}
                  transition={{ duration: 0.6, delay: i * 0.05, ease: 'easeOut' }}
                  className="h-full rounded bg-gradient-to-r from-mantu to-mantu-light"
                />
              </div>
              <div className="w-6 text-right text-xs text-white/50">{row.count}</div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-6 text-xs text-white/30">
        {data.meta.note}
      </p>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3 }}
      className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5"
    >
      <div className="text-3xl font-bold text-white/95">
        <CountUp value={value} />
      </div>
      <div className="mt-1 text-xs text-white/50">{label}</div>
    </motion.div>
  )
}
