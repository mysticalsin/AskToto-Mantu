import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  writeMaximum: 0,
  writeCount: 0,
  holdFirstWrite: false,
  firstWriteReached: null as (() => void) | null,
  releaseFirstWrite: null as Promise<void> | null,
  holdClose: false,
  closeReached: null as (() => void) | null,
  releaseClose: null as Promise<void> | null
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  const write = ((...args: unknown[]) => {
    const [fd, buffer, offset, length, position, callback] = args
    if (io.writeMaximum <= 0 || typeof buffer === 'string' || typeof callback !== 'function') {
      return Reflect.apply(original.write, undefined, args)
    }
    io.writeCount += 1
    const actualLength = Math.min(Number(length), io.writeMaximum)
    const perform = () =>
      Reflect.apply(original.write, undefined, [fd, buffer, Number(offset), actualLength, Number(position), callback])
    if (io.holdFirstWrite && io.writeCount === 1) {
      io.firstWriteReached?.()
      const release = io.releaseFirstWrite
      if (!release) throw new Error('R1_FIXTURE_RELEASE_MISSING')
      void release.then(perform)
      return
    }
    return perform()
  }) as typeof original.write
  const close = ((fd: number, callback?: (error: NodeJS.ErrnoException | null) => void) => {
    if (!io.holdClose || !callback) return original.close(fd, callback)
    io.closeReached?.()
    const release = io.releaseClose
    if (!release) throw new Error('R2_FIXTURE_RELEASE_MISSING')
    void release.then(() => original.close(fd, callback))
    return
  }) as typeof original.close
  return { ...original, write, close }
})

import {
  createRuntimeExclusiveFileAfterAdmission,
  prepareRuntimeExclusiveFileCreation,
  type RuntimePhysicalSnapshotInput
} from './runtime-owned-files'
import { prepareRuntimeOwnedTreeCreation } from './runtime-owned-tree'
import {
  createRuntimePayloadPlanIssuer,
  issueRuntimePayloadFilePin,
  runtimePayloadPlanParentGraph
} from './runtime-payload-plan'
import { captureRuntimeProfileParentPin, disposeRuntimeProfileParentPin } from './runtime-purpose-root'
import {
  captureRuntimePackNamespace,
  disposeRuntimePackNamespace,
  disposeRuntimeTreeParentPin,
  prepareRuntimeTreeParent
} from './runtime-pack-namespace'
import type { RuntimePayloadWritePlan } from './runtime-payload-plan'

const roots: string[] = []

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(): void {
      if (!resolvePromise) throw new Error('CONTROL_DEFERRED_NOT_READY')
      resolvePromise()
    }
  }
}

async function fixture(): Promise<{ readonly parent: string; readonly packRoot: string }> {
  const rawParent = await mkdtemp(join(tmpdir(), 'runtime-owned-transfer-red-'))
  roots.push(rawParent)
  const original = await lstat(rawParent, { bigint: true })
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('RUNTIME_TRANSFER_FIXTURE_PARENT_INVALID')
  const parent = await realpath(rawParent)
  const canonical = await lstat(parent, { bigint: true })
  if (
    !canonical.isDirectory() ||
    canonical.isSymbolicLink() ||
    canonical.dev !== original.dev ||
    canonical.ino !== original.ino ||
    canonical.birthtimeNs !== original.birthtimeNs
  ) {
    throw new Error('RUNTIME_TRANSFER_FIXTURE_PARENT_CHANGED')
  }
  return { parent, packRoot: join(parent, 'speech-packs') }
}

async function createWriter(
  value: { readonly parent: string; readonly packRoot: string },
  plan: RuntimePayloadWritePlan,
  assertCurrentSync: () => void
) {
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
    const writer = await prepareRuntimeOwnedTreeCreation({ parentPin, plan, assertCurrentSync })
    return { writer, parentPin, namespace, profile }
  } catch (error) {
    if (parentPin) await disposeRuntimeTreeParentPin(parentPin).catch(() => undefined)
    if (namespace) await disposeRuntimePackNamespace(namespace).catch(() => undefined)
    if (profile) await disposeRuntimeProfileParentPin(profile).catch(() => undefined)
    throw error
  }
}

function planFor(payload: Buffer): RuntimePayloadWritePlan {
  const issuer = createRuntimePayloadPlanIssuer()
  return issuer.issue({
    componentId: 'red-control',
    componentVersion: 'v1',
    manifestIdentity: 'c'.repeat(64),
    resourcePolicyIdentity: 'red-control-policy',
    rootRelativePath: 'owned',
    files: [
      {
        relativePath: 'payload.bin',
        byteLength: payload.byteLength,
        sha256: createHash('sha256').update(payload).digest('hex')
      }
    ],
    admittedMaximumBytes: payload.byteLength,
    admittedMaximumFiles: 1,
    admittedMaximumPathBytes: 128
  })
}

async function writeTreeFile(
  payload: Buffer,
  retireAction?: () => void
): Promise<{
  readonly writer: Awaited<ReturnType<typeof createWriter>>['writer']
  readonly sink: Awaited<ReturnType<Awaited<ReturnType<typeof createWriter>>['writer']['createFile']>>
  readonly owned: Awaited<ReturnType<typeof createWriter>>
  readonly filePath: string
}> {
  const value = await fixture()
  const plan = planFor(payload)
  const owned = await createWriter(value, plan, () => {
    if (retireAction) retireAction()
  })
  await owned.writer.createRoot()
  const sink = await owned.writer.createFile(issueRuntimePayloadFilePin(plan, 'payload.bin'))
  return { writer: owned.writer, sink, owned, filePath: join(value.packRoot, 'owned', 'payload.bin.partial') }
}

