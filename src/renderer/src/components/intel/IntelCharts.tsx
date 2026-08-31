import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import type { MeetingSummary } from '@shared/ipc'
import { INTEL_SPRING, intelStagger, useIntelReducedMotion } from './IntelMotion'

const WEEKS_SHOWN = 12

export interface WeeklyBarData {
  weeks: { w: number; n: number }[]
  max: number
  maxIdx: number
}

/** ISO-week (Mon-anchored) start for a date, as a ms timestamp. */
export function weekStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day)
  return d.getTime()
}

/**
 * The WEEKS_SHOWN meetings-per-week columns (oldest first), the bar scale, and the busiest column.
 * Pure and `now`-injected so the bucketing is testable across a DST boundary.
 * Step back seven CALENDAR days at a time instead of subtracting 7*24h: weekStart returns local
 * Monday midnights, and consecutive local Monday midnights are 7d ± 1h apart across a DST
 * transition. setDate preserves the wall-clock fields, so each column stays a real Monday 00:00.
 */
export function computeWeeklyBars(meetings: MeetingSummary[], now: number): WeeklyBarData {
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
  const weeks = columns.map((w) => ({ w, n: counts.get(w) || 0 }))
  const max = Math.max(1, ...weeks.map((x) => x.n))
  const maxIdx = weeks.reduce((best, x, i) => (x.n > weeks[best].n ? i : best), 0)
  return { weeks, max, maxIdx }
}

