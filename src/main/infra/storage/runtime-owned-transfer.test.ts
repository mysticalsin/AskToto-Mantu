import { createHash } from 'node:crypto'
import { closeSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance as nodePerformance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  writeMaximum: 0,
  writeCount: 0,
  writeZero: false,
  openCount: 0,
  exclusiveFds: [] as number[],
  rawCloseCalls: [] as number[],
  rawCloseAcknowledgements: [] as number[],
  closeAcknowledged: null as ((fd: number) => void) | null,
  holdFirstWrite: false,
  firstWriteReached: null as (() => void) | null,
  releaseFirstWrite: null as Promise<void> | null,
  holdClose: false,
  closeError: false,
  syncCount: 0,
  holdSync: false,
  syncReached: null as (() => void) | null,
  releaseSync: null as Promise<void> | null,
  failFinalStat: false,
  closeReached: null as ((fd: number) => void) | null,
  releaseClose: null as Promise<void> | null,
  holdCreatePreparation: false,
  createPreparationReached: null as (() => void) | null,
  releaseCreatePreparation: null as Promise<void> | null,
  holdAfterExclusiveOpen: false,
  exclusiveOpenReached: null as (() => void) | null,
  releaseAfterExclusiveOpen: null as Promise<void> | null,
  holdPhysicalClose: false,
  physicalRenameCommitted: false,
  physicalCloseReached: null as (() => void) | null,
  releasePhysicalClose: null as Promise<void> | null
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  const write = ((...args: unknown[]) => {
    const [fd, buffer, offset, length, position, callback] = args
    if (io.writeMaximum <= 0 || typeof buffer === 'string' || typeof callback !== 'function') {
      return Reflect.apply(original.write, undefined, args)
    }
    io.writeCount += 1
    if (io.writeZero) {
      queueMicrotask(() => callback(null, 0))
      return
    }
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
    const ownedExclusive = io.exclusiveFds.includes(fd)
    if (ownedExclusive) io.rawCloseCalls.push(fd)
    if (io.closeError && callback) {
      original.close(fd, () => callback(Object.assign(new Error('R2_CLOSE_FAILED'), { code: 'EIO' })))
      return
    }
    const observedCallback =
      callback &&
      function (this: unknown, error: NodeJS.ErrnoException | null) {
        if (!error && ownedExclusive) {
          io.rawCloseAcknowledgements.push(fd)
          io.closeAcknowledged?.(fd)
        }
        callback.call(this, error)
      }
    if (!io.holdClose || !callback) return original.close(fd, observedCallback)
    io.closeReached?.(fd)
    const release = io.releaseClose
    if (!release) throw new Error('R2_FIXTURE_RELEASE_MISSING')
    void release.then(() => original.close(fd, observedCallback))
    return
  }) as typeof original.close
  const fsync = ((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
    io.syncCount++
    if (!io.holdSync) return original.fsync(fd, callback)
    io.syncReached?.()
    const release = io.releaseSync
    if (!release) throw new Error('R14_SYNC_RELEASE_MISSING')
    void release.then(() => original.fsync(fd, callback))
  }) as typeof original.fsync
  const openSync = ((path: string, flags: number, mode?: number) => {
    const fd = original.openSync(path, flags, mode)
    if (path.endsWith('.partial') && flags & original.constants.O_EXCL) {
      io.openCount++
      io.exclusiveFds.push(fd)
    }
    return fd
  }) as typeof original.openSync
  const renameSync = ((source: string, destination: string) => {
    original.renameSync(source, destination)
    if (io.holdPhysicalClose && source.endsWith('payload.bin.partial')) io.physicalRenameCommitted = true
  }) as typeof original.renameSync
  return { ...original, write, close, openSync, fsync, renameSync }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const lstat: typeof original.lstat = ((path: Parameters<typeof original.lstat>[0], options?: unknown) => {
    if (io.failFinalStat && String(path).endsWith('payload.bin'))
      return Promise.reject(new Error('R14_POST_MOVE_STAT_HELD'))
    return original.lstat(path, options as never)
  }) as typeof original.lstat
  const open: typeof original.open = (async (...args: Parameters<typeof original.open>) => {
    const handle = await original.open(...args)
    if (io.holdPhysicalClose && String(args[0]).endsWith('payload.bin.partial')) {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        if (io.holdPhysicalClose && io.physicalRenameCommitted) {
          io.physicalCloseReached?.()
          const release = io.releasePhysicalClose
          if (!release) throw new Error('R14_PHYSICAL_CLOSE_RELEASE_MISSING')
          await release
        }
        await close()
      }
    }
    return handle
  }) as typeof original.open
  return { ...original, lstat, open }
})

vi.mock('./runtime-owned-files', async (importOriginal) => {
  const original = await importOriginal<typeof import('./runtime-owned-files')>()
  return {
    ...original,
    prepareRuntimeExclusiveFileCreation: async (
      input: Parameters<typeof original.prepareRuntimeExclusiveFileCreation>[0]
    ) => {
      if (io.holdCreatePreparation) {
        io.createPreparationReached?.()
        const release = io.releaseCreatePreparation
        if (!release) throw new Error('R11_CREATE_PREPARATION_RELEASE_MISSING')
        await release
      }
      return original.prepareRuntimeExclusiveFileCreation(input)
    },
    createRuntimeExclusiveFileAfterAdmission: async (
      ...args: Parameters<typeof original.createRuntimeExclusiveFileAfterAdmission>
    ) => {
      const created = await original.createRuntimeExclusiveFileAfterAdmission(...args)
      if (io.holdAfterExclusiveOpen) {
        io.exclusiveOpenReached?.()
        const release = io.releaseAfterExclusiveOpen
        if (!release) throw new Error('R11_EXCLUSIVE_OPEN_RELEASE_MISSING')
        await release
      }
      return created
    }
  }
})

import { beginRuntimeOwnedTreeDownload, prepareRuntimeOwnedTreeCreation } from './runtime-owned-tree'
import {
  createRuntimePayloadPlanIssuer,
  issueRuntimePayloadFilePin,
  runtimePayloadPlanParentGraph
} from './runtime-payload-plan'
import { captureRuntimeProfileParentPin, disposeRuntimeProfileParentPin } from './runtime-purpose-root'
import {
  appendRuntimeOwnedTransfer,
  discardRuntimeOwnedTransfer,
  finishRuntimeOwnedTransfer,
  restartRuntimeOwnedTransfer,
  resumeRuntimeOwnedTransfer,
  runtimeOwnedTransferProgress,
  stopRuntimeOwnedTransfer,
  suspendRuntimeOwnedTransfer,
  type RuntimeOwnedTransferAction,
  type RuntimeOwnedTransferBounds,
  type RuntimeOwnedTransferSuspension
} from './runtime-owned-transfer'
import {
  captureRuntimePackNamespace,
  disposeRuntimePackNamespace,
  disposeRuntimeTreeParentPin,
  prepareRuntimeTreeParent
} from './runtime-pack-namespace'
import type { RuntimePayloadWritePlan } from './runtime-payload-plan'
import type { RuntimePayloadPlanIssuer } from './runtime-payload-plan'
import {
  createRuntimeExclusiveFileAfterAdmission,
  prepareRuntimeExclusiveFileCreation,
  type RuntimePhysicalSnapshotInput
} from './runtime-owned-files'

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

