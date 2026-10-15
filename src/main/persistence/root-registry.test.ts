import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type SettlementFixtureHandle = { close: () => Promise<void> }
type SettlementGate = {
  entered: Promise<void>
  notifyEntered: () => void
  wait: Promise<void>
  release: () => void
  error: string | undefined
  attempts: number
  raw: SettlementFixtureHandle | undefined
}

vi.mock('electron')

const rootSettlementFaults = vi.hoisted(() => ({
  closeGates: new Map<string, SettlementGate>()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
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
                if (gate.error) throw new Error(gate.error)
              }
              await target.close()
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
    raw: undefined
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
})
