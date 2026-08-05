import { useMemo } from 'react'
import { motion } from 'framer-motion'
import type { MeetingRef } from '../types/data'

interface Props {
  meetings: MeetingRef[]
  emptyText?: string
}

/**
 * Shared meeting-history list for entity detail panes (Deal/Account/Person) — every meeting ref the
 * entity was tagged in, newest first. Reused rather than re-implemented per view so "what meetings
 * touched this entity" always reads the same way across Deals/Accounts/People. Undated refs (a hand-built
 * data.json can omit a date; live ingest always stamps one) sort last rather than corrupting the order.
 */
export function Timeline({ meetings, emptyText = 'No meetings recorded yet.' }: Props) {
  const sorted = useMemo(
    () => [...meetings].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    [meetings],
  )

  if (sorted.length === 0) {
    return <div className="text-xs text-white/30">{emptyText}</div>
  }

  return (
    <div className="space-y-2">
      {sorted.map((m, i) => (
        <motion.div
          key={`${m.file}-${i}`}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.04 }}
          className="flex items-center gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2"
        >
          <span className="flex-shrink-0 whitespace-nowrap text-[11px] text-white/40">
            {m.date ? m.date.slice(0, 10) : 'Undated'}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-white/80" title={m.file}>
            {m.title || m.file}
          </span>
        </motion.div>
      ))}
    </div>
  )
}
