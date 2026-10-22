import { useMemo } from 'react'
import type { MeetingSummary } from '@shared/ipc'

// The dashboard's two chart components (and the pure week bucketing behind them), split out of BrainView.
// Charts follow the dataviz discipline: single-hue bars for magnitude, thin marks, text in ink tokens.

/** ISO-week (Mon-anchored) start for a date, as a ms timestamp. */
function weekStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7 // Mon=0 … Sun=6
  d.setDate(d.getDate() - day)
  return d.getTime()
}

const WEEKS_SHOWN = 12

export interface WeeklyBarData {
  weeks: { w: number; n: number }[]
  max: number
  maxIdx: number
}

/**
 * The WEEKS_SHOWN meetings-per-week columns (oldest first), the bar scale, and the busiest column.
 * Pure and `now`-injected so the bucketing is testable across a DST boundary. Exported for unit testing.
 */
export function computeWeeklyBars(meetings: MeetingSummary[], now: number): WeeklyBarData {
  // Step back seven CALENDAR days at a time instead of subtracting 7*24h: `weekStart` returns local
  // Monday midnights, and consecutive local Monday midnights are 7d ± 1h apart across a DST
  // transition. Fixed-millisecond columns therefore miss every bucket key on the far side of a
  // transition (bars read zero) and, going into spring-forward, land on Sunday 23:00 — mislabelling
  // the axis too. `setDate` preserves the wall-clock fields, so each column stays a real Monday 00:00.
  const columns: number[] = []
  const cursor = new Date(weekStart(now))
  for (let i = 0; i < WEEKS_SHOWN; i++) {
    columns.unshift(cursor.getTime())
    cursor.setDate(cursor.getDate() - 7)
  }
  const counts = new Map<number, number>()
  for (const m of meetings) {
    const ms = Date.parse(m.date)
    if (isNaN(ms)) continue
    const w = weekStart(ms)
    counts.set(w, (counts.get(w) || 0) + 1)
  }
  // No range guard needed: a bucket outside the 12 columns is simply never read.
  const weeks = columns.map((w) => ({ w, n: counts.get(w) || 0 }))
  const max = Math.max(1, ...weeks.map((x) => x.n))
  const maxIdx = weeks.reduce((best, x, i) => (x.n > weeks[best].n ? i : best), 0)
  return { weeks, max, maxIdx }
}

/** Meetings-per-week bars: single hue, thin marks, rounded data ends, native tooltips per bar. */
export function WeeklyBars({ meetings }: { meetings: MeetingSummary[] }): JSX.Element {
  const { weeks, max, maxIdx } = useMemo(() => computeWeeklyBars(meetings, Date.now()), [meetings])

  const W = 480
  const H = 64
  const gap = 6
  const bw = (W - gap * (WEEKS_SHOWN - 1)) / WEEKS_SHOWN
  const fmt = (w: number): string => new Date(w).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[64px] w-full"
        role="img"
        aria-label="Meetings per week"
      >
        {weeks.map(({ w, n }, i) => {
          const h = n === 0 ? 2 : Math.max(4, (n / max) * (H - 14))
          const x = i * (bw + gap)
          return (
            <g key={w}>
              <rect
                x={x}
                y={H - h}
                width={bw}
                height={h}
                rx={n === 0 ? 1 : 4}
                fill={n === 0 ? 'rgba(255,255,255,0.08)' : 'var(--color-accent-2)'}
              >
                <title>{`Week of ${fmt(w)}: ${n} meeting${n === 1 ? '' : 's'}`}</title>
              </rect>
              {/* Selective direct labels: only the busiest week and the current week carry a number. */}
              {n > 0 && (i === maxIdx || i === WEEKS_SHOWN - 1) && (
                <text
                  x={x + bw / 2}
                  y={H - h - 4}
                  textAnchor="middle"
                  className="fill-[color:var(--color-ink-2)]"
                  fontSize={10}
                  fontWeight={600}
                >
                  {n}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="mt-0.5 flex justify-between text-[9px] text-[color:var(--color-ink-3)]">
        <span>{fmt(weeks[0].w)}</span>
        <span>this week</span>
      </div>
    </div>
  )
}

/** Horizontal magnitude bars (accounts per sector) — label left, single-hue track, count right. */
export function SectorBars({ sectors }: { sectors: { sector: string; n: number }[] }): JSX.Element {
  const max = Math.max(1, ...sectors.map((s) => s.n))
  return (
    <div className="flex flex-col gap-1.5">
      {sectors.map(({ sector, n }) => (
        <div key={sector} className="flex items-center gap-2" title={`${sector}: ${n} account${n === 1 ? '' : 's'}`}>
          <div className="w-32 shrink-0 truncate text-right text-[11px] capitalize text-[color:var(--color-ink-3)]">
            {sector.replace(/-/g, ' ')}
          </div>
          <div className="h-[6px] min-w-[24px] flex-1 overflow-hidden rounded-full bg-white/[0.05]">
            <div className="h-full rounded-full bg-[var(--color-accent-2)]" style={{ width: `${(n / max) * 100}%` }} />
          </div>
          <div className="min-w-[1.25rem] shrink-0 text-right text-[11px] font-semibold text-[color:var(--color-ink-2)]">
            {n}
          </div>
        </div>
      ))}
    </div>
  )
}
