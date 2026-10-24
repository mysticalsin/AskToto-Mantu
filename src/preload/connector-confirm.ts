import type { IpcRenderer } from 'electron'
import {
  CONNECTOR_CONFIRM_IPC,
  ConnectorConfirmCancelResponseSchema,
  ConnectorConfirmCancellationSchema,
  ConnectorConfirmDecisionResponseSchema,
  ConnectorConfirmDecisionSchema,
  ConnectorConfirmStateSchema,
  type ConnectorConfirmCancellation,
  type ConnectorConfirmDecision,
  type ConnectorConfirmDecisionResponse,
  type ConnectorConfirmState
} from '../shared/connector-confirm'

type Unsub = () => void
const NONE: ConnectorConfirmState = { proposalId: null }
const INVALID = { ok: false, reason: 'invalid_input' } as const

/**
 * `window.toto.connectorConfirm` (G64): the confirm card every connector write waits for. Main owns the card and the
 * pending write; the renderer only echoes the card's ids with a yes or a no. Every reply and push is validated here
 * and a malformed one is dropped, never repaired.
 */
export function createConnectorConfirmPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  connectorConfirm: {
    current(): Promise<ConnectorConfirmState>
    decide(input: ConnectorConfirmDecision): Promise<ConnectorConfirmDecisionResponse>
    cancel(input: ConnectorConfirmCancellation): Promise<{ ok: boolean }>
    onChanged(listener: (state: ConnectorConfirmState) => void): Unsub
  }
} {
  return {
    connectorConfirm: {
      async current() {
        try {
          const parsed = ConnectorConfirmStateSchema.safeParse(await ipc.invoke(CONNECTOR_CONFIRM_IPC.current))
          return parsed.success ? parsed.data : NONE
        } catch {
          return NONE
        }
      },
      async decide(input) {
        const payload = ConnectorConfirmDecisionSchema.safeParse(input)
        if (!payload.success) return INVALID
        try {
          const parsed = ConnectorConfirmDecisionResponseSchema.safeParse(
            await ipc.invoke(CONNECTOR_CONFIRM_IPC.decide, payload.data)
          )
          return parsed.success ? parsed.data : INVALID
        } catch {
          return INVALID
        }
      },
      async cancel(input) {
        const payload = ConnectorConfirmCancellationSchema.safeParse(input)
        if (!payload.success) return { ok: false }
        try {
          const parsed = ConnectorConfirmCancelResponseSchema.safeParse(
            await ipc.invoke(CONNECTOR_CONFIRM_IPC.cancel, payload.data)
          )
          return parsed.success ? parsed.data : { ok: false }
        } catch {
          return { ok: false }
        }
      },
      onChanged(listener) {
        const handler = (_event: unknown, payload: unknown): void => {
          const parsed = ConnectorConfirmStateSchema.safeParse(payload)
          if (!parsed.success) return
          try {
            listener(parsed.data)
          } catch {
            /* a throwing subscriber must not break the bridge */
          }
        }
        ipc.on(CONNECTOR_CONFIRM_IPC.state, handler)
        return () => ipc.removeListener(CONNECTOR_CONFIRM_IPC.state, handler)
      }
    }
  }
}