export function formatWeekLabel(w: number): string {
  return new Date(w).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function meetingCountLabel(n: number): string {
  return `${n} meeting${n === 1 ? '' : 's'}`
}

type BarPoint = { label: string; value: number; title?: string }

type ChartCtx = {
  data: BarPoint[]
  width: number
  height: number
  max: number
  hover: number | null
  setHover: (i: number | null) => void
  reduced: boolean
  highlightIndex: number
}

const ChartContext = createContext<ChartCtx | null>(null)

function useChart(): ChartCtx {
  const ctx = useContext(ChartContext)
  if (!ctx) throw new Error('Intel chart parts must render inside IntelBarChart')
  return ctx
}

export function IntelBarChart({
  data,
  width = 480,
  height = 72,
  highlightIndex = -1,
  ariaLabel,
  children
}: {
  data: BarPoint[]
  width?: number
  height?: number
  highlightIndex?: number
  ariaLabel: string
  children: ReactNode
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const reduced = useIntelReducedMotion()
  const max = Math.max(1, ...data.map((d) => d.value))
  const ctx = useMemo(
    () => ({ data, width, height, max, hover, setHover, reduced, highlightIndex }),
    [data, width, height, max, hover, reduced, highlightIndex]
  )
  return (
    <ChartContext.Provider value={ctx}>
      <div className="intel-chart relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="block h-[72px] w-full"
          role="img"
          aria-label={ariaLabel}
        >
          {children}
        </svg>
        <IntelTooltipOverlay />
      </div>
    </ChartContext.Provider>
  )
}

/** Recessive horizontal rules. Place before the bars. */
export function IntelGrid({ lines = 3 }: { lines?: number }): JSX.Element {
  const { width, height } = useChart()
  const top = 14
  const bottom = height - 2
  return (
    <g aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => {
        const t = lines === 1 ? 0 : i / (lines - 1)
        const y = top + (1 - t) * (bottom - top)
        return (
          <line
            key={i}
            x1={0}
            x2={width}
            y1={y}
            y2={y}
            className="intel-chart-grid"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
    </g>
  )
}

export function IntelBar(): JSX.Element {
  const { data, width, height, max, hover, setHover, reduced, highlightIndex } = useChart()
  const n = Math.max(1, data.length)
  const gap = 6
  const bw = (width - gap * (n - 1)) / n
  const plotH = height - 16

  return (
    <g>
      {data.map((d, i) => {
        const h = d.value === 0 ? 2 : Math.max(4, (d.value / max) * plotH)
        const x = i * (bw + gap)
        const active = hover === i || highlightIndex === i
        return (
          <g
            key={`${d.label}-${i}`}
            tabIndex={0}
            role="img"
            aria-label={d.title ?? `${d.label}: ${meetingCountLabel(d.value)}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <rect
              x={x}
              y={0}
              width={bw}
              height={height}
              fill="transparent"
              className="cursor-default"
            />
            <motion.rect
              x={x}
              y={height - h}
              width={bw}
              height={h}
              rx={d.value === 0 ? 1 : 4}
              className={d.value === 0 ? 'intel-chart-track' : 'intel-chart-mark'}
              style={{
                transformBox: 'fill-box',
                transformOrigin: 'bottom',
                opacity: hover !== null && hover !== i ? 0.45 : active ? 1 : 0.88
              }}
              initial={reduced ? false : { scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ ...INTEL_SPRING, delay: reduced ? 0 : intelStagger(i, 0.028, 11) }}
            />
            {d.value > 0 && (i === highlightIndex || i === n - 1) && (
              <text
                x={x + bw / 2}
                y={height - h - 4}
                textAnchor="middle"
                className="fill-[color:var(--color-ink-2)]"
                fontSize={10}
                fontWeight={600}
              >
                {d.value}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

export function IntelXAxis({ start, end }: { start: string; end: string }): JSX.Element {
  return (
    <div className="mt-0.5 flex justify-between text-[9px] text-[color:var(--color-ink-3)]">
      <span>{start}</span>
      <span>{end}</span>
    </div>
  )
}

/** Composition marker: the live tooltip paints outside the SVG via IntelBarChart. */
export function IntelTooltip(): null {
  return null
}

function IntelTooltipOverlay(): JSX.Element | null {
  const { data, hover } = useChart()
  if (hover === null || !data[hover]) return null
  const d = data[hover]
  const n = Math.max(1, data.length)
  const left = ((hover + 0.5) / n) * 100
  return (
    <div
      className="intel-chart-tooltip"
      style={{ left: `${left}%` }}
      role="status"
    >
      <div className="font-semibold text-[color:var(--color-ink)]">{d.label}</div>
      <div className="text-[color:var(--color-ink-2)]">{d.title ?? meetingCountLabel(d.value)}</div>
    </div>
  )
}

/** Meetings-per-week: Grid + Bar + XAxis + Tooltip. Single hue, never a fabricated percent. */
export function WeeklyBars({ meetings }: { meetings: MeetingSummary[] }): JSX.Element {
  const { weeks, maxIdx } = useMemo(() => computeWeeklyBars(meetings, Date.now()), [meetings])
  const data = weeks.map(({ w, n }) => ({
    label: `Week of ${formatWeekLabel(w)}`,
    value: n,
    title: `${meetingCountLabel(n)}`
  }))
  return (
    <div>
      <IntelBarChart data={data} highlightIndex={maxIdx} ariaLabel="Meetings per week">
        <IntelGrid />
        <IntelBar />
        <IntelTooltip />
      </IntelBarChart>
      <IntelXAxis start={formatWeekLabel(weeks[0].w)} end="this week" />
    </div>
  )
}

/** Horizontal magnitude bars: label, single-hue track, count. */
export function SectorBars({ sectors }: { sectors: { sector: string; n: number }[] }): JSX.Element {
  const max = Math.max(1, ...sectors.map((s) => s.n))
  const reduced = useIntelReducedMotion()
  return (
    <div className="flex flex-col gap-1.5">
      {sectors.map(({ sector, n }, i) => {
        const pct = (n / max) * 100
        return (
          <div
            key={sector}
            className="flex items-center gap-2"
            title={`${sector}: ${n} account${n === 1 ? '' : 's'}`}
          >
            <div className="w-32 shrink-0 truncate text-right text-[11px] capitalize text-[color:var(--color-ink-3)]">
              {sector.replace(/-/g, ' ')}
            </div>
            <div className="intel-mag-track h-[7px] min-w-[24px] flex-1">
              <motion.div
                className="intel-mag-fill h-full"
                initial={reduced ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ ...INTEL_SPRING, delay: reduced ? 0 : intelStagger(i, 0.04, 8) }}
                style={{ width: `${pct}%`, transformOrigin: 'left center' }}
              />
            </div>
            <div className="min-w-[1.25rem] shrink-0 text-right text-[11px] font-semibold tabular-nums text-[color:var(--color-ink-2)]">
              {n}
            </div>
          </div>
        )
      })}
    </div>
  )
}
