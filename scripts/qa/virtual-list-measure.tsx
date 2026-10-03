import React, { memo } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import { VirtualList } from '../../src/renderer/src/ui/VirtualList'
import { MeetingRow } from '../../src/renderer/src/components/RecallView'
import { TranscriptRow } from '../../src/renderer/src/components/Review'
import { DealRow } from '../../src/renderer/src/components/BrainView'
import { GoingColdRow } from '../../intelligence/src/views/GraphRows'
import type { DealEntity } from '@shared/brain'
import type { MeetingSummary, TranscriptLine } from '@shared/ipc'
import type { GoingColdRow as GoingColdItem } from '../../intelligence/src/types/data'

type Surface = 'history' | 'review' | 'brain' | 'relationships'
type SurfaceItem =
  | { surface: 'history'; key: string; row: MeetingSummary }
  | { surface: 'review'; key: string; row: TranscriptLine }
  | { surface: 'brain'; key: string; row: DealEntity }
  | { surface: 'relationships'; key: string; row: GoingColdItem }
type SurfaceSpec = { surface: Surface; rows: SurfaceItem[]; rowHeight: number }

type SurfaceResult = {
  surface: Surface
  rows: number
  renderedRows: number
  frames: number
  idleFrameGapMs: number
  maxFrameGapMs: number
  avgFrameGapMs: number
  droppedFrames: number
  maxWorkMs: number
  avgWorkMs: number
  maxLongTaskMs: number
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

function historyFixture(): SurfaceItem[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    surface: 'history',
    key: `meeting-${i}.md`,
    row: {
      file: `meeting-${i}.md`,
      title: `Customer review ${i}`,
      date: new Date(Date.UTC(2026, 0, 1 + (i % 28), 14, i % 60)).toISOString(),
      mode: 'standard',
      durationMin: 25 + (i % 50),
      participants: [`Speaker ${i % 9}`, `Contact ${i % 17}`],
      topics: [`topic ${i % 13}`, `topic ${(i + 4) % 13}`]
    }
  }))
}

function reviewFixture(): SurfaceItem[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    surface: 'review',
    key: `transcript-${i}`,
    row: {
      speaker: i % 4 === 0 ? 'you' : i % 4 === 1 ? 'them' : 'unknown',
      text: `Transcript line ${i}: this fixture uses the same transcript row as Review so wrapping, speaker labels and timestamps are measured.`,
      t: i * 1200
    }
  }))
}

function brainFixture(): SurfaceItem[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    surface: 'brain',
    key: `deal-${i}`,
    row: {
      schema_version: 2,
      id: `deal-${i}`,
      aliases: [],
      name: `Opportunity ${i}`,
      account: `Account ${i % 23}`,
      stage: i % 3 === 0 ? 'Proposal' : 'Discovery',
      outcome: 'open',
      win_likelihood_band: i % 3 === 0 ? 'good' : i % 3 === 1 ? 'mixed' : 'concerning',
      band_evidence: `Recent signal ${i % 31} from the customer conversation.`,
      velocity: { signal: i % 2 === 0 ? 'hard-calendar-gate' : 'no-hard-date-found', evidence: 'Measured fixture' },
      meetings: [{ file: `meeting-${i}.md`, title: `Meeting ${i}`, date: new Date(2026, 0, 1 + (i % 28)).toISOString() }],
      signals: [],
      missed_signals: [],
      commitments: [],
      feedback: []
    } as DealEntity
  }))
}

function relationshipFixture(): SurfaceItem[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    surface: 'relationships',
    key: `person-${i}`,
    row: {
      nodeId: `person-${i}`,
      label: `Relationship ${i}`,
      type: i % 2 === 0 ? 'person' : 'account',
      account: `Account ${i % 23}`,
      daysQuiet: 14 + (i % 90),
      hook: `Follow up on the last discussed topic ${i % 19}.`
    }
  }))
}

const specs: SurfaceSpec[] = [
  { surface: 'history', rows: historyFixture(), rowHeight: 78 },
  { surface: 'review', rows: reviewFixture(), rowHeight: 46 },
  { surface: 'brain', rows: brainFixture(), rowHeight: 92 },
  { surface: 'relationships', rows: relationshipFixture(), rowHeight: 64 }
]

