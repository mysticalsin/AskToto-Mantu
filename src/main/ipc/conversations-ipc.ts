import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  AppendRequestSchema,
  CONVERSATION_IPC,
  DraftGetRequestSchema,
  DraftSetRequestSchema,
  HistoryRequestSchema,
  ListRequestSchema,
  OpenRequestSchema,
  SetAnchorRequestSchema
} from '@shared/conversations'
import type { ConversationService } from '../features/conversations'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface ConversationsIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  service: ConversationService
}

const INVALID = { ok: false, reason: 'invalid' } as const
const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const
const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The renderer's seam to persisted conversations (G49): list, open, paged history, append, composer drafts and the
 * reading anchor. Every channel sits behind the main-window top-frame sender gate and a signed-in check, validates its
 * payload strictly (an owner key, a tenant key or a `seq` in a request makes it invalid), and answers with a typed
 * refusal instead of an error. The service validates again, so a caller other than this file cannot skip the schema.
 */
export function registerConversationsIpc(deps: ConversationsIpcDependencies): void {
  const { ipcMain, service } = deps
  const handle = <In>(
    channel: string,
    surface: string,
    schema: { safeParse(raw: unknown): { success: boolean; data?: In } },
    run: (input: In) => Promise<unknown>
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
      deps.authorizeSender(event as unknown as SenderEventLike, {
        surface: `conversations.${surface}`,
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
  handle(CONVERSATION_IPC.list, 'list', ListRequestSchema, () => service.list())
  handle(CONVERSATION_IPC.open, 'open', OpenRequestSchema, (input) => service.open(input))
  handle(CONVERSATION_IPC.history, 'history', HistoryRequestSchema, (input) => service.history(input))
  handle(CONVERSATION_IPC.append, 'append', AppendRequestSchema, (input) => service.append(input))
  handle(CONVERSATION_IPC.draftGet, 'draftGet', DraftGetRequestSchema, (input) => service.draftGet(input))
  handle(CONVERSATION_IPC.draftSet, 'draftSet', DraftSetRequestSchema, (input) => service.draftSet(input))
  handle(CONVERSATION_IPC.setAnchor, 'setAnchor', SetAnchorRequestSchema, (input) => service.setAnchor(input))
}
