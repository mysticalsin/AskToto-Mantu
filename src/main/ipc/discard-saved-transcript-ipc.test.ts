import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC, type Settings } from '@shared/ipc'
import {
  type DiscardSavedTranscriptIpcDependencies,
  registerDiscardSavedTranscriptIpc
} from './discard-saved-transcript-ipc'

type Handler = (
  event: IpcMainInvokeEvent,
  raw: unknown
) => Promise<{ ok: boolean; error?: string; deletedPaths?: string[] }>

let folder: string
const settings = { profile: { name: 'Work' } } as unknown as Settings

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'discard-ipc-'))
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

function setup(overrides: Partial<DiscardSavedTranscriptIpcDependencies> = {}) {
  const handlers = new Map<string, Handler>()
  const durable: { path: string; settings: Settings }[] = []
  const receipts = {
    sealMeetingAndJoin: vi.fn(async () => {}),
    durablePathsForMeeting: vi.fn(() => [...durable]),
    markMeetingDiscarded: vi.fn(),
    markDurablePathDiscarded: vi.fn(),
    releaseMeetingSeal: vi.fn()
  }
  const releaseFence = vi.fn()
  const deps: DiscardSavedTranscriptIpcDependencies = {
    ipcMain: {
      handle: (channel: string, handler: unknown) => {
        handlers.set(channel, handler as Handler)
      }
    } as unknown as Pick<IpcMain, 'handle'>,
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    captureAuthSessionBoundary: () => () => true,
    authSessionGeneration: () => 7,
    receipts,
    getSettings: () => settings,
    resolveMeetingsFolder: () => folder,
    safeMeetingBasename: (file: unknown) =>
      typeof file === 'string' && file.endsWith('.md') ? (file.split(/[\\/]/).pop() ?? null) : null,
    recallRead: vi.fn(async () => ({ ok: true, startedAt: 100 }) as never),
    acquireGraphBuildFence: vi.fn(async () => releaseFence),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    deleteMeetingAtPath: vi.fn(async () => ({ ok: true })),
    auditLog: vi.fn() as never,
    publishMeetingCard: vi.fn(async () => {}) as never,
    warn: vi.fn(),
    exciseDeletedMeeting: vi.fn(async () => ({ gone: true })),
    requestSourceRefresh: vi.fn(async () => {}),
    ...overrides
  }
  registerDiscardSavedTranscriptIpc(deps)
  const handler = handlers.get(IPC.discardSavedTranscript)
  if (!handler) throw new Error('discardSavedTranscript handler was not registered')
  return { handler, deps, receipts, durable, releaseFence }
}

const event = {} as IpcMainInvokeEvent

