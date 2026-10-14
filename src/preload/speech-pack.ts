import { IPC } from '../shared/ipc'
import {
  SpeechPackActionRequestSchema,
  SpeechPackActionResultSchema,
  SpeechPackProgressSchema,
  SpeechPackSnapshotSchema,
  type SpeechPackActionRequest,
  type SpeechPackActionResult,
  type SpeechPackProgress,
  type SpeechPackSnapshot
} from '../shared/speech-pack'

export function createSpeechPackBridge(transport: {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
  subscribe: (channel: string, callback: (payload: unknown) => void) => () => void
}) {
  return {
    async speechPackState(): Promise<SpeechPackSnapshot> {
      const result = SpeechPackSnapshotSchema.safeParse(await transport.invoke(IPC.speechPackState))
      if (!result.success) throw new Error('Invalid speech pack response')
      return result.data
    },
    async speechPackAction(request: SpeechPackActionRequest): Promise<SpeechPackActionResult> {
      const parsed = SpeechPackActionRequestSchema.safeParse(request)
      if (!parsed.success) return { ok: false, reason: 'invalid-request' }
      const result = SpeechPackActionResultSchema.safeParse(await transport.invoke(IPC.speechPackAction, parsed.data))
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
