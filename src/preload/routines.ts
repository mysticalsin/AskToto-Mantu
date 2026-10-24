import type { IpcRenderer } from 'electron'
import {
  ChangedPushSchema,
  CompileResultSchema,
  ConsentResultSchema,
  ListResultSchema,
  MutationResultSchema,
  ResultPushSchema,
  ROUTINE_IPC,
  type CompileRequest,
  type CompileResult,
  type ConsentResult,
  type ListResult,
  type MutationResult,
  type ResultPush
} from '../shared/routines'

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

type Unsub = () => void

/**
 * The routines bridge (G66). Every reply from main is validated here against the contract (strict, so a reply that
 * carried an owner or tenant key would be dropped) and a malformed one is replaced by a content-free refusal. Creating a
 * routine is two calls on purpose: `compile` returns the exact preview, `consent` echoes its hash.
 */
export function createRoutinesPreloadApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): {
  routines: {
    list(): Promise<ListResult>
    compile(request: CompileRequest): Promise<CompileResult>
    consent(proposalId: string, previewHash: string): Promise<ConsentResult>
    pause(routineId: string): Promise<MutationResult>
    resume(routineId: string, reconciled?: true): Promise<MutationResult>
    runNow(routineId: string): Promise<MutationResult>
    remove(routineId: string): Promise<MutationResult>
    onChanged(cb: () => void): Unsub
    onResult(cb: (result: ResultPush) => void): Unsub
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
  const subscribe = <T>(
    channel: string,
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    cb: (value: T) => void
  ): Unsub => {
    const handler = (_event: unknown, raw: unknown): void => {
      const parsed = schema.safeParse(raw)
      if (parsed.success) cb(parsed.data)
    }
    ipc.on(channel, handler)
    return () => ipc.removeListener(channel, handler)
  }
  return {
    routines: {
      list: () => call(ListResultSchema, ROUTINE_IPC.list),
      compile: (request) => call(CompileResultSchema, ROUTINE_IPC.compile, request),
      consent: (proposalId, previewHash) => call(ConsentResultSchema, ROUTINE_IPC.consent, { proposalId, previewHash }),
      pause: (routineId) => call(MutationResultSchema, ROUTINE_IPC.pause, { routineId }),
      resume: (routineId, reconciled) =>
        call(MutationResultSchema, ROUTINE_IPC.resume, reconciled ? { routineId, reconciled } : { routineId }),
      runNow: (routineId) => call(MutationResultSchema, ROUTINE_IPC.runNow, { routineId }),
      remove: (routineId) => call(MutationResultSchema, ROUTINE_IPC.remove, { routineId }),
      onChanged: (cb) => subscribe(ROUTINE_IPC.changed, ChangedPushSchema, () => cb()),
      onResult: (cb) => subscribe(ROUTINE_IPC.result, ResultPushSchema, cb)
    }
  }
}
