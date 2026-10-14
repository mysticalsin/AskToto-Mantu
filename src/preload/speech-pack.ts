import { IPC } from '../shared/ipc'
import {
  SpeechPackActionRequestSchema,
  SpeechPackActionResultSchema,
  SpeechPackInstallWithPlanRequestSchema,
  SpeechPackInstallWithPlanResultSchema,
  SpeechPackPlanPreviewRequestSchema,
  SpeechPackPlanPreviewResultSchema,
  SpeechPackProgressSchema,
  SpeechPackSnapshotSchema,
  type SpeechPackActionRequest,
  type SpeechPackActionResult,
  type SpeechPackInstallWithPlanRequest,
  type SpeechPackInstallWithPlanResult,
  type SpeechPackPlanPreviewRequest,
  type SpeechPackPlanPreviewResult,
  type SpeechPackProgress,
  type SpeechPackSnapshot
} from '../shared/speech-pack'

export function createSpeechPackBridge(transport: {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
  subscribe: (channel: string, callback: (payload: unknown) => void) => () => void
}) {
  const invoke = async (channel: string, payload?: unknown): Promise<unknown> => {
    try {
      return payload === undefined ? await transport.invoke(channel) : await transport.invoke(channel, payload)
    } catch {
      throw new Error('Invalid speech pack response')
    }
  }
  return {
    async speechPackState(): Promise<SpeechPackSnapshot> {
      const result = SpeechPackSnapshotSchema.safeParse(await invoke(IPC.speechPackState))
      if (!result.success) throw new Error('Invalid speech pack response')
      return result.data
    },
    async speechPackAction(request: SpeechPackActionRequest): Promise<SpeechPackActionResult> {
      const parsed = SpeechPackActionRequestSchema.safeParse(request)
      if (!parsed.success) return { ok: false, reason: 'invalid-request' }
      const result = SpeechPackActionResultSchema.safeParse(await invoke(IPC.speechPackAction, parsed.data))
      if (!result.success) throw new Error('Invalid speech pack response')
      return result.data
    },
    async speechPackPlanPreview(request: SpeechPackPlanPreviewRequest): Promise<SpeechPackPlanPreviewResult> {
      const parsed = SpeechPackPlanPreviewRequestSchema.safeParse(request)
      if (!parsed.success) return { ok: false, reason: 'invalid-request' }
      const result = SpeechPackPlanPreviewResultSchema.safeParse(await invoke(IPC.speechPackPlanPreview, parsed.data))
      if (!result.success) throw new Error('Invalid speech pack response')
      return result.data
    },
    async speechPackInstallWithPlan(
      request: SpeechPackInstallWithPlanRequest
    ): Promise<SpeechPackInstallWithPlanResult> {
      const parsed = SpeechPackInstallWithPlanRequestSchema.safeParse(request)
      if (!parsed.success) return { ok: false, reason: 'invalid-request' }
      const result = SpeechPackInstallWithPlanResultSchema.safeParse(
        await invoke(IPC.speechPackInstallWithPlan, parsed.data)
      )
      if (!result.success) throw new Error('Invalid speech pack response')
      return result.data
    },
    onSpeechPackProgress(callback: (payload: SpeechPackProgress) => void): () => void {
      return transport.subscribe(IPC.speechPackProgress, (payload) => {
        const result = SpeechPackProgressSchema.safeParse(payload)
        if (result.success) callback(result.data)
      })
    }
  }
}