type WriterFixture = Awaited<ReturnType<typeof createWriter>>
type TreeSink = Awaited<ReturnType<WriterFixture['writer']['createFile']>>

async function disposeWriter(owned: Awaited<ReturnType<typeof createWriter>>): Promise<void> {
  await owned.writer.dispose()
  await disposeRuntimeTreeParentPin(owned.parentPin)
  await disposeRuntimePackNamespace(owned.namespace)
  await disposeRuntimeProfileParentPin(owned.profile)
}

afterEach(async () => {
  io.writeMaximum = 0
  io.writeCount = 0
  io.holdFirstWrite = false
  io.firstWriteReached = null
  io.releaseFirstWrite = null
  io.holdClose = false
  io.closeReached = null
  io.releaseClose = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime owned transfer old API causal controls', () => {
  it('runtime owned transfer fences each actual short write when the original action retires', async () => {
    const payload = Buffer.from('retire-between-real-short-writes')
    let actionCurrent = true
    const held = deferred()
    const release = deferred()
    io.firstWriteReached = held.resolve
    io.releaseFirstWrite = release.promise
    const transfer = await writeTreeFile(payload, () => {
      if (!actionCurrent) throw new Error('R1_ACTION_ALREADY_RETIRED')
    })
    io.writeMaximum = 4
    io.holdFirstWrite = true
    let writeSettled = false
    const writing = transfer.sink.write(payload).finally(() => {
      writeSettled = true
    })
    try {
      await held.promise
      actionCurrent = false
      release.resolve()
      await writing.catch(() => undefined)
      expect(
        io.writeCount,
        'R1_CAUSAL_WRITE_FENCE: action retirement must stop before the next actual short-write syscall'
      ).toBe(1)
    } finally {
      release.resolve()
      await writing.catch(() => undefined)
      expect(writeSettled).toBe(true)
      await disposeWriter(transfer.owned)
    }
  })

  it('runtime owned transfer accounts for delegated short writes while the action stays current', async () => {
    const payload = Buffer.from('positive-short-write-control-payload')
    const transfer = await writeTreeFile(payload)
    io.writeMaximum = 3
    try {
      await transfer.sink.write(payload)
      expect(io.writeCount).toBeGreaterThanOrEqual(3)
      const receipt = await transfer.sink.close()
      expect(receipt.byteLength).toBe(payload.byteLength)
      expect(receipt.sha256).toBe(createHash('sha256').update(payload).digest('hex'))
      expect(await readFile(transfer.filePath)).toEqual(payload)
    } finally {
      await disposeWriter(transfer.owned)
    }
  })

  it('runtime owned transfer joins raw exclusive closes until the actual close settles', async () => {
    const value = await fixture()
    const parentPath = join(value.parent, 'raw-parent')
    await mkdir(parentPath)
    const parentVersion = await lstat(parentPath, { bigint: true })
    const snapshot: RuntimePhysicalSnapshotInput = {
      roots: [{ path: parentPath, identity: parentVersion }],
      nodes: [{ path: parentPath, version: parentVersion }],
      directories: [{ path: parentPath, version: parentVersion, children: [] }]
    }
    const path = join(parentPath, 'raw.partial')
    const admission = await prepareRuntimeExclusiveFileCreation({ path, parentPath, snapshot })
    const creation = await createRuntimeExclusiveFileAfterAdmission(admission, 0, () => undefined)
    const closeReached = deferred()
    const release = deferred()
    io.holdClose = true
    io.closeReached = closeReached.resolve
    io.releaseClose = release.promise
    let firstSettled = false
    let secondSettled = false
    const first = creation.sink.close().finally(() => {
      firstSettled = true
    })
    let second: ReturnType<typeof creation.sink.close> | undefined
    try {
      await closeReached.promise
      second = creation.sink.close().finally(() => {
        secondSettled = true
      })
      await Promise.resolve()
      expect(
        { firstSettled, secondSettled },
        'R2_CAUSAL_CLOSE_JOIN: every raw close observer must remain pending until the actual FD close callback'
      ).toEqual({ firstSettled: false, secondSettled: false })
    } finally {
      release.resolve()
      io.holdClose = false
      await first.catch(() => undefined)
      if (second) await second.catch(() => undefined)
    }
  })

  it('runtime owned transfer resolves raw close observers from the same actual close', async () => {
    const value = await fixture()
    const parentPath = join(value.parent, 'raw-parent-positive')
    await mkdir(parentPath)
    const parentVersion = await lstat(parentPath, { bigint: true })
    const snapshot: RuntimePhysicalSnapshotInput = {
      roots: [{ path: parentPath, identity: parentVersion }],
      nodes: [{ path: parentPath, version: parentVersion }],
      directories: [{ path: parentPath, version: parentVersion, children: [] }]
    }
    const path = join(parentPath, 'raw.partial')
    const admission = await prepareRuntimeExclusiveFileCreation({ path, parentPath, snapshot })
    const creation = await createRuntimeExclusiveFileAfterAdmission(admission, 0, () => undefined)
    const closeReached = deferred()
    const release = deferred()
    io.holdClose = true
    io.closeReached = closeReached.resolve
    io.releaseClose = release.promise
    const first = creation.sink.close()
    let secondSettled = false
    try {
      await closeReached.promise
      const second = creation.sink.close().finally(() => {
        secondSettled = true
      })
      await Promise.resolve()
      release.resolve()
      const [firstReceipt, secondReceipt] = await Promise.all([first, second])
      expect(secondSettled).toBe(true)
      expect(secondReceipt).toEqual(firstReceipt)
      expect(firstReceipt.status).toBe('created')
    } finally {
      release.resolve()
      io.holdClose = false
      await first.catch(() => undefined)
    }
  })
})
