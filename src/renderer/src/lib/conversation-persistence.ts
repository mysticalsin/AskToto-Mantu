import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChatTurn } from '@shared/ipc'
import type { AppendResult, DraftGetResult, EmptyResult, HistoryResult, OpenResult } from '@shared/conversations'

/** The slice of `window.toto.conversations` this surface uses. */
export interface ConversationBridge {
  open(assistantId: string, meetingFile?: string, fresh?: boolean): Promise<OpenResult>
  history(conversationId: string, page: { before?: string; after?: string; limit: number }): Promise<HistoryResult>
  append(input: {
    conversationId: string
    assistantId: string
    runId: string
    turns: Array<{ role: 'user' | 'assistant'; text: string }>
  }): Promise<AppendResult>
  draftGet(conversationId: string): Promise<DraftGetResult>
  draftSet(conversationId: string, text: string): Promise<EmptyResult>
}

export interface ConversationPersistenceDeps {
  bridge: ConversationBridge
  getInput(): string
  setInput(text: string): void
  /** The follow-up memory the Ask surface sends with its next question. */
  history: { current: ChatTurn[] }
  lastTurnAt: { current: number }
  /** Whether Ask follow-up memory is on: turns are only persisted and replayed while the person has it on. */
  memoryEnabled(): boolean
  onActiveId(id: string | null): void
  debounceMs?: number
  seedTurns?: number
}

export interface ConversationPersistence {
  /** Opens the thread for an assistant, restores the follow-up memory and the composer draft. */
  start(assistantId: string): Promise<void>
  /** The composer text changed: saves the draft in main after a short pause. */
  inputChanged(text: string): void
  /** A completed Ask turn: records it, and follows the link when main started a successor thread. */
  record(assistantId: string, runId: string, question: string, answer: string): Promise<void>
  /** "New chat": a fresh empty thread (the old one stays readable in main). */
  newThread(assistantId: string): Promise<void>
  dispose(): void
}

const SIGNED_OUT = new Set(['signed-out', 'stale'])

export function createConversationPersistence(deps: ConversationPersistenceDeps): ConversationPersistence {
  const { bridge } = deps
  const debounceMs = deps.debounceMs ?? 400
  const seedTurns = deps.seedTurns ?? 12
  let activeId: string | null = null
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  /** The draft text main holds (restored or saved): what is cleared from the screen if the person is signed out. */
  let remembered = ''

  const setActive = (id: string | null): void => {
    activeId = id
    deps.onActiveId(id)
  }
  const cancelSave = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  /** Signed out or the owner changed: nothing private stays visible, and nothing more is sent. */
  const dropVisible = (): void => {
    cancelSave()
    epoch += 1
    setActive(null)
    deps.history.current = []
    deps.lastTurnAt.current = 0
    if (remembered !== '' && deps.getInput() === remembered) deps.setInput('')
    remembered = ''
  }
  const refused = (result: { ok: boolean; reason?: string }): boolean => {
    if (result.ok) return false
    if (result.reason !== undefined && SIGNED_OUT.has(result.reason)) dropVisible()
    return true
  }
  const load = async (assistantId: string, fresh: boolean, mine: number): Promise<void> => {
    const opened = await bridge.open(assistantId, undefined, fresh)
    if (mine !== epoch || refused(opened) || !opened.ok) return
    const id = opened.conversation.id
    setActive(id)
    if (fresh) return
    if (deps.memoryEnabled()) {
      const page = await bridge.history(id, { limit: seedTurns })
      if (mine !== epoch || refused(page) || !page.ok) return
      // Only an empty memory is seeded: what the person already asked this session is newer than what was stored.
      if (deps.history.current.length === 0 && page.turns.length > 0) {
        deps.history.current = page.turns.map((t): ChatTurn => ({ role: t.role, content: t.text }))
        deps.lastTurnAt.current = page.turns[page.turns.length - 1]!.at
      }
    }
    const draft = await bridge.draftGet(id)
    if (mine !== epoch || refused(draft) || !draft.ok) return
    if (draft.text !== null && deps.getInput() === '') {
      remembered = draft.text
      deps.setInput(draft.text)
    }
  }

  return {
    async start(assistantId) {
      cancelSave()
      epoch += 1
      remembered = ''
      await load(assistantId, false, epoch)
    },

    inputChanged(text) {
      cancelSave()
      const id = activeId
      if (id === null || text === remembered) return
      const mine = epoch
      timer = setTimeout(() => {
        timer = null
        if (mine !== epoch) return
        remembered = text
        void bridge.draftSet(id, text).then((result) => {
          if (mine === epoch) refused(result)
        })
      }, debounceMs)
    },

    async record(assistantId, runId, question, answer) {
      const id = activeId
      if (id === null || !deps.memoryEnabled() || question === '' || answer === '') return
      const mine = epoch
      const result = await bridge.append({
        conversationId: id,
        assistantId,
        runId,
        turns: [
          { role: 'user', text: question },
          { role: 'assistant', text: answer }
        ]
      })
      if (mine !== epoch || refused(result) || !result.ok) return
      // Main may have continued the conversation in a linked successor thread: follow it.
      if (result.conversationId !== activeId) setActive(result.conversationId)
    },

    async newThread(assistantId) {
      cancelSave()
      epoch += 1
      remembered = ''
      deps.history.current = []
      setActive(null)
      await load(assistantId, true, epoch)
    },

    dispose() {
      cancelSave()
      epoch += 1
    }
  }
}

export interface ConversationPersistenceHook {
  /** The thread the Ask surface is writing to, for anything that binds to the conversation (attachments). */
  activeConversationId: string | null
  record(runId: string, question: string, answer: string): void
  newThread(): void
}

/**
 * Binds the Ask composer to its persisted thread: loads the thread, the last turns and the composer draft when the
 * assistant changes, saves the draft as the person types, records completed turns, and starts a fresh thread on "New
 * chat". The logic lives in `createConversationPersistence`; this is only the React binding.
 */
export function useConversationPersistence(options: {
  assistantId: string
  input: string
  setInput: (text: string) => void
  history: MutableRefObject<ChatTurn[]>
  lastTurnAt: MutableRefObject<number>
  memoryEnabled: boolean
}): ConversationPersistenceHook {
  const { assistantId, input, memoryEnabled } = options
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const latest = useRef(options)
  latest.current = options
  const controller = useRef<ConversationPersistence | null>(null)
  if (controller.current === null) {
    controller.current = createConversationPersistence({
      get bridge() {
        return window.toto.conversations
      },
      getInput: () => latest.current.input,
      setInput: (text) => latest.current.setInput(text),
      history: {
        get current() {
          return latest.current.history.current
        },
        set current(turns) {
          latest.current.history.current = turns
        }
      },
      lastTurnAt: {
        get current() {
          return latest.current.lastTurnAt.current
        },
        set current(at) {
          latest.current.lastTurnAt.current = at
        }
      },
      memoryEnabled: () => latest.current.memoryEnabled,
      onActiveId: setActiveConversationId
    } as ConversationPersistenceDeps)
  }
  const persistence = controller.current

  useEffect(() => {
    void persistence.start(assistantId)
    return () => persistence.dispose()
  }, [assistantId, memoryEnabled, persistence])
  useEffect(() => persistence.inputChanged(input), [input, persistence])

  return {
    activeConversationId,
    record: (runId, question, answer) => void persistence.record(latest.current.assistantId, runId, question, answer),
    newThread: () => void persistence.newThread(latest.current.assistantId)
  }
}
