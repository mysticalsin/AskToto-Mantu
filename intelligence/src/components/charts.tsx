// Small, hand-rolled chart primitives for StatsView — no charting library. Every color is one of the
// app's existing CSS custom properties (index.css) so these stay in the same visual language as the
// rest of the dashboard. Marks are kept thin, axes recessive, labels direct rather than legend boxes
// (every series count here is ≤4), and every component renders an honest empty state instead of a
// misleading zero-value chart when it has nothing to draw.

import { motion } from 'framer-motion'
import { CountUp } from './CountUp'

const MANTU_GRADIENT = 'linear-gradient(to right, var(--color-mantu), var(--color-mantu-light))'

/** A single stat card with the CountUp roll-up look. `value: null` renders an honest em-dash instead
 *  of a fabricated number (e.g. a kept-rate with nothing settled yet). */
export function StatTile({
  label,
  value,
  suffix = '',
  decimals = 0,
  hint,
}: {
  label: string
  value: number | string | null
  suffix?: string
  decimals?: number
  hint?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3 }}
      className="rounded-xl border border-[var(--color-mantu-border)] bg-[var(--color-mantu-surface)] p-5"
    >
      <div className="text-3xl font-bold text-white/95">
        {value === null ? (
          '—'
        ) : typeof value === 'number' ? (
          <CountUp value={value} decimals={decimals} suffix={suffix} />
        ) : (
          value
        )}
      </div>
      <div className="mt-1 text-xs text-white/50">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-white/30">{hint}</div>}
    </motion.div>
  )
}

/** A horizontal labeled bar, scaled against a shared `max` so a row of these reads as one chart. */
export function BarRow({
  label,
  value,
  max,
  color,
  valueLabel,
  delay = 0,
}: {
  label: string
  value: number
  max: number
  /** CSS background (solid color or gradient); defaults to the mantu brand gradient. */
  color?: string
  valueLabel?: string
  delay?: number
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 flex-shrink-0 truncate text-xs text-white/60" title={label}>
        {label}
      </div>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/5">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, delay, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{ background: color ?? MANTU_GRADIENT }}
        />
      </div>
      <div className="min-w-[2.5rem] flex-shrink-0 whitespace-nowrap text-right text-xs text-white/50">
        {valueLabel ?? value}
      </div>
    </div>
  )
}

function shortWeekLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** A mini vertical bar chart of meeting counts per week (meetingsPerWeek's buckets). Fixed pixel width,
 *  meant to sit inside an `overflow-x-auto` wrapper rather than stretch/distort. */
export function WeeklyBars({ buckets }: { buckets: { weekStartISO: string; count: number }[] }) {
  if (buckets.length === 0) return <div className="text-xs text-white/30">No meetings recorded yet.</div>

  const max = Math.max(1, ...buckets.map((b) => b.count))
  const barW = 26
  const gap = 8
  const chartH = 64
  const totalW = buckets.length * (barW + gap) - gap
  const totalH = chartH + 18

  return (
    <div className="overflow-x-auto">
      <svg width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`} className="block">
        <line x1={0} y1={chartH} x2={totalW} y2={chartH} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
        {buckets.map((b, i) => {
          const h = Math.max((b.count / max) * (chartH - 6), b.count > 0 ? 3 : 0)
          const x = i * (barW + gap)
          const y = chartH - h
          const showLabel = i % 3 === 0 || i === buckets.length - 1
          return (
            <g key={b.weekStartISO}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={3}
                fill="var(--color-mantu-light)"
                opacity={b.count === 0 ? 0.12 : 0.85}
              >
                <title>{`Week of ${shortWeekLabel(b.weekStartISO)}: ${b.count} meeting${b.count === 1 ? '' : 's'}`}</title>
              </rect>
              {showLabel && (
                <text x={x + barW / 2} y={totalH - 4} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.35)">
                  {shortWeekLabel(b.weekStartISO)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** A sentiment line (-1..1 domain, zero baseline always drawn) with a soft rolling-average overlay
 *  behind it. Stretches to the width of its container — strokes are non-scaling so they stay thin. */
export function Sparkline({
  series,
  rolling,
  height = 120,
}: {
  series: { date: string; score: number }[]
  rolling?: { date: string; avg: number }[]
  height?: number
}) {
  if (series.length === 0) return <div className="text-xs text-white/30">No sentiment data yet.</div>

  const viewW = 600
  const pad = 10
  const innerW = viewW - pad * 2
  const innerH = height - pad * 2
  const n = series.length
  const x = (i: number) => pad + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (score: number) => pad + innerH / 2 - score * (innerH / 2)
  const zeroY = y(0)

  const linePath = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')
  const rollingPath =
    rolling && rolling.length > 0
      ? rolling.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ')
      : null

  const dotColor = (score: number) =>
    score > 0 ? 'var(--color-band-positive)' : score < 0 ? 'var(--color-band-negative)' : 'var(--color-band-stalled)'

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${viewW} ${height}`} preserveAspectRatio="none" className="block">
      <line
        x1={pad}
        y1={zeroY}
        x2={viewW - pad}
        y2={zeroY}
        stroke="rgba(255,255,255,0.15)"
        strokeWidth={1}
        strokeDasharray="2,3"
        vectorEffect="non-scaling-stroke"
      />
      {rollingPath && (
        <path
          d={rollingPath}
          fill="none"
          stroke="var(--color-mantu-light)"
          strokeWidth={3}
          opacity={0.35}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={linePath}
        fill="none"
        stroke="var(--color-mantu-light)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      {series.map((p, i) => (
        <circle key={`${p.date}-${i}`} cx={x(i)} cy={y(p.score)} r={2.5} fill={dotColor(p.score)}>
          <title>{`${p.date}: ${p.score > 0 ? 'positive' : p.score < 0 ? 'negative' : 'neutral'}`}</title>
        </circle>
      ))}
    </svg>
  )
}

/** A single-row stacked bar (e.g. stance mix within a category) — 2px gaps between segments, direct
 *  labels underneath rather than a separate legend (segment count here is always ≤4). */
export function StackedBar({
  title,
  segments,
}: {
  title: string
  segments: { key: string; label: string; value: number; color: string }[]
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  const visible = segments.filter((s) => s.value > 0)

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-white/60">
        <span>{title}</span>
        <span className="text-white/30">{total}</span>
      </div>
      {total === 0 ? (
        <div className="h-3 rounded-full bg-white/5" />
      ) : (
        <div className="flex h-3 gap-[2px]">
          {visible.map((seg) => (
            <div
              key={seg.key}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(seg.value / total) * 100}%`, background: seg.color }}
              title={`${seg.label}: ${seg.value}`}
            />
          ))}
        </div>
      )}
      {visible.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-white/40">
          {visible.map((seg) => (
            <span key={seg.key} className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: seg.color }} />
              {seg.label} {seg.value}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
