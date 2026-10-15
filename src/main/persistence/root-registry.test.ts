import { afterEach, describe, expect, it, vi } from 'vitest'
import { constants } from 'node:fs'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type SettlementFixtureHandle = { close: () => Promise<void>; fd?: number }
type SettlementGate = {
  entered: Promise<void>
  notifyEntered: () => void
  wait: Promise<void>
  release: () => void
  error: string | undefined
  attempts: number
  confirmed: number
  raw: SettlementFixtureHandle | undefined
  errors: Error[]
}
type WriterWriteGate = {
  entered: Promise<void>
  notifyEntered: () => void
  wait: Promise<void>
  release: () => void
  error: Error | undefined
  reject: boolean
  calls: number
  faults: number
  exclusive: boolean
  raw: SettlementFixtureHandle | undefined
}

vi.mock('electron')

const rootSettlementFaults = vi.hoisted(() => ({
  closeGates: new Map<string, SettlementGate>(),
  writeGates: new Map<string, WriterWriteGate>(),
  newCasePaths: new Set<string>(),
  originalFs: undefined as typeof import('node:fs/promises') | undefined,
  openedHandles: new Map<string, SettlementFixtureHandle>(),
  observedPaths: new Map<string, { lstat: number; unlink: number }>(),
  retainedCleanupHandles: new Set<SettlementFixtureHandle>(),
  retainedCleanupDirectories: new Set<string>()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  rootSettlementFaults.originalFs = actual
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      const counts = rootSettlementFaults.observedPaths.get(path)
      if (counts) counts.lstat += 1
      return actual.lstat(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const path = String(args[0])
      const counts = rootSettlementFaults.observedPaths.get(path)
      if (counts) counts.unlink += 1
      return actual.unlink(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      const newCasePath = rootSettlementFaults.newCasePaths.has(path)
      if (newCasePath && !rootSettlementFaults.openedHandles.has(path))
        rootSettlementFaults.openedHandles.set(path, handle)
      const closeGate = rootSettlementFaults.closeGates.get(path)
      if (newCasePath && closeGate && !closeGate.raw) closeGate.raw = handle
      const writeGate = rootSettlementFaults.writeGates.get(path)
      if (writeGate && !writeGate.raw) {
        writeGate.raw = handle
        writeGate.exclusive = typeof args[1] === 'number' && (args[1] & constants.O_EXCL) !== 0
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close')
            return async () => {
              const gate = rootSettlementFaults.closeGates.get(path)
              if (gate && (!gate.raw || gate.raw === target)) {
                gate.attempts += 1
                gate.raw = target
                gate.notifyEntered()
                await gate.wait
                if (gate.error) {
                  const error = new Error(gate.error)
                  if (newCasePath) gate.errors.push(error)
                  throw error
                }
              }
              await target.close()
              if (newCasePath && gate && gate.raw === target) gate.confirmed += 1
            }
          if (newCasePath && property === 'writeFile')
            return async (...writeArgs: Parameters<typeof target.writeFile>) => {
              const gate = rootSettlementFaults.writeGates.get(path)
              if (gate && gate.raw === target) {
                gate.calls += 1
                gate.raw = target
                gate.notifyEntered()
                await gate.wait
                if (gate.reject && gate.error) {
                  gate.faults += 1
                  throw gate.error
                }
              }
              return target.writeFile(...writeArgs)
            }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})

function settlementGate(error?: string): SettlementGate {
  let notifyEntered!: () => void
  let release!: () => void
  return {
    entered: new Promise<void>((resolveEntered) => {
      notifyEntered = resolveEntered
    }),
    wait: new Promise<void>((resolveWait) => {
      release = resolveWait
    }),
    notifyEntered() {
      notifyEntered()
    },
    release() {
      release()
    },
    error,
    attempts: 0,
    confirmed: 0,
    raw: undefined,
    errors: []
  }
}

function writerWriteGate(error: Error | undefined, reject = true): WriterWriteGate {
  let notifyEntered!: () => void
  let release!: () => void
  return {
    entered: new Promise<void>((resolveEntered) => {
      notifyEntered = resolveEntered
    }),
    wait: new Promise<void>((resolveWait) => {
      release = resolveWait
    }),
    notifyEntered() {
      notifyEntered()
    },
    release() {
      release()
    },
    error,
    reject,
    calls: 0,
    faults: 0,
    exclusive: false,
    raw: undefined
  }
}

type ProbeCustody = {
  root: Awaited<ReturnType<RootRegistry['create']>>
  cleanup: { status: 'fulfilled' } | { status: 'rejected'; error: unknown } | null
}

function ownedCleanupCustody() {
  const directories: string[] = []
  const paths: string[] = []
  const gates: Array<{ release: () => void }> = []
  const operations: Promise<unknown>[] = []
  const auxiliaries: Array<{ handle: SettlementFixtureHandle; closed: boolean; failed: boolean }> = []
  const probes: ProbeCustody[] = []
  return {
    probes,
    directory(path: string) {
      directories.push(path)
      if (directories.length > 4) throw new Error('owned-cleanup fixture directory bound')
    },
    arm(path: string) {
      paths.push(path)
      rootSettlementFaults.newCasePaths.add(path)
      if (paths.length > 24) throw new Error('owned-cleanup fixture path bound')
    },
    gate<T extends { release: () => void }>(gate: T): T {
      gates.push(gate)
      if (gates.length > 16) throw new Error('owned-cleanup fixture gate bound')
      return gate
    },
    operation<T>(operation: Promise<T>): Promise<T> {
      operations.push(operation)
      if (operations.length > 32) throw new Error('owned-cleanup fixture operation bound')
      return operation
    },
    auxiliary(handle: SettlementFixtureHandle) {
      const entry = { handle, closed: false, failed: false }
      auxiliaries.push(entry)
      if (auxiliaries.length > 4) throw new Error('owned-cleanup fixture auxiliary bound')
      return entry
    },
    retainProbe(root: ProbeCustody['root']): ProbeCustody {
      const entry: ProbeCustody = { root, cleanup: null }
      probes.push(entry)
      if (probes.length > 8) throw new Error('owned-cleanup fixture successor bound')
      return entry
    },
    async cleanup() {
      for (const gate of gates) gate.release()
      const joined = await Promise.allSettled(operations)
      const failures: string[] = []
      const unjoined = joined.filter((result) => result.status === 'rejected').length
      if (unjoined) failures.push(`joined-operation:${unjoined}`)
      const failedProbes = probes.filter((probe) => probe.cleanup?.status !== 'fulfilled').length
      if (failedProbes) failures.push(`probe-close:${failedProbes}`)
      const uncertainPaths = new Set(
        unjoined
          ? paths
          : probes.filter((probe) => probe.cleanup?.status !== 'fulfilled').map((probe) => probe.root.meetingPath)
      )
      const closeGates = new Map(paths.map((path) => [path, rootSettlementFaults.closeGates.get(path)]))
      for (const path of paths) {
        rootSettlementFaults.closeGates.delete(path)
        rootSettlementFaults.writeGates.delete(path)
      }
      for (const path of paths) {
        const raw = rootSettlementFaults.openedHandles.get(path)
        const closeGate = closeGates.get(path)
        let closeFailed = uncertainPaths.has(path)
        if (closeFailed && raw) rootSettlementFaults.retainedCleanupHandles.add(raw)
        if (raw && typeof raw.fd === 'number' && raw.fd < 0 && closeGate?.attempts && closeGate.confirmed === 0) {
          closeFailed = true
          failures.push('unconfirmed-raw-close')
          rootSettlementFaults.retainedCleanupHandles.add(raw)
        }
        if (raw && typeof raw.fd === 'number' && raw.fd >= 0) {
          try {
            await raw.close()
          } catch {
            closeFailed = true
            failures.push('raw-close')
            rootSettlementFaults.retainedCleanupHandles.add(raw)
          }
        }
        if (!closeFailed) {
          rootSettlementFaults.openedHandles.delete(path)
          rootSettlementFaults.observedPaths.delete(path)
          rootSettlementFaults.newCasePaths.delete(path)
        }
      }
      for (const auxiliary of auxiliaries) {
        if (auxiliary.failed) {
          failures.push('prior-auxiliary-close')
          rootSettlementFaults.retainedCleanupHandles.add(auxiliary.handle)
        }
        if (auxiliary.closed || typeof auxiliary.handle.fd !== 'number' || auxiliary.handle.fd < 0) continue
        try {
          await auxiliary.handle.close()
          auxiliary.closed = true
        } catch {
          failures.push('auxiliary-close')
          rootSettlementFaults.retainedCleanupHandles.add(auxiliary.handle)
        }
      }
      if (failures.length) {
        for (const path of directories) rootSettlementFaults.retainedCleanupDirectories.add(path)
      } else {
        for (const path of directories.reverse()) {
          try {
            await rm(path, { recursive: true, force: true })
          } catch {
            failures.push('directory-remove')
            rootSettlementFaults.retainedCleanupDirectories.add(path)
          }
        }
      }
      if (failures.length) throw new Error(`owned-cleanup fixture finalizer failed: ${failures.slice(0, 8).join(',')}`)
    }
  }
}

function recordSettlementEvidence(caseId: string, evidence: Record<string, unknown>): void {
  console.info(`PERSISTENCE_SETTLEMENT_EVIDENCE ${JSON.stringify({ caseId, ...evidence })}`)
}

import { RootRegistry, type RootScopeBinding } from './root-registry'

function authority(generation = 'generation-1', maxHeldRoots = 4) {
  const scopes = new WeakMap<object, RootScopeBinding>()
  let active = true
  const scope = Object.freeze({})
  const binding: RootScopeBinding = Object.freeze({
    profileNamespace: 'profile-main',
    principalAssociation: 'principal-hash',
    generation,
    nativeKeyAccess: 'allowed',
    legacyFileKeyAccess: 'authorized',
    maxHeldRoots,
    isCurrent: () => active
  })
  scopes.set(scope, binding)
  return {
    scope,
    binding,
    scopes,
    retire: () => {
      active = false
    }
  }
}

describe('persistence root registry', () => {
  let base: string | undefined

  afterEach(async () => {
    for (const gate of rootSettlementFaults.closeGates.values()) gate.release()
    rootSettlementFaults.closeGates.clear()
    if (base) await rm(base, { recursive: true, force: true })
    base = undefined
  })

  it('does not create any path while reopening a missing generation', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-root-registry-'))
    const owner = authority()
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })

    await expect(roots.openExisting(owner.scope, 'meeting-missing')).rejects.toThrow()
    await expect(lstat(join(base, 'persistence-v2'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds one writer lease and permanently retires the exact scope after an ABA restoration', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-root-registry-'))
    const owner = authority()
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    const root = await roots.create(owner.scope, 'meeting-one')
    const writer = await roots.acquireWriter(owner.scope, root)
    await expect(roots.acquireWriter(owner.scope, root)).rejects.toMatchObject({ code: 'EEXIST' })

    roots.retireScope(owner.scope)
    expect(() => root.assertCurrent()).toThrow(/retired/i)
    await writer.release()
    await roots.closeRoot(owner.scope, root)

    const successor = authority('generation-2')
    owner.scopes.set(successor.scope, successor.binding)
    const reopened = await roots.openExisting(successor.scope, 'meeting-one')
    const nextWriter = await roots.acquireWriter(successor.scope, reopened)
    await expect(nextWriter.assertPhysicalCurrent()).resolves.toBeUndefined()
    await nextWriter.release()
    await roots.closeRoot(successor.scope, reopened)
  })

  it('closes rejected gateway opens and enforces the configured max plus one root descriptor limit', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-root-registry-'))
    const owner = authority('generation-1', 1)
    let rejectGateway = true
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => {
        if (rejectGateway) throw new Error('gateway rejected root')
      }
    })

    await expect(roots.create(owner.scope, 'meeting-one')).rejects.toThrow('gateway rejected root')
    rejectGateway = false
    const root = await roots.openExisting(owner.scope, 'meeting-one')
    await expect(roots.openExisting(owner.scope, 'meeting-one')).rejects.toThrow(/descriptor limit/i)
    await roots.closeRoot(owner.scope, root)
    const reopened = await roots.openExisting(owner.scope, 'meeting-one')
    await roots.closeRoot(owner.scope, reopened)
  })

  it('retains the root charge when a rejected open cannot close its descriptor', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-root-registry-open-close-failure-'))
    const owner = authority('generation-open-close', 1)
    let rejectGateway = true
    const rootPath = join(base, 'persistence-v2', owner.binding.profileNamespace, 'meetings', 'meeting-one')
    const closeFailure = 'injected failed-open directory close failure'
    const closeGate = settlementGate(closeFailure)
    closeGate.release()
    rootSettlementFaults.closeGates.set(rootPath, closeGate)
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => {
        if (rejectGateway) {
          rejectGateway = false
          throw new Error('gateway rejected root')
        }
      }
    })
    let unexpectedSuccessor: Awaited<ReturnType<RootRegistry['openExisting']>> | undefined
    try {
      await expect(roots.create(owner.scope, 'meeting-one')).rejects.toThrow('gateway rejected root')
      rootSettlementFaults.closeGates.delete(rootPath)
      const successorAttempt = roots.openExisting(owner.scope, 'meeting-one').then(
        (root) => {
          unexpectedSuccessor = root
          return { status: 'fulfilled' }
        },
        (error: unknown) => ({
          status: 'rejected',
          errorName: error instanceof Error ? error.name.slice(0, 80) : typeof error,
          errorMessage: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
        })
      )
      const successorOutcome = await successorAttempt
      recordSettlementEvidence('R04', {
        failedOpenCloseAttempts: closeGate.attempts,
        gatewayRejected: true,
        successorAdmitted: Boolean(unexpectedSuccessor),
        successorOutcome
      })
      expect(closeGate.attempts).toBe(1)
      expect(successorOutcome, `${closeFailure} must retain the failed-open root descriptor charge`).toMatchObject({
        status: 'rejected'
      })
    } finally {
      rootSettlementFaults.closeGates.delete(rootPath)
      await closeGate.raw?.close().catch(() => undefined)
      if (unexpectedSuccessor) await roots.closeRoot(owner.scope, unexpectedSuccessor).catch(() => undefined)
    }
  })

  it('keeps the writer reservation after unlink until descriptor settlement', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-root-registry-writer-close-failure-'))
    const owner = authority('generation-writer-close', 3)
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    const root = await roots.create(owner.scope, 'meeting-one')
    const reopened = await roots.openExisting(owner.scope, 'meeting-one')
    const writer = await roots.acquireWriter(owner.scope, root)
    const closePath = writer.lockPath
    const closeFailure = 'injected held writer close failure'
    const closeGate = settlementGate(closeFailure)
    rootSettlementFaults.closeGates.set(closePath, closeGate)
    const closePromise = writer.release()
    const probe = async (candidate: typeof root): Promise<{ admitted: boolean; errorMessage?: string }> => {
      try {
        const lease = await roots.acquireWriter(owner.scope, candidate)
        try {
          await lease.release()
        } catch (error) {
          return { admitted: true, errorMessage: error instanceof Error ? error.message.slice(0, 240) : String(error) }
        }
        return { admitted: true }
      } catch (error) {
        return {
          admitted: false,
          errorMessage: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
        }
      }
    }
    try {
      await closeGate.entered
      const heldOriginalAdmitted = await probe(root)
      const heldReopenedAdmitted = await probe(reopened)

      closeGate.release()
      await expect(closePromise).rejects.toThrow(closeFailure)
      const failedOriginalAdmitted = await probe(root)
      const failedReopenedAdmitted = await probe(reopened)
      recordSettlementEvidence('R05', {
        closeAttempts: closeGate.attempts,
        reopenedCapability: true,
        maxHeldRoots: owner.binding.maxHeldRoots,
        heldOriginalAdmitted: heldOriginalAdmitted.admitted,
        heldReopenedAdmitted: heldReopenedAdmitted.admitted,
        failedOriginalAdmitted: failedOriginalAdmitted.admitted,
        failedReopenedAdmitted: failedReopenedAdmitted.admitted,
        rejectionMessages: [
          heldOriginalAdmitted.errorMessage,
          heldReopenedAdmitted.errorMessage,
          failedOriginalAdmitted.errorMessage,
          failedReopenedAdmitted.errorMessage
        ]
      })
      expect(
        [
          heldOriginalAdmitted.admitted,
          heldReopenedAdmitted.admitted,
          failedOriginalAdmitted.admitted,
          failedReopenedAdmitted.admitted
        ],
        `${closeFailure} must retain physical-root ownership for returned and freshly reopened capabilities`
      ).toEqual([false, false, false, false])
      expect(
        [heldOriginalAdmitted, heldReopenedAdmitted, failedOriginalAdmitted, failedReopenedAdmitted]
          .filter((probeResult) => !probeResult.admitted)
          .every((probeResult) => /writer|lock|exclusive|EEXIST/i.test(probeResult.errorMessage ?? ''))
      ).toBe(true)
      expect(closeGate.attempts).toBe(1)
    } finally {
      rootSettlementFaults.closeGates.delete(closePath)
      closeGate.release()
      await closePromise.catch(() => undefined)
      await closeGate.raw?.close().catch(() => undefined)
      await roots.closeRoot(owner.scope, root).catch(() => undefined)
      await roots.closeRoot(owner.scope, reopened).catch(() => undefined)
    }
  })

  it('retains owned cleanup failure for foreign writer entries before and after lease return', async () => {
    const ids = ['returned-owned', 'returned-foreign', 'prereturn-owned', 'prereturn-foreign'] as const
    const results: Array<Record<string, unknown>> = []
    const soleOriginalControl: boolean[] = []
    const custody = ownedCleanupCustody()
    const cleanupErrorText = 'Persistence writer lock entry changed before owned cleanup'
    const writeErrorText = 'injected pre-return writer write failure'

    try {
      for (const id of ids) {
        const caseBase = await mkdtemp(join(tmpdir(), 'metis-root-registry-r06-'))
        custody.directory(caseBase)
        const owner = authority(`generation-${id}`, 1)
        const rootPath = join(caseBase, 'persistence-v2', owner.binding.profileNamespace, 'meetings', 'meeting-one')
        const backupPath = join(rootPath, '.journal-writer.lock.backup')
        const lockPath = join(rootPath, '.journal-writer.lock')
        const probePath = (meetingId: string) =>
          join(caseBase, 'persistence-v2', owner.binding.profileNamespace, 'meetings', meetingId)
        custody.arm(rootPath)
        custody.arm(lockPath)
        const roots = new RootRegistry({
          userDataRoot: () => caseBase,
          resolveScope: (scope) => owner.scopes.get(scope),
          bindGatewayRoot: async () => undefined
        })
        const root = await roots.create(owner.scope, 'meeting-one')
        const preReturn = id.startsWith('prereturn')
        const foreign = id.endsWith('foreign')
        const originalWriteError = new Error(writeErrorText)
        const writeGate = custody.gate(writerWriteGate(preReturn ? originalWriteError : undefined, preReturn))
        rootSettlementFaults.writeGates.set(lockPath, writeGate)
        if (!preReturn) writeGate.release()
        const lockGate = custody.gate(settlementGate())
        lockGate.release()
        rootSettlementFaults.closeGates.set(lockPath, lockGate)
        const rootGate = custody.gate(settlementGate())
        rootGate.release()
        rootGate.raw = rootSettlementFaults.openedHandles.get(rootPath)
        rootSettlementFaults.closeGates.set(rootPath, rootGate)
        const writerOperation = preReturn
          ? custody.operation(
              roots.acquireWriter(owner.scope, root).then(
                (lease) => ({ status: 'fulfilled' as const, lease }),
                (error: unknown) => ({ status: 'rejected' as const, error })
              )
            )
          : undefined
        let lease: Awaited<ReturnType<RootRegistry['acquireWriter']>> | undefined
        let rootOutcome: any
        let heldProbe: { outcome: string; successorSettled: boolean | null } | undefined
        let postProbe: { outcome: string; successorSettled: boolean | null } | undefined
        let settlement: any
        let originalIdentity: { dev: number | bigint; ino: number | bigint } | undefined
        let originalMarker: Buffer | undefined
        let foreignIdentity: { dev: number | bigint; ino: number | bigint; bytes: Buffer } | undefined
        let namedIdentity = 'owned'
        let writerCloseBeforeRepeat = 0
        let foreignSurvived: boolean | null = null
        let originalSurvived: boolean | null = null
        let lockAbsent = false
        const physicalFs = rootSettlementFaults.originalFs
        if (!physicalFs) throw new Error('R06 original filesystem fixture unavailable')
        const installForeignEntry = async () => {
          originalMarker = await physicalFs.readFile(lockPath)
          await physicalFs.rename(lockPath, backupPath)
          const sentinel = await physicalFs.open(lockPath, 'wx', 0o600)
          const retained = custody.auxiliary(sentinel)
          try {
            await sentinel.writeFile('synthetic foreign writer entry')
          } finally {
            try {
              await sentinel.close()
              retained.closed = true
            } catch {
              retained.failed = true
            }
          }
          if (retained.failed) throw new Error('R06 auxiliary fixture close failed')
          const exact = await physicalFs.lstat(lockPath, { bigint: true })
          foreignIdentity = { dev: exact.dev, ino: exact.ino, bytes: await physicalFs.readFile(lockPath) }
        }
        {
          if (preReturn) {
            const first = await Promise.race([
              writeGate.entered.then(() => 'entered' as const),
              writerOperation!.then(() => 'completed' as const)
            ])
            if (first !== 'entered') throw new Error('R06 fixture writer operation completed before the write gate')
            const originalStat = await (writeGate.raw as any).stat({ bigint: true })
            originalIdentity = { dev: originalStat.dev, ino: originalStat.ino }
            if (foreign) await installForeignEntry()
            const namedAtWriteGate = await lstat(lockPath, { bigint: true })
            namedIdentity =
              namedAtWriteGate.dev === originalIdentity.dev && namedAtWriteGate.ino === originalIdentity.ino
                ? 'owned'
                : 'foreign-inode'
            writeGate.release()
            const attempt = await writerOperation!
            if (attempt.status === 'fulfilled') lease = attempt.lease
            else settlement = { status: 'rejected', error: attempt.error, repeat: 'not-applicable' }
          } else {
            lease = await roots.acquireWriter(owner.scope, root)
            const originalStat = await (writeGate.raw as any).stat({ bigint: true })
            originalIdentity = { dev: originalStat.dev, ino: originalStat.ino }
          }
          if (!preReturn && foreign) await installForeignEntry()
          if (!preReturn) {
            const namedBefore = await lstat(lockPath, { bigint: true })
            namedIdentity =
              namedBefore.dev === originalIdentity.dev && namedBefore.ino === originalIdentity.ino
                ? 'owned'
                : 'foreign-inode'
          }
          if (lease) {
            const first = custody.operation(
              lease.release().then(
                () => ({ status: 'fulfilled' as const }),
                (error: unknown) => ({ status: 'rejected' as const, error })
              )
            )
            settlement = await first
            writerCloseBeforeRepeat = lockGate.attempts
            const beforeRepeat = snapshotIo(lockPath)
            const repeated = await custody.operation(
              lease.release().then(
                () => ({ status: 'fulfilled' as const }),
                (error: unknown) => ({ status: 'rejected' as const, error })
              )
            )
            const afterRepeat = snapshotIo(lockPath)
            settlement = {
              ...settlement,
              repeat:
                repeated.status === 'rejected' && 'error' in repeated && repeated.error === settlement.error
                  ? 'same-rejection'
                  : repeated.status,
              repeatError: 'error' in repeated ? repeated.error : undefined
            }
            settlement.extraIo = ioDelta(beforeRepeat, afterRepeat)
          } else {
            if (!settlement) throw new Error('R06 fixture did not capture the actual pre-return writer settlement')
            writerCloseBeforeRepeat = lockGate.attempts
          }
          heldProbe = await custody.operation(
            differentRootProbe(roots, owner.scope, 'held-probe', probePath('held-probe'), custody)
          )
          const closeFirst = await custody.operation(
            roots.closeRoot(owner.scope, root).then(
              () => ({ status: 'fulfilled' as const }),
              (error: unknown) => ({ status: 'rejected' as const, error })
            )
          )
          const rootClosesAfterFirst = rootGate.attempts
          const rootBeforeRepeat = snapshotIo(rootPath)
          const lockBeforeRootRepeat = snapshotIo(lockPath)
          const closeAgain = await custody.operation(
            roots.closeRoot(owner.scope, root).then(
              () => ({ status: 'fulfilled' as const }),
              (error: unknown) => ({ status: 'rejected' as const, error })
            )
          )
          const rootClosesAfterRepeat = rootGate.attempts
          const rootAfterRepeat = snapshotIo(rootPath)
          const lockAfterRootRepeat = snapshotIo(lockPath)
          rootOutcome = {
            status: closeFirst.status,
            error: 'error' in closeFirst ? closeFirst.error : undefined,
            repeat:
              closeAgain.status === 'rejected' &&
              'error' in closeAgain &&
              closeAgain.error === ('error' in closeFirst ? closeFirst.error : undefined)
                ? 'same-rejection'
                : closeAgain.status,
            extraIo: ioDelta(rootBeforeRepeat, rootAfterRepeat) + ioDelta(lockBeforeRootRepeat, lockAfterRootRepeat)
          }
          postProbe = await custody.operation(
            differentRootProbe(roots, owner.scope, 'post-probe', probePath('post-probe'), custody)
          )
          try {
            await physicalFs.lstat(lockPath, { bigint: true })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            lockAbsent = true
          }
          if (foreign) {
            const backup = await physicalFs.lstat(backupPath, { bigint: true })
            const named = await physicalFs.lstat(lockPath, { bigint: true })
            foreignSurvived = Boolean(
              named.isFile() &&
                !named.isSymbolicLink() &&
                foreignIdentity &&
                named.dev === foreignIdentity.dev &&
                named.ino === foreignIdentity.ino &&
                (await physicalFs.readFile(lockPath)).equals(foreignIdentity.bytes) &&
                originalIdentity &&
                (named.dev !== originalIdentity.dev || named.ino !== originalIdentity.ino)
            )
            originalSurvived = Boolean(
              backup.isFile() &&
                !backup.isSymbolicLink() &&
                originalIdentity &&
                backup.dev === originalIdentity.dev &&
                backup.ino === originalIdentity.ino &&
                originalMarker &&
                (await physicalFs.readFile(backupPath)).equals(originalMarker)
            )
          }
          const writerCloseCounts = [writerCloseBeforeRepeat, lockGate.attempts]
          const rootCloseCounts = [rootClosesAfterFirst, rootClosesAfterRepeat]
          const aggregateErrors = settlement?.error instanceof AggregateError ? Array.from(settlement.error.errors) : []
          if (id === 'prereturn-owned')
            soleOriginalControl.push(
              settlement?.status === 'rejected' &&
                settlement.error === originalWriteError &&
                !(settlement.error instanceof AggregateError)
            )
          const cleanupCause =
            aggregateErrors.length === 2
              ? aggregateErrors[1]
              : !preReturn && settlement?.status === 'rejected'
                ? settlement.error
                : undefined
          const cleanupSame =
            cleanupCause instanceof Error ? containsErrorIdentity(rootOutcome.error, cleanupCause) : null
          results.push({
            id,
            boundary: {
              exclusive: writeGate.exclusive,
              writeCalls: writeGate.calls,
              writeFaults: writeGate.faults,
              leases: lease ? 1 : 0,
              sameHandle: Boolean(writeGate.raw) && writeGate.raw === lockGate.raw,
              named: namedIdentity
            },
            entry: { foreignSurvived, originalSurvived, lockAbsent },
            settlement: {
              status: settlement?.status,
              originalError: Boolean(
                preReturn &&
                  (foreign
                    ? settlement?.error === originalWriteError || aggregateErrors[0] === originalWriteError
                    : settlement?.error === originalWriteError && !(settlement.error instanceof AggregateError))
              ),
              cleanupError: Boolean(cleanupCause instanceof Error && cleanupCause.message === cleanupErrorText),
              aggregate:
                aggregateErrors.length === 2 &&
                aggregateErrors[0] === originalWriteError &&
                aggregateErrors[1] instanceof Error &&
                aggregateErrors[1].message === cleanupErrorText
                  ? ['write', 'cleanup']
                  : [],
              repeat: settlement?.repeat,
              closes: writerCloseCounts,
              confirmed: lockGate.confirmed,
              extraIo: settlement?.extraIo ?? 0
            },
            root: {
              heldProbe: heldProbe.outcome,
              status: rootOutcome.status,
              sameCleanupError: cleanupSame,
              repeat: rootOutcome.repeat,
              closes: rootCloseCounts,
              extraIo: rootOutcome.extraIo,
              postProbe: postProbe.outcome,
              successorSettled: postProbe.successorSettled
            }
          })
        }
      }
      if (soleOriginalControl.length !== 1 || soleOriginalControl[0] !== true)
        throw new Error('R06 fixture owned pre-return control did not retain the sole original write Error')
      recordSettlementEvidence('R06', { cases: results })
      expect(results, 'R06 fixture boundaries and both owned controls must be complete').toHaveLength(4)
      expect(
        results.map((entry: any) => [
          entry.boundary.exclusive,
          entry.boundary.writeCalls,
          entry.boundary.writeFaults,
          entry.boundary.leases,
          entry.boundary.sameHandle,
          entry.boundary.named,
          entry.settlement.closes,
          entry.settlement.confirmed,
          entry.settlement.extraIo,
          entry.root.heldProbe,
          entry.root.extraIo
        ]),
        'R06 actual exclusive writer, target identity, close confirmation and held root capacity must be reached'
      ).toEqual([
        [true, 1, 0, 1, true, 'owned', [1, 1], 1, 0, 'descriptor-limit', 0],
        [true, 1, 0, 1, true, 'foreign-inode', [1, 1], 1, 0, 'descriptor-limit', 0],
        [true, 1, 1, 0, true, 'owned', [1, 1], 1, 0, 'descriptor-limit', 0],
        [true, 1, 1, 0, true, 'foreign-inode', [1, 1], 1, 0, 'descriptor-limit', 0]
      ])
      const controls = results.filter((entry: any) => entry.id.endsWith('owned')) as any[]
      expect(
        controls.map((entry) => [
          entry.settlement.status,
          entry.settlement.originalError,
          entry.settlement.cleanupError,
          entry.settlement.aggregate,
          entry.settlement.repeat,
          entry.entry.lockAbsent,
          entry.entry.foreignSurvived,
          entry.entry.originalSurvived,
          entry.root.status,
          entry.root.sameCleanupError,
          entry.root.repeat,
          entry.root.closes,
          entry.root.postProbe,
          entry.root.successorSettled
        ]),
        'R06 owned-entry same-boundary controls must remain healthy'
      ).toEqual([
        [
          'fulfilled',
          false,
          false,
          [],
          'fulfilled',
          true,
          null,
          null,
          'fulfilled',
          null,
          'fulfilled',
          [1, 1],
          'admitted',
          true
        ],
        [
          'rejected',
          true,
          false,
          [],
          'not-applicable',
          true,
          null,
          null,
          'fulfilled',
          null,
          'fulfilled',
          [1, 1],
          'admitted',
          true
        ]
      ])
      expect(
        results
          .filter((entry: any) => String(entry.id).endsWith('foreign'))
          .map((entry: any) => [
            entry.entry.lockAbsent,
            entry.entry.foreignSurvived,
            entry.entry.originalSurvived,
            entry.settlement.status,
            entry.settlement.originalError,
            entry.settlement.cleanupError,
            entry.settlement.aggregate,
            entry.settlement.repeat,
            entry.root.heldProbe,
            entry.root.status,
            entry.root.sameCleanupError,
            entry.root.repeat,
            entry.root.closes,
            entry.root.extraIo,
            entry.root.postProbe,
            entry.root.successorSettled
          ]),
        `R06 observed foreign writer entry must retain owned cleanup failure; ${cleanupErrorText}; ${writeErrorText}`
      ).toEqual([
        [
          false,
          true,
          true,
          'rejected',
          false,
          true,
          [],
          'same-rejection',
          'descriptor-limit',
          'rejected',
          true,
          'same-rejection',
          [0, 0],
          0,
          'descriptor-limit',
          null
        ],
        [
          false,
          true,
          true,
          'rejected',
          true,
          true,
          ['write', 'cleanup'],
          'not-applicable',
          'descriptor-limit',
          'rejected',
          true,
          'same-rejection',
          [0, 0],
          0,
          'descriptor-limit',
          null
        ]
      ])
    } finally {
      await custody.cleanup()
    }
  })

  it('joins one failed-open root close through the captured binder capability', async () => {
    const cases: Record<string, unknown> = {}
    const initialHeldProbes: string[] = []
    const soleOriginalControl: boolean[] = []
    const custody = ownedCleanupCustody()
    try {
      for (const id of ['confirmed-close', 'failed-close'] as const) {
        const caseBase = await mkdtemp(join(tmpdir(), 'metis-root-registry-r07-'))
        custody.directory(caseBase)
        const owner = authority(`generation-${id}`, 1)
        const rootPath = join(caseBase, 'persistence-v2', owner.binding.profileNamespace, 'meetings', 'meeting-one')
        const probePath = (meetingId: string) =>
          join(caseBase, 'persistence-v2', owner.binding.profileNamespace, 'meetings', meetingId)
        custody.arm(rootPath)
        const binderError = new Error('injected captured-root binder failure')
        const closeError = 'injected captured-root directory close failure'
        const gate = custody.gate(settlementGate(id === 'failed-close' ? closeError : undefined))
        let captured: Awaited<ReturnType<RootRegistry['create']>> | undefined
        let bindCalls = 0
        const roots = new RootRegistry({
          userDataRoot: () => caseBase,
          resolveScope: (scope) => owner.scopes.get(scope),
          bindGatewayRoot: async (root) => {
            if (root.meetingId === 'meeting-one' && bindCalls++ === 0) {
              captured = root
              throw binderError
            }
          }
        })
        rootSettlementFaults.closeGates.set(rootPath, gate)
        let openingState = 'pending'
        const opening = custody.operation(
          roots.create(owner.scope, 'meeting-one').then(
            () => {
              openingState = 'fulfilled'
              return { status: 'fulfilled' as const }
            },
            (error: unknown) => {
              openingState = 'rejected'
              return { status: 'rejected' as const, error }
            }
          )
        )
        const boundary = await Promise.race([
          gate.entered.then(() => 'entered' as const),
          opening.then(() => 'completed' as const)
        ])
        if (boundary !== 'entered' || !captured || !gate.raw)
          throw new Error('R07 fixture opening completed before the actual captured-root close gate')
        const openingAtGate = openingState
        const openedHandleMatches = gate.raw === rootSettlementFaults.openedHandles.get(rootPath)
        const entryAttempts = gate.attempts
        const initialHeldProbe = await custody.operation(
          differentRootProbe(roots, owner.scope, 'held-probe', probePath('held-probe'), custody)
        )
        initialHeldProbes.push(initialHeldProbe.outcome)
        let heldProbe = initialHeldProbe
        const publicCalls: Array<{ status: 'fulfilled' } | { status: 'rejected'; error: unknown }> = []
        const heldAtCheckpoint: string[] = []
        let afterCounts: number[]
        let repeatExtraIo: number
        let openingResult: Awaited<typeof opening>
        if (id === 'failed-close') {
          const states = ['pending', 'pending']
          const startPublic = (index: number) =>
            custody.operation(
              roots.closeRoot(owner.scope, captured!).then(
                () => {
                  states[index] = 'fulfilled'
                  return { status: 'fulfilled' as const }
                },
                (error: unknown) => {
                  states[index] = 'rejected'
                  return { status: 'rejected' as const, error }
                }
              )
            )
          const p1 = startPublic(0)
          const p2 = startPublic(1)
          heldProbe = await custody.operation(
            differentRootProbe(roots, owner.scope, 'held-checkpoint', probePath('held-checkpoint'), custody)
          )
          heldAtCheckpoint.push(...states)
          const afterHeldAttempts = gate.attempts
          gate.release()
          openingResult = await opening
          publicCalls.push(...(await Promise.all([p1, p2])))
          const beforeRepeat = snapshotIo(rootPath)
          const repeats = [0, 1].map(() =>
            custody.operation(
              roots.closeRoot(owner.scope, captured!).then(
                () => ({ status: 'fulfilled' as const }),
                (error: unknown) => ({ status: 'rejected' as const, error })
              )
            )
          )
          publicCalls.push(...(await Promise.all(repeats)))
          repeatExtraIo = ioDelta(beforeRepeat, snapshotIo(rootPath))
          afterCounts = [entryAttempts, afterHeldAttempts, gate.attempts]
        } else {
          gate.release()
          openingResult = await opening
          const beforeRepeat = snapshotIo(rootPath)
          const first = await custody.operation(
            roots.closeRoot(owner.scope, captured).then(
              () => ({ status: 'fulfilled' as const }),
              (error: unknown) => ({ status: 'rejected' as const, error })
            )
          )
          const afterFirst = gate.attempts
          const second = await custody.operation(
            roots.closeRoot(owner.scope, captured).then(
              () => ({ status: 'fulfilled' as const }),
              (error: unknown) => ({ status: 'rejected' as const, error })
            )
          )
          publicCalls.push(first, second)
          repeatExtraIo = ioDelta(beforeRepeat, snapshotIo(rootPath))
          afterCounts = [entryAttempts, afterFirst, gate.attempts]
        }
        const postProbe = await custody.operation(
          differentRootProbe(roots, owner.scope, 'post-probe', probePath('post-probe'), custody)
        )
        if (id === 'confirmed-close')
          soleOriginalControl.push(
            openingResult.status === 'rejected' &&
              openingResult.error === binderError &&
              !(openingResult.error instanceof AggregateError)
          )
        cases[id === 'confirmed-close' ? 'confirmedClose' : 'failedClose'] = makeR07Record({
          failedBranch: id === 'failed-close',
          captured,
          owner,
          openingResult,
          openingAtHold: openingAtGate,
          openedHandleMatches,
          binderError,
          gate,
          heldProbe,
          heldCalls: heldAtCheckpoint.map((status) => ({ status })),
          publicCalls,
          afterCounts,
          firstCloseError: gate.errors[0],
          confirmed: gate.confirmed,
          postProbe,
          repeatExtraIo
        })
      }
      if (soleOriginalControl.length !== 1 || soleOriginalControl[0] !== true)
        throw new Error('R07 fixture confirmed-close control did not retain the sole original binder Error')
      recordSettlementEvidence('R07', cases)
      expect(Object.keys(cases), 'R07 both actual close branches must be collected').toEqual([
        'confirmedClose',
        'failedClose'
      ])
      expect(initialHeldProbes, 'R07 initial live-root charge must be observed before public cleanup').toEqual([
        'descriptor-limit',
        'descriptor-limit'
      ])
      const control = cases.confirmedClose as any
      const failed = cases.failedClose as any
      expect(
        [
          control.captured,
          control.sameHandle,
          control.maxRoots,
          control.openingAtHold,
          control.heldProbe,
          control.publicAtHold,
          control.closeAttempts,
          control.confirmed,
          control.openingOriginalError,
          control.openingCleanupError,
          control.openingAggregate,
          control.publicOutcomes,
          control.samePublicError,
          control.firstCloseError,
          control.repeatExtraIo,
          control.postProbe,
          control.successorSettled
        ],
        'R07 confirmed-close control must prove the physical close and healthy successor'
      ).toEqual([
        true,
        true,
        1,
        'pending',
        'descriptor-limit',
        [],
        [1, 1, 1],
        1,
        true,
        false,
        [],
        ['fulfilled', 'fulfilled'],
        false,
        false,
        0,
        'admitted',
        true
      ])
      expect(
        [
          failed.captured,
          failed.sameHandle,
          failed.maxRoots,
          failed.openingAtHold,
          failed.heldProbe,
          failed.publicAtHold,
          failed.closeAttempts,
          failed.confirmed,
          failed.openingOriginalError,
          failed.openingCleanupError,
          failed.openingAggregate,
          failed.publicOutcomes,
          failed.samePublicError,
          failed.firstCloseError,
          failed.repeatExtraIo,
          failed.postProbe,
          failed.successorSettled
        ],
        'injected captured-root binder failure; injected captured-root directory close failure'
      ).toEqual([
        true,
        true,
        1,
        'pending',
        'descriptor-limit',
        ['pending', 'pending'],
        [1, 1, 1],
        0,
        true,
        true,
        ['bind', 'close'],
        ['rejected', 'rejected', 'rejected', 'rejected'],
        true,
        true,
        0,
        'descriptor-limit',
        null
      ])
    } finally {
      await custody.cleanup()
    }
  })
})

