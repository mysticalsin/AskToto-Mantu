import type { IpcRenderer } from 'electron'
import {
  DICTATION_MEMORY_IPC,
  DictationMemoryAckSchema,
  DictationRecoveryNoticeSchema,
  DictationSpansSchema,
  DictionaryListSchema,
  type DictationMemoryAck,
  type DictationRecoveryNotice,
  type DictationSpans,
  type DictionaryList
} from '../shared/dictation-memory'

const REFUSED: DictationMemoryAck = { ok: false, count: 0 }

/**
 * The dictation memory bridge (G26). Every reply from main is validated here and a malformed one is replaced by a
 * content-free fallback, so the renderer only ever sees the contract shapes. There is no call that inserts text, that
 * names the original a correction is learned from, or that adds a dictionary term: a recovered draft is only shown,
 * and a dictionary entry can only come from a correction of text main itself dictated.
 */
export function createDictationMemoryPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  dictationMemory: {
    /** The recoverable drafts, offered once. Taking them is the offer. */
    takeRecovery(): Promise<DictationRecoveryNotice | null>
    /** Copied or dismissed; `correctedText` is the draft as the person edited it in Métis. */
    resolveRecovery(id: string, correctedText?: string): Promise<DictationMemoryAck>
    /** Dictated spans still inside the correction window. */
    recentSpans(): Promise<DictationSpans>
    correctSpan(id: string, correctedText: string): Promise<DictationMemoryAck>
    listDictionary(): Promise<DictionaryList>
    removeDictionaryEntry(id: string): Promise<DictationMemoryAck>
    clearDictionary(): Promise<DictationMemoryAck>
  }
} {
  const ack = async (channel: string, payload?: unknown): Promise<DictationMemoryAck> => {
    try {
      const parsed = DictationMemoryAckSchema.safeParse(await ipc.invoke(channel, payload))
      return parsed.success ? parsed.data : REFUSED
    } catch {
      return REFUSED
    }
  }
  return {
    dictationMemory: {
      async takeRecovery() {
        try {
          const parsed = DictationRecoveryNoticeSchema.safeParse(await ipc.invoke(DICTATION_MEMORY_IPC.recoveryTake))
          return parsed.success ? parsed.data : null
        } catch {
          return null
        }
      },
      resolveRecovery: (id, correctedText) =>
        ack(DICTATION_MEMORY_IPC.recoveryResolve, correctedText === undefined ? { id } : { id, correctedText }),
      async recentSpans() {
        try {
          const parsed = DictationSpansSchema.safeParse(await ipc.invoke(DICTATION_MEMORY_IPC.spansRecent))
          return parsed.success ? parsed.data : { spans: [] }
        } catch {
          return { spans: [] }
        }
      },
      correctSpan: (id, correctedText) => ack(DICTATION_MEMORY_IPC.spansCorrect, { id, correctedText }),
      async listDictionary() {
        try {
          const parsed = DictionaryListSchema.safeParse(await ipc.invoke(DICTATION_MEMORY_IPC.dictionaryList))
          return parsed.success ? parsed.data : { status: 'unavailable', entries: [] }
        } catch {
          return { status: 'unavailable', entries: [] }
        }
      },
      removeDictionaryEntry: (id) => ack(DICTATION_MEMORY_IPC.dictionaryRemove, { id }),
      clearDictionary: () => ack(DICTATION_MEMORY_IPC.dictionaryClear)
    }
  }
}
