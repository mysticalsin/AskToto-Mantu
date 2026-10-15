import { describe, expect, it } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ImportJob, ImportJobsSnapshot } from './import-job-types'
import type { ImportJobView } from '@shared/import-jobs'
import { SpeechAuthLeaseController } from './auth-speech-lease'
import {
  createImportJobView,
  createImportJobsSnapshotScopeGuard,
  emptyImportJobsSnapshot,
  readImportJobsSnapshot,
  trackMainDocument
} from './import-jobs-snapshot-ipc'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const job = { jobId: 'job-a', sourcePath: '/private/meeting.wav' } as ImportJob
const view = {
  jobId: 'job-a',
  title: 'Meeting',
  state: 'queued',
  cursor: 0,
  totalChunks: 0,
  pct: null
} as ImportJobView
const completeSnapshot: ImportJobsSnapshot = {
  jobs: [job],
  policyBlocked: false,
  policyState: 'allowed',
  heldJobIds: ['held-a', 'held-b'],
  policyHeldJobIds: ['policy-a'],
  inventoryOverflow: true,
  policyHoldOverflow: true
}

function fixture() {
  const state = {
    profile: '/profile/a',
    settingsEpoch: 3,
    session: { email: 'user@example.test' } as object,
    authEpoch: 1,
    authorized: true,
    url: 'app://metis/index.html',
    documentEpoch: 0
  }
  const sender = { isDestroyed: () => false, getURL: () => state.url }
  const frame = {
    parent: null,
    get url() {
      return state.url
    },
    isDestroyed: () => false
  }
  const window = { webContents: sender, isDestroyed: () => false }
  const event = {
    sender,
    get senderFrame() {
      return frame
    }
  }
  const readers = {
    currentWindow: () => window,
    documentEpoch: () => state.documentEpoch,
    currentProfilePath: () => state.profile,
    refreshSettings: () => undefined,
    settingsEpoch: () => state.settingsEpoch,
    captureAuthBoundary: () => {
      const session = state.session
      const authEpoch = state.authEpoch
      return () => state.authorized && state.session === session && state.authEpoch === authEpoch
    }
  }
  const captureScope = () =>
    createImportJobsSnapshotScopeGuard(
      event as unknown as IpcMainInvokeEvent,
      window as unknown as BrowserWindow,
      readers
    )
  return { state, event, window, readers, captureScope }
}

describe('import jobs IPC snapshot boundary', () => {
  it('returns the complete empty contract while signed out', async () => {
    const readSnapshot = async () => {
      throw new Error('must not read jobs while signed out')
    }
    await expect(
      readImportJobsSnapshot(
        () => false,
        () => null,
        readSnapshot,
        () => view
      )
    ).resolves.toEqual(emptyImportJobsSnapshot())
  })

  it('keeps the legacy export closed while persistence is unconfigured', async () => {
    const { captureScope } = fixture()
    const result = await readImportJobsSnapshot(
      () => true,
      captureScope,
      async () => completeSnapshot,
      () => view
    )
    expect(result).toEqual({
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
    expect(result.capabilityState).toBe('unavailable')
    expect(result.persistenceState).toBe('unconfigured')
  })

  it('projects a sanitized queue view with its stable position', () => {
    const queuedJob = {
      ...job,
      title: 'Meeting',
      state: 'queued',
      cursor: 2,
      totalChunks: 4,
      progressPct: 50,
      createdAt: 2,
      updatedAt: 3
    } as ImportJob
    const olderJob = { ...queuedJob, jobId: 'job-older', createdAt: 1 } as ImportJob
    const result = createImportJobView(() => [queuedJob, olderJob])(queuedJob)
    expect(result).toMatchObject({ jobId: 'job-a', pct: 50, queuePosition: 2 })
    expect(result).not.toHaveProperty('sourcePath')
  })

  it('drops a held snapshot after logout/login ABA with the same profile and email', async () => {
    const pending = deferred<ImportJobsSnapshot>()
    const { state, captureScope } = fixture()
    const request = readImportJobsSnapshot(
      () => state.authorized,
      captureScope,
      () => pending.promise,
      () => view
    )

    state.session = { email: 'user@example.test' }
    state.authEpoch += 1
    state.session = { email: 'user@example.test' }
    state.authEpoch += 1
    pending.resolve(completeSnapshot)

    await expect(request).resolves.toEqual(emptyImportJobsSnapshot())
  })

  it('uses the real auth session epoch boundary without creating a speech-provider lease', () => {
    const state = {
      session: { email: 'user@example.test', domain: 'example.test', tid: 'tenant-a', at: 1 },
      epoch: 4,
      profile: '/profile/a',
      authorized: true
    }
    const controller = new SpeechAuthLeaseController({
      prepareSession: () => {},
      readSession: () => state.session,
      readSessionEpoch: () => state.epoch,
      readProfilePath: () => state.profile,
      readBoundary: async () => null,
      validateSession: () => {},
      sessionIsValid: () => true
    })
    const current = controller.captureSessionBoundary(() => state.authorized)
    expect(current()).toBe(true)
    state.session = { ...state.session }
    state.epoch += 1
    expect(current()).toBe(false)
  })

  it('drops a held snapshot after the sender navigates to another document', async () => {
    const pending = deferred<ImportJobsSnapshot>()
    const { state, captureScope } = fixture()
    const request = readImportJobsSnapshot(
      () => true,
      captureScope,
      () => pending.promise,
      () => view
    )

    state.url = 'app://metis/other-document.html'
    pending.resolve(completeSnapshot)

    await expect(request).resolves.toEqual(emptyImportJobsSnapshot())
  })

  it('drops a held snapshot after a same-URL document reload', async () => {
    const pending = deferred<ImportJobsSnapshot>()
    const { state, captureScope } = fixture()
    const request = readImportJobsSnapshot(
      () => true,
      captureScope,
      () => pending.promise,
      () => view
    )

    state.documentEpoch += 1
    pending.resolve(completeSnapshot)

    await expect(request).resolves.toEqual(emptyImportJobsSnapshot())
  })

  it('advances document identity only for committed main-frame navigation attempts', () => {
    let listener: (...args: unknown[]) => void = () => {}
    let invalidations = 0
    const webContents = {
      on: (_event: string, callback: (...args: unknown[]) => void) => {
        listener = callback
      }
    }
    const readEpoch = trackMainDocument(
      webContents as never,
      () => true,
      () => {
        invalidations += 1
      }
    )
    const nav = (isInPlace: boolean, isMainFrame: boolean) =>
      listener({}, 'app://metis/index.html', isInPlace, isMainFrame)

    expect(readEpoch()).toBe(0)
    nav(true, true)
    nav(false, false)
    expect(readEpoch()).toBe(0)
    nav(false, true)
    expect(readEpoch()).toBe(1)
    expect(invalidations).toBe(1)
  })

  it('rejects profile-root and settings-epoch changes captured before the await', async () => {
    const { state, captureScope } = fixture()
    const profileGuard = captureScope()!
    state.profile = '/profile/b'
    expect(profileGuard()).toBe(false)

    state.profile = '/profile/a'
    const settingsGuard = captureScope()!
    state.settingsEpoch += 1
    expect(settingsGuard()).toBe(false)
  })
})
