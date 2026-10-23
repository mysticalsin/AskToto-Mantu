import { describe, expect, it, vi } from 'vitest'
import { CONTEXT_IPC } from '@shared/context-manifest'
import { registerContextIpc } from './context-grants-ipc'
import { createDocumentGrants } from '../features/context-grants/document-grants'
import { createManifestLog } from '../features/context-grants/manifest'
import { createSnapshotStore } from '../features/context-grants/snapshot-store'
import { memoryIo, testOpen, testSeal, type Env } from '../features/context-grants/__fixtures__/context-grants-fixtures'

function setup(opts: { authed?: boolean } = {}) {
  const env: Env = { owner: 'owner-a', generation: 0, session: 's1', now: 1_000 }
  const handlers = new Map<string, (event: unknown, raw?: unknown) => unknown>()
  const store = createSnapshotStore({
    io: memoryIo(),
    seal: testSeal,
    open: testOpen,
    owner: () => env.owner,
    generation: () => env.generation,
    now: () => env.now
  })
  const grants = createDocumentGrants({
    store,
    owner: () => env.owner,
    generation: () => env.generation,
    sessionId: () => env.session,
    now: () => env.now
  })
  const manifests = createManifestLog({ owner: () => env.owner, now: () => env.now })
  const observe = vi.fn(async () => ({
    sourceId: 'display:1',
    observationId: 'obs-1',
    generation: 0,
    capturedAt: 1_000,
    text: 'Synthetic page text',
    app: 'Synthetic App'
  }))
  const assertMainWindow = vi.fn((event: unknown) => {
    if ((event as { bad?: boolean }).bad) throw new Error('not main window')
  })
  registerContextIpc({
    ipcMain: { handle: (channel, fn) => void handlers.set(channel, fn as never) },
    assertMainWindow: assertMainWindow as never,
    requireAuth: () => opts.authed !== false,
    store,
    grants,
    manifests,
    observe
  })
  const call = (channel: string, raw?: unknown, event: unknown = {}) => handlers.get(channel)?.(event, raw)
  return { handlers, call, observe, assertMainWindow, store, grants, manifests }
}

describe('context IPC', () => {
  it('registers every channel behind assertMainWindow', async () => {
    const { handlers, call, assertMainWindow } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(CONTEXT_IPC).sort())
    for (const channel of handlers.keys()) {
      await expect(async () => call(channel, {}, { bad: true })).rejects.toThrow('not main window')
    }
    expect(assertMainWindow).toHaveBeenCalled()
  })

  it('a snapshot is taken only on the explicit request, with its gesture', async () => {
    const { call, observe } = setup()
    expect(observe).not.toHaveBeenCalled()
    const result = (await call(CONTEXT_IPC.snapshotRequest, {
      gesture: 'hold-to-talk-screen-intent',
      kind: 'screen'
    })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith('screen')
  })

  it('rejects unknown gestures and extra fields without capturing', async () => {
    const { call, observe } = setup()
    expect(await call(CONTEXT_IPC.snapshotRequest, { gesture: 'ambient', kind: 'screen' })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await call(CONTEXT_IPC.snapshotRequest, { gesture: 'capture-button', kind: 'screen', extra: 1 })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(observe).not.toHaveBeenCalled()
  })

  it('refuses everything while signed out', async () => {
    const { call, observe } = setup({ authed: false })
    expect(await call(CONTEXT_IPC.snapshotRequest, { gesture: 'capture-button', kind: 'screen' })).toEqual({
      ok: false,
      reason: 'signed-out'
    })
    expect(await call(CONTEXT_IPC.grantDocument, { snapshotId: 'x', gesture: 'capture-button' })).toEqual({
      ok: false,
      reason: 'signed-out'
    })
    expect(await call(CONTEXT_IPC.turnManifest, { turnId: 't' })).toBeNull()
    expect(observe).not.toHaveBeenCalled()
  })

  it('grants, lists without text, revokes and deletes', async () => {
    const { call } = setup()
    const snap = (await call(CONTEXT_IPC.snapshotRequest, { gesture: 'capture-button', kind: 'document' })) as {
      ok: true
      snapshot: { snapshotId: string }
    }
    const granted = (await call(CONTEXT_IPC.grantDocument, {
      snapshotId: snap.snapshot.snapshotId,
      gesture: 'capture-button'
    })) as { ok: true; grantId: string }
    expect(granted.ok).toBe(true)
    const held = (await call(CONTEXT_IPC.held)) as { snapshots: Array<{ granted: boolean }>; grants: unknown[] }
    expect(held.snapshots[0].granted).toBe(true)
    expect(JSON.stringify(held)).not.toContain('Synthetic page text')
    expect(await call(CONTEXT_IPC.revokeGrant, { grantId: granted.grantId })).toEqual({ ok: true })
    // ending a grant deletes the document it covered
    expect(((await call(CONTEXT_IPC.held)) as { snapshots: unknown[] }).snapshots).toEqual([])
    const second = (await call(CONTEXT_IPC.snapshotRequest, { gesture: 'capture-button', kind: 'screen' })) as {
      ok: true
      snapshot: { snapshotId: string }
    }
    expect(await call(CONTEXT_IPC.snapshotDelete, { snapshotId: second.snapshot.snapshotId })).toEqual({ ok: true })
    expect(await call(CONTEXT_IPC.snapshotDelete, { snapshotId: second.snapshot.snapshotId })).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('serves the stored manifest for a turn and null for an unknown one', async () => {
    const { call, manifests } = setup()
    manifests.record('t1', [
      { origin: 'user-typed', authority: 'instruction', sourceId: 'prompt', bytes: 2, via: 'ask' }
    ])
    expect(await call(CONTEXT_IPC.turnManifest, { turnId: 't1' })).toMatchObject({ turnId: 't1' })
    expect(await call(CONTEXT_IPC.turnManifest, { turnId: 'nope' })).toBeNull()
    expect(await call(CONTEXT_IPC.turnManifest, { nope: 1 })).toBeNull()
  })
})