function snapshotIo(path: string): { lstat: number; unlink: number } {
  const existing = rootSettlementFaults.observedPaths.get(path)
  if (existing) return { ...existing }
  const counts = { lstat: 0, unlink: 0 }
  rootSettlementFaults.observedPaths.set(path, counts)
  return { ...counts }
}

function ioDelta(before: { lstat: number; unlink: number }, after: { lstat: number; unlink: number }): number {
  return after.lstat - before.lstat + after.unlink - before.unlink
}

function containsErrorIdentity(error: unknown, expected: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (error === expected) return true
  if (!(error instanceof AggregateError) || seen.has(error) || depth >= 8) return false
  seen.add(error)
  return Array.from(error.errors).some((member) => containsErrorIdentity(member, expected, seen, depth + 1))
}

async function differentRootProbe(
  roots: RootRegistry,
  scope: ReturnType<typeof authority>['scope'],
  meetingId: string,
  meetingPath: string,
  custody: ReturnType<typeof ownedCleanupCustody>
): Promise<{ outcome: string; successorSettled: boolean | null }> {
  custody.arm(meetingPath)
  let root: Awaited<ReturnType<RootRegistry['create']>>
  try {
    root = await roots.create(scope, meetingId)
  } catch (error) {
    return {
      outcome: error instanceof Error && /descriptor limit/i.test(error.message) ? 'descriptor-limit' : 'other',
      successorSettled: null
    }
  }
  const retained = custody.retainProbe(root)
  retained.cleanup = await roots.closeRoot(scope, root).then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  )
  return { outcome: 'admitted', successorSettled: retained.cleanup.status === 'fulfilled' ? true : null }
}

