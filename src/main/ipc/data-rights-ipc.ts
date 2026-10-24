import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { DATA_RIGHTS_IPC, DataRightsConfirmRequestSchema, DataRightsNoPayloadSchema } from '@shared/data-rights'
import type { DataRightsService } from '../features/data-rights'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface DataRightsIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  service: DataRightsService
}

const INVALID = { ok: false, reason: 'invalid' } as const
const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const
const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The renderer's seam to data rights (G82): preview and confirm an erasure, export, and read the last receipt. Every
 * channel sits behind the main-window top-frame sender gate and a signed-in check, validates its payload strictly (an
 * owner, a tenant, a path or a store list makes it invalid) and answers with a typed refusal instead of an error.
 */
export function registerDataRightsIpc(deps: DataRightsIpcDependencies): void {
  const guard = (event: IpcMainInvokeEvent, surface: string): boolean => {
    deps.authorizeSender(event as unknown as SenderEventLike, {
      surface: `dataRights.${surface}`,
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
  const noPayload = (channel: string, surface: string, work: () => Promise<unknown>): void =>
    ipcMain.handle(channel, async (event, raw) =>
      guard(event, surface) ? (DataRightsNoPayloadSchema.safeParse(raw).success ? settle(work) : INVALID) : SIGNED_OUT
    )

  noPayload(DATA_RIGHTS_IPC.preview, 'preview', () => service.preview())
  noPayload(DATA_RIGHTS_IPC.export, 'export', () => service.exportData())
  noPayload(DATA_RIGHTS_IPC.lastReceipt, 'lastReceipt', () => service.lastReceipt())
  ipcMain.handle(DATA_RIGHTS_IPC.confirm, async (event, raw) => {
    if (!guard(event, 'confirm')) return SIGNED_OUT
    const parsed = DataRightsConfirmRequestSchema.safeParse(raw)
    return parsed.success ? settle(() => service.confirm(parsed.data)) : INVALID
  })
}
