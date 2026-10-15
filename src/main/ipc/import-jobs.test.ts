import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'
import { execFile, execSync } from 'node:child_process'
import { DEFAULT_SETTINGS, IPC } from '@shared/ipc'
import type { ImportJob, ImportJobManager } from '../import-jobs'
import { createImportJobAuthority } from '../import-job-authority'
import {
  captureSettingsAuthority,
  commitManagedAuthorityDocument,
  getSettingsAuthorityHistory,
  isSettingsAuthorityCurrent
} from '../settings-authority-history'
import { getPublishedSettingsObservation, publishSettingsSnapshot } from '../settings-observation'
import { registerImportJobsIpc } from './import-jobs'

vi.mock('electron')
vi.mock('node:child_process')

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
  currentImportPersistenceState = () => 'configured' as const,
  refreshImportAuthority = async () => {},
  captureImportOperation,
  assertMainWindow = vi.fn(),
  managerStart,
  managerStartMany,
  managerSnapshot
}: {
  requireAuth?: boolean
  auth?: () => boolean
  assertImportAdmissionAllowed?: () => void
  assertImportAdmissionCurrent?: () => void
  currentImportRetentionState?: () => 'allowed' | 'summary-only' | 'unavailable'
  currentImportPersistenceState?: () => 'configured' | 'unconfigured' | 'invalid'
  refreshImportAuthority?: () => Promise<void>
  captureImportOperation?: () => Promise<{ assertCurrent(): void; refreshSameScope(): Promise<void> }>
  assertMainWindow?: (event: IpcMainInvokeEvent) => void
  managerStart?: () => Promise<ImportJob>
  managerStartMany?: () => Promise<ImportJob[]>
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
    start: managerStart ? vi.fn(managerStart) : vi.fn(async () => job),
    startMany: managerStartMany ? vi.fn(managerStartMany) : vi.fn(async () => [job]),
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
  const getImportJobs = vi.fn(() => manager)

  registerImportJobsIpc({
    ipcMain,
    win: null,
    assertMainWindow,
    requireAuth: auth ?? (() => requireAuth),
    getImportJobs,
    refreshImportAuthority,
    captureImportOperation:
      captureImportOperation ??
      (async () => {
        await refreshImportAuthority()
        const isAuthenticated = auth ?? (() => requireAuth)
        return {
          assertCurrent: () => {
            if (!isAuthenticated()) throw new Error('The original import authority is no longer current.')
          },
          refreshSameScope: refreshImportAuthority
        }
      }),
    assertImportAdmissionAllowed,
    assertImportAdmissionCurrent,
    currentImportRetentionState,
    currentImportCapabilityState: () => 'available',
    currentImportPersistenceState,
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
    getImportJobs,
    consumePickedAudio,
    invoke(channel: string, raw?: unknown): Promise<unknown> {
      const listener = handlers.get(channel)
      if (!listener) throw new Error(`Missing handler ${channel}`)
      return Promise.resolve(listener({} as IpcMainInvokeEvent, raw))
    }
  }
}

describe('import jobs IPC adapter', () => {
  it('runs positive Start, Batch, Resume, and List through the real published settings authority', async () => {
    const configured = structuredClone(DEFAULT_SETTINGS)
    commitManagedAuthorityDocument('user', '/profile/import-ipc-test.json', null, 'readable')
    commitManagedAuthorityDocument('admin', '/machine/import-ipc-test.json', null, 'readable')
    publishSettingsSnapshot(configured, true)

    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 4,
      readAuthority: async () => {
        const observation = getPublishedSettingsObservation()
        if (!observation) throw new Error('No published settings')
        return {
          ...observation,
          allowedProviders: null,
          localSpeechPack: null,
          lockedKeys: [],
          history: getSettingsAuthorityHistory()
        }
      },
      currentObservation: getPublishedSettingsObservation,
      captureAuthorityReceipt: () => captureSettingsAuthority('import'),
      isAuthorityReceiptCurrent: isSettingsAuthorityCurrent
    })
    const context = setup({
      refreshImportAuthority: async () => {
        await authority.refreshSettings()
      },
      captureImportOperation: authority.captureOperation,
      assertImportAdmissionAllowed: authority.assertAdmissionAllowed,
      assertImportAdmissionCurrent: authority.assertAdmissionCurrent
    })

    await expect(context.invoke(IPC.importAudioStart, { token: 'a'.repeat(24) })).resolves.toMatchObject({
      jobId: 'job-1'
    })
    await expect(
      context.invoke(IPC.importAudioStartBatch, { tokens: ['b'.repeat(24), 'c'.repeat(24)] })
    ).resolves.toMatchObject([{ jobId: 'job-1' }])
    await expect(
      context.invoke(IPC.importJobResume, { jobId: '11111111-1111-4111-8111-111111111111' })
    ).resolves.toMatchObject({ jobId: 'job-1' })
    await expect(context.invoke(IPC.importJobsList)).resolves.toMatchObject({
      policyState: 'allowed',
      persistenceState: 'configured',
      jobs: [{ jobId: 'job-1' }]
    })
    expect(context.manager.start).toHaveBeenCalledOnce()
    expect(context.manager.startMany).toHaveBeenCalledOnce()
    expect(context.manager.resume).toHaveBeenCalledOnce()
  })

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

  it('checks the synchronous fresh authority immediately before the single Start token consume', async () => {
    const context = setup({
      assertImportAdmissionCurrent: () => {
        throw new Error('Authority changed before token use.')
      }
    })

    await expect(context.invoke(IPC.importAudioStart, { token: 'a'.repeat(24) })).rejects.toThrow(
      'Authority changed before token use.'
    )
    expect(context.consumePickedAudio).not.toHaveBeenCalled()
    expect(context.manager.start).not.toHaveBeenCalled()
  })

  it('does not consume a single Start token after its sender changes during authority refresh', async () => {
    let senderChecks = 0
    const context = setup({
      assertMainWindow: () => {
        senderChecks += 1
        if (senderChecks === 2) throw new Error('The import sender is no longer current.')
      }
    })

    await expect(context.invoke(IPC.importAudioStart, { token: 'a'.repeat(24) })).rejects.toThrow(
      'The import sender is no longer current.'
    )
    expect(context.consumePickedAudio).not.toHaveBeenCalled()
    expect(context.manager.start).not.toHaveBeenCalled()
  })

  it('does not consume any batch tokens after its sender changes during authority refresh', async () => {
    let senderChecks = 0
    const context = setup({
      assertMainWindow: () => {
        senderChecks += 1
        if (senderChecks === 2) throw new Error('The import sender is no longer current.')
      }
    })

    await expect(
      context.invoke(IPC.importAudioStartBatch, { tokens: ['a'.repeat(24), 'b'.repeat(24)] })
    ).rejects.toThrow('The import sender is no longer current.')
    expect(context.consumePickedAudio).not.toHaveBeenCalled()
    expect(context.manager.startMany).not.toHaveBeenCalled()
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

  it('does not publish a Start result after authentication is revoked during manager admission', async () => {
    let authenticated = true
    let release!: (value: ImportJob) => void
    let markStarted!: () => void
    const entered = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const started = new Promise<ImportJob>((resolve) => {
      release = resolve
    })
    const context = setup({
      auth: () => authenticated,
      managerStart: () => {
        markStarted()
        return started
      }
    })
    const pending = context.invoke(IPC.importAudioStart, { token: 'a'.repeat(24) })
    await entered
    authenticated = false
    release(job)

    await expect(pending).rejects.toThrow('The original import authority is no longer current.')
    expect(context.consumePickedAudio).toHaveBeenCalledOnce()
  })

  it('does not publish a batch result after its sender owner changes during manager admission', async () => {
    let release!: (value: ImportJob[]) => void
    let markStarted!: () => void
    const entered = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const started = new Promise<ImportJob[]>((resolve) => {
      release = resolve
    })
    let senderChecks = 0
    const context = setup({
      managerStartMany: () => {
        markStarted()
        return started
      },
      assertMainWindow: () => {
        senderChecks += 1
        if (senderChecks === 4) throw new Error('The import sender is no longer current.')
      }
    })
    const pending = context.invoke(IPC.importAudioStartBatch, { tokens: ['a'.repeat(24)] })
    await entered
    release([job])

    await expect(pending).rejects.toThrow('The import sender is no longer current.')
    expect(context.consumePickedAudio).toHaveBeenCalledOnce()
    expect(context.manager.startMany).toHaveBeenCalledOnce()
  })

  it('does not publish a single Start result after its sender owner changes during manager admission', async () => {
    let release!: (value: ImportJob) => void
    let markStarted!: () => void
    const entered = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const started = new Promise<ImportJob>((resolve) => {
      release = resolve
    })
    let senderChecks = 0
    const context = setup({
      managerStart: () => {
        markStarted()
        return started
      },
      assertMainWindow: () => {
        senderChecks += 1
        if (senderChecks === 4) throw new Error('The import sender is no longer current.')
      }
    })
    const pending = context.invoke(IPC.importAudioStart, { token: 'a'.repeat(24) })
    await entered
    release(job)

    await expect(pending).rejects.toThrow('The import sender is no longer current.')
    expect(context.consumePickedAudio).toHaveBeenCalledOnce()
  })

  it('does not publish a batch result after authentication is revoked during manager admission', async () => {
    let authenticated = true
    let release!: (value: ImportJob[]) => void
    let markStarted!: () => void
    const entered = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const started = new Promise<ImportJob[]>((resolve) => {
      release = resolve
    })
    const context = setup({
      auth: () => authenticated,
      managerStartMany: () => {
        markStarted()
        return started
      }
    })
    const pending = context.invoke(IPC.importAudioStartBatch, { tokens: ['a'.repeat(24)] })
    await entered
    authenticated = false
    release([job])

    await expect(pending).rejects.toThrow('The original import authority is no longer current.')
    expect(context.consumePickedAudio).toHaveBeenCalledOnce()
  })

  it('returns the closed unavailable snapshot when authentication is absent', async () => {
    const context = setup({ requireAuth: false })

    await expect(context.invoke(IPC.importJobsList)).resolves.toEqual({
      jobs: [],
      policyBlocked: true,
      policyState: 'unavailable',
      capabilityState: 'unavailable',
      persistenceState: 'unconfigured',
      heldJobIds: [],
      policyHeldJobIds: [],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })
    expect(context.manager.snapshot).not.toHaveBeenCalled()
  })

  it('routes every manager operation through the lazy main-owned accessor', async () => {
    const context = setup()

    await context.invoke(IPC.importAudioStart, { token: 'a'.repeat(24) })
    await context.invoke(IPC.importAudioStartBatch, { tokens: ['b'.repeat(24)] })
    await context.invoke(IPC.importJobsList)
    await context.invoke(IPC.importJobCancel, { jobId: 'job-1' })
    await context.invoke(IPC.importJobResume, { jobId: 'job-1' })
    await context.invoke(IPC.importJobRemove, { jobId: 'job-1' })

    expect(context.getImportJobs).toHaveBeenCalledTimes(6)
    expect(context.manager.start).toHaveBeenCalledOnce()
    expect(context.manager.startMany).toHaveBeenCalledOnce()
    expect(context.manager.cancel).toHaveBeenCalledWith('job-1')
    expect(context.manager.resume).toHaveBeenCalledWith('job-1')
    expect(context.manager.remove).toHaveBeenCalledWith('job-1')
    expect(vi.mocked(shell.openPath)).not.toHaveBeenCalled()
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
    expect(vi.mocked(execSync)).not.toHaveBeenCalled()
  })

  it('refuses a single start before consuming its one-shot audio token when persistence is unconfigured', async () => {
    const context = setup({ currentImportPersistenceState: () => 'unconfigured' })
    await expect(context.invoke(IPC.importAudioStart, { token: 'a'.repeat(24) })).rejects.toThrow(
      'Saved import recovery is not configured.'
    )
    expect(context.consumePickedAudio).not.toHaveBeenCalled()
    expect(context.manager.start).not.toHaveBeenCalled()
  })

  it('refuses a batch before consuming any prefix of its one-shot audio tokens', async () => {
    const context = setup({ currentImportPersistenceState: () => 'unconfigured' })
    await expect(
      context.invoke(IPC.importAudioStartBatch, { tokens: ['a'.repeat(24), 'b'.repeat(24)] })
    ).rejects.toThrow('Saved import recovery is not configured.')
    expect(context.consumePickedAudio).not.toHaveBeenCalled()
    expect(context.manager.startMany).not.toHaveBeenCalled()
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
      persistenceState: 'unconfigured',
      heldJobIds: [],
      policyHeldJobIds: [],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })
  })

  it('does not publish an old snapshot after an allowed authority scope changes and returns to A', async () => {
    let release!: (value: unknown) => void
    let semanticEpoch = 1
    const snapshot = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const context = setup({
      managerSnapshot: () => snapshot,
      captureImportOperation: async () => {
        const captured = semanticEpoch
        const assertCurrent = () => {
          if (semanticEpoch !== captured) throw new Error('The original import authority is no longer current.')
        }
        return { assertCurrent, refreshSameScope: async () => assertCurrent() }
      }
    })
    const result = context.invoke(IPC.importJobsList)
    semanticEpoch = 2
    semanticEpoch = 3 // Authority is currently allowed again, but this result belongs to epoch 1.
    release({
      jobs: [job],
      policyBlocked: false,
      policyState: 'allowed',
      heldJobIds: ['job-1'],
      policyHeldJobIds: [],
      inventoryOverflow: false,
      policyHoldOverflow: false
    })

    await expect(result).resolves.toMatchObject({ jobs: [], policyState: 'unavailable' })
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

  it('does not publish a List snapshot after the sender changes during its final authority read', async () => {
    let senderChecks = 0
    const context = setup({
      assertMainWindow: () => {
        senderChecks += 1
        if (senderChecks === 3) throw new Error('The import sender is no longer current.')
      }
    })

    await expect(context.invoke(IPC.importJobsList)).resolves.toMatchObject({
      jobs: [],
      policyState: 'unavailable',
      capabilityState: 'unavailable'
    })
  })

  it('rechecks sender, auth and synchronous admission after the final Resume refresh', async () => {
    let authenticated = true
    let admissionChecks = 0
    const current = vi.fn()
    const context = setup({
      auth: () => authenticated,
      assertImportAdmissionAllowed: () => {
        admissionChecks += 1
        if (admissionChecks === 2) authenticated = false
      },
      assertImportAdmissionCurrent: current
    })

    await expect(context.invoke(IPC.importJobResume, { jobId: 'job-1' })).rejects.toThrow(
      'The original import authority is no longer current.'
    )
    expect(context.manager.resume).toHaveBeenCalledOnce()
    expect(current).not.toHaveBeenCalled()
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

  it('returns content-free held identities but no job views until persistence is configured', async () => {
    const context = setup({
      currentImportPersistenceState: () => 'unconfigured',
      managerSnapshot: async () => ({
        jobs: [job],
        policyBlocked: false,
        policyState: 'allowed',
        heldJobIds: ['held-job'],
        policyHeldJobIds: [],
        inventoryOverflow: false,
        policyHoldOverflow: false
      })
    })
    await expect(context.invoke(IPC.importJobsList)).resolves.toMatchObject({
      jobs: [],
      persistenceState: 'unconfigured',
      heldJobIds: ['held-job']
    })
  })
})
