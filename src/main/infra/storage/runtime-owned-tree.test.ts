import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  disposeRuntimeOwnedTreeReceipt,
  prepareRuntimeOwnedTreeCreation,
  prepareRuntimeOwnedTreeReopen
} from './runtime-owned-tree'
import { createRuntimeOwnedTreeRecordIssuer } from './runtime-owned-tree-record'
import type { RuntimePhysicalSnapshotInput } from './runtime-owned-files'

const roots: string[] = []
const binding = {
  purpose: 'metis-speech-pack-owner-key/v1' as const,
  schemaVersion: 2 as const,
  profileBinding: 'profile-a',
  principalBinding: 'principal-a',
  rootBinding: 'speech-pack-root-a'
}

async function fixture(): Promise<{ parent: string; root: string; parentSnapshot: RuntimePhysicalSnapshotInput }> {
  const parent = await mkdtemp(join(tmpdir(), 'runtime-owned-tree-'))
  roots.push(parent)
  const version = await lstat(parent, { bigint: true })
  const parentSnapshot: RuntimePhysicalSnapshotInput = {
    roots: [{ path: parent, identity: version }],
    nodes: [{ path: parent, version }],
    directories: [{ path: parent, version, children: await readdir(parent) }]
  }
  return { parent, root: join(parent, 'owned'), parentSnapshot }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime owned tree capabilities', () => {
  it('seals exact created membership after bounded writes and receipt-backed file promotion', async () => {
    const value = await fixture()
    const writer = await prepareRuntimeOwnedTreeCreation({
      rootPath: value.root,
      parentPath: value.parent,
      parentSnapshot: value.parentSnapshot,
      assertCurrentSync: () => undefined
    })
    try {
      await writer.createRoot()
      await writer.createDirectory('model')
      const sink = await writer.createFile('model/model.partial', 11)
      await sink.write(Buffer.from('model-bytes'))
      await sink.sync()
      const closed = await sink.close()
      expect(closed.sha256).toBe('357e5d6fafa34d27360fec24b4326d3534905e33c6acdee60198fb078b7b79e5')
      expect(closed.byteLength).toBe(11)
      const promoted = await writer.renameFile('model/model.partial', 'model/model.gguf', () => undefined)
      expect(promoted.status).toBe('moved')
      const receipt = await writer.seal()
      expect(receipt.manifest.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
        'directory:model',
        'file:model/model.gguf'
      ])
      await disposeRuntimeOwnedTreeReceipt(receipt)
    } finally {
      await writer.dispose()
    }
  })

  it('reopens only the authenticated exact member set and preserves foreign additions', async () => {
    const value = await fixture()
    const writer = await prepareRuntimeOwnedTreeCreation({
      rootPath: value.root,
      parentPath: value.parent,
      parentSnapshot: value.parentSnapshot,
      assertCurrentSync: () => undefined
    })
    const issuer = createRuntimeOwnedTreeRecordIssuer({ ...binding, rootPath: value.root })
    let receipt: Awaited<ReturnType<typeof writer.seal>> | undefined
    try {
      await writer.createRoot()
      const sink = await writer.createFile('notice.txt', 6)
      await sink.write(Buffer.from('notice'))
      await sink.close()
      receipt = await writer.seal()
    } finally {
      await writer.dispose()
    }
    if (!receipt) throw new Error('fixture seal failed')
    const record = issuer.issue({ ...binding, rootPath: value.root, manifest: receipt.manifest })
    await disposeRuntimeOwnedTreeReceipt(receipt)
    const reopened = await prepareRuntimeOwnedTreeReopen({
      rootPath: value.root,
      rootBinding: binding.rootBinding,
      profileBinding: binding.profileBinding,
      principalBinding: binding.principalBinding,
      record,
      assertCurrentSync: () => undefined
    })
    await disposeRuntimeOwnedTreeReceipt(reopened)

    await writeFile(join(value.root, 'foreign.txt'), 'preserve', { flag: 'wx' })
    await expect(
      prepareRuntimeOwnedTreeReopen({
        rootPath: value.root,
        rootBinding: binding.rootBinding,
        profileBinding: binding.profileBinding,
        principalBinding: binding.principalBinding,
        record,
        assertCurrentSync: () => undefined
      })
    ).rejects.toThrow('RUNTIME_PHYSICAL_CLOSURE_CHANGED')
    expect(await readdir(value.root)).toContain('foreign.txt')
    issuer.retire()
    await expect(
      prepareRuntimeOwnedTreeReopen({
        rootPath: value.root,
        rootBinding: binding.rootBinding,
        profileBinding: binding.profileBinding,
        principalBinding: binding.principalBinding,
        record,
        assertCurrentSync: () => undefined
      })
    ).rejects.toThrow('RUNTIME_TREE_RECORD_NOT_AUTHENTICATED')
  })
})