const SurfaceRow = memo(function SurfaceRow({ item }: { item: SurfaceItem }): JSX.Element {
  if (item.surface === 'history') {
    return (
      <MeetingRow
        meeting={item.row}
        isSelected={false}
        isActive={false}
        isDeleting={false}
        isEditing={false}
        editingValue=""
        isRenaming={false}
        isOpen={false}
        error={null}
        indexStatus={null}
        indexError={null}
        hydration={undefined}
        onSelect={() => undefined}
        onOpen={() => undefined}
        onDownload={() => undefined}
        onToggleConnections={() => undefined}
        onTrash={() => undefined}
        onExport={() => undefined}
        onStartEdit={() => undefined}
        onEditingChange={() => undefined}
        onCommitEdit={() => undefined}
        onCancelEdit={() => undefined}
      />
    )
  }
  if (item.surface === 'review') return <TranscriptRow line={item.row} />
  if (item.surface === 'brain') {
    return (
      <DealRow
        deal={item.row}
        onSetOutcome={() => undefined}
        onOpenRecord={() => undefined}
        accountIdByName={new Map()}
      />
    )
  }
  return <GoingColdRow item={item.row} onFocus={() => undefined} />
})

function SurfaceList({ spec }: { spec: SurfaceSpec }): JSX.Element {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
        {spec.surface}
      </h2>
      <VirtualList
        items={spec.rows}
        getKey={(item) => `${item.surface}:${item.key}`}
        estimateSize={() => spec.rowHeight}
        className="measure-scroller scroll-thin h-[420px] overflow-y-auto rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-2"
        ariaLabel={`${spec.surface} 5000-row fixture`}
        overscan={8}
        renderItem={({ item, style, measureRef }) => (
          <div ref={measureRef} style={style} data-row={spec.surface} className="pb-1.5">
            <SurfaceRow item={item} />
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
  return new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
}

function afterFrameWork(): Promise<number> {
  return new Promise((resolveWork) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolveWork(performance.now())
    }
    channel.port2.postMessage(undefined)
  })
}

async function measureIdleFrameGap(frames: number): Promise<{ average: number; lastFrame: number }> {
  const gaps: number[] = []
  let previousFrame = await animationFrame()
  for (let i = 0; i < frames; i++) {
    const frame = await animationFrame()
    gaps.push(frame - previousFrame)
    previousFrame = frame
  }
  return {
    average: gaps.reduce((sum, n) => sum + n, 0) / Math.max(1, gaps.length),
    lastFrame: previousFrame
  }
}

async function measureScroller(scroller: HTMLElement, surface: Surface): Promise<SurfaceResult> {
  const frames = 120
  const frameGaps: number[] = []
  const workDurations: number[] = []
  const longTaskDurations: number[] = []
  const observers: PerformanceObserver[] = []
  if (typeof PerformanceObserver !== 'undefined') {
    for (const type of ['long-animation-frame', 'longtask']) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTaskDurations.push(entry.duration)
        })
        observer.observe({ type, buffered: true })
        observers.push(observer)
      } catch {
        // Chromium versions differ on long-animation-frame support; dropped-frame counts remain the gap gate.
      }
    }
  }
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const idle = await measureIdleFrameGap(30)
  let previousFrame = idle.lastFrame
  let droppedFrames = 0
  const droppedFrameThreshold = idle.average * 1.5
  for (let i = 0; i < frames; i++) {
    const frame = await animationFrame()
    const frameGap = frame - previousFrame
    frameGaps.push(frameGap)
    if (frameGap > droppedFrameThreshold) droppedFrames += 1
    scroller.scrollTop = (maxTop * i) / Math.max(1, frames - 1)
    const afterWork = await afterFrameWork()
    workDurations.push(afterWork - frame)
    previousFrame = frame
    const renderedRows = scroller.querySelectorAll('[data-row]').length
    if (renderedRows > 180) throw new Error(`${surface} rendered ${renderedRows} rows in one frame`)
  }
  for (const observer of observers) observer.disconnect()
  const renderedRows = scroller.querySelectorAll('[data-row]').length
  const maxFrameGapMs = Math.max(...frameGaps)
  const avgFrameGapMs = frameGaps.reduce((sum, n) => sum + n, 0) / frameGaps.length
  const maxWorkMs = Math.max(...workDurations)
  const avgWorkMs = workDurations.reduce((sum, n) => sum + n, 0) / workDurations.length
  const maxLongTaskMs = longTaskDurations.length > 0 ? Math.max(...longTaskDurations) : 0
  return {
    surface,
    rows: ROWS,
    renderedRows,
    frames,
    idleFrameGapMs: idle.average,
    maxFrameGapMs,
    avgFrameGapMs,
    droppedFrames,
    maxWorkMs,
    avgWorkMs,
    maxLongTaskMs
  }
}

window.__virtualListMeasure = async (): Promise<MeasureReport> => {
  await animationFrame()
  const scrollers = Array.from(document.querySelectorAll<HTMLElement>('.measure-scroller'))
  const results: SurfaceResult[] = []
  for (let i = 0; i < scrollers.length; i++) results.push(await measureScroller(scrollers[i], specs[i].surface))
  return {
    verdict: results.every((r) => r.maxWorkMs <= BUDGET_MS && r.droppedFrames === 0) ? 'PASS' : 'FAIL',
    budgetMs: BUDGET_MS,
    results
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
