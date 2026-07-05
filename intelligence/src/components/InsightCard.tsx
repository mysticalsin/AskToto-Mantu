import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { CoachingInsight } from '../types/data'
import { categoryLabel, groundingColor, groundingLabel } from '../lib/format'

interface Props {
  insight: CoachingInsight
  index: number
  onSelectDeal?: (bidId: string) => void
}

export function InsightCard({ insight, index, onSelectDeal }: Props) {
  const [expanded, setExpanded] = useState(false)
  const isRecurring = insight.n_observations >= 2

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      // Cap the stagger at 8 cards — beyond that, delay*index would keep the Nth card invisible for
      // seconds on a deep account/deal history, which reads as missing content, not a nice reveal.
      animate={{ opacity: 1, y: 0, transition: { duration: 0.35, delay: Math.min(index, 8) * 0.06, ease: 'easeOut' } }}
      whileHover={{ y: -4 }}
      className="group rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5 shadow-lg shadow-black/20 transition-shadow hover:shadow-xl hover:shadow-mantu/10"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-mantu/20 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-mantu-light">
            {categoryLabel[insight.category]}
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
              isRecurring ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-white/50'
            }`}
          >
            {isRecurring ? `Recurring · n=${insight.n_observations}` : 'Single-deal observation'}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-white/50" title="grounding">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: groundingColor[insight.grounding] }}
          />
          {groundingLabel[insight.grounding]}
        </div>
      </div>

      <h3 className="mt-3 text-base font-semibold text-white/90">{insight.pattern}</h3>

      <div className="mt-3 rounded-lg border border-mantu/30 bg-mantu/10 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-mantu-light">
          Coaching move
        </div>
        <p className="mt-1 text-sm leading-snug text-white/90">{insight.coaching_move}</p>
      </div>

      <p className="mt-3 text-sm leading-snug text-white/60">{insight.why_it_matters}</p>

      <div className="mt-4 flex items-center justify-between text-[11px] text-white/40">
        <div className="flex items-center gap-3">
          {/* Evidence stated as what it IS — grounding tier + recurrence. Never a percentage: the
              store's own rule (brain.ts) is that no % can be calibrated from this data, and the
              underlying score is a heuristic tier constant, not a measured probability. */}
          <span>
            {insight.grounding === 'verified' ? 'Quoted evidence' : insight.grounding === 'assumed' ? 'Inferred' : 'Tentative'}
            {insight.n_observations >= 2 ? ` · seen ${insight.n_observations}×` : ''}
          </span>
          <span>·</span>
          <span>{insight.deals.length} deal{insight.deals.length === 1 ? '' : 's'}</span>
        </div>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="rounded-md px-2 py-1 font-medium text-mantu-light transition-colors hover:bg-mantu/15"
        >
          {expanded ? 'Hide detail' : 'Show detail'}
        </button>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            key="detail"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 space-y-2 border-t border-white/10 pt-3"
          >
            <p className="text-xs text-white/60">{insight.what_happened}</p>
            {insight.sources.map((s, i) => (
              <div key={i} className="rounded-md bg-black/20 p-2 text-xs text-white/50">
                <div className="mb-1 font-mono text-[10px] text-mantu-light/80">{s.file}</div>
                <div className="italic">&ldquo;{s.quote_or_paraphrase}&rdquo;</div>
              </div>
            ))}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {insight.deals.map((d) =>
                onSelectDeal ? (
                  <button
                    key={d}
                    onClick={() => onSelectDeal(d)}
                    className="rounded-full border border-mantu/40 px-2 py-0.5 text-[11px] text-mantu-light transition-colors hover:bg-mantu/20"
                  >
                    {d} →
                  </button>
                ) : (
                  <span
                    key={d}
                    className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-white/40"
                  >
                    {d}
                  </span>
                )
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
