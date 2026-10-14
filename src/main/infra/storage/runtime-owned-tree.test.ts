import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  disposeRuntimeOwnedTreeReceipt,
  prepareRuntimeOwnedTreeCreation,
  prepareRuntimeOwnedTreeReopen
} from './runtime-owned-tree'
import { createRuntimeOwnedTreeRecordIssuer } from './runtime-owned-tree-record'
import {
  createRuntimePayloadPlanIssuer,
  issueRuntimePayloadFilePin,
  type RuntimePayloadWritePlan
} from './runtime-payload-plan'
import { captureRuntimeProfileParentPin, disposeRuntimeProfileParentPin } from './runtime-purpose-root'
import {
  captureRuntimePackNamespace,
  disposeRuntimePackNamespace,
  disposeRuntimeTreeParentPin,
  prepareRuntimeTreeParent
} from './runtime-pack-namespace'

const roots: string[] = []
const binding = {
  purpose: 'metis-speech-pack-owner-key/v1' as const,
  schemaVersion: 2 as const,
  profileBinding: 'profile-a',
  principalBinding: 'principal-a',
  rootBinding: 'speech-pack-root-a'
}

async function fixture(): Promise<{ parent: string; packRoot: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'runtime-owned-tree-'))
  roots.push(parent)
  return { parent, packRoot: join(parent, 'speech-packs') }
}

async function createWriter(value: { parent: string; packRoot: string }, plan: RuntimePayloadWritePlan) {
  const profile = await captureRuntimeProfileParentPin({
    profilePath: value.parent,
    binding: { profileBinding: 'profile-test', principalBinding: 'principal-test', persistentProfileGeneration: '1' },
    assertCurrentSync: () => undefined,
    assertProfilePhysicalCurrent: async () => undefined,
    assertSingleInstanceCurrentSync: () => undefined
  })
  const namespace = await captureRuntimePackNamespace({
    profile,
    mainPackRootPath: value.packRoot,
    mode: 'create-explicit'
  })
  const parentPin = await prepareRuntimeTreeParent({ namespace, relativeParent: '', plan })
  const writer = await prepareRuntimeOwnedTreeCreation({ parentPin, plan, assertCurrentSync: () => undefined })
  return { writer, parentPin, namespace, profile }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime owned tree capabilities', () => {
  it('seals exact created membership after bounded writes and receipt-backed file promotion', async () => {
    const value = await fixture()
    const planIssuer = createRuntimePayloadPlanIssuer()
    const plan = planIssuer.issue({
      componentId: 'test-component',
      componentVersion: 'v1',
      manifestIdentity: 'a'.repeat(64),
      resourcePolicyIdentity: 'test-policy',
      rootRelativePath: 'owned',
      files: [
        {
          relativePath: 'model/model.gguf',
          byteLength: 11,
          sha256: '357e5d6fafa34d27360fec24b4326d3534905e33c6acdee60198fb078b7b79e5'
        }
      ],
      admittedMaximumBytes: 11,
      admittedMaximumFiles: 1,
      admittedMaximumPathBytes: 128
    })
    const owned = await createWriter(value, plan)
    const writer = owned.writer
    try {
      await writer.createRoot()
      await writer.createDirectory('model')
      const sink = await writer.createFile(issueRuntimePayloadFilePin(plan, 'model/model.gguf'))
      await sink.write(Buffer.from('model-bytes'))
      await sink.sync()
      const closed = await sink.close()
      expect(closed.sha256).toBe('357e5d6fafa34d27360fec24b4326d3534905e33c6acdee60198fb078b7b79e5')
      expect(closed.byteLength).toBe(11)
      const promoted = await writer.renameFile('model/model.gguf.partial', 'model/model.gguf', () => undefined)
      expect(promoted.status).toBe('moved')
      const receipt = await writer.seal()
      expect(receipt.manifest.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
        'directory:model',
        'file:model/model.gguf'
      ])
      await disposeRuntimeOwnedTreeReceipt(receipt)
    } finally {
      await writer.dispose()
      await disposeRuntimeTreeParentPin(owned.parentPin)
      await disposeRuntimePackNamespace(owned.namespace)
      await disposeRuntimeProfileParentPin(owned.profile)
    }
  })

  it('reopens only the authenticated exact member set and preserves foreign additions', async () => {
    const value = await fixture()
    const planIssuer = createRuntimePayloadPlanIssuer()
    const plan = planIssuer.issue({
      componentId: 'test-component',
      componentVersion: 'v1',
      manifestIdentity: 'b'.repeat(64),
      resourcePolicyIdentity: 'test-policy',
      rootRelativePath: 'owned',
      files: [
        {
          relativePath: 'notice.txt',
          byteLength: 6,
          sha256: '9368a7d21e018f64ae3327d2f25cd4d7693b2d85328e4bb680bcfcbd4c26b90e'
        }
      ],
      admittedMaximumBytes: 6,
      admittedMaximumFiles: 1,
      admittedMaximumPathBytes: 128
    })
    const owned = await createWriter(value, plan)
    const writer = owned.writer
    const issuer = createRuntimeOwnedTreeRecordIssuer({ ...binding, rootPath: join(value.packRoot, 'owned') })
    let receipt: Awaited<ReturnType<typeof writer.seal>> | undefined
    try {
      await writer.createRoot()
      const sink = await writer.createFile(issueRuntimePayloadFilePin(plan, 'notice.txt'))
      await sink.write(Buffer.from('notice'))
      await sink.close()
      await writer.renameFile('notice.txt.partial', 'notice.txt', () => undefined)
      receipt = await writer.seal()
    } finally {
      await writer.dispose()
    }
    if (!receipt) throw new Error('fixture seal failed')
    const record = issuer.issue({ ...binding, rootPath: join(value.packRoot, 'owned'), manifest: receipt.manifest })
    await disposeRuntimeOwnedTreeReceipt(receipt)
    const reopened = await prepareRuntimeOwnedTreeReopen({
      rootPath: join(value.packRoot, 'owned'),
      rootBinding: binding.rootBinding,
      profileBinding: binding.profileBinding,
      principalBinding: binding.principalBinding,
      record,
      assertCurrentSync: () => undefined
    })
    await disposeRuntimeOwnedTreeReceipt(reopened)
    await disposeRuntimeTreeParentPin(owned.parentPin)
    await disposeRuntimePackNamespace(owned.namespace)
    await disposeRuntimeProfileParentPin(owned.profile)

    const ownedRoot = join(value.packRoot, 'owned')
    await writeFile(join(ownedRoot, 'foreign.txt'), 'preserve', { flag: 'wx' })
    await expect(
      prepareRuntimeOwnedTreeReopen({
        rootPath: ownedRoot,
        rootBinding: binding.rootBinding,
        profileBinding: binding.profileBinding,
        principalBinding: binding.principalBinding,
        record,
        assertCurrentSync: () => undefined
      })
    ).rejects.toThrow('RUNTIME_PHYSICAL_CLOSURE_CHANGED')
    expect(await readdir(ownedRoot)).toContain('foreign.txt')
    issuer.retire()
    await expect(
      prepareRuntimeOwnedTreeReopen({
        rootPath: ownedRoot,
        rootBinding: binding.rootBinding,
        profileBinding: binding.profileBinding,
        principalBinding: binding.principalBinding,
        record,
        assertCurrentSync: () => undefined
      })
    ).rejects.toThrow('RUNTIME_TREE_RECORD_NOT_AUTHENTICATED')
  })
})
