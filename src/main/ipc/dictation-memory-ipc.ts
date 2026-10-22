import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  DICTATION_MEMORY_IPC,
  DictationRecoveryResolveSchema,
  DictationSpanCorrectSchema,
  DictionaryRemoveSchema,
  type DictationMemoryAck,
  type DictationRecoveryNotice,
  type DictionaryList
} from '@shared/dictation-memory'
import type { DictationMemory } from '../features/dictation'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface DictationMemoryIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  memory: Pick<
    DictationMemory,
    | 'recoveryTake'
    | 'recoveryResolve'
    | 'spansRecent'
    | 'spansCorrect'
    | 'dictionaryList'
    | 'dictionaryRemove'
    | 'dictionaryClear'
  >
}

const REFUSED: DictationMemoryAck = { ok: false, count: 0 }
const UNAVAILABLE_LIST: DictionaryList = { status: 'unavailable', entries: [] }

/**
 * The renderer's seam to the dictation memory (G26): recover a draft once, correct a recently dictated span, inspect
 * and delete the personal dictionary. Every channel sits behind the main-window top-frame sender gate and a signed-in
 * check, validates its payload strictly, and answers with a typed, content-free fallback instead of an error: a
 * refusal never says why and never echoes text.
 *
 * What a renderer can NOT do here: insert text (a recovered draft is only returned, never inserted), supply the
 * "original" a correction is learned from (main holds it and the schemas reject an `original` key), or add a term to
 * the dictionary directly (there is no such channel).
 */
export function registerDictationMemoryIpc(deps: DictationMemoryIpcDependencies): void {
  const guard = (event: IpcMainInvokeEvent, surface: string): boolean => {
    deps.authorizeSender(event as unknown as SenderEventLike, {
      surface: `dictation.memory.${surface}`,
      requireOwner: false,
      allowedFrames: 'main-window-top'
    })
    return deps.requireAuth()
  }
  const settle = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work()
    } catch {
      return fallback
    }
  }
  const parse = <T>(
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    raw: unknown
  ): T | null => {
    const parsed = schema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  deps.ipcMain.handle(
    DICTATION_MEMORY_IPC.recoveryTake,
    async (event): Promise<DictationRecoveryNotice | null> =>
      guard(event, 'recoveryTake') ? settle(() => deps.memory.recoveryTake(), null) : null
  )
  deps.ipcMain.handle(DICTATION_MEMORY_IPC.recoveryResolve, async (event, raw): Promise<DictationMemoryAck> => {
    const signedIn = guard(event, 'recoveryResolve')
    const input = parse(DictationRecoveryResolveSchema, raw)
    return signedIn && input ? settle(() => deps.memory.recoveryResolve(input), REFUSED) : REFUSED
  })
  deps.ipcMain.handle(DICTATION_MEMORY_IPC.spansRecent, async (event) =>
    guard(event, 'spansRecent') ? deps.memory.spansRecent() : { spans: [] }
  )
  deps.ipcMain.handle(DICTATION_MEMORY_IPC.spansCorrect, async (event, raw): Promise<DictationMemoryAck> => {
    const signedIn = guard(event, 'spansCorrect')
    const input = parse(DictationSpanCorrectSchema, raw)
    return signedIn && input ? settle(() => deps.memory.spansCorrect(input), REFUSED) : REFUSED
  })
  deps.ipcMain.handle(
    DICTATION_MEMORY_IPC.dictionaryList,
    async (event): Promise<DictionaryList> =>
      guard(event, 'dictionaryList') ? settle(() => deps.memory.dictionaryList(), UNAVAILABLE_LIST) : UNAVAILABLE_LIST
  )
  deps.ipcMain.handle(DICTATION_MEMORY_IPC.dictionaryRemove, async (event, raw): Promise<DictationMemoryAck> => {
    const signedIn = guard(event, 'dictionaryRemove')
    const input = parse(DictionaryRemoveSchema, raw)
    return signedIn && input ? settle(() => deps.memory.dictionaryRemove(input), REFUSED) : REFUSED
  })
  deps.ipcMain.handle(
    DICTATION_MEMORY_IPC.dictionaryClear,
    async (event): Promise<DictationMemoryAck> =>
      guard(event, 'dictionaryClear') ? settle(() => deps.memory.dictionaryClear(), REFUSED) : REFUSED
  )
}
