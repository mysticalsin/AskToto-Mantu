import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  ArchiveRequestSchema,
  AssistantNoPayloadSchema,
  ASSISTANT_IPC,
  ConfirmRequestSchema,
  ProposeRequestSchema,
  UpdateRequestSchema
} from '@shared/assistants'
import { ownerCommand } from '@shared/context-authority'
import type { AssistantService } from '../features/assistants'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface AssistantsIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  service: AssistantService
}

const INVALID = { ok: false, reason: 'invalid' } as const
const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const

/**
 * The renderer's seam to the assistant store (G48): list, propose, confirm, update, archive and the history map. Every
 * channel sits behind the main-window top-frame sender gate and a signed-in check, validates its payload strictly (an
 * unknown key, such as an owner key or an origin, makes it invalid), and answers with a typed refusal instead of an error.
 *
 * What a renderer can NOT do here: say who is proposing (a proposal on this surface is the owner's typed command, tagged
 * by main; content-derived text never reaches it), read an owner key, a tenant key or an idempotency key, create anything
 * without confirming the exact preview, or touch a system (built-in mode) assistant.
 */
export function registerAssistantsIpc(deps: AssistantsIpcDependencies): void {
  const guard = (event: IpcMainInvokeEvent, surface: string): boolean => {
    deps.authorizeSender(event as unknown as SenderEventLike, {
      surface: `assistants.${surface}`,
      requireOwner: true,
      allowedFrames: 'main-window-top'
    })
    return deps.requireAuth()
  }
  const settle = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work()
    } catch {
      return fallback
    }
  }
  const { ipcMain, service } = deps

  ipcMain.handle(ASSISTANT_IPC.list, async (event, raw) =>
    guard(event, 'list')
      ? AssistantNoPayloadSchema.safeParse(raw).success
        ? settle(() => service.list(), { ok: false, reason: 'unavailable' } as const)
        : { ok: false, reason: 'invalid' as const }
      : SIGNED_OUT
  )
  ipcMain.handle(ASSISTANT_IPC.propose, async (event, raw) => {
    if (!guard(event, 'propose')) return SIGNED_OUT
    const parsed = ProposeRequestSchema.safeParse(raw)
    if (!parsed.success) return INVALID
    // This explicit authenticated owner-window request is the typed command; no origin or authority is accepted from payload.
    return settle(() => service.propose(ownerCommand('user-typed', 'assistant proposal'), parsed.data.drafts), {
      ok: false,
      reason: 'unavailable'
    } as const)
  })
  ipcMain.handle(ASSISTANT_IPC.confirm, async (event, raw) => {
    if (!guard(event, 'confirm')) return SIGNED_OUT
    const parsed = ConfirmRequestSchema.safeParse(raw)
    return parsed.success
      ? settle(() => service.confirm(parsed.data), { ok: false, reason: 'unavailable' } as const)
      : INVALID
  })
  ipcMain.handle(ASSISTANT_IPC.update, async (event, raw) => {
    if (!guard(event, 'update')) return SIGNED_OUT
    const parsed = UpdateRequestSchema.safeParse(raw)
    return parsed.success
      ? settle(() => service.update(parsed.data), { ok: false, reason: 'unavailable' } as const)
      : INVALID
  })
  ipcMain.handle(ASSISTANT_IPC.archive, async (event, raw) => {
    if (!guard(event, 'archive')) return SIGNED_OUT
    const parsed = ArchiveRequestSchema.safeParse(raw)
    return parsed.success
      ? settle(() => service.archive(parsed.data), { ok: false, reason: 'unavailable' } as const)
      : INVALID
  })
  ipcMain.handle(ASSISTANT_IPC.historyMap, async (event, raw) =>
    guard(event, 'historyMap')
      ? AssistantNoPayloadSchema.safeParse(raw).success
        ? settle(() => service.historyMap(), { ok: false, reason: 'unavailable' } as const)
        : { ok: false, reason: 'invalid' as const }
      : SIGNED_OUT
  )
}
