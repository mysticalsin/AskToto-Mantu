import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  GetRequestSchema,
  MarkReadRequestSchema,
  MarkUnreadRequestSchema,
  SearchRequestSchema,
  SelectRequestSchema,
  SetArchivedRequestSchema,
  SetPinnedRequestSchema,
  WORKSPACE_IPC
} from '@shared/conversation-workspace'
import type { WorkspaceService } from '../features/conversations'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface ConversationWorkspaceIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  service: WorkspaceService
}

const INVALID = { ok: false, reason: 'invalid' } as const
const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const
const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The renderer's seam to the workspace state in main (G50): selection, read and unread, archive, pins and scoped
 * search. Every channel sits behind the main-window top-frame sender gate and a signed-in check, validates its payload
 * strictly (an owner key, a tenant key or a `seq` in a request makes it invalid), and answers with a typed refusal
 * instead of an error. The service validates again, so a caller other than this file cannot skip the schema.
 */
export function registerConversationWorkspaceIpc(deps: ConversationWorkspaceIpcDependencies): void {
  const { ipcMain, service } = deps
  const handle = <In>(
    channel: string,
    surface: string,
    schema: { safeParse(raw: unknown): { success: boolean; data?: In } },
    run: (input: In) => Promise<unknown>
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
      deps.authorizeSender(event as unknown as SenderEventLike, {
        surface: `workspace.${surface}`,
        requireOwner: true,
        allowedFrames: 'main-window-top'
      })
      if (!deps.requireAuth()) return SIGNED_OUT
      const parsed = schema.safeParse(raw)
      if (!parsed.success) return INVALID
      try {
        return await run(parsed.data as In)
      } catch {
        return UNAVAILABLE
      }
    })
  }
  handle(WORKSPACE_IPC.get, 'get', GetRequestSchema, () => service.get())
  handle(WORKSPACE_IPC.select, 'select', SelectRequestSchema, (input) => service.select(input))
  handle(WORKSPACE_IPC.markRead, 'markRead', MarkReadRequestSchema, (input) => service.markRead(input))
  handle(WORKSPACE_IPC.markUnread, 'markUnread', MarkUnreadRequestSchema, (input) => service.markUnread(input))
  handle(WORKSPACE_IPC.setArchived, 'setArchived', SetArchivedRequestSchema, (input) => service.setArchived(input))
  handle(WORKSPACE_IPC.setPinned, 'setPinned', SetPinnedRequestSchema, (input) => service.setPinned(input))
  handle(WORKSPACE_IPC.search, 'search', SearchRequestSchema, (input) => service.search(input))
}
