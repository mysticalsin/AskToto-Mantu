import type { IpcRenderer } from 'electron'
import {
  CUSTOM_MCP_IPC,
  CustomMcpConfirmCallPayloadSchema,
  CustomMcpConfirmPayloadSchema,
  CustomMcpDraftPayloadSchema,
  CustomMcpIdPayloadSchema,
  CustomMcpProposeCallPayloadSchema,
  type CustomMcpDraftPayload,
  type CustomMcpResponse,
  type CustomMcpView
} from '../shared/custom-mcp'

const INVALID = { ok: false, error: 'invalid_input' } as const
type Schema<T> = { safeParse(raw: unknown): { success: true; data: T } | { success: false } }

export function createCustomMcpPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  customMcp: {
    list(): Promise<CustomMcpResponse<{ servers: CustomMcpView[] }>>
    draft(input: CustomMcpDraftPayload): Promise<CustomMcpResponse<{ server: CustomMcpView }>>
    confirm(input: {
      id: string
      reviewTokenId: string
      allowedTools: string[]
    }): Promise<CustomMcpResponse<{ server: CustomMcpView }>>
    refresh(id: string): Promise<CustomMcpResponse<{ server: CustomMcpView }>>
    disable(id: string): Promise<CustomMcpResponse<{ server: CustomMcpView }>>
    remove(id: string): Promise<CustomMcpResponse>
    proposeCall(input: { id: string; tool: string; args: Record<string, unknown> }): Promise<CustomMcpResponse<object>>
    confirmCall(proposalId: string): Promise<CustomMcpResponse<object>>
  }
} {
  // Validate on the way out so a malformed call never reaches main; main validates again and owns every decision.
  const call = async <T, R>(schema: Schema<T> | null, channel: string, payload: unknown): Promise<R> => {
    try {
      let data: unknown = {}
      if (schema) {
        const parsed = schema.safeParse(payload)
        if (!parsed.success) return INVALID as unknown as R
        data = parsed.data
      }
      return (await ipc.invoke(channel, data)) as R
    } catch {
      return INVALID as unknown as R
    }
  }
  return {
    customMcp: {
      list: () => call(null, CUSTOM_MCP_IPC.list, {}),
      draft: (input) => call(CustomMcpDraftPayloadSchema, CUSTOM_MCP_IPC.draft, input),
      confirm: (input) => call(CustomMcpConfirmPayloadSchema, CUSTOM_MCP_IPC.confirm, input),
      refresh: (id) => call(CustomMcpIdPayloadSchema, CUSTOM_MCP_IPC.refresh, { id }),
      disable: (id) => call(CustomMcpIdPayloadSchema, CUSTOM_MCP_IPC.disable, { id }),
      remove: (id) => call(CustomMcpIdPayloadSchema, CUSTOM_MCP_IPC.remove, { id }),
      proposeCall: (input) => call(CustomMcpProposeCallPayloadSchema, CUSTOM_MCP_IPC.proposeCall, input),
      confirmCall: (proposalId) => call(CustomMcpConfirmCallPayloadSchema, CUSTOM_MCP_IPC.confirmCall, { proposalId })
    }
  }
}
