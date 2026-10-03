import React, { memo } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { VirtualList } from './ui/VirtualList'

type FixtureRow = { id: string; title: string; detail: string; tone: string }
type Surface = 'history' | 'review' | 'brain' | 'relationships'
type SurfaceSpec = { surface: Surface; rows: FixtureRow[]; rowHeight: number }

type SurfaceResult = {
  surface: Surface
  rows: number
  renderedRows: number
  frames: number
  maxFrameWorkMs: number
  avgFrameWorkMs: number
}

type MeasureReport = {
  verdict: 'PASS' | 'FAIL'
  budgetMs: number
  results: SurfaceResult[]
}

declare global {
  interface Window {
    __virtualListMeasure?: () => Promise<MeasureReport>
  }
}

const ROWS = 5000
const BUDGET_MS = 16

function fixture(surface: Surface): FixtureRow[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    id: `${surface}-${i}`,
    title: `${surface} row ${i}`,
    detail: `Fixture detail ${i % 37} for the ${surface} virtual-list measurement.`,
    tone: i % 3 === 0 ? 'good' : i % 3 === 1 ? 'mixed' : 'risk'
  }))
}

const specs: SurfaceSpec[] = [
  { surface: 'history', rows: fixture('history'), rowHeight: 56 },
  { surface: 'review', rows: fixture('review'), rowHeight: 44 },
  { surface: 'brain', rows: fixture('brain'), rowHeight: 68 },
  { surface: 'relationships', rows: fixture('relationships'), rowHeight: 52 }
]

const MeasureRow = memo(function MeasureRow({ row, surface }: { row: FixtureRow; surface: Surface }): JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-3 py-2 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold text-[color:var(--color-ink)]">{row.title}</span>
        <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-[color:var(--color-ink-3)]">
          {surface}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[color:var(--color-ink-3)]">{row.detail}</div>
    </div>
  )
})

function SurfaceList({ spec }: { spec: SurfaceSpec }): JSX.Element {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
        {spec.surface}
      </h2>
      <VirtualList
        items={spec.rows}
        getKey={(row) => row.id}
        estimateSize={() => spec.rowHeight}
        className="measure-scroller scroll-thin h-[420px] overflow-y-auto rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-2"
        ariaLabel={`${spec.surface} 5000-row fixture`}
        overscan={8}
        renderItem={({ item, style, measureRef }) => (
          <div key={item.id} ref={measureRef} style={style} data-row={item.id} className="pb-1.5">
            <MeasureRow row={item} surface={spec.surface} />
          </div>
        )}
      />
    </section>
  )
}

function App(): JSX.Element {
  return (
    <main className="grid min-h-screen grid-cols-2 gap-4 bg-[var(--color-bg)] p-4 text-[color:var(--color-ink)]">
      {specs.map((spec) => (
        <SurfaceList key={spec.surface} spec={spec} />
      ))}
    </main>
  )
}

function animationFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

async function measureScroller(scroller: HTMLElement, surface: Surface): Promise<SurfaceResult> {
  const frames = 120
  const work: number[] = []
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  for (let i = 0; i < frames; i++) {
    await animationFrame()
    const start = performance.now()
    scroller.scrollTop = (maxTop * i) / Math.max(1, frames - 1)
    const renderedRows = scroller.querySelectorAll('[data-row]').length
    work.push(performance.now() - start)
    if (renderedRows > 180) throw new Error(`${surface} rendered ${renderedRows} rows in one frame`)
  }
  const renderedRows = scroller.querySelectorAll('[data-row]').length
  const maxFrameWorkMs = Math.max(...work)
  const avgFrameWorkMs = work.reduce((sum, n) => sum + n, 0) / work.length
  return {
    surface,
    rows: ROWS,
    renderedRows,
    frames,
    maxFrameWorkMs,
    avgFrameWorkMs
  }
}

window.__virtualListMeasure = async (): Promise<MeasureReport> => {
  await animationFrame()
  const scrollers = Array.from(document.querySelectorAll<HTMLElement>('.measure-scroller'))
  const results: SurfaceResult[] = []
  for (let i = 0; i < scrollers.length; i++) results.push(await measureScroller(scrollers[i], specs[i].surface))
  return {
    verdict: results.every((r) => r.maxFrameWorkMs <= BUDGET_MS) ? 'PASS' : 'FAIL',
    budgetMs: BUDGET_MS,
    results
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
