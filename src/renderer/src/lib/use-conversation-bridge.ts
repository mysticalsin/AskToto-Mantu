import { useEffect, useRef, type MutableRefObject } from 'react'
import {
  ConversationAskSchema,
  ConversationCaptureBeginSchema,
  type ConversationAsk,
  type ConversationCaptureBegin,
  type ConversationCaptureBinding,
  type ConversationSnapshot
} from '@shared/conversation/conversation-session'
import type { ChatTurn } from '@shared/ipc'
import type { useAsk } from '../state'
import { CommandMicController, conversationAskMatchesSnapshot, conversationCaptureMatches } from './use-command-mic'

type ConversationEvents = {
  onCaptureBegin(cb: (begin: ConversationCaptureBegin) => void): () => void
  onCaptureCancel(cb: (binding: ConversationCaptureBinding) => void): () => void
  onAsk(cb: (message: ConversationAsk) => void): () => void
  onState(cb: (snapshot: ConversationSnapshot) => void): () => void
  getState(): Promise<ConversationSnapshot | null>
}

export interface ConversationBridgeDeps {
  ask: ReturnType<typeof useAsk>
  setView(view: 'answer'): void
  setCollapsed(collapsed: boolean): void
  historyRef: MutableRefObject<ChatTurn[]>
  pendingUserRef: MutableRefObject<{ id: string; q: string } | null>
}

/**
 * Main owns the conversation and issues each exact capture token. The renderer only holds the current
 * token long enough to run its bounded microphone window; speech text arrives separately as onAsk.
 */
export function useConversationBridge(deps: ConversationBridgeDeps): void {
  const { ask, setView, setCollapsed, historyRef, pendingUserRef } = deps
  const conversationActionsRef = useRef({ run: ask.run, currentId: ask.currentId, cancel: ask.cancel, setView })
  conversationActionsRef.current = { run: ask.run, currentId: ask.currentId, cancel: ask.cancel, setView }
  useEffect(() => {
    const conversation = (window.toto as typeof window.toto & { conversation?: ConversationEvents }).conversation
    if (!conversation) return
    let mounted = true
    let capture: { begin: ConversationCaptureBegin; controller: CommandMicController } | null = null
    let pendingAsk: string | null = null
    let acceptedAsk: { sessionId: string; replyGeneration: number; runId: string } | null = null
    const disposeCapture = (): void => {
      const owned = capture
      capture = null
      owned?.controller.dispose()
    }
    const onBegin = (raw: ConversationCaptureBegin): void => {
      const parsed = ConversationCaptureBeginSchema.safeParse(raw)
      if (!mounted || !parsed.success) return
      const begin = parsed.data
      if (capture?.begin.sessionId === begin.sessionId && capture.begin.captureToken === begin.captureToken) return
      disposeCapture()
      const controller = new CommandMicController()
      capture = { begin, controller }
      void controller.start({ conversation: begin })
    }
    const onCancel = (binding: ConversationCaptureBinding): void => {
      if (!capture || !conversationCaptureMatches(capture.begin, binding)) return
      disposeCapture()
    }
    const onState = (snapshot: ConversationSnapshot): void => {
      if (capture && (!snapshot.active || snapshot.sessionId !== capture.begin.sessionId)) disposeCapture()
      if (acceptedAsk && (!snapshot.active || snapshot.sessionId !== acceptedAsk.sessionId)) {
        if (conversationActionsRef.current.currentId() === acceptedAsk.runId) conversationActionsRef.current.cancel()
        acceptedAsk = null
      }
      if (!snapshot.active) pendingAsk = null
    }
    const onAsk = (raw: ConversationAsk): void => {
      const parsed = ConversationAskSchema.safeParse(raw)
      if (!mounted || !parsed.success) return
      const message = parsed.data
      const key = `${message.sessionId}\u0000${message.replyGeneration}`
      if (
        pendingAsk === key ||
        (acceptedAsk?.sessionId === message.sessionId && acceptedAsk.replyGeneration >= message.replyGeneration)
      )
        return
      const current = conversationActionsRef.current.currentId()
      if (current && current !== acceptedAsk?.runId) return // a deliberate user ask owns the stream
      pendingAsk = key
      void conversation
        .getState()
        .then((snapshot) => {
          if (!mounted || pendingAsk !== key) return
          pendingAsk = null
          if (!conversationAskMatchesSnapshot(message, snapshot)) return
          const actions = conversationActionsRef.current
          const owned = actions.currentId()
          if (owned && owned !== acceptedAsk?.runId) return
          if (acceptedAsk?.sessionId === message.sessionId && acceptedAsk.replyGeneration >= message.replyGeneration)
            return
          actions.setView('answer')
          setCollapsed(false)
          const id = actions.run({
            mode: 'answer',
            prompt: message.text,
            inputOrigin: 'user-spoken-by-owner',
            conversationReply: { sessionId: message.sessionId, replyGeneration: message.replyGeneration },
            history: historyRef.current
          })
          acceptedAsk = { sessionId: message.sessionId, replyGeneration: message.replyGeneration, runId: id }
          pendingUserRef.current = { id, q: message.text }
        })
        .catch(() => {
          if (pendingAsk === key) pendingAsk = null
        })
    }
    const offBegin = conversation.onCaptureBegin(onBegin)
    const offCancel = conversation.onCaptureCancel(onCancel)
    const offAsk = conversation.onAsk(onAsk)
    const offState = conversation.onState(onState)
    return () => {
      mounted = false
      offBegin()
      offCancel()
      offAsk()
      offState()
      disposeCapture()
    }
  }, [historyRef, pendingUserRef, setCollapsed])
}
