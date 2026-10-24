import type { IpcRenderer } from 'electron'
import {
  GetResultSchema,
  MutationResultSchema,
  SearchResultSchema,
  WORKSPACE_IPC,
  type GetResult,
  type MutationResult,
  type SearchResult
} from '../shared/conversation-workspace'

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The workspace-state bridge (G50). Every reply from main is validated here against the contract (strict, so a reply
 * that carried an owner or tenant key or a `seq` would be dropped) and a malformed one is replaced by a content-free
 * refusal.
 */
export function createConversationWorkspacePreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  workspace: {
    get(): Promise<GetResult>
    select(conversationId: string | null): Promise<MutationResult>
    markRead(conversationId: string, throughTurnId: string): Promise<MutationResult>
    markUnread(conversationId: string): Promise<MutationResult>
    setArchived(conversationId: string, archived: boolean): Promise<MutationResult>
    setPinned(kind: 'conversation' | 'assistant', id: string, pinned: boolean): Promise<MutationResult>
    search(query: string, options: { limit: number; includeArchived?: boolean }): Promise<SearchResult>
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
    workspace: {
      get: () => call(GetResultSchema, WORKSPACE_IPC.get),
      select: (conversationId) => call(MutationResultSchema, WORKSPACE_IPC.select, { conversationId }),
      markRead: (conversationId, throughTurnId) =>
        call(MutationResultSchema, WORKSPACE_IPC.markRead, { conversationId, throughTurnId }),
      markUnread: (conversationId) => call(MutationResultSchema, WORKSPACE_IPC.markUnread, { conversationId }),
      setArchived: (conversationId, archived) =>
        call(MutationResultSchema, WORKSPACE_IPC.setArchived, { conversationId, archived }),
      setPinned: (kind, id, pinned) => call(MutationResultSchema, WORKSPACE_IPC.setPinned, { kind, id, pinned }),
      search: (query, options) =>
        call(SearchResultSchema, WORKSPACE_IPC.search, {
          query,
          limit: options.limit,
          ...(options.includeArchived === undefined ? {} : { includeArchived: options.includeArchived })
        })
    }
  }
}
