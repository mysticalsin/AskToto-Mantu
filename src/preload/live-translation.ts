import type { IpcRenderer } from 'electron'
import {
  TRANSLATION_IPC,
  TRANSLATION_MAX_SUBSCRIPTIONS,
  TranslationResetSchema,
  TranslationRetractSchema,
  TranslationSegmentSchema,
  TranslationStatusSchema,
  type TranslationReset,
  type TranslationRetract,
  type TranslationSegment,
  type TranslationStatus
} from '../shared/live-translation'

export type LiveTranslationEvent =
  | ({ kind: 'segment' } & TranslationSegment)
  | ({ kind: 'retract' } & TranslationRetract)
  | ({ kind: 'reset' } & TranslationReset)
  | ({ kind: 'status' } & TranslationStatus)

const MAX_TRACKED = 4_096

export function createLiveTranslationPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener'>): {
  onTranslation(cb: (event: LiveTranslationEvent) => void): () => void
} {
  let active = 0
  return {
    onTranslation(cb) {
      if (active >= TRANSLATION_MAX_SUBSCRIPTIONS) return () => {}
      // The highest revision shown per line: a delayed older push never replaces a newer one.
      const seen = new Map<string, number>()
      const emit = (event: LiveTranslationEvent): void => {
        try {
          cb(event)
        } catch {
          // A throwing subscriber must not break the bridge.
        }
      }
      const handlers: Array<[string, (_event: unknown, payload: unknown) => void]> = [
        [
          TRANSLATION_IPC.segment,
          (_e, payload) => {
            const parsed = TranslationSegmentSchema.safeParse(payload)
            if (!parsed.success) return
            const key = `${parsed.data.meetingStartedAt}:${parsed.data.utteranceId}`
            const prev = seen.get(key)
            if (prev !== undefined && parsed.data.revision <= prev) return
            seen.delete(key)
            seen.set(key, parsed.data.revision)
            if (seen.size > MAX_TRACKED) {
              const oldest = seen.keys().next()
              if (!oldest.done) seen.delete(oldest.value)
            }
            emit({ kind: 'segment', ...parsed.data })
          }
        ],
        [
          TRANSLATION_IPC.retract,
          (_e, payload) => {
            const parsed = TranslationRetractSchema.safeParse(payload)
            if (parsed.success) emit({ kind: 'retract', ...parsed.data })
          }
        ],
        [
          TRANSLATION_IPC.reset,
          (_e, payload) => {
            const parsed = TranslationResetSchema.safeParse(payload)
            if (!parsed.success) return
            seen.clear()
            emit({ kind: 'reset', ...parsed.data })
          }
        ],
        [
          TRANSLATION_IPC.status,
          (_e, payload) => {
            const parsed = TranslationStatusSchema.safeParse(payload)
            if (parsed.success) emit({ kind: 'status', ...parsed.data })
          }
        ]
      ]
      for (const [channel, listener] of handlers) ipc.on(channel, listener)
      active += 1
      let done = false
      return () => {
        if (done) return
        done = true
        for (const [channel, listener] of handlers) ipc.removeListener(channel, listener)
        active -= 1
      }
    }
  }
}
