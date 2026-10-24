import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import type { QuietAction } from '@shared/quiet-mode-settings'
import type { AssistantService } from '../features/assistants'
import {
  createRoutineEngine,
  createRoutineStore,
  ROUTINE_SCHEDULER_LIMITS,
  type RoutineAuditPhase,
  type RoutineEngine,
  type RoutineEngineDeps,
  type RoutinePublication
} from '../features/routines'
import { startRoutineTicker, type RoutineTickerPowerMonitor } from '../infra/scheduler/routine-ticker'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import { registerRoutinesIpc } from '../ipc/routines-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { memoryAccess, memoryPartitionsConfigured, onMemoryPartitionChange } from '../memory-partition/memory-access'
import { TaskScheduler } from '../tasks/task-scheduler'

export interface RoutinesWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  ownerSession: {
    currentOwnerKey(): string | null
    currentTenantKey(): string | null
    onRevoked(cb: () => void): () => void
  }
  userDataPath(): string
  /** The app's own secret sealing (`encryptSecret` / `decryptSecret`). */
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  /** The assistant service (G48): routines only read whether an assistant is archived. */
  assistants: Pick<AssistantService, 'list'>
  /** Electron's `powerMonitor`: wake and unlock tick at once. */
  powerMonitor: RoutineTickerPowerMonitor
  isOnline(): boolean
  /** The quiet policy for an unsolicited toast right now (G68). */
  quietAction(): QuietAction
  /** The one notification path (`showQuietNotification`): unsolicited, so the quiet gate decides. */
  notify(options: { title: string; body: string }): QuietAction
  audit(record: { phase: RoutineAuditPhase; reason?: string; count?: number }): void
  onWillQuit?(listener: () => void): unknown
  /** Absent until G67 (suggestions) and G69/G64 (acting routines): compile refuses those purposes as unsupported. */
  research?: RoutineEngineDeps['research']
  proposeAction?: RoutineEngineDeps['proposeAction']
  /** The allowance meter (G79 to G81). Until it exists the allowance is reported available (ASSUMED, D-16). */
  allowance?: RoutineEngineDeps['allowance']
  /** True while no confirm card is current. Defaults to idle. */
  commandIdle?: RoutineEngineDeps['commandIdle']
  /** Test seams. */
  partition?(): string | null
  onPartitionChange?(listener: () => void): () => void
  now?(): number
  defaultTimeZone?(): string
  tickMs?: number
}

/** G19's partition in force: its id, or null while none is open (signed out, unverified, a switch in flight). */
function activePartition(): string | null {
  if (!memoryPartitionsConfigured()) return null
  const access = memoryAccess()
  return access.status === 'ok' ? access.partitionId : null
}

/** What a published routine output says. Local, short and free of meeting content. */
export function routineNotification(output: RoutinePublication): { title: string; body: string } {
  return output.kind === 'allowance'
    ? { title: 'Routines paused', body: 'Routines resume when your allowance resets.' }
    : { title: 'Routine', body: output.title }
}

/**
 * Builds the routine store and engine (G66) under `<userData>/routines/<partition>.bin` (sealed, one file per memory
 * partition), registers its IPC behind the shared sender authorizer, starts the ticker, and stops the runner when the owner
 * is revoked or the partition changes. Hangs off `createOwnerSessionWiring`, so index.ts gains no lines.
 *
 * Routines run only while Métis is open and only for a verified owner: without an owner key, tenant key and an open
 * partition there is no scope, nothing starts and every call is refused as signed out.
 */
export function bootstrapRoutines(deps: RoutinesWiringDeps): { engine: RoutineEngine; dispose(): void } {
  const partition = deps.partition ?? activePartition
  const scope = () => {
    const partitionId = partition()
    const ownerKey = deps.ownerSession.currentOwnerKey()
    const tenantKey = deps.ownerSession.currentTenantKey()
    return partitionId && ownerKey && tenantKey ? { partitionId, ownerKey, tenantKey } : null
  }
  const file = (partitionId: string): string => {
    if (!/^(?:legacy|[0-9a-f]{24})$/.test(partitionId)) throw new Error('invalid memory partition')
    return join(deps.userDataPath(), 'routines', `${partitionId}.bin`)
  }
  const store = createRoutineStore({
    io: {
      async read(partitionId) {
        try {
          return await readFile(file(partitionId))
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
          throw error
        }
      },
      async write(partitionId, data) {
        const target = file(partitionId)
        await mkdir(join(deps.userDataPath(), 'routines'), { recursive: true, mode: 0o700 })
        await atomicSavedWrite(target, data)
      }
    },
    seal: deps.seal,
    open: deps.open,
    scope
  })
  let ipc: ReturnType<typeof registerRoutinesIpc> | null = null
  const engine = createRoutineEngine({
    store,
    scope,
    scheduler: new TaskScheduler(ROUTINE_SCHEDULER_LIMITS),
    now: deps.now ?? Date.now,
    defaultTimeZone: deps.defaultTimeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    assistants: async () => {
      const listed = await deps.assistants.list()
      return listed.ok ? listed.assistants.map((a) => ({ assistantId: a.assistantId, archived: a.archived })) : null
    },
    isOnline: deps.isOnline,
    allowance: deps.allowance ?? (() => ({ available: true })),
    quietAction: deps.quietAction,
    publish: (output) => deps.notify(routineNotification(output)),
    commandIdle: deps.commandIdle ?? (() => true),
    ...(deps.research ? { research: deps.research } : {}),
    ...(deps.proposeAction ? { proposeAction: deps.proposeAction } : {}),
    audit: (record) => deps.audit(record),
    emit: (event) => ipc?.push(event)
  })
  ipc = registerRoutinesIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    engine
  })
  // The disposers are discarded on purpose: these bindings live for the app lifetime.
  deps.ownerSession.onRevoked(() => engine.onOwnerChange())
  ;(deps.onPartitionChange ?? onMemoryPartitionChange)(() => engine.onOwnerChange())
  const stopTicker = startRoutineTicker(() => void engine.tick(), {
    powerMonitor: deps.powerMonitor,
    ...(deps.tickMs ? { everyMs: deps.tickMs } : {})
  })
  const dispose = (): void => {
    stopTicker()
    engine.onOwnerChange()
  }
  deps.onWillQuit?.(dispose)
  void engine.tick()
  return { engine, dispose }
}
