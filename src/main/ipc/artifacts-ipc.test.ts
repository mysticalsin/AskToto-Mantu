import { describe, expect, it, vi } from 'vitest'
import { ARTIFACT_IPC } from '@shared/artifact'
import type { ArtifactService } from '../features/artifacts/service'
import { registerArtifactsIpc } from './artifacts-ipc'

function setup(opts: { signedIn?: boolean; mainWindow?: boolean } = {}) {
  const handlers = new Map<string, (...a: never[]) => unknown>()
  const listeners = new Map<string, (...a: never[]) => unknown>()
  const service = {
    forTurn: vi.fn(async (turnId: string) => ({ manifest: { turnId, artifactIds: [] }, chips: [] })),
    open: vi.fn(async () => ({ ok: true }) as const),
    reveal: vi.fn(async () => ({ ok: true }) as const),
    arm: vi.fn(async () => ({ ok: true }) as const),
    dragStart: vi.fn((_id: string, begin: (i: { file: string }) => void) => {
      begin({ file: '/recorded/file.md' })
      return { ok: true } as const
    })
  } satisfies ArtifactService
  const assertMainWindow = vi.fn(() => {
    if (opts.mainWindow === false) throw new Error('not main window')
  })
  registerArtifactsIpc({
    ipcMain: {
      handle: (c: string, h: never) => void handlers.set(c, h),
      on: (c: string, h: never) => void listeners.set(c, h)
    } as never,
    assertMainWindow,
    requireAuth: () => opts.signedIn !== false,
    service,
    dragIcon: () => 'icon'
  })
  const startDrag = vi.fn()
  const event = { sender: { startDrag } } as never
  return { handlers, listeners, service, startDrag, event, assertMainWindow }
}

describe('artifacts IPC', () => {
  it('lists, opens and reveals by id behind the main-window gate', async () => {
    const { handlers, service, event } = setup()
    await (handlers.get(ARTIFACT_IPC.forTurn) as (...a: unknown[]) => Promise<unknown>)(event, { turnId: 't1' })
    expect(service.forTurn).toHaveBeenCalledWith('t1')
    await (handlers.get(ARTIFACT_IPC.open) as (...a: unknown[]) => Promise<unknown>)(event, { artifactId: 'a1' })
    await (handlers.get(ARTIFACT_IPC.reveal) as (...a: unknown[]) => Promise<unknown>)(event, { artifactId: 'a1' })
    expect(service.open).toHaveBeenCalledWith('a1')
    expect(service.reveal).toHaveBeenCalledWith('a1')
    await (handlers.get(ARTIFACT_IPC.arm) as (...a: unknown[]) => Promise<unknown>)(event, { artifactId: 'a1' })
    expect(service.arm).toHaveBeenCalledWith('a1')
  })

  it('rejects a payload carrying a path, extra fields or the wrong shape', async () => {
    const { handlers, service, event } = setup()
    const open = handlers.get(ARTIFACT_IPC.open) as (...a: unknown[]) => Promise<unknown>
    expect(await open(event, { artifactId: 'a1', path: '/etc/passwd' })).toEqual({ ok: false, reason: 'invalid' })
    expect(await open(event, '/etc/passwd')).toEqual({ ok: false, reason: 'invalid' })
    expect(await open(event, { artifactId: '' })).toEqual({ ok: false, reason: 'invalid' })
    expect(service.open).not.toHaveBeenCalled()
  })

  it('does nothing while signed out', async () => {
    const { handlers, listeners, service, startDrag, event } = setup({ signedIn: false })
    expect(
      await (handlers.get(ARTIFACT_IPC.open) as (...a: unknown[]) => Promise<unknown>)(event, { artifactId: 'a' })
    ).toEqual({
      ok: false,
      reason: 'signed-out'
    })
    ;(listeners.get(ARTIFACT_IPC.dragStart) as (...a: unknown[]) => void)(event, { artifactId: 'a' })
    expect(service.open).not.toHaveBeenCalled()
    expect(service.dragStart).not.toHaveBeenCalled()
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('calls webContents.startDrag with the recorded file only, never anything the renderer sent', () => {
    const { listeners, startDrag, event, service } = setup()
    ;(listeners.get(ARTIFACT_IPC.dragStart) as (...a: unknown[]) => void)(event, { artifactId: 'a1' })
    expect(service.dragStart).toHaveBeenCalledWith('a1', expect.any(Function))
    expect(startDrag).toHaveBeenCalledExactlyOnceWith({ file: '/recorded/file.md', icon: 'icon' })
    startDrag.mockClear()
    ;(listeners.get(ARTIFACT_IPC.dragStart) as (...a: unknown[]) => void)(event, {
      artifactId: 'a1',
      file: '/etc/passwd'
    })
    ;(listeners.get(ARTIFACT_IPC.dragStart) as (...a: unknown[]) => void)(event, '/etc/passwd')
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('ignores a drag from a sender that is not the main window', () => {
    const { listeners, startDrag, event, service } = setup({ mainWindow: false })
    ;(listeners.get(ARTIFACT_IPC.dragStart) as (...a: unknown[]) => void)(event, { artifactId: 'a1' })
    expect(service.dragStart).not.toHaveBeenCalled()
    expect(startDrag).not.toHaveBeenCalled()
  })
})
