import type { IpcRenderer } from 'electron'
import {
  APPLE_CALENDAR_IPC,
  AppleCalendarCreateRequestSchema,
  AppleCalendarCreateResultSchema,
  AppleCalendarStatusSchema,
  type AppleCalendarCreateRequest,
  type AppleCalendarCreateResult,
  type AppleCalendarStatus
} from '../shared/apple-calendar'

const UNAVAILABLE: AppleCalendarStatus = { available: false }

/**
 * `window.toto.appleCalendar` (G65c). `status` never prompts; `requestAccess` is the only call that can raise the system
 * Calendar prompt and the UI calls it only from an explicit click. `create` shows the connector confirm card in main and
 * resolves after the owner answers. Every reply is validated here and a malformed one is dropped.
 */
export function createAppleCalendarPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  appleCalendar: {
    status(): Promise<AppleCalendarStatus>
    requestAccess(): Promise<AppleCalendarStatus>
    create(input: AppleCalendarCreateRequest): Promise<AppleCalendarCreateResult>
  }
} {
  const readStatus = async (channel: string): Promise<AppleCalendarStatus> => {
    try {
      const parsed = AppleCalendarStatusSchema.safeParse(await ipc.invoke(channel))
      return parsed.success ? parsed.data : UNAVAILABLE
    } catch {
      return UNAVAILABLE
    }
  }
  return {
    appleCalendar: {
      status: () => readStatus(APPLE_CALENDAR_IPC.status),
      requestAccess: () => readStatus(APPLE_CALENDAR_IPC.ask),
      async create(input) {
        const payload = AppleCalendarCreateRequestSchema.safeParse(input)
        if (!payload.success) return { ok: false, error: 'That event is not valid.' }
        try {
          const parsed = AppleCalendarCreateResultSchema.safeParse(
            await ipc.invoke(APPLE_CALENDAR_IPC.create, payload.data)
          )
          return parsed.success ? parsed.data : { ok: false, error: 'Apple Calendar did not answer.' }
        } catch {
          return { ok: false, error: 'Apple Calendar did not answer.' }
        }
      }
    }
  }
}
