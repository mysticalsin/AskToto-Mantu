/**
 * Act 2 — Demo (MQA-277). Replaces the old static mock card in OnboardingExperience.tsx's `reveal`
 * scene with a LIVE demo: a scripted fake meeting plays through Métis's REAL Bar/Copilot/Answer/
 * QuickActions components (never a video, never a from-scratch mock), narrated by a synthetic cursor
 * that glides to the "What to say next" chip and clicks it for real. Per the Vibe-Island teardown's
 * boxed pattern: drive the real UI with fake data behind a safety guard, so the user watches the actual
 * product respond before configuring anything.
 *
 * Architecture:
 * - lib/onboarding-demo.ts owns ALL the fake content as a pure `demoFrameAt(elapsedMs)` projection.
 *   Each DEMO_STAGE is one video: a rAF clock plays elapsedMs from that clip's start to its hold.
 *   Next is the only way to change videos (resets the clock). No timer that jumps stages.
 * - lib/synthetic-cursor.ts owns the pure easing math for the drawn cursor; this component only
 *   measures the target chip's real screen position each frame.
 * - SAFETY (MQA-278, see @shared/demo-guard + lib/onboarding-demo-guard.ts): this component flips a
 *   session-scoped "the demo is on screen" flag on mount/unmount so the real Answer component's own
 *   save/rate buttons (which it mounts, for the fact-check beat) refuse to persist anything while this
 *   scene is up — and the demo's own data source (onboarding-demo.ts) structurally cannot read a real
 *   transcript or session in the first place (pinned by a contract test).
 */
import { Suspense, lazy, useEffect, useRef, useState, type RefObject } from 'react'
import type { TranscriptLine } from '@shared/ipc'
import { CONVERSATION_MODES, BUILTIN_MODE_LABELS, type BuiltinMode } from '@shared/ipc'
import type { AnswerState } from '../state'
import { Bar } from './Bar'
import { QuickActions } from './QuickActions'
import {
  DEMO_FACTCHECK_LABEL,
  demoRecapMarkdown,
  demoBeatHoldMs,
  demoHasNextBeat,
  demoPlaybackElapsed,
  demoPlaybackAfterNext,
  demoFrameAt,
  demoNextLeavesTour,
  type DemoCursorTarget
} from '../lib/onboarding-demo'
import { cursorPositionAt, type Point } from '../lib/synthetic-cursor'
import { setOnboardingDemoActive } from '../lib/onboarding-demo-guard'
import { ModeRecapView, modeRecapSections } from './ModeRecap'

// Same weight rationale as App.tsx's own lazy Answer/Copilot: both pull in Markdown.tsx -> streamdown +
// shiki/core, which has no reason to be in the eager boot chunk for a user who skips the tour.
const Answer = lazy(() => import('./Answer').then((m) => ({ default: m.Answer })))
const Copilot = lazy(() => import('./Copilot').then((m) => ({ default: m.Copilot })))

/** Prefetch Markdown+shiki during Act 1 so the first Next does not compile on the click. */
export function prefetchOnboardingDemoChunks(): void {
  void import('./Answer')
  void import('./Copilot')
}

/** Transcript / frame React commits — not every rAF. Cursor is DOM-driven. */
export const DEMO_COMMIT_MS = 100

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

const CHIP_SELECTOR: Record<Exclude<DemoCursorTarget, 'none'>, string> = {
  suggestion: '[aria-label="What to say next"]',
  factcheck: '[aria-label="Fact-check"]'
}

/** Intra-video rAF clock. Plays the current DEMO_STAGE; Next is the only way to change beat.
 *  Cursor is a ref + DOM transform. React state commits at beat boundaries or ≤ ~10 Hz. */
