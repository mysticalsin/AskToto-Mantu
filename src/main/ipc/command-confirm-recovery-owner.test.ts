import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { COMMAND_CONFIRM_IPC } from '@shared/metis-command-contract'
import { actionEnvelope, type ActionEnvelope } from '../action-guard'
import type { CommandExecutionContext } from '../command-control'
import { DesktopActionTaskBridge, type DesktopActionTaskBridgeDeps } from '../tasks/desktop-action-task-bridge'
import type { TaskStateStore } from '../tasks/encrypted-task-file-store'
import type { TaskStateReadResult } from '../tasks/task-persistence'
import { registerCommandConfirmIpc } from './command-confirm-ipc'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic recovery note' } }
const PRINCIPAL_A = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) } as const

type StableRecoveryPrincipal = Readonly<{ ownerKey: string; tenantKey: string }>
type RecoveryPrincipalInjection = { recoveryPrincipal: () => StableRecoveryPrincipal }

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  async read(): Promise<TaskStateReadResult> {
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.serialized = null
  }
}

class MemoryAcks {
  ids: string[] = []
  async read(): Promise<readonly string[]> {
    return [...this.ids]
  }
  async write(ids: readonly string[]): Promise<void> {
    this.ids = [...ids]
  }
}

function context(proposalId: string): CommandExecutionContext {
  return {
    proposalId,
    owner: { webContentsId: 7, revision: 3 },
    ...actionEnvelope(proposalId, NOTE),
    dependsOn: []
  }
}

function verified(request: DesktopActionRequest, envelope: ActionEnvelope): DesktopActionResult {
  return {
    id: request.id,
    ok: true,
    outcome: 'verified',
    receipt: { ...envelope, observation: 'Synthetic action is visible in its app' }
  }
}

function bridge(
  store: MemoryStore,
  acknowledgements: MemoryAcks,
  principal: StableRecoveryPrincipal,
  generation: number,
  execute: DesktopActionTaskBridgeDeps['execute']
): DesktopActionTaskBridge {
  const deps: DesktopActionTaskBridgeDeps & RecoveryPrincipalInjection = {
    execute,
    store,
    acknowledgements,
    authSessionGeneration: () => generation,
    recoveryPrincipal: () => principal,
    newId: (() => {
      let id = 0
      return () => `ipc-recovery-owner-${++id}`
    })(),
    now: () => 1_000_000
  }
  return new DesktopActionTaskBridge(deps)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('command confirmation recovery IPC owner gate', () => {
  it('keeps A crash recovery undisclosed and unacknowledged to B through the real sender-gated handler', async () => {
    const source = new MemoryStore()
    const sourceAcks = new MemoryAcks()
    const held = deferred<DesktopActionResult>()
    let executorStarted = false
    const first = bridge(source, sourceAcks, PRINCIPAL_A, 53, async () => {
      executorStarted = true
      return held.promise
    })
    let running: Promise<DesktopActionResult> | undefined
    let settled = false
    let crashBytes: string | null = null
    let crashAcks: string[] = []
    try {
      running = first.execute(NOTE, context('ipc-crash-before-settlement'))
      void running.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await vi.waitFor(() => expect(executorStarted).toBe(true), { timeout: 1_000 })
      await vi.waitFor(() => expect(source.serialized).toContain('"status":"dispatching"'))
      first.stop('owner-reset')
      crashBytes = source.serialized
      crashAcks = [...sourceAcks.ids]
      expect(crashBytes).toContain('"status":"dispatching"')
      expect(crashAcks).toEqual([])
    } finally {
      held.resolve(verified(NOTE, actionEnvelope('ipc-crash-before-settlement', NOTE)))
      if (running) await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 })
    }

    const restartedStore = new MemoryStore()
    restartedStore.serialized = crashBytes
    const restartedAcks = new MemoryAcks()
    restartedAcks.ids = crashAcks
    const replay = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => verified(request, envelope))
    const restarted = bridge(
      restartedStore,
      restartedAcks,
      { ownerKey: 'c'.repeat(64), tenantKey: 'd'.repeat(64) },
      53,
      replay
    )
    expect(await restarted.recover()).toMatchObject({ available: true, uncertain: 1 })

    const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (event: IpcMainInvokeEvent) => unknown) => handlers.set(channel, listener)
    } as Pick<IpcMain, 'handle'>
    const assertMainWindow = vi.fn((event: IpcMainInvokeEvent) => {
      if (event.sender.id !== 19) throw new Error('not-current-main-window')
    })
    registerCommandConfirmIpc(ipcMain, assertMainWindow, {
      takeRecoveryNotices: restarted.takeRecoveryNotices.bind(restarted)
    })
    const recovery = handlers.get(COMMAND_CONFIRM_IPC.recoveryNotices)
    expect(recovery).toBeTypeOf('function')

    const staleSender = { sender: { id: 18 } } as IpcMainInvokeEvent
    expect(() => recovery?.(staleSender)).toThrow('not-current-main-window')
    const currentSender = { sender: { id: 19 } } as IpcMainInvokeEvent
    const notices = await recovery?.(currentSender)
    expect(assertMainWindow).toHaveBeenCalledTimes(2)
    expect.soft(notices).toEqual([])
    expect.soft(JSON.stringify(notices)).not.toContain(NOTE.args.title)
    expect.soft(restartedAcks.ids).toEqual([])
    expect.soft(replay).not.toHaveBeenCalled()
    expect(restarted.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
  })
})
