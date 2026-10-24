import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  CUSTOM_MCP_IPC,
  CustomMcpConfirmCallPayloadSchema,
  CustomMcpConfirmPayloadSchema,
  CustomMcpDraftPayloadSchema,
  CustomMcpIdPayloadSchema,
  CustomMcpProposeCallPayloadSchema
} from '@shared/custom-mcp'
import type { CustomMcpService } from '../features/custom-mcp/custom-mcp-service'

export interface CustomMcpIpcDeps {
  assertMainWindow(event: IpcMainInvokeEvent): void
  requireAuth(): boolean
  service: Pick<
    CustomMcpService,
    'list' | 'draft' | 'confirm' | 'refresh' | 'disable' | 'remove' | 'proposeCall' | 'confirmCall'
  >
}

const AUTH = { ok: false, error: 'auth_required' } as const
const INVALID = { ok: false, error: 'invalid_input' } as const
const FAILED = { ok: false, error: 'call_failed' } as const

/**
 * Settings-owned custom MCP management. Every channel is main-window-gated and signed-in only, payloads are strict,
 * and the renderer can never supply an approval: write proposals are minted by the service and confirmed by id.
 */
export function registerCustomMcpIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: CustomMcpIpcDeps): void {
  const handle = <T>(
    channel: string,
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } } | null,
    run: (input: T) => Promise<unknown>
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
      deps.assertMainWindow(event)
      if (!deps.requireAuth()) return AUTH
      let input = undefined as T
      if (schema) {
        const parsed = schema.safeParse(raw ?? {})
        if (!parsed.success) return INVALID
        input = parsed.data
      } else if (raw !== undefined && raw !== null && !(typeof raw === 'object' && Object.keys(raw).length === 0)) {
        return INVALID
      }
      try {
        return await run(input)
      } catch {
        // Nothing from the failure (it may carry a URL or server text) is forwarded.
        return FAILED
      }
    })
  }

  handle(CUSTOM_MCP_IPC.list, null, () => deps.service.list())
  handle(CUSTOM_MCP_IPC.draft, CustomMcpDraftPayloadSchema, (input) => deps.service.draft(input))
  handle(CUSTOM_MCP_IPC.confirm, CustomMcpConfirmPayloadSchema, (input) => deps.service.confirm(input))
  handle(CUSTOM_MCP_IPC.refresh, CustomMcpIdPayloadSchema, (input) => deps.service.refresh(input.id))
  handle(CUSTOM_MCP_IPC.disable, CustomMcpIdPayloadSchema, (input) => deps.service.disable(input.id))
  handle(CUSTOM_MCP_IPC.remove, CustomMcpIdPayloadSchema, (input) => deps.service.remove(input.id))
  handle(CUSTOM_MCP_IPC.proposeCall, CustomMcpProposeCallPayloadSchema, (input) => deps.service.proposeCall(input))
  handle(CUSTOM_MCP_IPC.confirmCall, CustomMcpConfirmCallPayloadSchema, (input) => deps.service.confirmCall(input))
}