describe('discard saved transcript IPC', () => {
  it('refuses without auth before touching receipts', async () => {
    const { handler, receipts } = setup({ requireAuth: () => false })
    await expect(handler(event, { startedAt: 100 })).resolves.toEqual({
      ok: false,
      error: 'Sign in with your Mantu account first.'
    })
    expect(receipts.sealMeetingAndJoin).not.toHaveBeenCalled()
  })

  it('rejects a malformed payload', async () => {
    const { handler, receipts } = setup()
    await expect(handler(event, { startedAt: 100, extra: true })).resolves.toEqual({
      ok: false,
      error: 'Could not verify this meeting.'
    })
    expect(receipts.sealMeetingAndJoin).not.toHaveBeenCalled()
  })

  it('marks a meeting with no durable files discarded without asking', async () => {
    const { handler, deps, receipts } = setup()
    await expect(handler(event, { startedAt: 100 })).resolves.toEqual({ ok: true, deletedPaths: [] })
    expect(receipts.markMeetingDiscarded).toHaveBeenCalledWith(100, 7)
    expect(deps.showMessageBox).not.toHaveBeenCalled()
    expect(receipts.releaseMeetingSeal).toHaveBeenCalledWith(100, 7)
  })

  it('deletes receipt-owned files after confirmation and releases the seal and fence', async () => {
    const { handler, deps, receipts, durable, releaseFence } = setup()
    const path = join(folder, 'a.md')
    durable.push({ path, settings })
    await expect(handler(event, { startedAt: 100, title: 'Standup' })).resolves.toEqual({
      ok: true,
      deletedPaths: [path]
    })
    expect(deps.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete "Standup"?' }))
    expect(receipts.markMeetingDiscarded).toHaveBeenCalledWith(100, 7)
    expect(deps.deleteMeetingAtPath).toHaveBeenCalledWith(settings, path)
    expect(receipts.markDurablePathDiscarded).toHaveBeenCalledWith(path, 7)
    expect(deps.exciseDeletedMeeting).toHaveBeenCalledWith(settings, 'a.md')
    expect(releaseFence).toHaveBeenCalledOnce()
    expect(receipts.releaseMeetingSeal).toHaveBeenCalledWith(100, 7)
  })

  it('keeps files when the confirmation is cancelled', async () => {
    const { handler, deps, receipts, durable } = setup({
      showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false }))
    })
    durable.push({ path: join(folder, 'a.md'), settings })
    await expect(handler(event, { startedAt: 100 })).resolves.toEqual({
      ok: false,
      error: 'cancelled',
      deletedPaths: []
    })
    expect(deps.deleteMeetingAtPath).not.toHaveBeenCalled()
    expect(receipts.markMeetingDiscarded).not.toHaveBeenCalled()
  })

  it('recovers an evicted receipt only when the existing saved file proves this meeting identity', async () => {
    const path = join(folder, 'evicted.md')
    writeFileSync(path, 'saved')
    const { handler, deps } = setup()
    await expect(handler(event, { startedAt: 100, path })).resolves.toEqual({
      ok: true,
      deletedPaths: [resolve(path)]
    })
    expect(deps.recallRead).toHaveBeenCalledWith('evicted.md')
    expect(deps.deleteMeetingAtPath).toHaveBeenCalledWith(settings, resolve(path))
  })

  it('refuses an existing saved file whose identity belongs to another meeting', async () => {
    const path = join(folder, 'other.md')
    writeFileSync(path, 'saved')
    const { handler, deps } = setup({ recallRead: vi.fn(async () => ({ ok: true, startedAt: 999 }) as never) })
    await expect(handler(event, { startedAt: 100, path })).resolves.toEqual({
      ok: false,
      error: 'The saved transcript could not be verified. Try Disregard again.',
      deletedPaths: []
    })
    expect(deps.deleteMeetingAtPath).not.toHaveBeenCalled()
  })

  it('refuses an existing file outside the current meetings folder without reading it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'discard-ipc-outside-'))
    try {
      const path = join(outside, 'elsewhere.md')
      writeFileSync(path, 'saved')
      const { handler, deps } = setup()
      await expect(handler(event, { startedAt: 100, path })).resolves.toEqual({
        ok: false,
        error: 'The saved transcript could not be verified. Try Disregard again.',
        deletedPaths: []
      })
      expect(deps.recallRead).not.toHaveBeenCalled()
      expect(deps.deleteMeetingAtPath).not.toHaveBeenCalled()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('treats a missing evicted file as nothing left to delete', async () => {
    const { handler, deps, receipts } = setup()
    await expect(handler(event, { startedAt: 100, path: join(folder, 'gone.md') })).resolves.toEqual({
      ok: true,
      deletedPaths: []
    })
    expect(deps.recallRead).not.toHaveBeenCalled()
    expect(receipts.markMeetingDiscarded).toHaveBeenCalledWith(100, 7)
  })

  it('stops before deletion when sign-in changes after confirmation', async () => {
    let current = true
    const { handler, deps, durable } = setup({
      captureAuthSessionBoundary: () => () => current,
      showMessageBox: vi.fn(async () => {
        current = false
        return { response: 0, checkboxChecked: false }
      })
    })
    durable.push({ path: join(folder, 'a.md'), settings })
    await expect(handler(event, { startedAt: 100 })).resolves.toEqual({
      ok: false,
      error: 'Sign-in changed before deletion.',
      deletedPaths: []
    })
    expect(deps.deleteMeetingAtPath).not.toHaveBeenCalled()
  })
})
