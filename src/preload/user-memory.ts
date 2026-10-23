import type { IpcRenderer } from 'electron'
import {
  USER_MEMORY_IPC,
  UserMemoryAckSchema,
  UserMemoryListSchema,
  type UserMemoryAck,
  type UserMemoryList
} from '../shared/user-memory'

const REFUSED: UserMemoryAck = { ok: false }
const UNAVAILABLE: UserMemoryList = { status: 'unavailable', items: [], tombstones: 0 }

/**
 * The user memory bridge (G57). Every reply from main is validated here and a malformed one is replaced by a
 * content-free fallback. There is no call that adds an item: what Métis remembers comes only from the owner's own
 * command, in main. The renderer can list, correct and delete by opaque id.
 */
export function createUserMemoryPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  userMemory: {
    list(): Promise<UserMemoryList>
    correct(id: string, text: string): Promise<UserMemoryAck>
    remove(id: string): Promise<UserMemoryAck>
  }
} {
  const ack = async (channel: string, payload: unknown): Promise<UserMemoryAck> => {
    try {
      const parsed = UserMemoryAckSchema.safeParse(await ipc.invoke(channel, payload))
      return parsed.success ? parsed.data : REFUSED
    } catch {
      return REFUSED
    }
  }
  return {
    userMemory: {
      async list() {
        try {
          const parsed = UserMemoryListSchema.safeParse(await ipc.invoke(USER_MEMORY_IPC.list))
          return parsed.success ? parsed.data : UNAVAILABLE
        } catch {
          return UNAVAILABLE
        }
      },
      correct: (id, text) => ack(USER_MEMORY_IPC.correct, { id, text }),
      remove: (id) => ack(USER_MEMORY_IPC.delete, { id })
    }
  }
}
