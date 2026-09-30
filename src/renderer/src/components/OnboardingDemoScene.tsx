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
 *   Next/Previous select a video; Replay restarts it. No timer jumps stages.
 * - lib/synthetic-cursor.ts owns the pure easing math for the drawn cursor; this component only
 *   measures the target chip's real screen position each frame.
 * - SAFETY (MQA-278, see @shared/demo-guard + lib/onboarding-demo-guard.ts): this component flips a
 *   session-scoped "the demo is on screen" flag on mount/unmount so the real Answer component's own
 *   save/rate buttons (which it mounts, for the fact-check beat) refuse to persist anything while this
 *   scene is up — and the demo's own data source (onboarding-demo.ts) structurally cannot read a real
 *   transcript or session in the first place (pinned by a contract test).
 */
import { Suspense, lazy, useEffect, useId, useRef, useState, type RefObject } from 'react'
import type { TranscriptLine } from '@shared/ipc'
import { CONVERSATION_MODES, BUILTIN_MODE_LABELS, type BuiltinMode } from '@shared/ipc'
import type { AnswerState } from '../state'
import { Bar } from './Bar'
import { QuickActions } from './QuickActions'
import {
  DEMO_FACTCHECK_LABEL,
  DEMO_STAGE_VIDEOS,
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
import { OnboardingDemoPreviewBoundary } from './OnboardingDemoPreviewBoundary'
import {
  advanceDemoBeat,
  createDemoPlaybackClock,
  demoClockCommand,
  demoOrchestratorSnapshot,
  demoPlaybackStatus,
  demoStepComplete,
  initialDemoOrchestratorState,
  previousDemoBeat,
  readDemoEnvironment,
  replayDemoBeat,
  runOptionalDemoMedia,
  toggleDemoPause,
  watchDemoEnvironment,
  type DemoBeatModel,
  type DemoOrchestratorState,
  type DemoPlaybackClock,
  type DemoPlaybackPhase,
  type DemoPlaybackSnapshot
} from '../lib/onboarding-demo-controls'

// Same weight rationale as App.tsx's own lazy Answer/Copilot: both pull in Markdown.tsx -> streamdown +
// shiki/core, which has no reason to be in the eager boot chunk before this act.
const Answer = lazy(() => import('./Answer').then((m) => ({ default: m.Answer })))
const Copilot = lazy(() => import('./Copilot').then((m) => ({ default: m.Copilot })))

/** @deprecated Prefer lib/onboarding-demo-prefetch — kept as re-export for older imports. */
export { prefetchOnboardingDemoChunks } from '../lib/onboarding-demo-prefetch'

/** Transcript / frame React commits — not every rAF. Cursor is DOM-driven. */
export const DEMO_COMMIT_MS = 100

const CHIP_SELECTOR: Record<Exclude<DemoCursorTarget, 'none'>, string> = {
  suggestion: '[aria-label="What to say next"]',
  factcheck: '[aria-label="Fact-check"]'
}

const DEMO_STAGE_LABELS = {
  lines: 'Listen to a meeting',
  suggestion: 'Get a suggestion',
  factcheck: 'Check a claim',
  recap: 'Review the recap'
} as const

/** The demo's own beat/stage content, adapted to the orchestrator's generic contract —
 * see lib/onboarding-demo.ts for what each query actually computes. */
const DEMO_BEAT_MODEL: DemoBeatModel = {
  hasNextBeat: demoHasNextBeat,
  holdMs: demoBeatHoldMs,
  playbackElapsed: demoPlaybackElapsed,
  afterNext: demoPlaybackAfterNext
}

/** The same real demo, with one clock owner and explicit user-controlled pacing. Pause/
 * Replay/Previous/Next all resolve through lib/onboarding-demo-controls.ts's pure
 * orchestrator (unit-tested there); this hook only wires it to the DemoPlaybackClock and
 * the DOM (cursor position, chip click) that the orchestrator itself cannot own. */
function useDemoPlayback(wrapRef: RefObject<HTMLDivElement>) {
  const [motion] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  )
  const [environment, setEnvironment] = useState(() =>
    readDemoEnvironment(typeof document === 'undefined' ? null : document, motion)
  )
  const [orchestrator, setOrchestrator] = useState<DemoOrchestratorState>(initialDemoOrchestratorState)
  const [localMs, setLocalMs] = useState(0)
  const [phase, setPhase] = useState<DemoPlaybackPhase>('paused')
  const clockRef = useRef<DemoPlaybackClock | null>(null)
  const phaseRef = useRef<DemoPlaybackPhase>('paused')
  const controlsRef = useRef({ environment, paused: orchestrator.paused })
  controlsRef.current = { environment, paused: orchestrator.paused }
  // Event handlers read the latest orchestrator state from this ref; commit() is the only
  // writer and updates it before setOrchestrator.
  const orchestratorRef = useRef(orchestrator)
  const cursorRef = useRef<HTMLDivElement>(null)
  const lastCommitRef = useRef(0)
  const clickedForRef = useRef<DemoCursorTarget | null>(null)

  useEffect(() =>
    watchDemoEnvironment(
      typeof document === 'undefined' ? null : document,
      motion,
      (next) => {
        controlsRef.current = { ...controlsRef.current, environment: next }
        clockRef.current?.[demoClockCommand(next, controlsRef.current.paused)]()
        setEnvironment(next)
      }
    ), [motion])

  useEffect(() => {
    const beat = orchestrator.beat
    clickedForRef.current = null
    lastCommitRef.current = 0
    phaseRef.current = 'paused'
    setPhase('paused')
    setLocalMs(0)
    const duration = demoBeatHoldMs(beat) - demoPlaybackElapsed(beat, 0)
    const tick = (snapshot: DemoPlaybackSnapshot): void => {
      const local = snapshot.elapsedMs
      const elapsed = demoPlaybackElapsed(beat, local)
      const frame = demoFrameAt(elapsed)
      const cursorEl = cursorRef.current
      const wrap = wrapRef.current
      const controls = controlsRef.current
      if (
        !cursorEl || !wrap || frame.cursor.target === 'none' ||
        controls.environment.reducedMotion || controls.environment.hidden || controls.paused
      ) {
        if (cursorEl) cursorEl.style.opacity = '0'
      } else {
        const chip = wrap.querySelector<HTMLElement>(CHIP_SELECTOR[frame.cursor.target])
        if (!chip) {
          cursorEl.style.opacity = '0'
        } else {
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
          if (
            snapshot.phase === 'playing' && frame.cursor.pressed &&
            clickedForRef.current !== frame.cursor.target
          ) {
            clickedForRef.current = frame.cursor.target
            // The scripted chip is optional decoration, never authority to block Next.
            runOptionalDemoMedia(() => chip.click())
          }
        }
      }
      if (snapshot.phase !== phaseRef.current) {
        phaseRef.current = snapshot.phase
        setPhase(snapshot.phase)
      }
      const held = elapsed >= demoBeatHoldMs(beat)
      if (snapshot.phase !== 'playing' || held || local - lastCommitRef.current >= DEMO_COMMIT_MS) {
        lastCommitRef.current = local
        setLocalMs(local)
      }
    }
    const clock = createDemoPlaybackClock(duration, {
      now: () => performance.now(),
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id)
    }, tick)
    // Deliberately no play/pause/finish call here: the sync effect below depends on the same
    // orchestrator.beat/replayKey and runs right after this one in the same commit, so it is
    // the only place that drives a freshly created clock too.
    clockRef.current = clock
    return () => {
      clock.dispose()
      if (clockRef.current === clock) clockRef.current = null
      if (cursorRef.current) cursorRef.current.style.opacity = '0'
    }
  }, [orchestrator.beat, orchestrator.replayKey, wrapRef])

  useEffect(() => {
    clockRef.current?.[demoClockCommand(environment, orchestrator.paused)]()
  }, [environment.hidden, environment.reducedMotion, orchestrator.paused, orchestrator.beat, orchestrator.replayKey])

  const resetPlayback = (): void => {
    clockRef.current?.dispose()
    controlsRef.current = { ...controlsRef.current, paused: false }
    lastCommitRef.current = 0
  }
  const commit = (next: DemoOrchestratorState): void => {
    orchestratorRef.current = next
    setOrchestrator(next)
  }

  const snapshot = demoOrchestratorSnapshot(orchestrator, localMs, environment.reducedMotion, DEMO_BEAT_MODEL)

  return {
    elapsedMs: snapshot.elapsedMs,
    beat: snapshot.beat,
    hasNext: snapshot.hasNext,
    cursorRef,
    reducedMotion: environment.reducedMotion,
    paused: snapshot.paused,
    phase,
    replayKey: snapshot.replayKey,
    status: demoPlaybackStatus(phase, environment, snapshot.paused),
    togglePaused: () => {
      // Stop immediately in the click, rather than waiting for a render/effect.
      const next = toggleDemoPause(orchestratorRef.current, phaseRef.current, controlsRef.current.environment.reducedMotion)
      if (next === orchestratorRef.current) return
      controlsRef.current = { ...controlsRef.current, paused: next.paused }
      clockRef.current?.[demoClockCommand(controlsRef.current.environment, next.paused)]()
      commit(next)
    },
    replay: () => {
      resetPlayback()
      setLocalMs(0)
      commit(replayDemoBeat(orchestratorRef.current))
    },
    previous: () => {
      const next = previousDemoBeat(orchestratorRef.current)
      if (next === orchestratorRef.current) return
      resetPlayback()
      setLocalMs(0)
      commit(next)
    },
    advance: () => {
      if (!demoStepComplete(phaseRef.current, controlsRef.current.environment.reducedMotion)) return false
      resetPlayback()
      const next = advanceDemoBeat(orchestratorRef.current, DEMO_BEAT_MODEL)
      setLocalMs(next.localMs)
      commit(next.state)
      return true
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
  onPlayVideo: playOptionalVideo
}: {
  mode: string
  onSetMode: (mode: BuiltinMode) => void
  onContinue: () => void
  onPlayVideo?: () => void
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const {
    elapsedMs, beat, hasNext, advance, previous, replay, togglePaused,
    paused, phase, status, replayKey, reducedMotion, cursorRef
  } = useDemoPlayback(wrapRef)
  const stepComplete = demoStepComplete(phase, reducedMotion)
  const statusId = useId()
  const previewId = useId()
  // Keep the optional media attempt synchronous and navigation-independent.
  const onPlayVideo = (): void => runOptionalDemoMedia(playOptionalVideo)
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
      <Suspense fallback={<p role="status">Loading the example. You can still continue setup.</p>}>
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
      <Suspense fallback={<p role="status">Loading the example. You can still continue setup.</p>}>
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
    <div key="reveal" className="flex min-h-0 w-full flex-1 flex-col items-center gap-4">
      <div className="scene-enter flex min-h-0 w-full flex-1 flex-col items-center gap-4 overflow-y-auto py-2">
      <h2 className="m-0 text-[24px] font-semibold text-[color:var(--color-ink)]">Here’s what that looks like.</h2>
      <p className="m-0 text-[13px] text-[color:var(--color-ink-2)]">
        {hasNext
          ? 'This clip plays on its own. Next starts the next one.'
          : 'That’s the full pass. Continue when you’re ready.'}
      </p>
      <p id={statusId} role="status" aria-live="polite" aria-atomic="true"
        className="m-0 max-w-[880px] text-center text-[13px] text-[color:var(--color-ink-2)]">
        Step {beat + 1} of {DEMO_STAGE_VIDEOS.length}: {DEMO_STAGE_LABELS[frame.stage]}. {status}
      </p>
      <p className="m-0 max-w-[880px] text-center text-[12px] text-[color:var(--color-ink-2)]">
        Scripted example. No recording or desktop actions.
      </p>
      <div role="group" aria-label="Example role" className="flex max-w-[880px] flex-wrap justify-center gap-1.5">
        {CONVERSATION_MODES.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onSetMode(id)}
            aria-pressed={mode === id}
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

      <div id={previewId} className="w-full max-w-[880px]">
      <OnboardingDemoPreviewBoundary key={`${beat}:${replayKey}`}>
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
      </OnboardingDemoPreviewBoundary>
      </div>
      </div>

      <div className="flex w-full shrink-0 flex-col items-center gap-3">
        <div role="group" aria-label="Demo playback"
          className="flex max-w-[880px] flex-wrap items-center justify-center gap-2">
          <button type="button" className="onboard-cta no-drag focus-ring"
            disabled={beat === 0} aria-controls={previewId} onClick={previous}>
            Previous
          </button>
          {!reducedMotion && (
            <button type="button" className="onboard-cta no-drag focus-ring"
              disabled={phase === 'held'} aria-pressed={paused}
              aria-controls={previewId} onClick={togglePaused}>
              {paused ? 'Resume demo' : 'Pause demo'}
            </button>
          )}
          <button type="button" className="onboard-cta no-drag focus-ring"
            aria-controls={previewId} onClick={replay}>
            Replay this step
          </button>
        </div>
        <div role="group" aria-label="Continue onboarding" className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          aria-describedby={statusId}
          disabled={!stepComplete}
          onClick={() => {
            onPlayVideo?.()
            if (!stepComplete) return
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
    </div>
  )
}
