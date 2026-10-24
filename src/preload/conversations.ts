import type { IpcRenderer } from 'electron'
import {
  AppendResultSchema,
  CONVERSATION_IPC,
  DraftGetResultSchema,
  EmptyResultSchema,
  HistoryResultSchema,
  ListResultSchema,
  OpenResultSchema,
  type AppendResult,
  type DraftGetResult,
  type EmptyResult,
  type HistoryResult,
  type ListResult,
  type OpenResult
} from '../shared/conversations'

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The conversations bridge (G49). Every reply from main is validated here against the contract (strict, so a reply that
 * carried an owner or tenant key would be dropped) and a malformed one is replaced by a content-free refusal.
 */
export function createConversationsPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  conversations: {
    list(): Promise<ListResult>
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
    setAnchor(conversationId: string, turnId: string): Promise<EmptyResult>
  }
} {
  const call = async <T>(
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    channel: string,
    payload?: unknown
  ): Promise<T> => {
    try {
      const parsed = schema.safeParse(await ipc.invoke(channel, payload))
      return parsed.success ? parsed.data : (UNAVAILABLE as unknown as T)
    } catch {
      return UNAVAILABLE as unknown as T
    }
  }
  return {
    conversations: {
      list: () => call(ListResultSchema, CONVERSATION_IPC.list),
      open: (assistantId, meetingFile, fresh) =>
        call(OpenResultSchema, CONVERSATION_IPC.open, {
          assistantId,
          ...(meetingFile === undefined ? {} : { meetingFile }),
          ...(fresh ? { fresh: true } : {})
        }),
      history: (conversationId, page) =>
        call(HistoryResultSchema, CONVERSATION_IPC.history, { conversationId, ...page }),
      append: (input) => call(AppendResultSchema, CONVERSATION_IPC.append, input),
      draftGet: (conversationId) => call(DraftGetResultSchema, CONVERSATION_IPC.draftGet, { conversationId }),
      draftSet: (conversationId, text) => call(EmptyResultSchema, CONVERSATION_IPC.draftSet, { conversationId, text }),
      setAnchor: (conversationId, turnId) =>
        call(EmptyResultSchema, CONVERSATION_IPC.setAnchor, { conversationId, turnId })
    }
  }
}
