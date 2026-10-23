import type { IpcRenderer } from 'electron'
import { TASK_CARD_IPC, TaskCardListSchema, TaskCardIdInputSchema, type TaskCardView } from '../shared/task-card'

type Unsub = () => void

/**
 * `window.toto.taskCards` (G33): the live desktop task cards for the sidecar. Main owns the truth and sends only
 * the renderer-safe view. Replies and pushes are validated here; a malformed one is dropped, never repaired.
 */
export function createTaskCardsPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  taskCards: {
    list(): Promise<TaskCardView[]>
    stop(cardId: string): Promise<{ ok: boolean }>
    dismiss(cardId: string): Promise<{ ok: boolean }>
    onCards(listener: (cards: TaskCardView[]) => void): Unsub
  }
} {
  const decide = async (channel: string, cardId: string): Promise<{ ok: boolean }> => {
    const input = TaskCardIdInputSchema.safeParse({ cardId })
    if (!input.success) return { ok: false }
    const raw: unknown = await ipc.invoke(channel, input.data)
    return { ok: typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === true }
  }
  return {
    taskCards: {
      async list() {
        const parsed = TaskCardListSchema.safeParse(await ipc.invoke(TASK_CARD_IPC.list))
        return parsed.success ? parsed.data : []
      },
      stop: (cardId) => decide(TASK_CARD_IPC.stop, cardId),
      dismiss: (cardId) => decide(TASK_CARD_IPC.dismiss, cardId),
      onCards(listener) {
        const handler = (_event: unknown, payload: unknown): void => {
          const parsed = TaskCardListSchema.safeParse(payload)
          if (!parsed.success) return
          try {
            listener(parsed.data)
          } catch {
            /* a throwing subscriber must not break the bridge */
          }
        }
        ipc.on(TASK_CARD_IPC.cards, handler)
        return () => ipc.removeListener(TASK_CARD_IPC.cards, handler)
      }
    }
  }
}
