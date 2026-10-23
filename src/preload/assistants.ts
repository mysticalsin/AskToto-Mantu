import type { IpcRenderer } from 'electron'
import {
  ASSISTANT_IPC,
  ConfirmResultSchema,
  HistoryMapResultSchema,
  ListResultSchema,
  MutationResultSchema,
  ProposeResultSchema,
  type AssistantDraft,
  type ConfirmResult,
  type HistoryMapResult,
  type ListResult,
  type MutationResult,
  type ProposeResult
} from '../shared/assistants'

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The assistants bridge (G48). Every reply from main is validated here against the contract (strict, so a reply that
 * carried an owner or tenant key would be dropped) and a malformed one is replaced by a content-free refusal. Creating
 * an assistant is two calls on purpose: `propose` returns the exact preview, `confirm` echoes its hash.
 */
export function createAssistantsPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  assistants: {
    list(): Promise<ListResult>
    propose(drafts: Array<Pick<AssistantDraft, 'name' | 'base'> & { instructions?: string }>): Promise<ProposeResult>
    confirm(proposalId: string, previewHash: string): Promise<ConfirmResult>
    update(input: {
      assistantId: string
      expectedRevision: number
      name?: string
      base?: AssistantDraft['base']
      instructions?: string
    }): Promise<MutationResult>
    archive(assistantId: string, expectedRevision: number, archived: boolean): Promise<MutationResult>
    historyMap(): Promise<HistoryMapResult>
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
    assistants: {
      list: () => call(ListResultSchema, ASSISTANT_IPC.list),
      propose: (drafts) => call(ProposeResultSchema, ASSISTANT_IPC.propose, { drafts }),
      confirm: (proposalId, previewHash) =>
        call(ConfirmResultSchema, ASSISTANT_IPC.confirm, { proposalId, previewHash }),
      update: (input) => call(MutationResultSchema, ASSISTANT_IPC.update, input),
      archive: (assistantId, expectedRevision, archived) =>
        call(MutationResultSchema, ASSISTANT_IPC.archive, { assistantId, expectedRevision, archived }),
      historyMap: () => call(HistoryMapResultSchema, ASSISTANT_IPC.historyMap)
    }
  }
}
