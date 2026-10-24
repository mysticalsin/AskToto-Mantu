import type { IpcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import {
  UPDATE_LIFECYCLE_IPC,
  UpdateLifecycleStateSchema,
  type UpdateInstallResult,
  type UpdateLifecycleState
} from '../shared/update-lifecycle'

type Unsub = () => void

/**
 * `window.toto.installUpdate` / `getUpdateState` / `onUpdateState` (G86): the update lifecycle. Install answers with
 * whether it relaunched or why it was deferred. Replies and pushes are validated; a malformed one is dropped.
 */
export function createUpdateLifecyclePreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  installUpdate(): Promise<UpdateInstallResult>
  getUpdateState(): Promise<UpdateLifecycleState>
  onUpdateState(listener: (state: UpdateLifecycleState) => void): Unsub
} {
  return {
    installUpdate: () => ipc.invoke(IPC.updateInstall),
    async getUpdateState() {
      const parsed = UpdateLifecycleStateSchema.safeParse(await ipc.invoke(UPDATE_LIFECYCLE_IPC.stateGet))
      return parsed.success ? parsed.data : { phase: 'idle' }
    },
    onUpdateState(listener) {
      const handler = (_event: unknown, payload: unknown): void => {
        const parsed = UpdateLifecycleStateSchema.safeParse(payload)
        if (!parsed.success) return
        try {
          listener(parsed.data)
        } catch {
          /* a throwing subscriber must not break the bridge */
        }
      }
      ipc.on(UPDATE_LIFECYCLE_IPC.state, handler)
      return () => ipc.removeListener(UPDATE_LIFECYCLE_IPC.state, handler)
    }
  }
}