function useDemoPlayback(wrapRef: RefObject<HTMLDivElement>): {
  elapsedMs: number
  beat: number
  hasNext: boolean
  advance: () => void
  cursorRef: RefObject<HTMLDivElement>
} {
  const [beat, setBeat] = useState(0)
  const [localMs, setLocalMs] = useState(0)
  const reduced = prefersReducedMotion()
  const cursorRef = useRef<HTMLDivElement>(null)
  const lastCommitRef = useRef(0)
  const clickedForRef = useRef<DemoCursorTarget | null>(null)

  useEffect(() => {
    clickedForRef.current = null
    lastCommitRef.current = 0
    setLocalMs(reduced ? 1e9 : 0)
    if (reduced) return
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number): void => {
      const local = now - t0
      const elapsed = demoPlaybackElapsed(beat, local)
      const frame = demoFrameAt(elapsed)
      const cursorEl = cursorRef.current
      const wrap = wrapRef.current
      if (!cursorEl || !wrap || frame.cursor.target === 'none') {
        if (cursorEl) cursorEl.style.opacity = '0'
      } else {
        const chip = wrap.querySelector<HTMLElement>(CHIP_SELECTOR[frame.cursor.target])
        if (chip) {
          const wrapRect = wrap.getBoundingClientRect()
          const chipRect = chip.getBoundingClientRect()
          const to: Point = {
            x: chipRect.left + chipRect.width / 2 - wrapRect.left,
            y: chipRect.top + chipRect.height / 2 - wrapRect.top
          }
          const from: Point = { x: wrapRect.width / 2, y: 24 }
          const p = cursorPositionAt(frame.cursor.progress, from, to)
          cursorEl.style.opacity = '1'
          cursorEl.style.transform = `translate(${p.x - 7}px, ${p.y - 7}px)`
          cursorEl.classList.toggle('demo-cursor-press', frame.cursor.pressed)
          if (frame.cursor.pressed && clickedForRef.current !== frame.cursor.target) {
            clickedForRef.current = frame.cursor.target
            chip.click()
          }
        }
      }
      const held = elapsed >= demoBeatHoldMs(beat)
      if (held || local - lastCommitRef.current >= DEMO_COMMIT_MS) {
        lastCommitRef.current = local
        setLocalMs(local)
      }
      if (!held) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [beat, reduced, wrapRef])

  return {
    elapsedMs: demoPlaybackElapsed(beat, localMs),
    beat,
    hasNext: demoHasNextBeat(beat),
    cursorRef,
    advance: () => {
      const next = demoPlaybackAfterNext(beat)
      lastCommitRef.current = 0
      setLocalMs(next.localMs)
      setBeat(next.beat)
    }
  }
}

function DemoRecapCard({ mode }: { mode: string }): JSX.Element {
  const md = demoRecapMarkdown(mode)
  return (
    <div className="scene-enter w-full max-w-[880px]">
      <ModeRecapView mode={mode} title="Mantu Intelligence" sections={modeRecapSections(md, mode)} />
    </div>
  )
}

export function OnboardingDemoScene({
  mode,
  onSetMode,
  onContinue,
  onPlayVideo
}: {
  mode: string
  onSetMode: (mode: BuiltinMode) => void
  onContinue: () => void
  onPlayVideo?: () => void
}): JSX.Element {
  const reducedMotion = prefersReducedMotion()
  const wrapRef = useRef<HTMLDivElement>(null)
  const { elapsedMs, beat, hasNext, advance, cursorRef } = useDemoPlayback(wrapRef)
  const frame = demoFrameAt(elapsedMs)
  const startedAtRef = useRef(Date.now())

  // MQA-278 — flip the session-scoped guard for exactly as long as this scene is mounted.
  useEffect(() => {
    setOnboardingDemoActive(true)
    return () => setOnboardingDemoActive(false)
  }, [])

  const demoLines: TranscriptLine[] = frame.lines.map((l) => ({ speaker: l.speaker, text: l.text, t: l.at }))

  const suggestionAnswer: AnswerState | null = frame.suggestion
    ? { id: 'onboarding-demo-suggestion', text: frame.suggestion.text, streaming: frame.suggestion.streaming, error: null, prompt: '' }
    : null

  const busy = !!(frame.suggestion?.streaming && frame.stage === 'suggestion') || !!(frame.factcheck?.streaming && frame.stage === 'factcheck')

  const body =
    frame.stage === 'factcheck' ? (
      <Suspense fallback={null}>
        <Answer
          text={frame.factcheck?.text ?? ''}
          streaming={!!frame.factcheck?.streaming}
          error={null}
          label={DEMO_FACTCHECK_LABEL}
          kind="factcheck"
          provider="cloudflare"
        />
      </Suspense>
    ) : (
      <Suspense fallback={null}>
        <Copilot
          lines={demoLines}
          suggestion={suggestionAnswer}
          mode="general"
          listening
          loading={false}
          loadingPct={null}
          error={null}
          showTranscript
          onEnd={() => {}}
        />
      </Suspense>
    )

  return (
    <div key="reveal" className="flex w-full flex-1 flex-col items-center justify-center gap-6">
      <div className="scene-enter flex w-full flex-col items-center justify-center gap-6">
      <h2 className="m-0 text-[24px] font-semibold text-[color:var(--color-ink)]">Here’s what that looks like.</h2>
      <p className="m-0 text-[13px] text-[color:var(--color-ink-2)]">
        {hasNext
          ? 'This clip plays on its own. Next starts the next one.'
          : 'That’s the full pass. Continue when you’re ready.'}
      </p>
      <div className="flex max-w-[880px] flex-wrap justify-center gap-1.5">
        {CONVERSATION_MODES.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onSetMode(id)}
            className={
              'onboard-role-chip no-drag focus-ring rounded-full px-3 py-1.5 text-[11px] font-semibold ' +
              (mode === id
                ? 'bg-[#f4f4f5] text-[#09090b]'
                : 'bg-white/10 text-[color:var(--color-ink-2)] hover:bg-white/16')
            }
          >
            {BUILTIN_MODE_LABELS[id]}
          </button>
        ))}
      </div>

      {!frame.meetingEnded ? (
        <div ref={wrapRef} className="relative w-full max-w-[880px]">
          <Bar
            value=""
            onChange={() => {}}
            onSubmit={() => {}}
            onStop={() => {}}
            busy={busy}
            listening
            onToggleListen={() => {}}
            paused={false}
            onTogglePause={() => {}}
            onCapture={() => {}}
            capturing={false}
            captureAccel=""
            onSettings={() => {}}
            onHistory={() => {}}
            onMinimize={() => {}}
            stealth={false}
            onToggleStealth={() => {}}
            startedAt={startedAtRef.current}
            panelOpen={false}
            onTogglePanel={() => {}}
            canTogglePanel={false}
            focusSignal={0}
            mode="general"
            onSetMode={() => {}}
            body={body}
            onNewMeeting={() => {}}
            onTranscript={() => {}}
            transcriptShown
          />
          <QuickActions
            onAction={() => {}}
            rainbowRing={!frame.suggestion && !frame.factcheck}
            providerReady
            localSummaryReady
            localSuggestReady
            localFallbackReady
          />
          {!reducedMotion && (
            <div ref={cursorRef} aria-hidden="true" className="demo-cursor" style={{ opacity: 0 }} />
          )}
        </div>
      ) : (
        <DemoRecapCard mode={mode} />
      )}
      </div>

      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={() => {
            onPlayVideo?.()
            if (demoNextLeavesTour(beat)) onContinue()
            else advance()
          }}
          className="onboard-cta no-drag focus-ring"
        >
          Next
        </button>
        <button type="button" onClick={onContinue} className="onboard-cta no-drag focus-ring">
          Set me up
        </button>
      </div>
    </div>
  )
}
