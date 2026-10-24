import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  AdjustRequestSchema,
  CardRefSchema,
  DismissRequestSchema,
  SUGGESTION_IPC,
  SuggestionNoPayloadSchema
} from '@shared/suggestions'
import type { SuggestionService } from '../features/suggestions'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface SuggestionsIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  service: SuggestionService
}

const INVALID = { ok: false, reason: 'invalid' } as const
const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const
const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The renderer's seam to the suggestion pipeline (G67): list, check now, mark a card shown, accept, dismiss and adjust.
 * Every channel sits behind the main-window top-frame sender gate and a signed-in check, validates its payload strictly
 * (an unknown key, such as an owner key, an account ref or a source, makes it invalid) and answers with a typed
 * refusal instead of an error.
 *
 * What a renderer can NOT do here: choose a source, name an account or a grant, accept a card it was not last shown, or
 * accept at a revision or nonce other than the current one. Nothing on this surface writes to a provider.
 */
export function registerSuggestionsIpc(deps: SuggestionsIpcDependencies): void {
  const guard = (event: IpcMainInvokeEvent, surface: string): boolean => {
    deps.authorizeSender(event as unknown as SenderEventLike, {
      surface: `suggestions.${surface}`,
      requireOwner: true,
      allowedFrames: 'main-window-top'
    })
    return deps.requireAuth()
  }
  const settle = async <T>(work: () => Promise<T>): Promise<T | typeof UNAVAILABLE> => {
    try {
      return await work()
    } catch {
      return UNAVAILABLE
    }
  }
  const { ipcMain, service } = deps

  ipcMain.handle(SUGGESTION_IPC.list, async (event, raw) =>
    guard(event, 'list')
      ? SuggestionNoPayloadSchema.safeParse(raw).success
        ? settle(() => service.list())
        : INVALID
      : SIGNED_OUT
  )
  ipcMain.handle(SUGGESTION_IPC.checkNow, async (event, raw) =>
    guard(event, 'checkNow')
      ? SuggestionNoPayloadSchema.safeParse(raw).success
        ? settle(() => service.checkNow())
        : INVALID
      : SIGNED_OUT
  )
  ipcMain.handle(SUGGESTION_IPC.shown, async (event, raw) => {
    if (!guard(event, 'shown')) return SIGNED_OUT
    const parsed = CardRefSchema.safeParse(raw)
    return parsed.success ? settle(() => service.shown(parsed.data)) : INVALID
  })
  ipcMain.handle(SUGGESTION_IPC.accept, async (event, raw) => {
    if (!guard(event, 'accept')) return SIGNED_OUT
    const parsed = CardRefSchema.safeParse(raw)
    return parsed.success ? settle(() => service.accept(parsed.data)) : INVALID
  })
  ipcMain.handle(SUGGESTION_IPC.dismiss, async (event, raw) => {
    if (!guard(event, 'dismiss')) return SIGNED_OUT
    const parsed = DismissRequestSchema.safeParse(raw)
    return parsed.success ? settle(() => service.dismiss(parsed.data)) : INVALID
  })
  ipcMain.handle(SUGGESTION_IPC.adjust, async (event, raw) => {
    if (!guard(event, 'adjust')) return SIGNED_OUT
    const parsed = AdjustRequestSchema.safeParse(raw)
    return parsed.success ? settle(() => service.adjust(parsed.data)) : INVALID
  })
}
