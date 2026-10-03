import { IPC } from '@shared/ipc'

export type IpcAuthPolicy = 'required' | 'public'
export type IpcChannel = typeof IPC[keyof typeof IPC]

export const PUBLIC_IPC_HANDLERS = [
  IPC.localAppleEngineStatus,
  IPC.permissionsOpenSettings,
  IPC.permissionsRepairScreen,
  IPC.permissionsAttestScreen,
  IPC.permissionsRevealCopy
] as const satisfies readonly IpcChannel[]
export type ReviewedPublicIpcChannel = typeof PUBLIC_IPC_HANDLERS[number]

const publicHandlers = new Set<IpcChannel>(PUBLIC_IPC_HANDLERS)

export function assertReviewedPublicHandler(channel: IpcChannel): void {
  if (!publicHandlers.has(channel)) {
    throw new Error(`Public IPC handler is not in the reviewed allowlist: ${channel}`)
  }
}
