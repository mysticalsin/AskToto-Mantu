import type { IpcRenderer } from 'electron'
import {
  AcceptResultSchema,
  AckResultSchema,
  AdjustResultSchema,
  CheckResultSchema,
  ListResultSchema,
  SUGGESTION_IPC,
  type AcceptResult,
  type AckResult,
  type AdjustRequest,
  type AdjustResult,
  type CardRef,
  type CheckResult,
  type DismissReason,
  type ListResult
} from '../shared/suggestions'

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The suggestions bridge (G67). Every reply from main is validated here against the contract (strict, so a reply that
 * carried an owner key or a source ref would be dropped) and a malformed one is replaced by a content-free refusal.
 */
export function createSuggestionsPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  suggestions: {
    list(): Promise<ListResult>
    checkNow(): Promise<CheckResult>
    shown(ref: CardRef): Promise<AckResult>
    accept(ref: CardRef): Promise<AcceptResult>
    dismiss(ref: CardRef, reason: DismissReason): Promise<AckResult>
    adjust(request: AdjustRequest): Promise<AdjustResult>
  }
} {
  const call = async <T>(
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    channel: string,
    payload?: unknown
  ): Promise<T> => {
    try {
      const parsed = schema.safeParse(await ipc.invoke(channel, payload))
      return parsed.success ? parsed.data : (UNAVAILABLE as unknown as T)
    } catch {
      return UNAVAILABLE as unknown as T
    }
  }
  return {
    suggestions: {
      list: () => call(ListResultSchema, SUGGESTION_IPC.list),
      checkNow: () => call(CheckResultSchema, SUGGESTION_IPC.checkNow),
      shown: (ref) => call(AckResultSchema, SUGGESTION_IPC.shown, ref),
      accept: (ref) => call(AcceptResultSchema, SUGGESTION_IPC.accept, ref),
      dismiss: (ref, reason) => call(AckResultSchema, SUGGESTION_IPC.dismiss, { ...ref, reason }),
      adjust: (request) => call(AdjustResultSchema, SUGGESTION_IPC.adjust, request)
    }
  }
}
