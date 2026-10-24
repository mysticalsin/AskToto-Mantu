import { useCallback, useEffect, useRef } from 'react'
import type { InterventionSnapshot } from '@shared/intervention-contract'
import type { TranscriptLine } from '@shared/ipc'
import { fieldContext } from './ask-context'
import type { AskRequest } from './ask-types'
import {
  cancelStaleLive,
  runQuestionFlow,
  runShadowFlow,
  type FlowSettings,
  type ShadowWatermarkCommit
} from './intervention-flow'
import { InterventionGate, diffTranscriptLines, transcriptLineId, type TranscriptLineLike } from './intervention-gate'
import { ProactiveControls, playbookFingerprint, syncPlaybook } from './proactive-controls'

/**
 * React glue for the InterventionGate (G70). The decisions live in intervention-flow.ts and
 * intervention-gate.ts; these hooks only own refs and effects, and keep the latest props in a ref so the
 * handlers they hand out never act on a stale render.
 */

/** One gate per window. It learns about the transcript and the session scope from the same state the UI reads. */
export function useInterventionGate(args: {
  lines: readonly TranscriptLineLike[]
  listening: boolean
  meetingStartRef: { readonly current: number }
  signedIn: boolean
}): InterventionGate {
  const { lines, listening, meetingStartRef, signedIn } = args
  const gateRef = useRef<InterventionGate | null>(null)
  if (!gateRef.current) {
    gateRef.current = new InterventionGate({
      meetingStartMs: meetingStartRef.current,
      report: (record) => void window.toto.reportInterventionShadow(record)
    })
  }
  const gate = gateRef.current
  const prevLines = useRef<readonly TranscriptLineLike[]>(lines)
  const prevListening = useRef(listening)
  const prevSignedIn = useRef(signedIn)

  useEffect(() => {
    if (prevListening.current !== listening) {
      prevListening.current = listening
      if (listening) gate.startMeeting(meetingStartRef.current)
      else gate.observe({ kind: 'scope', change: 'stop' })
      prevLines.current = lines // a new meeting's reset is a scope change, not a retraction of every old line
    }
    if (prevSignedIn.current !== signedIn) {
      prevSignedIn.current = signedIn
      if (!signedIn) gate.observe({ kind: 'scope', change: 'sign-out' })
      prevLines.current = lines
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lines is read for the reset only
  }, [gate, listening, signedIn, meetingStartRef])

  useEffect(() => {
    for (const event of diffTranscriptLines(prevLines.current, lines)) gate.observe(event)
    prevLines.current = lines
  }, [gate, lines])

  return gate
}

export interface QuestionInterventionArgs {
  gate: InterventionGate
  lines: readonly TranscriptLineLike[]
  listening: boolean
  settings: FlowSettings | null
  suggest: { answer: { streaming?: boolean } | null; run: (req: AskRequest) => string; cancel: () => unknown }
  focusCopilot: () => void
  readySpeculative: () => { snapshot: InterventionSnapshot } | null
  showSpeculative: () => void
}

/**
 * The auto-answer when the other person asks a question (debounce = suggestEverySec): returns the handler for
 * `useListen`'s onQuestion. Also cancels the live card it started when that card's evidence is invalidated.
 */
export function useQuestionIntervention(args: QuestionInterventionArgs): (line: TranscriptLine) => void {
  const latest = useRef(args)
  latest.current = args
  const lastSuggestAtRef = useRef(0)
  const liveSnapshotRef = useRef<InterventionSnapshot | null>(null)
  const controlsRef = useRef<ProactiveControls | null>(null)
  if (!controlsRef.current) controlsRef.current = new ProactiveControls(Date.now)
  const controls = controlsRef.current
  const playbookBaselineRef = useRef<string | null>(null)
  // G77: null until settings load, so the first loaded playbook is the baseline and never a change.
  const fingerprint = args.settings ? playbookFingerprint(args.settings) : null

  useEffect(() => {
    if (fingerprint === null) return
    syncPlaybook({ baseline: playbookBaselineRef, fingerprint, gate: args.gate, controls })
  }, [args.gate, controls, fingerprint])

  useEffect(() => {
    cancelStaleLive({
      gate: args.gate,
      snapshotRef: liveSnapshotRef,
      streaming: !!args.suggest.answer?.streaming,
      cancel: () => void latest.current.suggest.cancel()
    })
  }, [args.gate, args.lines, args.listening, args.suggest.answer?.streaming, fingerprint])

  return useCallback(
    (line: TranscriptLine): void => {
      const a = latest.current
      void runQuestionFlow(
        {
          gate: a.gate,
          nowMs: Date.now,
          lastSuggestAtRef,
          settings: a.settings,
          suggestStreaming: () => !!latest.current.suggest.answer?.streaming,
          focusCopilot: a.focusCopilot,
          readySpeculative: a.readySpeculative,
          showSpeculative: a.showSpeculative,
          runSuggest: (snapshot) => {
            liveSnapshotRef.current = snapshot
            a.suggest.run({ mode: 'suggest', outputIntent: 'ambient', context: fieldContext('conversation') })
          },
          offerQuiet: (channel) => window.toto.quietOutputOffer(channel),
          controls,
          triggerText: line.text
        },
        transcriptLineId(line.t)
      )
    },
    [controls]
  )
}

export interface ShadowPregenerationArgs {
  gate: InterventionGate
  lines: readonly (TranscriptLineLike & { speaker: 'them' | 'you' | 'unknown' })[]
  listening: boolean
  settings: FlowSettings | null
  anyStreaming: boolean
  watermarkRef: { current: { lineCount: number; at: number } }
  runSpeculative: () => string
  commitWatermark: (commit: ShadowWatermarkCommit) => void
  /** Clock override for tests; defaults to Date.now. */
  nowMs?: () => number
}

/** One pre-generation attempt: the body of the shadow effect, callable without React. */
export function startShadowPregeneration(
  latest: { readonly current: ShadowPregenerationArgs },
  busyRef: { current: boolean }
) {
  return runShadowFlow({
    gate: latest.current.gate,
    busyRef,
    rulesInput: () => {
      const a = latest.current
      return {
        listening: a.listening,
        settings: a.settings,
        lastSpeaker: a.lines.length ? a.lines[a.lines.length - 1].speaker : null,
        lineCount: a.lines.length,
        watermark: a.watermarkRef.current,
        nowMs: (a.nowMs ?? Date.now)(),
        anyStreaming: a.anyStreaming
      }
    },
    runSpeculative: () => latest.current.runSpeculative(),
    commitWatermark: (commit) => latest.current.commitWatermark(commit)
  })
}

/**
 * While a meeting is live, pre-generate a shadow "what to say next" whenever the OTHER side has spoken and the
 * last speculative run is older than suggestEverySec, so the button and the auto-answer can paint instantly.
 * Never fires while anything visible is streaming (visible work wins bandwidth).
 */
export function useShadowPregeneration(args: ShadowPregenerationArgs): void {
  const latest = useRef(args)
  latest.current = args
  const busyRef = useRef(false)
  const { gate, lines, listening, settings, anyStreaming } = args

  useEffect(() => {
    void startShadowPregeneration(latest, busyRef)
  }, [gate, lines, listening, settings, anyStreaming])
}
