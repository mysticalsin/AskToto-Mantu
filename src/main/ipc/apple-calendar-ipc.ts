import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  APPLE_CALENDAR_IPC,
  AppleCalendarCreateRequestSchema,
  AppleCalendarPermissionSchema,
  appleCalendarPermissionCopy,
  type AppleCalendarCreateResult,
  type AppleCalendarStatus
} from '@shared/apple-calendar'
import type { ConnectorResult } from '@shared/connector-catalog'
import type { EventKitHost } from '../infra/process/eventkit-helper-host'

export interface AppleCalendarIpcDeps {
  assertMainWindow(event: IpcMainInvokeEvent): void
  requireAuth(): boolean
  platform: NodeJS.Platform
  eventKit: Pick<EventKitHost, 'status' | 'ask'>
  /** Runs the catalog write. It shows the connector confirm card in `ownerWebContentsId` and waits for it. */
  create(
    input: { subject: string; body: string; startIso: string; endIso: string },
    ownerWebContentsId: number
  ): Promise<{ ok: boolean; error?: string; uncertain?: boolean; result?: ConnectorResult }>
}

const UNAVAILABLE: AppleCalendarStatus = { available: false }

/**
 * "Add to Apple Calendar" IPC (G65c). Every handler sits behind the main-window sender check and a signed-in session.
 * `status` never prompts; `ask` raises the system prompt only while the system has not asked yet (the renderer calls it
 * only from an explicit click). `create` always waits for the connector confirm card; the owner window comes from the
 * IPC sender and the reply carries no event text, id or helper output.
 */
export function registerAppleCalendarIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: AppleCalendarIpcDeps): void {
  const usable = (): boolean => deps.platform === 'darwin' && deps.requireAuth()

  ipcMain.handle(APPLE_CALENDAR_IPC.status, async (event: IpcMainInvokeEvent): Promise<AppleCalendarStatus> => {
    deps.assertMainWindow(event)
    if (!usable()) return UNAVAILABLE
    const permission = await deps.eventKit.status()
    return permission ? { available: true, permission } : UNAVAILABLE
  })

  ipcMain.handle(APPLE_CALENDAR_IPC.ask, async (event: IpcMainInvokeEvent): Promise<AppleCalendarStatus> => {
    deps.assertMainWindow(event)
    if (!usable()) return UNAVAILABLE
    let permission = await deps.eventKit.status()
    if (permission === 'notDetermined') permission = await deps.eventKit.ask()
    return permission ? { available: true, permission } : UNAVAILABLE
  })

  ipcMain.handle(
    APPLE_CALENDAR_IPC.create,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<AppleCalendarCreateResult> => {
      deps.assertMainWindow(event)
      if (!usable()) return { ok: false, error: 'Apple Calendar is not available.' }
      const parsed = AppleCalendarCreateRequestSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, error: 'That event is not valid.' }
      const run = await deps.create({ ...parsed.data, body: '' }, event.sender.id)
      if (run.ok) return { ok: true }
      const refusal = run.result && !run.result.ok ? run.result : null
      const permission = AppleCalendarPermissionSchema.safeParse(refusal?.permission)
      if (refusal?.reason === 'os_permission_missing' && permission.success) {
        return { ok: false, error: appleCalendarPermissionCopy(permission.data), permission: permission.data }
      }
      return {
        ok: false,
        error: run.error ?? 'Apple Calendar did not save the event.',
        ...(run.uncertain ? { uncertain: true } : {})
      }
    }
  )
}
