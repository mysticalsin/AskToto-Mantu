import { createHash } from 'node:crypto'
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
  PARAKEET_TDT_V3_INT8,
  WHISPER_BASE_Q8,
  componentBytes,
  type SpeechPackComponent
} from '../../features/components/speech-pack/manifest'
import {
  createRuntimePayloadPlanIssuer,
  issueRuntimePayloadFilePin,
  runtimePayloadPlanBudget,
  runtimePayloadPlanParentGraph,
  runtimePayloadPlanRoot,
  type RuntimePayloadWritePlan
} from './runtime-payload-plan'
import { componentManifestIdentity } from '../../features/components/speech-pack/resolver'
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
  let profile: Awaited<ReturnType<typeof captureRuntimeProfileParentPin>> | undefined
  let namespace: Awaited<ReturnType<typeof captureRuntimePackNamespace>> | undefined
  let parentPin: Awaited<ReturnType<typeof prepareRuntimeTreeParent>> | undefined
  try {
    profile = await captureRuntimeProfileParentPin({
      profilePath: value.parent,
      binding: { profileBinding: 'profile-test', principalBinding: 'principal-test', persistentProfileGeneration: '1' },
      assertCurrentSync: () => undefined,
      assertProfilePhysicalCurrent: async () => undefined,
      assertSingleInstanceCurrentSync: () => undefined
    })
    namespace = await captureRuntimePackNamespace({
      profile,
      mainPackRootPath: value.packRoot,
      mode: 'create-explicit'
    })
    parentPin = await prepareRuntimeTreeParent({
      namespace,
      relativeParent: runtimePayloadPlanParentGraph(plan).parentRelativePath,
      plan
    })
    const writer = await prepareRuntimeOwnedTreeCreation({ parentPin, plan, assertCurrentSync: () => undefined })
    return { writer, parentPin, namespace, profile }
  } catch (error) {
    if (parentPin) await disposeRuntimeTreeParentPin(parentPin).catch(() => undefined)
    if (namespace) await disposeRuntimePackNamespace(namespace).catch(() => undefined)
    if (profile) await disposeRuntimeProfileParentPin(profile).catch(() => undefined)
    throw error
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime owned tree capabilities', () => {
  it.each([
    ['compiled Whisper staging', WHISPER_BASE_Q8, `.staging/${WHISPER_BASE_Q8.id}/${WHISPER_BASE_Q8.version}`],
    [
      'compiled Parakeet staging',
      PARAKEET_TDT_V3_INT8,
      `.staging/${PARAKEET_TDT_V3_INT8.id}/${PARAKEET_TDT_V3_INT8.version}`
    ],
    ['compiled Parakeet active', PARAKEET_TDT_V3_INT8, `${PARAKEET_TDT_V3_INT8.id}/${PARAKEET_TDT_V3_INT8.version}`]
  ])('creates the exact nested tree for %s', async (_name, component, rootRelativePath) => {
    await expect(createNestedCatalogTree(component, rootRelativePath)).resolves.toBe(rootRelativePath)
  })

  it('creates a nested archive work tree for a test-only pinned fixture', async () => {
    const issuer = createRuntimePayloadPlanIssuer()
    const component = PARAKEET_TDT_V3_INT8
    const plan = issuer.issue({
      componentId: component.id,
      componentVersion: component.version,
      manifestIdentity: 'd'.repeat(64),
      resourcePolicyIdentity: 'test-resource-policy-id',
      rootRelativePath: `.staging/${component.id}/work`,
      files: [
        {
          relativePath: 'archive.download',
          byteLength: 9,
          sha256: 'aec070645fe53ee3b376305b6216cf2c4a74bb378fe7e3dd76541a2fbf7ae167'
        }
      ],
      admittedMaximumBytes: 9,
      admittedMaximumFiles: 1,
      admittedMaximumPathBytes: 256
    })
    const value = await fixture()
    const owned = await createWriter(value, plan)
    try {
      expect(runtimePayloadPlanParentGraph(plan)).toMatchObject({
        lane: 'work',
        rootRelativePath: `.staging/${component.id}/work`
      })
      await owned.writer.createRoot()
      expect(runtimePayloadPlanRoot(plan)).toBe(`.staging/${component.id}/work`)
    } finally {
      await owned.writer.dispose()
      await disposeRuntimeTreeParentPin(owned.parentPin)
      await disposeRuntimePackNamespace(owned.namespace)
      await disposeRuntimeProfileParentPin(owned.profile)
      issuer.retire()
    }
  })

  it('issues compiled Whisper staging and active plans at the exact unique-ancestor main budget', () => {
    expect(() => issueCompiledCatalogPlans(WHISPER_BASE_Q8)).not.toThrow()
  })

  it('issues compiled Parakeet staging and active plans at the exact unique-ancestor main budget', () => {
    expect(() => issueCompiledCatalogPlans(PARAKEET_TDT_V3_INT8)).not.toThrow()
  })

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
    ).rejects.toThrow(/^(?:RUNTIME_TREE_ROOT_CHANGED|RUNTIME_PHYSICAL_CLOSURE_CHANGED)$/)
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

