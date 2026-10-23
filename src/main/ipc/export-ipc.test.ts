import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { registerExportIpc } from './export-ipc'
import { appendReceipt } from '../features/export/export-receipts'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<Record<string, unknown>>
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'export-ipc-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const event = {} as IpcMainInvokeEvent
const receipt = {
  exportId: 'r1',
  kind: 'recap-pdf' as const,
  destination: '/exported/a.pdf',
  bytes: 1,
  sha256: 'b'.repeat(64),
  writtenAt: '2026-10-23T12:00:00.000Z',
  conflictResolution: 'none' as const
}

function setup(auth = true) {
  const handlers = new Map<string, Handler>()
  const openPath = vi.fn(async (_p: string) => '')
  const showItemInFolder = vi.fn()
  const exportDirectory = vi.fn(async (_r: unknown) => ({ ok: true as const, receipt, receiptLogged: true }))
  const audit = vi.fn()
  const assertMainWindow = vi.fn()
  registerExportIpc({
    ipcMain: { handle: (c: string, h: unknown) => handlers.set(c, h as Handler) } as unknown as Pick<IpcMain, 'handle'>,
    assertMainWindow,
    requireAuth: () => auth,
    exporter: { exportFile: vi.fn(), exportDirectory } as never,
    receiptLogPath: () => join(dir, 'log.jsonl'),
    downloadsPath: () => dir,
    userDataPath: () => dir,
    appInfo: () => ({ version: '1', platform: 'linux', arch: 'x64', packaged: false }),
    openPath,
    showItemInFolder,
    audit
  })
  return { handlers, openPath, showItemInFolder, exportDirectory, audit, assertMainWindow }
}

describe('export reveal', () => {
  it('opens or reveals the destination named by the receipt, never a renderer path', async () => {
    await appendReceipt(join(dir, 'log.jsonl'), receipt)
    const s = setup()
    const h = s.handlers.get(IPC.exportReveal)!
    expect(await h(event, { exportId: 'r1', action: 'reveal' })).toEqual({ ok: true })
    expect(s.showItemInFolder).toHaveBeenCalledWith('/exported/a.pdf')
    expect(await h(event, { exportId: 'r1', action: 'open' })).toEqual({ ok: true })
    expect(s.openPath).toHaveBeenCalledWith('/exported/a.pdf')
    expect(s.assertMainWindow).toHaveBeenCalledTimes(2)
  })
  it('refuses unknown ids, bad payloads and signed-out callers', async () => {
    const s = setup()
    const h = s.handlers.get(IPC.exportReveal)!
    expect(await h(event, { exportId: 'nope', action: 'open' })).toMatchObject({ ok: false })
    expect(await h(event, { exportId: 'r1', action: 'delete' })).toMatchObject({ ok: false })
    expect(await h(event, { path: '/etc/passwd', action: 'open' })).toMatchObject({ ok: false })
    expect(s.openPath).not.toHaveBeenCalled()
    const out = setup(false)
    expect(await out.handlers.get(IPC.exportReveal)!(event, { exportId: 'r1', action: 'open' })).toMatchObject({
      ok: false
    })
  })
})

describe('diagnostics export', () => {
  it('collects the bundle, exports it as a directory through the service and audits counts only', async () => {
    await writeFile(join(dir, 'crash-1.log'), 'dump')
    const s = setup()
    const out = await s.handlers.get(IPC.diagnosticsExport)!(event)
    expect(out).toMatchObject({ ok: true, path: '/exported/a.pdf', files: 1, receipt })
    const request = s.exportDirectory.mock.calls[0][0] as { kind: string; entries: { name: string }[] }
    expect(request.kind).toBe('diagnostics-bundle')
    expect(request.entries.map((e) => e.name)).toEqual(['crash-1.log', 'MANIFEST.txt'])
    expect(s.audit).toHaveBeenCalledWith('diagnostics.export', { files: 1 })
  })
})