function makeR07Record(input: any): Record<string, unknown> {
  const openingError = input.openingResult?.error
  const openingErrors = openingError instanceof AggregateError ? Array.from(openingError.errors) : []
  const publicOutcomes = input.publicCalls.map((call: any) => call.status)
  return {
    captured: Boolean(input.captured),
    sameHandle: input.openedHandleMatches === true,
    maxRoots: input.owner.binding.maxHeldRoots,
    openingAtHold: input.openingAtHold,
    heldProbe: input.heldProbe.outcome,
    publicAtHold: input.heldCalls.length ? input.heldCalls.map((call: any) => call.status) : [],
    closeAttempts: input.afterCounts,
    confirmed: input.confirmed,
    openingOriginalError:
      input.failedBranch && openingError instanceof AggregateError
        ? Array.from(openingError.errors).includes(input.binderError)
        : openingError === input.binderError,
    openingCleanupError: Boolean(
      openingError instanceof AggregateError &&
        input.firstCloseError &&
        Array.from(openingError.errors).includes(input.firstCloseError)
    ),
    openingAggregate:
      openingErrors.length === 2 && openingErrors[0] === input.binderError && openingErrors[1] === input.firstCloseError
        ? ['bind', 'close']
        : [],
    publicOutcomes,
    samePublicError:
      input.publicCalls.length > 1 &&
      input.publicCalls.every((call: any) => call.status === 'rejected' && call.error === input.publicCalls[0].error),
    firstCloseError: Boolean(
      input.firstCloseError &&
        input.publicCalls.length > 0 &&
        input.publicCalls.every((call: any) => call.status === 'rejected' && call.error === input.firstCloseError)
    ),
    repeatExtraIo: input.repeatExtraIo,
    postProbe: input.postProbe.outcome,
    successorSettled: input.postProbe.successorSettled
  }
}
