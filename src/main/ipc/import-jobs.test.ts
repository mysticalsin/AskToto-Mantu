import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { ImportJob, ImportJobManager } from '../import-jobs'
import { registerImportJobsIpc } from './import-jobs'

const job: ImportJob = {
  jobId: 'job-1',
  sourcePath: '/private/audio.wav',
  sourceName: 'audio.wav',
  sourceSizeBytes: 1,
  sourceMtimeMs: 1,
  title: 'Audio',
  state: 'queued',
  cursor: 0,
  totalChunks: 0,
  lines: [],
  createdAt: 1,
  updatedAt: 1
}

function setup({
  requireAuth = true,
  auth,
  assertImportAdmissionAllowed = () => {},
  assertImportAdmissionCurrent = () => {},
  currentImportRetentionState = () => 'allowed' as const,
  refreshImportAuthority = async () => {},
  managerSnapshot
}: {
  requireAuth?: boolean
  auth?: () => boolean
  assertImportAdmissionAllowed?: () => void
  assertImportAdmissionCurrent?: () => void
  currentImportRetentionState?: () => 'allowed' | 'summary-only' | 'unavailable'
  refreshImportAuthority?: () => Promise<void>
  managerSnapshot?: () => Promise<unknown>
} = {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, raw?: unknown) => unknown>()
  const ipcMain = {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, raw?: unknown) => unknown) => {
      handlers.set(channel, listener)
    }
  } as unknown as Pick<IpcMain, 'handle'>
  const consumePickedAudio = vi.fn((token: string) => ({
    path: `/private/${token}.wav`,
    name: `${token}.wav`,
    sizeBytes: 1,
    mtimeMs: 1
  }))
  const manager = {
    start: vi.fn(async () => job),
    startMany: vi.fn(async () => [job]),
    snapshot:
      managerSnapshot ??
      vi.fn(async () => ({
        jobs: [job],
        policyBlocked: false,
        policyState: 'allowed',
        heldJobIds: [],
        policyHeldJobIds: [],
        inventoryOverflow: false,
        policyHoldOverflow: false
      })),
    cancel: vi.fn(async () => {}),
    resume: vi.fn(async () => job),
    remove: vi.fn(async () => {})
  } as unknown as ImportJobManager

  registerImportJobsIpc({
    ipcMain,
    win: null,
    assertMainWindow: vi.fn(),
    requireAuth: auth ?? (() => requireAuth),
    getImportJobs: () => manager,
    refreshImportAuthority,
    assertImportAdmissionAllowed,
    assertImportAdmissionCurrent,
    currentImportRetentionState,
    currentImportCapabilityState: () => 'available',
    consumeAudioToken: consumePickedAudio,
    importJobView: (value) => ({
      jobId: value.jobId,
      title: value.title,
      state: value.state,
      cursor: value.cursor,
      totalChunks: value.totalChunks,
      pct: null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt
    })
  })

  return {
    manager,
    consumePickedAudio,
    invoke(channel: string, raw?: unknown): Promise<unknown> {
      const listener = handlers.get(channel)
      if (!listener) throw new Error(`Missing handler ${channel}`)
      return Promise.resolve(listener({} as IpcMainInvokeEvent, raw))
    }
  }
}

describe('import jobs IPC adapter', () => {
  it('checks current policy before consuming a one-shot token', async () => {
    const context = setup({
      assertImportAdmissionAllowed: () => {
        throw new Error('Import is paused by current policy.')
      }
    })

    await expect(context.invoke(IPC.importAudioStart, { token: 'a'.repeat(24) })).rejects.toThrow(
      'Import is paused by current policy.'
    )
    expect(context.consumePickedAudio).not.toHaveBeenCalled()
  })

  it('does not turn a policy flip between batch tokens into an ordinary file error', async () => {
    let checks = 0
    const context = setup({
      assertImportAdmissionCurrent: () => {
        checks += 1
        if (checks === 2) throw new Error('Import policy changed during batch admission.')
      }
    })

    await expect(
      context.invoke(IPC.importAudioStartBatch, { tokens: ['a'.repeat(24), 'b'.repeat(24)] })
    ).rejects.toThrow('Import policy changed during batch admission.')
    expect(context.consumePickedAudio).toHaveBeenCalledTimes(1)
    expect(context.manager.startMany).not.toHaveBeenCalled()
  })

  it('returns the closed unavailable snapshot when authentication is absent', async () => {
    const context = setup({ requireAuth: false })

    await expect(context.invoke(IPC.importJobsList)).resolves.toEqual({
      jobs: [],
      policyBlocked: true,
      policyState: 'unavailable',
      capabilityState: 'unavailable',
      heldJobIds: [],
      policyHeldJobIds: [],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })
    expect(context.manager.snapshot).not.toHaveBeenCalled()
  })

  it('does not return job metadata if authentication is revoked while the snapshot is loading', async () => {
    let release!: (value: unknown) => void
    let authenticated = true
    const snapshot = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const context = setup({ managerSnapshot: () => snapshot, auth: () => authenticated })
    const result = context.invoke(IPC.importJobsList)
    authenticated = false
    release({
      jobs: [job],
      policyBlocked: false,
      policyState: 'allowed',
      heldJobIds: ['job-1'],
      policyHeldJobIds: [],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })

    await expect(result).resolves.toEqual({
      jobs: [],
      policyBlocked: true,
      policyState: 'unavailable',
      capabilityState: 'unavailable',
      heldJobIds: [],
      policyHeldJobIds: [],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })
  })

  it('closes a snapshot when the refreshed authority becomes summary-only after inventory', async () => {
    let refreshes = 0
    const context = setup({
      refreshImportAuthority: async () => {
        refreshes += 1
      },
      currentImportRetentionState: () => (refreshes >= 2 ? 'summary-only' : 'allowed')
    })

    await expect(context.invoke(IPC.importJobsList)).resolves.toMatchObject({
      jobs: [],
      policyBlocked: true,
      policyState: 'summary-only'
    })
  })

  it('maps manager jobs while preserving the separate capability state', async () => {
    const context = setup({
      managerSnapshot: async () => ({
        jobs: [job],
        policyBlocked: false,
        policyState: 'allowed',
        heldJobIds: [],
        policyHeldJobIds: [],
        inventoryOverflow: false,
        policyHoldOverflow: false
      })
    })

    await expect(context.invoke(IPC.importJobsList)).resolves.toMatchObject({
      jobs: [{ jobId: 'job-1', title: 'Audio' }],
      policyState: 'allowed',
      capabilityState: 'available'
    })
  })
})
