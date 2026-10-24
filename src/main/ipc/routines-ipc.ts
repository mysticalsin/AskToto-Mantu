import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  ChangedPushSchema,
  CompileRequestSchema,
  ConsentRequestSchema,
  ResultPushSchema,
  ResumeRequestSchema,
  ROUTINE_IPC,
  RoutineNoPayloadSchema,
  RoutineTargetSchema
} from '@shared/routines'
import type { RoutineEngine, RoutineEvent } from '../features/routines'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface RoutinesIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  engine: RoutineEngine
}

/** The one webContents method used, so tests pass a plain object. */
interface PushTarget {
  isDestroyed?(): boolean
  send(channel: string, ...args: unknown[]): void
}

const INVALID = { ok: false, reason: 'invalid' } as const
const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const
const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The renderer's seam to the routine engine (G66): list, compile, consent, pause, resume, run now, delete. Every channel
 * sits behind the main-window top-frame sender gate and a signed-in check, validates its payload strictly (an unknown
 * key, such as an owner key, a scope or an action, makes it invalid), and answers with a typed refusal, never an error.
 *
 * What a renderer can NOT do here: supply a scope, an action to run, or a tool outside the read-only set; read an owner
 * key, a tenant key, an idempotency key or a journal key; or create a routine without echoing the exact preview hash.
 *
 * Returns `push`, which tells the windows that have used this surface that the list changed or a run settled. Pushes carry
 * ids, an outcome and a time only.
 */
export function registerRoutinesIpc(deps: RoutinesIpcDependencies): { push(event: RoutineEvent): void } {
  const subscribers = new Set<PushTarget>()
  const guard = (event: IpcMainInvokeEvent, surface: string): boolean => {
    deps.authorizeSender(event as unknown as SenderEventLike, {
      surface: `routines.${surface}`,
      requireOwner: true,
      allowedFrames: 'main-window-top'
    })
    if (!deps.requireAuth()) return false
    const sender = (event as unknown as { sender?: PushTarget }).sender
    if (sender && typeof sender.send === 'function') subscribers.add(sender)
    return true
  }
  const settle = async <T>(work: () => Promise<T>): Promise<T | typeof UNAVAILABLE> => {
    try {
      return await work()
    } catch {
      return UNAVAILABLE
    }
  }
  const { ipcMain, engine } = deps

  ipcMain.handle(ROUTINE_IPC.list, async (event, raw) =>
    guard(event, 'list')
      ? RoutineNoPayloadSchema.safeParse(raw).success
        ? settle(() => engine.list())
        : INVALID
      : SIGNED_OUT
  )
  ipcMain.handle(ROUTINE_IPC.compile, async (event, raw) => {
    if (!guard(event, 'compile')) return SIGNED_OUT
    const parsed = CompileRequestSchema.safeParse(raw)
    return parsed.success ? settle(() => engine.compile(parsed.data)) : INVALID
  })
  ipcMain.handle(ROUTINE_IPC.consent, async (event, raw) => {
    if (!guard(event, 'consent')) return SIGNED_OUT
    const parsed = ConsentRequestSchema.safeParse(raw)
    return parsed.success ? settle(() => engine.consent(parsed.data)) : INVALID
  })
  ipcMain.handle(ROUTINE_IPC.pause, async (event, raw) => {
    if (!guard(event, 'pause')) return SIGNED_OUT
    const parsed = RoutineTargetSchema.safeParse(raw)
    return parsed.success ? settle(() => engine.pause(parsed.data)) : INVALID
  })
  ipcMain.handle(ROUTINE_IPC.resume, async (event, raw) => {
    if (!guard(event, 'resume')) return SIGNED_OUT
    const parsed = ResumeRequestSchema.safeParse(raw)
    return parsed.success ? settle(() => engine.resume(parsed.data)) : INVALID
  })
  ipcMain.handle(ROUTINE_IPC.runNow, async (event, raw) => {
    if (!guard(event, 'runNow')) return SIGNED_OUT
    const parsed = RoutineTargetSchema.safeParse(raw)
    return parsed.success ? settle(() => engine.runNow(parsed.data)) : INVALID
  })
  ipcMain.handle(ROUTINE_IPC.remove, async (event, raw) => {
    if (!guard(event, 'delete')) return SIGNED_OUT
    const parsed = RoutineTargetSchema.safeParse(raw)
    return parsed.success ? settle(() => engine.remove(parsed.data)) : INVALID
  })

  return {
    push(event) {
      const [channel, payload] =
        event.type === 'changed'
          ? ([ROUTINE_IPC.changed, ChangedPushSchema.safeParse({})] as const)
          : ([
              ROUTINE_IPC.result,
              ResultPushSchema.safeParse({ routineId: event.routineId, outcome: event.outcome, at: event.at })
            ] as const)
      if (!payload.success) return
      for (const target of [...subscribers]) {
        try {
          if (target.isDestroyed?.() === true) {
            subscribers.delete(target)
            continue
          }
          target.send(channel, payload.data)
        } catch {
          subscribers.delete(target)
        }
      }
    }
  }
}
