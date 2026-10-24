import { describe, expect, it } from 'vitest'
import { CONTEXT_IPC } from '@shared/context-manifest'
import { createContextGrants } from './wiring'
import { testOpen, testSeal } from './__fixtures__/context-grants-fixtures'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('context grants wiring', () => {
  it('an owner change revokes everything and deletes the sealed files; stop does the same through revokeAll', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-g46-wire-'))
    try {
      let owner: string | null = 'p-a'
      let notify: () => void = () => undefined
      const handlers = new Map<string, (e: unknown, raw?: unknown) => unknown>()
      const ctx = createContextGrants({
        ipcMain: { handle: (c, fn) => void handlers.set(c, fn as never) },
        assertMainWindow: () => undefined,
        requireAuth: () => true,
        root,
        owner: () => owner,
        generation: () => 0,
        sessionId: () => 's',
        seal: testSeal,
        open: testOpen,
        observe: async () => ({
          sourceId: 'display:1',
          observationId: 'o',
          generation: 0,
          capturedAt: 1,
          text: 'synthetic text',
          app: null
        }),
        onOwnerChange: (l) => {
          notify = l
          return () => undefined
        }
      })
      const r = (await handlers.get(CONTEXT_IPC.snapshotRequest)?.(
        {},
        { gesture: 'capture-button', kind: 'screen' }
      )) as { ok: boolean; snapshot: { snapshotId: string } }
      expect(r.ok).toBe(true)
      ctx.grants.grant({ snapshotId: r.snapshot.snapshotId, gesture: 'capture-button' })
      expect((await readdir(root)).length).toBe(1)
      owner = 'p-b'
      notify()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(ctx.grants.active()).toEqual([])
      expect(ctx.store.list()).toEqual([])
      expect(await readdir(root)).toEqual([])
      owner = 'p-a'
      const again = (await handlers.get(CONTEXT_IPC.snapshotRequest)?.(
        {},
        { gesture: 'capture-button', kind: 'screen' }
      )) as { ok: boolean }
      expect(again.ok).toBe(true)
      await ctx.revokeAll('stop')
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers the attachment channels and revokeAll empties held attachments (G54)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-g54-wire-'))
    try {
      const handlers = new Map<string, (e: unknown, raw?: unknown) => unknown>()
      const ctx = createContextGrants({
        ipcMain: { handle: (c, fn) => void handlers.set(c, fn as never) },
        assertMainWindow: () => undefined,
        requireAuth: () => true,
        root,
        owner: () => 'p-a',
        generation: () => 0,
        sessionId: () => 's',
        seal: testSeal,
        open: testOpen,
        observe: async () => {
          throw new Error('no capture')
        },
        onOwnerChange: () => () => undefined,
        attachmentSources: { pickFiles: async () => [join(root, 'p.txt')], readClipboard: async () => null }
      })
      expect([...handlers.keys()]).toEqual(
        expect.arrayContaining(['attachments:add', 'attachments:remove', 'attachments:list'])
      )
      await writeFile(join(root, 'p.txt'), 'picked')
      const r = (await handlers.get('attachments:add')?.({}, { source: 'picker', conversationKey: 'c' })) as {
        attachments: unknown[]
      }
      expect(r.attachments).toHaveLength(1)
      expect(ctx.attachments.list('c')).toHaveLength(1)
      await ctx.revokeAll('stop')
      expect(ctx.attachments.list('c')).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
