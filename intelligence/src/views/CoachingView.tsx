import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import type { Category, DashboardData } from '../types/data'
import { InsightCard } from '../components/InsightCard'
import { categoryLabel, confidenceImpactScore } from '../lib/format'

interface Props {
  data: DashboardData
}

const ALL: 'all' = 'all'

export function CoachingView({ data }: Props) {
  const navigate = useNavigate()
  const [categoryFilter, setCategoryFilter] = useState<Category | typeof ALL>(ALL)

  const categories = useMemo(() => {
    const set = new Set<Category>(data.coaching_insights.map((i) => i.category))
    return Array.from(set)
  }, [data.coaching_insights])

  const sorted = useMemo(() => {
    const filtered =
      categoryFilter === ALL
        ? data.coaching_insights
        : data.coaching_insights.filter((i) => i.category === categoryFilter)
    return [...filtered].sort(
      (a, b) =>
        confidenceImpactScore(b.confidence, b.n_observations) -
        confidenceImpactScore(a.confidence, a.n_observations),
    )
  }, [data.coaching_insights, categoryFilter])

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-6">
        <h1 className="text-2xl font-semibold text-white/95">Coaching moves</h1>
        <p className="mt-1 text-sm text-white/50">
          Prescriptive moves sorted by confidence × impact. This is what a coach reads first.
        </p>
      </motion.div>

      <div className="mb-6 flex flex-wrap gap-2">
        <FilterPill active={categoryFilter === ALL} onClick={() => setCategoryFilter(ALL)}>
          All categories
        </FilterPill>
        {categories.map((c) => (
          <FilterPill key={c} active={categoryFilter === c} onClick={() => setCategoryFilter(c)}>
            {categoryLabel[c]}
          </FilterPill>
        ))}
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-10 text-center text-sm text-white/40">
          No coaching insights for this filter yet.
        </div>
      ) : (
        <motion.div layout className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((insight, i) => (
            <InsightCard
              key={insight.insight_id}
              insight={insight}
              index={i}
              onSelectDeal={(bidId) => navigate(`/deals?bid=${bidId}`)}
            />
          ))}
        </motion.div>
      )}
    </div>
  )
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-mantu bg-mantu text-white'
          : 'border-white/10 bg-white/5 text-white/60 hover:border-mantu/40 hover:text-white/90'
      }`}
    >
      {children}
    </button>
  )
}