async function waitForDiagnosticGate(promise: Promise<void>, name: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CONTROL_GATE_NOT_REACHED:${name}`)), 10_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function forceCloseLeakedDiagnosticFds(fds: readonly number[]): void {
  // Only the known-fault creation/disposal diagnostic invokes this after recording an orphan.
  // It is fixture teardown, never an ownership acknowledgement in the assertion.
  for (const fd of fds) {
    try {
      closeSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error
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

function planFor(
  payload: Buffer,
  secondPayload?: Buffer,
  nested = false,
  issuer: RuntimePayloadPlanIssuer = createRuntimePayloadPlanIssuer()
): RuntimePayloadWritePlan {
  return issuer.issue({
    componentId: 'red-control',
    componentVersion: 'v1',
    manifestIdentity: 'c'.repeat(64),
    resourcePolicyIdentity: 'red-control-policy',
    rootRelativePath: 'owned',
    files: [
      {
        relativePath: nested ? 'nested/payload.bin' : 'payload.bin',
        byteLength: payload.byteLength,
        sha256: createHash('sha256').update(payload).digest('hex')
      },
      ...(secondPayload
        ? [
            {
              relativePath: 'second.bin',
              byteLength: secondPayload.byteLength,
              sha256: createHash('sha256').update(secondPayload).digest('hex')
            }
          ]
        : [])
    ],
    admittedMaximumBytes: payload.byteLength + (secondPayload?.byteLength ?? 0),
    admittedMaximumFiles: secondPayload ? 2 : 1,
    admittedMaximumPathBytes: 128
  })
}

function transferBounds(): RuntimeOwnedTransferBounds {
  return {
    maximumChunkBytes: 64 * 1024,
    maximumRequests: 8,
    maximumRestarts: 3,
    maximumHandovers: 2,
    pausedRetentionMs: 30_000
  }
}

function transferAction(
  assertCurrentSync: () => void = () => undefined,
  identity: object = {},
  transaction = Symbol('transfer-test')
): RuntimeOwnedTransferAction {
  return Object.freeze({ identity, transaction, assertCurrentSync })
}

async function beginTransfer(
  payload: Buffer,
  action = transferAction(),
  rootAssert: () => void = () => undefined,
  secondPayload?: Buffer,
  nested = false,
  issuer?: RuntimePayloadPlanIssuer
) {
  const value = await fixture()
  const plan = planFor(payload, secondPayload, nested, issuer)
  const owned = await createWriter(value, plan, rootAssert)
  await owned.writer.createRoot()
  if (nested) await owned.writer.createDirectory('nested')
  const start = await beginRuntimeOwnedTreeDownload({
    writer: owned.writer,
    pin: issueRuntimePayloadFilePin(plan, nested ? 'nested/payload.bin' : 'payload.bin'),
    action,
    bounds: transferBounds(),
    assertCleanupCurrentSync: () => undefined
  })
  return {
    ...owned,
    plan,
    start,
    action,
    partialPath: join(value.packRoot, 'owned', nested ? 'nested' : '', 'payload.bin.partial'),
    finalPath: join(value.packRoot, 'owned', nested ? 'nested' : '', 'payload.bin')
  }
}

async function legacyFile(payload: Buffer, assertCurrentSync: () => void = () => undefined) {
  const value = await fixture()
  const plan = planFor(payload)
  const owned = await createWriter(value, plan, assertCurrentSync)
  await owned.writer.createRoot()
  const sink = await owned.writer.createFile(issueRuntimePayloadFilePin(plan, 'payload.bin'))
  return { ...owned, sink, partialPath: join(value.packRoot, 'owned', 'payload.bin.partial') }
}

async function rawExclusive() {
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
  return createRuntimeExclusiveFileAfterAdmission(admission, 0, () => undefined)
}

async function disposeWriter(
  owned: Awaited<ReturnType<typeof createWriter>> | Awaited<ReturnType<typeof beginTransfer>>
): Promise<void> {
  if ('start' in owned && runtimeOwnedTransferProgress(owned.start.target).state !== 'verified') {
    try {
      await discardRuntimeOwnedTransfer(owned.start.target, owned.start.cleanup).settled
    } catch {
      /* preserve pending owner */
    }
  }
  await owned.writer.dispose()
  await disposeRuntimeTreeParentPin(owned.parentPin)
  await disposeRuntimePackNamespace(owned.namespace)
  await disposeRuntimeProfileParentPin(owned.profile)
}

afterEach(async () => {
  io.writeMaximum = 0
  io.writeCount = 0
  io.writeZero = false
  io.openCount = 0
  io.exclusiveFds.length = 0
  io.rawCloseCalls.length = 0
  io.rawCloseAcknowledgements.length = 0
  io.closeAcknowledged = null
  io.holdFirstWrite = false
  io.firstWriteReached = null
  io.releaseFirstWrite = null
  io.holdClose = false
  io.closeError = false
  io.syncCount = 0
  io.holdSync = false
  io.syncReached = null
  io.releaseSync = null
  io.failFinalStat = false
  io.closeReached = null
  io.releaseClose = null
  io.holdCreatePreparation = false
  io.createPreparationReached = null
  io.releaseCreatePreparation = null
  io.holdAfterExclusiveOpen = false
  io.exclusiveOpenReached = null
  io.releaseAfterExclusiveOpen = null
  io.holdPhysicalClose = false
  io.physicalRenameCommitted = false
  io.physicalCloseReached = null
  io.releasePhysicalClose = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime owned transfer', () => {
  it('writes and seals a real nested pinned file through its owned target', async () => {
    const payload = Buffer.from('real-owned-transfer-content')
    const transfer = await beginTransfer(payload, undefined, undefined, undefined, true)
    try {
      await appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload)
      const verified = await finishRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)
      expect(verified).toBeDefined()
      const receipt = await transfer.writer.seal()
      expect(receipt.manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)).toEqual([
        'nested/payload.bin'
      ])
      expect(await readFile(transfer.finalPath)).toEqual(payload)
      await expect(lstat(transfer.partialPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await disposeWriter(transfer)
    }
  })

  it('accounts for real short writes without duplicated or missing bytes', async () => {
    const payload = Buffer.from('short-write-acknowledged-bytes')
    const transfer = await beginTransfer(payload)
    io.writeMaximum = 3
    try {
      await appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload)
      expect(io.writeCount).toBeGreaterThanOrEqual(3)
      expect(runtimeOwnedTransferProgress(transfer.start.target).bytes).toBe(payload.byteLength)
      await finishRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)
      expect(await readFile(transfer.finalPath)).toEqual(payload)
      const legacy = await legacyFile(payload)
      try {
        await legacy.sink.write(payload)
        await legacy.sink.sync()
        await legacy.sink.close()
        expect(await readFile(legacy.partialPath)).toEqual(payload)
      } finally {
        await disposeWriter(legacy)
      }
    } finally {
      await disposeWriter(transfer)
    }
  })

  it('rejects zero write progress and retains uncertain ownership', async () => {
    const payload = Buffer.from('zero-progress')
    const transfer = await beginTransfer(payload)
    io.writeZero = true
    io.writeMaximum = 3
    try {
      await expect(appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload)).rejects.toThrow(
        'RUNTIME_EXCLUSIVE_FILE_ZERO_PROGRESS'
      )
      expect(runtimeOwnedTransferProgress(transfer.start.target).bytes).toBe(0)
      expect(runtimeOwnedTransferProgress(transfer.start.target).state).toBe('frozen')
      expect(await readFile(transfer.partialPath)).toEqual(Buffer.alloc(0))
      expect(await lstat(transfer.finalPath).catch(() => null)).toBeNull()
    } finally {
      await disposeWriter(transfer)
    }
  })

  it('fences each actual short write when the original action retires', async () => {
    const payload = Buffer.from('retire-between-real-short-writes')
    let actionCurrent = true
    const held = deferred(),
      release = deferred()
    io.firstWriteReached = held.resolve
    io.releaseFirstWrite = release.promise
    io.writeMaximum = 4
    io.holdFirstWrite = true
    const transfer = await beginTransfer(
      payload,
      transferAction(() => {
        if (!actionCurrent) throw new Error('R1_ACTION_ALREADY_RETIRED')
      })
    )
    const writing = appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload)
    void writing.catch(() => undefined)
    try {
      await held.promise
      actionCurrent = false
      release.resolve()
      await expect(writing).rejects.toThrow('R1_ACTION_ALREADY_RETIRED')
      expect(
        io.writeCount,
        'R1_CAUSAL_WRITE_FENCE: action retirement must stop before the next actual short-write syscall'
      ).toBe(1)
      expect(runtimeOwnedTransferProgress(transfer.start.target).bytes).toBe(4)
      io.writeCount = 0
      const legacyHeld = deferred(),
        legacyRelease = deferred()
      let legacyCurrent = true
      io.firstWriteReached = legacyHeld.resolve
      io.releaseFirstWrite = legacyRelease.promise
      const legacy = await legacyFile(payload, () => {
        if (!legacyCurrent) throw new Error('R1_LEGACY_ACTION_ALREADY_RETIRED')
      })
      try {
        const legacyWriting = legacy.sink.write(payload)
        void legacyWriting.catch(() => undefined)
        await legacyHeld.promise
        legacyCurrent = false
        legacyRelease.resolve()
        await expect(legacyWriting).rejects.toThrow('R1_LEGACY_ACTION_ALREADY_RETIRED')
        expect(io.writeCount).toBe(1)
      } finally {
        legacyRelease.resolve()
        await legacy.writer.dispose().catch(() => undefined)
        await disposeRuntimeTreeParentPin(legacy.parentPin)
        await disposeRuntimePackNamespace(legacy.namespace)
        await disposeRuntimeProfileParentPin(legacy.profile)
      }
    } finally {
      release.resolve()
      await writing.catch(() => undefined)
      await disposeWriter(transfer)
    }
  })

  it('rejects oversized and concurrent appends before extra allocation or IO', async () => {
    const payload = Buffer.from('concurrent-append-check')
    const transfer = await beginTransfer(payload)
    const held = deferred(),
      release = deferred()
    io.firstWriteReached = held.resolve
    io.releaseFirstWrite = release.promise
    io.writeMaximum = 4
    io.holdFirstWrite = true
    try {
      await expect(
        appendRuntimeOwnedTransfer(
          transfer.start.target,
          transfer.start.attempt,
          Buffer.alloc(transferBounds().maximumChunkBytes + 1)
        )
      ).rejects.toThrow('RUNTIME_TRANSFER_CHUNK_LIMIT')
      const writing = appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload)
      void writing.catch(() => undefined)
      await held.promise
      await expect(
        appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, Buffer.from('extra'))
      ).rejects.toThrow('RUNTIME_TRANSFER_APPEND_IN_PROGRESS')
      expect(io.writeCount).toBe(1)
      release.resolve()
      await writing
      expect(await readFile(transfer.partialPath)).toEqual(payload)
    } finally {
      release.resolve()
      await disposeWriter(transfer)
    }
  })

  it('restarts one consumed logical pin with a fresh exclusive owner', async () => {
    const payload = Buffer.from('restart-uses-original-pin-once')
    const transfer = await beginTransfer(payload)
    const oldAttempt = transfer.start.attempt
    const oldOpens = io.openCount
    try {
      await appendRuntimeOwnedTransfer(transfer.start.target, oldAttempt, payload.subarray(0, 4))
      const nextAttempt = await restartRuntimeOwnedTransfer(transfer.start.target, oldAttempt)
      expect(io.openCount).toBe(oldOpens + 1)
      expect(() => appendRuntimeOwnedTransfer(transfer.start.target, oldAttempt, payload)).toThrow(
        'RUNTIME_TRANSFER_ATTEMPT_INVALID'
      )
      expect(() => issueRuntimePayloadFilePin(transfer.plan, 'payload.bin')).toThrow(
        'RUNTIME_PAYLOAD_FILE_PIN_UNAVAILABLE'
      )
      await appendRuntimeOwnedTransfer(transfer.start.target, nextAttempt, payload)
      await finishRuntimeOwnedTransfer(transfer.start.target, nextAttempt)
      expect(await readFile(transfer.finalPath)).toEqual(payload)
    } finally {
      await disposeWriter(transfer)
    }
  })

  it('retains a replaced prefix instead of deleting or appending to it', async () => {
    const payload = Buffer.from('prefix-owner-change')
    const transfer = await beginTransfer(payload)
    const foreign = Buffer.from('foreign replacement')
    const held = deferred(),
      release = deferred()
    try {
      await appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload.subarray(0, 4))
      io.writeCount = 0
      io.writeMaximum = 4
      io.holdFirstWrite = true
      io.firstWriteReached = held.resolve
      io.releaseFirstWrite = release.promise
      const writing = appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload.subarray(4))
      void writing.catch(() => undefined)
      await held.promise
      await rm(transfer.partialPath)
      await import('node:fs/promises').then(({ writeFile }) => writeFile(transfer.partialPath, foreign, { flag: 'wx' }))
      release.resolve()
      await expect(writing).rejects.toThrow('RUNTIME_EXCLUSIVE_FILE_OWNER_UNCONFIRMED')
      expect(await readFile(transfer.partialPath)).toEqual(foreign)
      expect(await lstat(transfer.finalPath).catch(() => null)).toBeNull()
    } finally {
      release.resolve()
      await disposeWriter(transfer)
      expect(await readFile(transfer.partialPath)).toEqual(foreign)
    }
  })

  it('suspends a verified prefix and resumes only with a settled fresh action', async () => {
    const payload = Buffer.from('explicit-owned-handover-prefix')
    const transfer = await beginTransfer(payload)
    const old = transfer.start.attempt
    try {
      await appendRuntimeOwnedTransfer(transfer.start.target, old, payload.subarray(0, 9))
      const suspended = await suspendRuntimeOwnedTransfer(transfer.start.target, old)
      expect(() => appendRuntimeOwnedTransfer(transfer.start.target, old, payload.subarray(9))).toThrow(
        'RUNTIME_TRANSFER_ATTEMPT_INVALID'
      )
      const next = await resumeRuntimeOwnedTransfer(
        transfer.start.target,
        suspended,
        transferAction(() => undefined, {}, transfer.action.transaction)
      )
      await appendRuntimeOwnedTransfer(transfer.start.target, next, payload.subarray(9))
      await finishRuntimeOwnedTransfer(transfer.start.target, next)
      expect(await readFile(transfer.finalPath)).toEqual(payload)
    } finally {
      await disposeWriter(transfer)
    }
  })

  it('rejects replayed suspended tokens and cross transaction handover', async () => {
    const payload = Buffer.from('replay-fence')
    const transaction = Symbol('txn')
    const transfer = await beginTransfer(
      payload,
      transferAction(() => undefined, {}, transaction)
    )
    try {
      const suspended = await suspendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)
      const neverIssued = Object.freeze({}) as RuntimeOwnedTransferSuspension
      await expect(
        resumeRuntimeOwnedTransfer(
          transfer.start.target,
          neverIssued,
          transferAction(() => undefined, {}, transaction)
        )
      ).rejects.toThrow('RUNTIME_TRANSFER_SUSPENSION_INVALID')
      await expect(resumeRuntimeOwnedTransfer(transfer.start.target, suspended, transferAction())).rejects.toThrow(
        'RUNTIME_TRANSFER_HANDOVER_INVALID'
      )
      const next = await resumeRuntimeOwnedTransfer(
        transfer.start.target,
        suspended,
        transferAction(() => undefined, {}, transaction)
      )
      const pausedAgain = await suspendRuntimeOwnedTransfer(transfer.start.target, next)
      await expect(
        resumeRuntimeOwnedTransfer(
          transfer.start.target,
          suspended,
          transferAction(() => undefined, {}, transaction)
        )
      ).rejects.toThrow('RUNTIME_TRANSFER_SUSPENSION_INVALID')
      const final = await resumeRuntimeOwnedTransfer(
        transfer.start.target,
        pausedAgain,
        transferAction(() => undefined, {}, transaction)
      )
      await appendRuntimeOwnedTransfer(transfer.start.target, final, payload)
      await finishRuntimeOwnedTransfer(transfer.start.target, final)
    } finally {
      await disposeWriter(transfer)
    }
  })

  it('rejects changed root custody and action ABA during resume', async () => {
    const payload = Buffer.from('root-custody')
    let rootCurrent = true
    const transfer = await beginTransfer(payload, transferAction(), () => {
      if (!rootCurrent) throw new Error('ROOT_CUSTODY_RETIRED')
    })
    try {
      const suspended = await suspendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)
      rootCurrent = false
      await expect(
        resumeRuntimeOwnedTransfer(
          transfer.start.target,
          suspended,
          transferAction(() => undefined, {}, transfer.action.transaction)
        )
      ).rejects.toThrow('RUNTIME_TRANSFER_ROOT_CUSTODY_RETIRED')
      rootCurrent = true
      await expect(
        resumeRuntimeOwnedTransfer(
          transfer.start.target,
          suspended,
          transferAction(() => undefined, {}, transfer.action.transaction)
        )
      ).rejects.toThrow('RUNTIME_TRANSFER_ROOT_CUSTODY_RETIRED')
    } finally {
      await disposeWriter(transfer)
    }
    const aba = await beginTransfer(payload)
    try {
      const first = await suspendRuntimeOwnedTransfer(aba.start.target, aba.start.attempt)
      const secondAction = transferAction(() => undefined, {}, aba.action.transaction)
      const second = await resumeRuntimeOwnedTransfer(aba.start.target, first, secondAction)
      const secondPause = await suspendRuntimeOwnedTransfer(aba.start.target, second)
      await expect(
        resumeRuntimeOwnedTransfer(
          aba.start.target,
          secondPause,
          transferAction(() => undefined, aba.action.identity, aba.action.transaction)
        )
      ).rejects.toThrow('RUNTIME_TRANSFER_HANDOVER_INVALID')
    } finally {
      await disposeWriter(aba)
    }
    const issuer = createRuntimePayloadPlanIssuer()
    const retiredPlan = await beginTransfer(payload, transferAction(), () => undefined, undefined, false, issuer)
    try {
      await appendRuntimeOwnedTransfer(retiredPlan.start.target, retiredPlan.start.attempt, payload.subarray(0, 4))
      const suspended = await suspendRuntimeOwnedTransfer(retiredPlan.start.target, retiredPlan.start.attempt)
      issuer.retire()
      const outcome = await resumeRuntimeOwnedTransfer(
        retiredPlan.start.target,
        suspended,
        transferAction(() => undefined, {}, retiredPlan.action.transaction)
      ).then(
        () => 'resumed',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      const partial = await readFile(retiredPlan.partialPath)
      expect({ outcome, partial }, 'R10_ORIGINAL_PLAN_RETIREMENT').toEqual({
        outcome: 'RUNTIME_PAYLOAD_PLAN_INVALID',
        partial: payload.subarray(0, 4)
      })
    } finally {
      await disposeWriter(retiredPlan)
    }
  })

  it('keeps cleanup pending until the actual close settles', async () => {
    const payload = Buffer.from('close-join')
    const secondPayload = Buffer.from('second')
    const transfer = await beginTransfer(payload, transferAction(), () => undefined, secondPayload)
    const closeReached = deferred(),
      release = deferred()
    io.holdClose = true
    io.closeReached = closeReached.resolve
    io.releaseClose = release.promise
    const secondPin = issueRuntimePayloadFilePin(transfer.plan, 'second.bin')
    try {
      const pending = discardRuntimeOwnedTransfer(transfer.start.target, transfer.start.cleanup)
      expect(discardRuntimeOwnedTransfer(transfer.start.target, transfer.start.cleanup).settled).toBe(pending.settled)
      await closeReached.promise
      let settled = false
      void pending.settled.finally(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      await expect(
        beginRuntimeOwnedTreeDownload({
          writer: transfer.writer,
          pin: secondPin,
          action: transferAction(() => undefined, {}, transfer.action.transaction),
          bounds: transferBounds(),
          assertCleanupCurrentSync: () => undefined
        })
      ).rejects.toThrow('RUNTIME_TREE_TRANSFER_SLOT_BUSY')
      release.resolve()
      expect(await pending.settled).toEqual({ status: 'removed' })
      const successor = await beginRuntimeOwnedTreeDownload({
        writer: transfer.writer,
        pin: secondPin,
        action: transferAction(() => undefined, {}, transfer.action.transaction),
        bounds: transferBounds(),
        assertCleanupCurrentSync: () => undefined
      })
      expect(await discardRuntimeOwnedTransfer(successor.target, successor.cleanup).settled).toEqual({
        status: 'removed'
      })
      const raw = await rawExclusive()
      const rawReached = deferred(),
        rawRelease = deferred()
      io.closeReached = rawReached.resolve
      io.releaseClose = rawRelease.promise
      const first = raw.sink.close()
      try {
        await rawReached.promise
        const second = raw.sink.close()
        let firstSettled = false,
          secondSettled = false
        void first.then(() => {
          firstSettled = true
        })
        void second.then(() => {
          secondSettled = true
        })
        await Promise.resolve()
        expect({ firstSettled, secondSettled }, 'R2_CAUSAL_CLOSE_JOIN').toEqual({
          firstSettled: false,
          secondSettled: false
        })
        rawRelease.resolve()
        const [firstReceipt, secondReceipt] = await Promise.all([first, second])
        expect(firstReceipt).toEqual(secondReceipt)
        expect(firstReceipt.status).toBe('created')
      } finally {
        rawRelease.resolve()
        await first.catch(() => undefined)
      }
    } finally {
      release.resolve()
      io.holdClose = false
      await disposeWriter(transfer)
    }
    const failed = await beginTransfer(payload, transferAction(), () => undefined, secondPayload)
    const blockedPin = issueRuntimePayloadFilePin(failed.plan, 'second.bin')
    io.closeError = true
    try {
      const pending = discardRuntimeOwnedTransfer(failed.start.target, failed.start.cleanup)
      await expect(pending.settled).rejects.toThrow('RUNTIME_TRANSFER_CLOSE_UNCONFIRMED')
      await expect(
        beginRuntimeOwnedTreeDownload({
          writer: failed.writer,
          pin: blockedPin,
          action: transferAction(() => undefined, {}, failed.action.transaction),
          bounds: transferBounds(),
          assertCleanupCurrentSync: () => undefined
        })
      ).rejects.toThrow('RUNTIME_TREE_TRANSFER_SLOT_BUSY')
      await expect(failed.writer.dispose()).rejects.toThrow('RUNTIME_TRANSFER_CLOSE_UNCONFIRMED')
    } finally {
      io.closeError = false
      await disposeRuntimeTreeParentPin(failed.parentPin)
      await disposeRuntimePackNamespace(failed.namespace)
      await disposeRuntimeProfileParentPin(failed.profile)
    }
    const creatingRoot = await fixture()
    const creatingPlan = planFor(Buffer.from('creation-disposal-race'))
    const creating = await createWriter(creatingRoot, creatingPlan, () => undefined)
    const creationReached = deferred(),
      releaseCreation = deferred()
    let creationObservation: {
      readonly begin: string
      readonly dispose: string
      readonly sameDisposePromise: boolean
      readonly held: {
        readonly beginPending: boolean
        readonly firstPending: boolean
        readonly repeatedPending: boolean
      }
      readonly newOpens: number
    } | null = null
    const returned = { start: null as Awaited<ReturnType<typeof beginRuntimeOwnedTreeDownload>> | null }
    const creatingFdIndex = io.exclusiveFds.length
    try {
      await creating.writer.createRoot()
      const priorOpens = io.openCount
      io.holdCreatePreparation = true
      io.createPreparationReached = creationReached.resolve
      io.releaseCreatePreparation = releaseCreation.promise
      const beginning = beginRuntimeOwnedTreeDownload({
        writer: creating.writer,
        pin: issueRuntimePayloadFilePin(creatingPlan, 'payload.bin'),
        action: transferAction(),
        bounds: transferBounds(),
        assertCleanupCurrentSync: () => undefined
      })
      const observedBegin = beginning.then(
        (start) => {
          returned.start = start
          return 'returned-start'
        },
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      await waitForDiagnosticGate(creationReached.promise, 'before-open')
      const disposing = creating.writer.dispose()
      const repeatedDisposing = creating.writer.dispose()
      const sameDisposePromise = disposing === repeatedDisposing
      let beginSettled = false,
        firstSettled = false,
        repeatedSettled = false
      void observedBegin.then(() => {
        beginSettled = true
      })
      void disposing.then(
        () => {
          firstSettled = true
        },
        () => {
          firstSettled = true
        }
      )
      void repeatedDisposing.then(
        () => {
          repeatedSettled = true
        },
        () => {
          repeatedSettled = true
        }
      )
      await Promise.resolve()
      const held = {
        beginPending: !beginSettled,
        firstPending: !firstSettled,
        repeatedPending: !repeatedSettled
      }
      io.holdCreatePreparation = false
      releaseCreation.resolve()
      const begin = await observedBegin
      const dispose = await disposing.then(
        () => 'settled',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      creationObservation = { begin, dispose, sameDisposePromise, held, newOpens: io.openCount - priorOpens }
    } finally {
      releaseCreation.resolve()
      io.holdCreatePreparation = false
      if (returned.start) {
        forceCloseLeakedDiagnosticFds(io.exclusiveFds.slice(creatingFdIndex))
        await discardRuntimeOwnedTransfer(returned.start.target, returned.start.cleanup).settled.catch(() => undefined)
      }
      await creating.writer.dispose().catch(() => undefined)
      await disposeRuntimeTreeParentPin(creating.parentPin)
      await disposeRuntimePackNamespace(creating.namespace)
      await disposeRuntimeProfileParentPin(creating.profile)
    }
    const openedRoot = await fixture()
    const openedPlan = planFor(Buffer.from('opened-before-attachment'))
    const opened = await createWriter(openedRoot, openedPlan, () => undefined)
    const exclusiveOpenReached = deferred(),
      releaseExclusiveOpen = deferred(),
      orphanCloseReached = deferred(),
      releaseOrphanClose = deferred(),
      orphanCloseAcknowledged = deferred()
    const openedObservation = {
      firstEvent: '',
      begin: '',
      dispose: '',
      sameDisposePromise: false,
      held: { beginPending: false, firstPending: false, repeatedPending: false, closeAcknowledged: false },
      newOpens: 0,
      rawCloseCalls: 0,
      rawCloseAcknowledgements: 0
    }
    const openedReturn = { start: null as Awaited<ReturnType<typeof beginRuntimeOwnedTreeDownload>> | null }
    const openedFdIndex = io.exclusiveFds.length
    const rawCloseCallIndex = io.rawCloseCalls.length
    const rawCloseAcknowledgementIndex = io.rawCloseAcknowledgements.length
    try {
      await opened.writer.createRoot()
      const priorOpens = io.openCount
      io.holdAfterExclusiveOpen = true
      io.exclusiveOpenReached = exclusiveOpenReached.resolve
      io.releaseAfterExclusiveOpen = releaseExclusiveOpen.promise
      io.holdClose = true
      io.closeReached = (fd) => {
        if (fd === io.exclusiveFds[openedFdIndex]) orphanCloseReached.resolve()
      }
      io.closeAcknowledged = (fd) => {
        if (fd === io.exclusiveFds[openedFdIndex]) orphanCloseAcknowledged.resolve()
      }
      io.releaseClose = releaseOrphanClose.promise
      const beginning = beginRuntimeOwnedTreeDownload({
        writer: opened.writer,
        pin: issueRuntimePayloadFilePin(openedPlan, 'payload.bin'),
        action: transferAction(),
        bounds: transferBounds(),
        assertCleanupCurrentSync: () => undefined
      })
      const observedBegin = beginning.then(
        (start) => {
          openedReturn.start = start
          return 'returned-start'
        },
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      await waitForDiagnosticGate(exclusiveOpenReached.promise, 'after-open')
      const disposing = opened.writer.dispose()
      const repeatedDisposing = opened.writer.dispose()
      openedObservation.sameDisposePromise = disposing === repeatedDisposing
      let beginSettled = false,
        firstSettled = false,
        repeatedSettled = false
      void observedBegin.then(() => {
        beginSettled = true
      })
      void disposing.then(
        () => {
          firstSettled = true
        },
        () => {
          firstSettled = true
        }
      )
      void repeatedDisposing.then(
        () => {
          repeatedSettled = true
        },
        () => {
          repeatedSettled = true
        }
      )
      io.holdAfterExclusiveOpen = false
      releaseExclusiveOpen.resolve()
      const observedDispose = disposing.then(
        () => 'settled',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      openedObservation.firstEvent = await Promise.race([
        orphanCloseReached.promise.then(() => 'close-entered'),
        observedDispose.then(() => 'disposed-before-close')
      ])
      if (openedObservation.firstEvent === 'close-entered') {
        await Promise.resolve()
        openedObservation.held = {
          beginPending: !beginSettled,
          firstPending: !firstSettled,
          repeatedPending: !repeatedSettled,
          closeAcknowledged: io.rawCloseAcknowledgements
            .slice(rawCloseAcknowledgementIndex)
            .includes(io.exclusiveFds[openedFdIndex])
        }
      }
      releaseOrphanClose.resolve()
      if (openedObservation.firstEvent === 'close-entered')
        await waitForDiagnosticGate(orphanCloseAcknowledged.promise, 'after-open-raw-close-ack')
      openedObservation.begin = await observedBegin
      openedObservation.dispose = await observedDispose
      openedObservation.newOpens = io.openCount - priorOpens
      const openedFd = io.exclusiveFds[openedFdIndex]
      openedObservation.rawCloseCalls = io.rawCloseCalls.slice(rawCloseCallIndex).filter((fd) => fd === openedFd).length
      openedObservation.rawCloseAcknowledgements = io.rawCloseAcknowledgements
        .slice(rawCloseAcknowledgementIndex)
        .filter((fd) => fd === openedFd).length
    } finally {
      releaseExclusiveOpen.resolve()
      releaseOrphanClose.resolve()
      io.holdAfterExclusiveOpen = false
      io.holdClose = false
      io.closeAcknowledged = null
      if (openedReturn.start) {
        forceCloseLeakedDiagnosticFds(io.exclusiveFds.slice(openedFdIndex))
        await discardRuntimeOwnedTransfer(openedReturn.start.target, openedReturn.start.cleanup).settled.catch(
          () => undefined
        )
      }
      await opened.writer.dispose().catch(() => undefined)
      await disposeRuntimeTreeParentPin(opened.parentPin)
      await disposeRuntimePackNamespace(opened.namespace)
      await disposeRuntimeProfileParentPin(opened.profile)
    }
    const paused = await beginTransfer(Buffer.from('paused-direct-dispose'))
    const pausedCloseReached = deferred(),
      releasePausedClose = deferred()
    let firstEvent = ''
    let disposalOutcome = ''
    try {
      await appendRuntimeOwnedTransfer(paused.start.target, paused.start.attempt, Buffer.from('paused-'))
      await suspendRuntimeOwnedTransfer(paused.start.target, paused.start.attempt)
      io.holdClose = true
      io.closeReached = pausedCloseReached.resolve
      io.releaseClose = releasePausedClose.promise
      const disposing = paused.writer.dispose()
      const observed = disposing.then(
        () => 'settled',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      firstEvent = await Promise.race([
        pausedCloseReached.promise.then(() => 'close-entered'),
        observed.then(() => 'disposed-before-close')
      ])
      if (firstEvent === 'close-entered') {
        let settled = false
        void observed.then(() => {
          settled = true
        })
        await Promise.resolve()
        expect(settled, 'R11_PAUSED_DIRECT_DISPOSE_JOINS_CLOSE').toBe(false)
      }
      releasePausedClose.resolve()
      disposalOutcome = await observed
    } finally {
      releasePausedClose.resolve()
      io.holdClose = false
      await discardRuntimeOwnedTransfer(paused.start.target, paused.start.cleanup).settled.catch(() => undefined)
      await disposeRuntimeTreeParentPin(paused.parentPin)
      await disposeRuntimePackNamespace(paused.namespace)
      await disposeRuntimeProfileParentPin(paused.profile)
    }
    expect(
      { creationObservation, openedObservation, pausedObservation: { firstEvent, disposalOutcome } },
      'R11_CREATION_AND_PAUSED_DISPOSAL_OWNER'
    ).toEqual({
      creationObservation: {
        begin: 'RUNTIME_TRANSFER_QUIESCING',
        dispose: 'settled',
        sameDisposePromise: true,
        held: { beginPending: true, firstPending: true, repeatedPending: true },
        newOpens: 0
      },
      openedObservation: {
        firstEvent: 'close-entered',
        begin: 'RUNTIME_TRANSFER_QUIESCING',
        dispose: 'settled',
        sameDisposePromise: true,
        held: { beginPending: true, firstPending: true, repeatedPending: true, closeAcknowledged: false },
        newOpens: 1,
        rawCloseCalls: 1,
        rawCloseAcknowledgements: 1
      },
      pausedObservation: { firstEvent: 'close-entered', disposalOutcome: 'settled' }
    })
  })

  it('cleans only its recorded partial after cancellation', async () => {
    const payload = Buffer.from('cancel-owned-only')
    const siblingBytes = Buffer.from('foreign')
    let actionCurrent = true
    const transfer = await beginTransfer(
      payload,
      transferAction(() => {
        if (!actionCurrent) throw new Error('R12_DOWNLOAD_ACTION_RETIRED')
      }),
      () => undefined,
      siblingBytes
    )
    const sibling = join(dirname(transfer.partialPath), 'second.bin')
    try {
      const siblingSink = await transfer.writer.createFile(issueRuntimePayloadFilePin(transfer.plan, 'second.bin'))
      await siblingSink.write(siblingBytes)
      await siblingSink.close()
      await transfer.writer.renameFile('second.bin.partial', 'second.bin', () => undefined)
      await appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload.subarray(0, 4))
      actionCurrent = false
      const outcome = await discardRuntimeOwnedTransfer(transfer.start.target, transfer.start.cleanup).settled
      expect(outcome).toEqual({ status: 'removed' })
      expect(await lstat(transfer.partialPath).catch(() => null)).toBeNull()
      expect(await readFile(sibling)).toEqual(siblingBytes)
    } finally {
      await disposeWriter(transfer)
    }
  })

  it('rejects tampered actual FD bytes at finish and while paused', async () => {
    const payload = Buffer.from('actual-fd-readback')
    const transfer = await beginTransfer(payload)
    try {
      await appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload)
      const fd = await import('node:fs/promises').then(({ open }) => open(transfer.partialPath, 'r+'))
      try {
        await fd.write(Buffer.from('X'), 0, 1, 0)
      } finally {
        await fd.close()
      }
      await expect(finishRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)).rejects.toThrow(
        'RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED'
      )
      expect(await lstat(transfer.finalPath).catch(() => null)).toBeNull()
    } finally {
      await disposeWriter(transfer)
    }

    const pausedTransfer = await beginTransfer(payload)
    try {
      await appendRuntimeOwnedTransfer(
        pausedTransfer.start.target,
        pausedTransfer.start.attempt,
        payload.subarray(0, 5)
      )
      const suspended = await suspendRuntimeOwnedTransfer(pausedTransfer.start.target, pausedTransfer.start.attempt)
      const fd = await import('node:fs/promises').then(({ open }) => open(pausedTransfer.partialPath, 'r+'))
      try {
        await fd.write(Buffer.from('X'), 0, 1, 0)
      } finally {
        await fd.close()
      }
      await expect(
        resumeRuntimeOwnedTransfer(
          pausedTransfer.start.target,
          suspended,
          transferAction(() => undefined, {}, pausedTransfer.action.transaction)
        )
      ).rejects.toThrow('RUNTIME_EXCLUSIVE_FILE_OWNER_CHANGED')
      expect(await lstat(pausedTransfer.finalPath).catch(() => null)).toBeNull()
    } finally {
      await disposeWriter(pausedTransfer)
    }
  })

  it('requires full size digest EOF and confirmed rename for verification', async () => {
    const terminalCode = (error: unknown, expected: string): string =>
      error instanceof Error && error.message === expected ? expected : 'UNEXPECTED_TERMINAL_ERROR'
    const readIfPresent = async (path: string): Promise<Buffer | null> => {
      try {
        return await readFile(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }
    const payload = Buffer.from('complete-digest-required')
    const transfer = await beginTransfer(payload)
    try {
      await appendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt, payload.subarray(0, 3))
      await expect(finishRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)).rejects.toThrow(
        'RUNTIME_TRANSFER_SIZE_MISMATCH'
      )
      await appendRuntimeOwnedTransfer(
        transfer.start.target,
        transfer.start.attempt,
        Buffer.alloc(payload.byteLength - 3, 0x21)
      )
      await expect(finishRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)).rejects.toThrow(
        'RUNTIME_TRANSFER_DIGEST_MISMATCH'
      )
      expect(await lstat(transfer.finalPath).catch(() => null)).toBeNull()
    } finally {
      await disposeWriter(transfer)
    }
    const confirmed = await beginTransfer(payload)
    const syncReached = deferred(),
      releaseSync = deferred()
    try {
      await appendRuntimeOwnedTransfer(confirmed.start.target, confirmed.start.attempt, payload)
      io.holdSync = true
      io.syncReached = syncReached.resolve
      io.releaseSync = releaseSync.promise
      const finishing = finishRuntimeOwnedTransfer(confirmed.start.target, confirmed.start.attempt)
      void finishing.catch(() => undefined)
      await syncReached.promise
      let settled = false
      void finishing.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(io.syncCount).toBe(1)
      releaseSync.resolve()
      expect(await finishing).toBeDefined()
      expect(await readFile(confirmed.finalPath)).toEqual(payload)
    } finally {
      releaseSync.resolve()
      io.holdSync = false
      await disposeWriter(confirmed)
    }
    const uncertain = await beginTransfer(payload)
    try {
      await appendRuntimeOwnedTransfer(uncertain.start.target, uncertain.start.attempt, payload)
      io.failFinalStat = true
      await expect(finishRuntimeOwnedTransfer(uncertain.start.target, uncertain.start.attempt)).rejects.toThrow(
        'RUNTIME_TRANSFER_RENAME_UNCONFIRMED'
      )
      io.failFinalStat = false
      expect(await readFile(uncertain.finalPath)).toEqual(payload)
      expect(runtimeOwnedTransferProgress(uncertain.start.target).state).toBe('frozen')
      await expect(uncertain.writer.seal()).rejects.toThrow('RUNTIME_TREE_WRITER_CLOSED')
    } finally {
      io.failFinalStat = false
      await disposeWriter(uncertain)
    }
    const stopped = await beginTransfer(payload)
    const stoppedSyncReached = deferred(),
      releaseStoppedSync = deferred()
    let stopObservation: {
      readonly outcome: { readonly state: 'fulfilled' | 'rejected'; readonly result: string }
      readonly final: Buffer | null
      readonly partial: Buffer | null
    } | null = null
    try {
      await appendRuntimeOwnedTransfer(stopped.start.target, stopped.start.attempt, payload)
      io.holdSync = true
      io.syncReached = stoppedSyncReached.resolve
      io.releaseSync = releaseStoppedSync.promise
      const finishing = finishRuntimeOwnedTransfer(stopped.start.target, stopped.start.attempt)
      await stoppedSyncReached.promise
      stopRuntimeOwnedTransfer(stopped.start.target, stopped.start.attempt)
      let settled = false
      void finishing.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await Promise.resolve()
      expect(settled, 'R14_STOP_HELD_SYNC_NOT_SETTLED').toBe(false)
      releaseStoppedSync.resolve()
      const outcome = await finishing.then(
        () => ({ state: 'fulfilled' as const, result: 'verified' }),
        (error: unknown) => ({ state: 'rejected' as const, result: terminalCode(error, 'RUNTIME_TRANSFER_QUIESCING') })
      )
      const final = await readIfPresent(stopped.finalPath)
      const partial = await readIfPresent(stopped.partialPath)
      stopObservation = { outcome, final, partial }
    } finally {
      releaseStoppedSync.resolve()
      io.holdSync = false
      await disposeWriter(stopped)
    }
    let lateActionCurrent = true
    const committed = await beginTransfer(
      payload,
      transferAction(() => {
        if (!lateActionCurrent) throw new Error('R14_LATE_ACTION_RETIRED')
      })
    )
    const physicalCloseReached = deferred(),
      releasePhysicalClose = deferred()
    let committedObservation: {
      readonly outcome: { readonly state: 'fulfilled' | 'rejected'; readonly result: string }
      readonly renameCommitted: boolean
      readonly finalBeforeRetirement: Buffer
      readonly finishPendingAtClose: boolean
      readonly finishPendingAfterRetirement: boolean
      readonly stateBeforeRelease: string
      readonly final: Buffer | null
      readonly seal: string
    } | null = null
    try {
      await appendRuntimeOwnedTransfer(committed.start.target, committed.start.attempt, payload)
      io.holdPhysicalClose = true
      io.physicalRenameCommitted = false
      io.physicalCloseReached = physicalCloseReached.resolve
      io.releasePhysicalClose = releasePhysicalClose.promise
      const finishing = finishRuntimeOwnedTransfer(committed.start.target, committed.start.attempt)
      const observedFinish = finishing.then(
        () => ({ state: 'fulfilled' as const, result: 'verified' }),
        (error: unknown) => ({ state: 'rejected' as const, result: terminalCode(error, 'R14_LATE_ACTION_RETIRED') })
      )
      let finishSettled = false
      void observedFinish.then(() => {
        finishSettled = true
      })
      await waitForDiagnosticGate(physicalCloseReached.promise, 'post-rename-physical-close')
      const renameCommitted = io.physicalRenameCommitted
      const finalBeforeRetirement = await readFile(committed.finalPath)
      await Promise.resolve()
      const finishPendingAtClose = !finishSettled
      lateActionCurrent = false
      await Promise.resolve()
      const finishPendingAfterRetirement = !finishSettled
      const stateBeforeRelease = runtimeOwnedTransferProgress(committed.start.target).state
      releasePhysicalClose.resolve()
      const outcome = await observedFinish
      const final = await readIfPresent(committed.finalPath)
      const seal = await committed.writer.seal().then(
        () => 'sealed',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      committedObservation = {
        outcome,
        renameCommitted,
        finalBeforeRetirement,
        finishPendingAtClose,
        finishPendingAfterRetirement,
        stateBeforeRelease,
        final,
        seal
      }
    } finally {
      releasePhysicalClose.resolve()
      io.holdPhysicalClose = false
      await disposeWriter(committed).catch(() => undefined)
    }
    expect({ stopObservation, committedObservation }, 'R14_STOP_AND_LATE_ACTION_PUBLICATION').toEqual({
      stopObservation: {
        outcome: { state: 'rejected', result: 'RUNTIME_TRANSFER_QUIESCING' },
        final: null,
        partial: payload
      },
      committedObservation: {
        outcome: { state: 'rejected', result: 'R14_LATE_ACTION_RETIRED' },
        renameCommitted: true,
        finalBeforeRetirement: payload,
        finishPendingAtClose: true,
        finishPendingAfterRetirement: true,
        stateBeforeRelease: 'active',
        final: payload,
        seal: 'RUNTIME_TREE_TRANSFER_ACTIVE'
      }
    })
  })

  it('refuses seal with paused failed or unfinished transfers', async () => {
    const payload = Buffer.from('seal-requires-final-target')
    const active = await beginTransfer(payload)
    try {
      await expect(active.writer.seal()).rejects.toThrow('RUNTIME_TREE_TRANSFER_ACTIVE')
    } finally {
      await disposeWriter(active)
    }
    const transfer = await beginTransfer(payload)
    try {
      const suspended = await suspendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)
      expect(suspended).toBeDefined()
      await expect(transfer.writer.seal()).rejects.toThrow('RUNTIME_TREE_TRANSFER_ACTIVE')
      const cleanup = await discardRuntimeOwnedTransfer(transfer.start.target, transfer.start.cleanup).settled
      expect(cleanup).toEqual({ status: 'removed' })
    } finally {
      await disposeWriter(transfer)
    }
    const pending = await beginTransfer(payload)
    const closeReached = deferred(),
      releaseClose = deferred()
    try {
      io.holdClose = true
      io.closeReached = closeReached.resolve
      io.releaseClose = releaseClose.promise
      const cleanup = discardRuntimeOwnedTransfer(pending.start.target, pending.start.cleanup)
      await closeReached.promise
      await expect(pending.writer.seal()).rejects.toThrow('RUNTIME_TREE_TRANSFER_ACTIVE')
      releaseClose.resolve()
      expect(await cleanup.settled).toEqual({ status: 'removed' })
    } finally {
      releaseClose.resolve()
      io.holdClose = false
      await disposeWriter(pending)
    }
    const failed = await beginTransfer(payload)
    try {
      io.writeMaximum = 1
      io.writeZero = true
      await expect(appendRuntimeOwnedTransfer(failed.start.target, failed.start.attempt, payload)).rejects.toThrow(
        'RUNTIME_EXCLUSIVE_FILE_ZERO_PROGRESS'
      )
      await expect(failed.writer.seal()).rejects.toThrow('RUNTIME_TREE_TRANSFER_ACTIVE')
    } finally {
      io.writeZero = false
      io.writeMaximum = 0
      await disposeWriter(failed)
    }
    const legacy = await legacyFile(payload)
    try {
      await legacy.sink.write(payload)
      await legacy.sink.close()
      await expect(legacy.writer.seal()).rejects.toThrow('RUNTIME_TREE_WRITER_INCOMPLETE')
    } finally {
      await disposeWriter(legacy)
    }
  })

  it('expires paused retention without releasing a pending owner', async () => {
    const payload = Buffer.from('fixed-pause-deadline')
    const transfer = await beginTransfer(payload, transferAction(), () => undefined, Buffer.from('next'))
    const secondPin = issueRuntimePayloadFilePin(transfer.plan, 'second.bin')
    const closeReached = deferred(),
      release = deferred()
    let monotonicNow = 1_000
    const clock = vi.spyOn(nodePerformance, 'now').mockImplementation(() => monotonicNow)
    try {
      vi.useFakeTimers()
      const wallBeforeRollback = Date.now()
      const suspended = await suspendRuntimeOwnedTransfer(transfer.start.target, transfer.start.attempt)
      vi.setSystemTime(wallBeforeRollback - 60 * 60_000)
      io.holdClose = true
      io.closeReached = closeReached.resolve
      io.releaseClose = release.promise
      monotonicNow += transferBounds().pausedRetentionMs + 1
      await vi.advanceTimersByTimeAsync(transferBounds().pausedRetentionMs + 1)
      await closeReached.promise
      await expect(
        resumeRuntimeOwnedTransfer(
          transfer.start.target,
          suspended,
          transferAction(() => undefined, {}, transfer.action.transaction)
        )
      ).rejects.toThrow('RUNTIME_TRANSFER_SUSPENSION_INVALID')
      expect(await lstat(transfer.partialPath)).toBeDefined()
      await expect(
        beginRuntimeOwnedTreeDownload({
          writer: transfer.writer,
          pin: secondPin,
          action: transferAction(() => undefined, {}, transfer.action.transaction),
          bounds: transferBounds(),
          assertCleanupCurrentSync: () => undefined
        })
      ).rejects.toThrow('RUNTIME_TREE_TRANSFER_SLOT_BUSY')
      const pending = discardRuntimeOwnedTransfer(transfer.start.target, transfer.start.cleanup)
      release.resolve()
      expect(await pending.settled).toEqual({
        status: 'removed'
      })
    } finally {
      release.resolve()
      io.holdClose = false
      vi.useRealTimers()
      clock.mockRestore()
      await disposeWriter(transfer)
    }
  })
})
