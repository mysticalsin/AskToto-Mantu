import { motion } from 'framer-motion'
import type { DashboardData } from '../types/data'
import { InsightCard } from '../components/InsightCard'
import { PlaceholderBanner } from '../components/PlaceholderBanner'
import { confidenceImpactScore } from '../lib/format'

interface Props {
  data: DashboardData
}

/**
 * Compact, chrome-free view meant for iframe embedding elsewhere.
 * Cards only — no nav, no filters, no sidebar.
 */
export function EmbedView({ data }: Props) {
  const top = [...data.coaching_insights]
    .sort(
      (a, b) =>
        confidenceImpactScore(b.confidence, b.n_observations) -
        confidenceImpactScore(a.confidence, a.n_observations),
    )
    .slice(0, 6)

  return (
    <div className="min-h-screen bg-[var(--color-mantu-bg)] p-4">
      {data.meta.is_placeholder && <PlaceholderBanner note={data.meta.note} compact />}
      <div className="text-xs font-semibold uppercase tracking-wide text-white/50">
        Coaching insights — Mantu Intelligence
      </div>
      {top.length === 0 ? (
        // The embed has no filters — the old "for this filter" copy was borrowed from CoachingView and lied.
        <div className="mt-3 rounded-xl border border-dashed border-white/15 p-10 text-center text-sm text-white/40">
          No coaching insights yet — they appear as meetings are ingested.
        </div>
      ) : (
        <motion.div layout className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {top.map((insight, i) => (
            <InsightCard
              key={insight.insight_id}
              insight={insight}
              index={i}
            />
          ))}
        </motion.div>
      )}
      <div className="mt-4 text-center">
        {/* HashRouter + file://: a root-relative href (even with target="_top") resolves to the
            filesystem root, not the app route. "#/" is the real path to the full dashboard. */}
        <a
          href="#/"
          target="_top"
          className="text-xs font-medium text-mantu-light hover:underline"
        >
          Open full dashboard →
        </a>
      </div>
    </div>
  )
}
