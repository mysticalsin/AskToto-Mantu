import { useEffect, type MutableRefObject } from 'react'
import type { ChatTurn } from '@shared/ipc'
import type { AnswerState } from '../state'

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
 * The three effects that keep renderer-side conversation memory in step with the answer hooks: record a
 * completed Ask turn, clear everything when the follow-up memory setting flips, and record completed
 * Copilot suggestions. The effects run in this order, exactly as they did inline in App.
 */
export function useConversationMemory(
  askAnswer: AnswerState | null,
  suggestAnswer: AnswerState | null,
  askFollowUpMemory: boolean | undefined,
  refs: ConversationMemoryRefs
): void {
  const { history, copilotHistory, lastTurnAt, pendingUser, cancelled } = refs

  // record a completed Ask turn into conversation memory (for follow-ups)
  useEffect(() => {
    const a = askAnswer
    if (!a || a.streaming || a.error) return
    const p = pendingUser.current
    if (!p || p.id !== a.id) return
    pendingUser.current = null
    if (cancelled.current) return // user cancelled — don't record a truncated turn into memory
    const next: ChatTurn[] = [
      ...history.current,
      { role: 'user', content: p.q },
      { role: 'assistant', content: a.text }
    ]
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
    if (!a || a.streaming || a.error || !a.prompt) return
    const next: ChatTurn[] = [
      ...copilotHistory.current,
      { role: 'user', content: a.prompt },
      { role: 'assistant', content: a.text }
    ]
    copilotHistory.current = next.slice(-12)
  }, [suggestAnswer])
}
