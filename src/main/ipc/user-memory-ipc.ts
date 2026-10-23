import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  USER_MEMORY_IPC,
  UserMemoryCorrectSchema,
  UserMemoryDeleteSchema,
  type UserMemoryAck,
  type UserMemoryList
} from '@shared/user-memory'
import type { UserMemory } from '../features/user-memory'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface UserMemoryIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  memory: Pick<UserMemory, 'list' | 'correct' | 'delete'>
  /** Counts only: which action ran and whether it landed. Never text. */
  audit?(record: { action: 'correct' | 'delete'; ok: boolean }): void
}

const REFUSED: UserMemoryAck = { ok: false }
const UNAVAILABLE: UserMemoryList = { status: 'unavailable', items: [], tombstones: 0 }

/**
 * The renderer's seam to the user memory (G57): list what Métis remembers, correct it, delete it. Every channel sits
 * behind the main-window top-frame sender gate and a signed-in check, validates its payload strictly and answers with
 * a typed, content-free fallback. There is deliberately no channel that adds an item: only the owner's own command, in
 * main, can.
 */
export function registerUserMemoryIpc(deps: UserMemoryIpcDependencies): void {
  const guard = (event: IpcMainInvokeEvent, surface: string): boolean => {
    deps.authorizeSender(event as unknown as SenderEventLike, {
      surface: `user.memory.${surface}`,
      requireOwner: false,
      allowedFrames: 'main-window-top'
    })
    return deps.requireAuth()
  }
  const act = async (action: 'correct' | 'delete', work: () => Promise<boolean>): Promise<UserMemoryAck> => {
    let ok = false
    try {
      ok = await work()
    } catch {
      ok = false
    }
    try {
      deps.audit?.({ action, ok })
    } catch {
      /* audit is best effort */
    }
    return { ok }
  }

  deps.ipcMain.handle(USER_MEMORY_IPC.list, async (event): Promise<UserMemoryList> => {
    if (!guard(event, 'list')) return UNAVAILABLE
    try {
      return await deps.memory.list()
    } catch {
      return UNAVAILABLE
    }
  })
  deps.ipcMain.handle(USER_MEMORY_IPC.correct, async (event, raw): Promise<UserMemoryAck> => {
    const signedIn = guard(event, 'correct')
    const parsed = UserMemoryCorrectSchema.safeParse(raw)
    if (!signedIn || !parsed.success) return REFUSED
    return act('correct', () => deps.memory.correct(parsed.data.id, parsed.data.text))
  })
  deps.ipcMain.handle(USER_MEMORY_IPC.delete, async (event, raw): Promise<UserMemoryAck> => {
    const signedIn = guard(event, 'delete')
    const parsed = UserMemoryDeleteSchema.safeParse(raw)
    if (!signedIn || !parsed.success) return REFUSED
    return act('delete', () => deps.memory.delete(parsed.data.id))
  })
}
