import type { IpcRenderer } from 'electron'
import {
  COMPONENT_OFFLOAD_IPC,
  OffloadConfirmResultSchema,
  OffloadPreviewResultSchema,
  OffloadReceiptsSchema,
  type OffloadConfirmResult,
  type OffloadPreviewResult,
  type OffloadReceipt
} from '../shared/component-offload'
import type { OptionalComponentId } from '../shared/speech-pack'

/** Optional-component offload bridge (G87): preview, confirm with the plan id, and the receipt log. */
export function createComponentOffloadPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  componentOffloadPreview(componentId: OptionalComponentId): Promise<OffloadPreviewResult>
  componentOffloadConfirm(planId: string): Promise<OffloadConfirmResult>
  componentOffloadReceipts(): Promise<OffloadReceipt[]>
} {
  const call = async (channel: string, payload?: unknown): Promise<unknown> => {
    try {
      return payload === undefined ? await ipc.invoke(channel) : await ipc.invoke(channel, payload)
    } catch {
      throw new Error('Invalid component offload response')
    }
  }
  return {
    async componentOffloadPreview(componentId) {
      const result = OffloadPreviewResultSchema.safeParse(await call(COMPONENT_OFFLOAD_IPC.preview, { componentId }))
      if (!result.success) throw new Error('Invalid component offload response')
      return result.data
    },
    async componentOffloadConfirm(planId) {
      const result = OffloadConfirmResultSchema.safeParse(await call(COMPONENT_OFFLOAD_IPC.confirm, { planId }))
      if (!result.success) throw new Error('Invalid component offload response')
      return result.data
    },
    async componentOffloadReceipts() {
      const result = OffloadReceiptsSchema.safeParse(await call(COMPONENT_OFFLOAD_IPC.receipts))
      if (!result.success) throw new Error('Invalid component offload response')
      return result.data
    }
  }
}
