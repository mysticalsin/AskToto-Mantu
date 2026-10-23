import type { IpcRenderer } from 'electron'
import {
  CONNECTOR_ACCOUNTS_IPC,
  ConnectorAccountListResponseSchema,
  ConnectorOnboardingBeginPayloadSchema,
  ConnectorOnboardingListResponseSchema,
  ConnectorOnboardingMutationResponseSchema,
  ConnectorOnboardingFlowPayloadSchema,
  type ConnectorAccountListResponse,
  type ConnectorOnboardingBeginPayload,
  type ConnectorOnboardingListResponse,
  type ConnectorOnboardingMutationResponse
} from '../shared/connector-accounts'

const INVALID = { ok: false, error: 'invalid_input' } as const

export function createConnectorAccountsPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  connectorAccounts: {
    list(): Promise<ConnectorAccountListResponse>
    listOnboarding(): Promise<ConnectorOnboardingListResponse>
    begin(input: ConnectorOnboardingBeginPayload): Promise<ConnectorOnboardingMutationResponse>
    resume(flowId: string): Promise<ConnectorOnboardingMutationResponse>
    abandon(flowId: string): Promise<ConnectorOnboardingMutationResponse>
  }
} {
  const call = async <T>(
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    channel: string,
    payload: unknown
  ): Promise<T> => {
    try {
      const parsed = schema.safeParse(await ipc.invoke(channel, payload))
      return parsed.success ? parsed.data : (INVALID as unknown as T)
    } catch {
      return INVALID as unknown as T
    }
  }
  return {
    connectorAccounts: {
      list: () => call(ConnectorAccountListResponseSchema, CONNECTOR_ACCOUNTS_IPC.list, {}),
      listOnboarding: () => call(ConnectorOnboardingListResponseSchema, CONNECTOR_ACCOUNTS_IPC.listOnboarding, {}),
      begin(input) {
        const parsed = ConnectorOnboardingBeginPayloadSchema.safeParse(input)
        if (!parsed.success) return Promise.resolve(INVALID)
        return call(ConnectorOnboardingMutationResponseSchema, CONNECTOR_ACCOUNTS_IPC.begin, parsed.data)
      },
      resume(flowId) {
        const parsed = ConnectorOnboardingFlowPayloadSchema.safeParse({ flowId })
        if (!parsed.success) return Promise.resolve(INVALID)
        return call(ConnectorOnboardingMutationResponseSchema, CONNECTOR_ACCOUNTS_IPC.resume, parsed.data)
      },
      abandon(flowId) {
        const parsed = ConnectorOnboardingFlowPayloadSchema.safeParse({ flowId })
        if (!parsed.success) return Promise.resolve(INVALID)
        return call(ConnectorOnboardingMutationResponseSchema, CONNECTOR_ACCOUNTS_IPC.abandon, parsed.data)
      }
    }
  }
}
