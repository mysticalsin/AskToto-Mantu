import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { actionEnvelope } from '../action-guard'

const mocks = vi.hoisted(() => {
  const adapter = {
    exec: vi.fn(async (_file: string, _args: readonly string[], _options?: { timeoutMs?: number }) => ({
      ok: true,
      stdout: '',
      stderr: '',
      timedOut: false
    })),
    spawnGui: vi.fn(async () => ({ ok: true })),
    automationStatus: vi.fn(async (): Promise<'granted' | 'denied' | 'unknown'> => 'granted'),
    accessibilityTrusted: vi.fn(() => true),
    frontmost: {
      observe: vi.fn(() => ({ ready: async () => true, matched: async () => true, cancel: vi.fn() }))
    }
  }
  return { adapter }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/isolated/asktoto-userdata' }
}))
vi.mock('../desktop-adapter-deps', () => ({
  createProductionDesktopAdapterDeps: () => mocks.adapter
}))
vi.mock('../auth', () => ({ authSessionGeneration: () => 1 }))
vi.mock('../logger', () => ({ auditLog: vi.fn(), mainLog: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('../qa-identity', () => ({ QA_IDENTITY_BUILD: false }))
vi.mock('../qa-voice-hooks', () => ({ qaDesktopSinkEnabled: vi.fn(() => false), createQaDesktopSink: vi.fn() }))
vi.mock('../secrets', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }))
vi.mock('../infra/storage/atomic-saved-write', () => ({ atomicSavedWrite: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, mkdir: vi.fn(async () => undefined), readFile: vi.fn(async () => '') }
})
vi.mock('./encrypted-task-file-store', () => ({
  createEncryptedTaskFileStore: () => ({
    read: async () => ({ kind: 'not-found' }),
    write: async () => undefined,
    quarantine: async () => undefined
  })
}))

import { createDesktopActionTaskBridge } from './desktop-action-task-runtime'

const REAL_PLATFORM = process.platform

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function dispatchContext(proposalId: string, request: DesktopActionRequest) {
  return {
    proposalId,
    owner: { webContentsId: 7, revision: 1 },
    ...actionEnvelope(proposalId, request),
    dependsOn: []
  }
}

const OWNER = 'webContents:7'

describe('production desktop-action task bridge Stop reaches adapter waits', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    vi.clearAllMocks()
    mocks.adapter.exec.mockResolvedValue({ ok: true, stdout: '', stderr: '', timedOut: false })
    mocks.adapter.automationStatus.mockResolvedValue('granted')
    mocks.adapter.accessibilityTrusted.mockReturnValue(true)
    mocks.adapter.frontmost.observe.mockReturnValue({
      ready: async () => true,
      matched: async () => true,
      cancel: vi.fn()
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  })

  it('Stop during Notes consent prevents AppleScript dispatch', async () => {
    const consent = deferred<'granted' | 'denied' | 'unknown'>()
    mocks.adapter.automationStatus.mockReturnValue(consent.promise)
    const bridge = createDesktopActionTaskBridge()
    const request: DesktopActionRequest = {
      id: 'desktop.create_note',
      args: { title: 'Synthetic title', body: 'Synthetic body' }
    }
    const run = bridge.execute(request, dispatchContext('notes-consent-stop', request))

    await vi.waitFor(() => expect(mocks.adapter.automationStatus).toHaveBeenCalledOnce())
    const card = bridge.cards(OWNER)[0]
    expect(card?.phase).toBe('running')
    expect(bridge.stopCard(OWNER, card.cardId)).toBe(true)
    consent.resolve('granted')

    const result = await run
    expect(mocks.adapter.exec).not.toHaveBeenCalled()
    expect(result.outcome).toBe('cancelled')
    expect(bridge.cards(OWNER)[0]?.phase).toBe('not_done')
  })

  it('Stop after Photo Booth launch acknowledgment prevents the shutter and keeps the outcome uncertain', async () => {
    const matched = deferred<boolean>()
    const cancelObservation = vi.fn()
    mocks.adapter.frontmost.observe.mockReturnValue({
      ready: async () => true,
      matched: () => matched.promise,
      cancel: cancelObservation
    })
    const bridge = createDesktopActionTaskBridge()
    const request: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }
    const run = bridge.execute(request, dispatchContext('photo-booth-stop', request))

    await vi.waitFor(() => expect(mocks.adapter.exec).toHaveBeenCalledOnce())
    expect(mocks.adapter.exec.mock.calls[0]?.[1]).toEqual(['-b', 'com.apple.PhotoBooth'])
    const card = bridge.cards(OWNER)[0]
    expect(bridge.stopCard(OWNER, card.cardId)).toBe(true)
    matched.resolve(true)

    const result = await run
    expect(mocks.adapter.exec).toHaveBeenCalledTimes(1)
    expect(cancelObservation).toHaveBeenCalledOnce()
    expect(result.outcome).toBe('unknown')
    expect(result.outcome).not.toBe('cancelled')
    expect(bridge.cards(OWNER)[0]?.phase).toBe('uncertain')

    await bridge.execute(request, dispatchContext('photo-booth-stop', request))
    expect(mocks.adapter.exec).toHaveBeenCalledTimes(1)
  })

  it('a healthy Notes dispatch through the production bridge preserves its verified receipt', async () => {
    mocks.adapter.exec.mockResolvedValueOnce({
      ok: true,
      stdout: 'x-coredata://6A0C1D2E-0000-4000-8000-000000000000/ICNote/p42',
      stderr: '',
      timedOut: false
    })
    const bridge = createDesktopActionTaskBridge()
    const request: DesktopActionRequest = {
      id: 'desktop.create_note',
      args: { title: 'Synthetic title', body: 'Synthetic body' }
    }

    await expect(bridge.execute(request, dispatchContext('notes-healthy', request))).resolves.toMatchObject({
      ok: true,
      outcome: 'verified'
    })
    expect(mocks.adapter.exec).toHaveBeenCalledOnce()
    expect(bridge.cards(OWNER)[0]?.phase).toBe('done')
  })

  it('a valid Notes receipt after Stop preserves verified completion of the dispatched effect', async () => {
    let finishDispatch!: (result: { ok: boolean; stdout: string; stderr: string; timedOut: boolean }) => void
    const dispatched = new Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      finishDispatch = resolve
    })
    mocks.adapter.exec.mockReturnValueOnce(dispatched)
    const bridge = createDesktopActionTaskBridge()
    const request: DesktopActionRequest = {
      id: 'desktop.create_note',
      args: { title: 'Synthetic title', body: 'Synthetic body' }
    }
    const run = bridge.execute(request, dispatchContext('notes-valid-receipt', request))

    await vi.waitFor(() => expect(mocks.adapter.exec).toHaveBeenCalledOnce())
    const card = bridge.cards(OWNER)[0]
    expect(bridge.stopCard(OWNER, card.cardId)).toBe(true)
    finishDispatch({
      ok: true,
      stdout: 'x-coredata://6A0C1D2E-0000-4000-8000-000000000000/ICNote/p42',
      stderr: '',
      timedOut: false
    })

    await expect(run).resolves.toMatchObject({ ok: true, outcome: 'verified' })
    expect(bridge.cards(OWNER)[0]?.phase).toBe('done')
  })
})
