import { useEffect, useRef, type MutableRefObject } from 'react'
import type { ChatTurn } from '@shared/ipc'
import type { AnswerState } from '../state'
import { forgetStaleTurns, rememberTurn } from './stale-outputs'

const MAX_STALE_RUNS = 64

/** Mutable follow-up memory owned by App: each ref is also read or written by App's own handlers. */
export interface ConversationMemoryRefs {
  /** Multi-turn memory for plain Ask follow-ups. */
  history: MutableRefObject<ChatTurn[]>
  /** Multi-turn memory for Copilot follow-ups during Listen. */
  copilotHistory: MutableRefObject<ChatTurn[]>
  /** When the last Ask turn completed (renderer half of main's fresh-question staleness check). */
  lastTurnAt: MutableRefObject<number>
  /** The Ask turn waiting for its answer, keyed by run id. */
  pendingUser: MutableRefObject<{ id: string; q: string } | null>
  /** Set when the user explicitly stops an answer, so a truncated turn is never recorded. */
  cancelled: MutableRefObject<boolean>
}

/**
 * The effects that keep renderer-side conversation memory in step with the answer hooks: record a
 * completed Ask turn, clear everything when the follow-up memory setting flips, and record completed
 * Copilot suggestions. The effects run in this order, exactly as they did inline in App. A fourth (G15) forgets
 * the runs main reports as stale: their turns leave both memories, and an ambient suggestion still on screen is
 * dismissed, because the transcript line it was built from was corrected. A requested answer stays visible.
 */
export function useConversationMemory(
  askAnswer: AnswerState | null,
  suggest: { answer: AnswerState | null; clear: () => void },
  askFollowUpMemory: boolean | undefined,
  refs: ConversationMemoryRefs
): void {
  const { history, copilotHistory, lastTurnAt, pendingUser, cancelled } = refs
  const suggestAnswer = suggest.answer
  // The latest card and dismiss handler, read when a report arrives; the subscription itself is made once.
  const latest = useRef(suggest)
  latest.current = suggest
  // Runs main reported stale (bounded): one that finishes recording after its report must not enter memory at all.
  const staleRuns = useRef<string[]>([])

  // record a completed Ask turn into conversation memory (for follow-ups)
  useEffect(() => {
    const a = askAnswer
    if (!a || a.streaming || a.error) return
    const p = pendingUser.current
    if (!p || p.id !== a.id) return
    pendingUser.current = null
    if (cancelled.current) return // user cancelled — don't record a truncated turn into memory
    if (staleRuns.current.includes(a.id)) return
    const question: ChatTurn = { role: 'user', content: p.q }
    rememberTurn(question, a.id)
    const next: ChatTurn[] = [...history.current, question, { role: 'assistant', content: a.text }]
    history.current = next.slice(-12)
    lastTurnAt.current = Date.now()
  }, [askAnswer])

  // Flipping follow-up memory is itself a conversation boundary: Q&A recorded while the toggle was OFF
  // (this effect's refs accumulate regardless of the setting) must never surface once it's turned ON.
  // Main resets its own carriers on the same transition (IPC.settingsSet); this clears the renderer's.
  // Also runs on mount/settings-load, where the refs are empty — harmless.
  useEffect(() => {
    history.current = []
    copilotHistory.current = []
    lastTurnAt.current = 0
  }, [askFollowUpMemory])

  // record completed Copilot suggestions into memory (for in-conversation follow-ups)
  useEffect(() => {
    const a = suggestAnswer
    if (!a || a.streaming || a.error || !a.prompt || staleRuns.current.includes(a.id)) return
    const question: ChatTurn = { role: 'user', content: a.prompt }
    rememberTurn(question, a.id)
    const next: ChatTurn[] = [...copilotHistory.current, question, { role: 'assistant', content: a.text }]
    copilotHistory.current = next.slice(-12)
  }, [suggestAnswer])

  // G15: a transcript line was corrected after these runs read it. Never replay them as follow-up context.
  useEffect(() => {
    return window.toto.onSessionOutputsStale(({ ids }) => {
      const stale = new Set(ids)
      staleRuns.current = [...staleRuns.current, ...ids].slice(-MAX_STALE_RUNS)
      history.current = forgetStaleTurns(history.current, stale)
      copilotHistory.current = forgetStaleTurns(copilotHistory.current, stale)
      const card = latest.current.answer
      if (card?.ephemeral && stale.has(card.id)) latest.current.clear()
    })
  }, [history, copilotHistory])
}