async function createNestedCatalogTree(component: SpeechPackComponent, rootRelativePath: string): Promise<string> {
  const issuer = createRuntimePayloadPlanIssuer()
  const plan = issuer.issue({
    componentId: component.id,
    componentVersion: component.version,
    manifestIdentity: 'e'.repeat(64),
    resourcePolicyIdentity: 'test-resource-policy-id',
    rootRelativePath,
    files: component.files.map((file) => ({
      relativePath: file.path,
      byteLength: file.bytes,
      sha256: file.sha256
    })),
    admittedMaximumBytes: component.files.reduce((sum, file) => sum + file.bytes, 0),
    admittedMaximumFiles: component.files.length,
    admittedMaximumPathBytes: 16_384
  })
  const value = await fixture()
  const owned = await createWriter(value, plan)
  try {
    await owned.writer.createRoot()
    expect(runtimePayloadPlanRoot(plan)).toBe(rootRelativePath)
    return rootRelativePath
  } finally {
    await owned.writer.dispose()
    await disposeRuntimeTreeParentPin(owned.parentPin)
    await disposeRuntimePackNamespace(owned.namespace)
    await disposeRuntimeProfileParentPin(owned.profile)
    issuer.retire()
  }
}

function issueCompiledCatalogPlans(component: SpeechPackComponent): void {
  const issuer = createRuntimePayloadPlanIssuer()
  const manifestIdentity = componentManifestIdentity(component)
  const resourcePolicyIdentity = createHash('sha256')
    .update('metis-speech-pack-resource-policy/v1\0')
    .update('test-resource-policy-id')
    .digest('hex')
  const files = component.files.map((file) => ({
    relativePath: file.path,
    byteLength: file.bytes,
    sha256: file.sha256
  }))
  const shared = {
    componentId: component.id,
    componentVersion: component.version,
    manifestIdentity,
    resourcePolicyIdentity,
    files,
    admittedMaximumBytes: componentBytes(component),
    admittedMaximumFiles: files.length,
    admittedMaximumPathBytes: uniqueAncestorPathBytes(`.staging/${component.id}/${component.version}`, component.files)
  }
  const staging = issuer.issue({
    ...shared,
    rootRelativePath: `.staging/${component.id}/${component.version}`
  })
  const active = issuer.issue({
    ...shared,
    rootRelativePath: `${component.id}/${component.version}`,
    admittedMaximumPathBytes: uniqueAncestorPathBytes(`${component.id}/${component.version}`, component.files)
  })
  expect(runtimePayloadPlanBudget(staging).maximumPathBytes).toBe(shared.admittedMaximumPathBytes)
  expect(runtimePayloadPlanBudget(active).maximumPathBytes).toBe(
    uniqueAncestorPathBytes(`${component.id}/${component.version}`, component.files)
  )
  issuer.retire()
}

function uniqueAncestorPathBytes(root: string, files: readonly { readonly path: string }[]): number {
  let total = Buffer.byteLength(root)
  const ancestors = new Set<string>()
  for (const { path } of files) {
    total += Buffer.byteLength(path)
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) ancestors.add(parts.slice(0, index).join('/'))
  }
  for (const ancestor of ancestors) total += Buffer.byteLength(ancestor)
  return total
}
