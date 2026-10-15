import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { link, lstat, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron')

import { RootRegistry, type OwnedMeetingRoot, type RootScopeBinding } from './root-registry'
import { createProfileBoundLegacyFileKeyAccess } from './legacy-file-key'

const legacyStatGate = vi.hoisted(() => ({
  path: null as string | null,
  expectedDev: null as bigint | null,
  expectedIno: null as bigint | null,
  armed: false,
  held: false,
  entries: 0,
  rawStatCalls: 0,
  rawMatchesRoot: false,
  realStatCompleted: false,
  entered: null as (() => void) | null,
  enteredPromise: null as Promise<void> | null,
  release: null as (() => void) | null,
  released: null as Promise<void> | null
}))
const fixtureBridge = vi.hoisted(() => ({
  active: null as any,
  restore: null as null | (() => void),
  clear: null as null | (() => void)
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const owner = fixtureBridge.active as FixtureOwner | null
      const path = String(args[0])
      owner?.reserveOperation()
      const reservation = owner?.reserveOpen(path)
      const opened = actual.open(...args)
      owner?.observeReserved('raw-open', opened, 'work')
      let raw: Awaited<typeof opened>
      try {
        raw = await opened
      } catch (error) {
        if (reservation) owner?.settleOpen(reservation)
        throw error
      }
      const record = reservation ? owner?.adopt(reservation, path, raw) : undefined
      if (!owner || !record) return raw
      return new Proxy(raw, {
        get(target, property) {
          if (property === 'stat')
            return (...statArgs: Parameters<typeof target.stat>) => {
              owner.reserveOperation()
              owner.reserveOperation()
              const operation = target.stat(...statArgs)
              owner.observeReserved('handle-raw-stat', operation, 'work')
              const delivered = operation.then(async (result) => {
                record.stats.push({
                  dev: result.dev,
                  ino: result.ino,
                  directory: result.isDirectory(),
                  file: result.isFile()
                })
                if (legacyStatGate.path === path) {
                  legacyStatGate.rawStatCalls += 1
                  legacyStatGate.rawMatchesRoot =
                    legacyStatGate.expectedDev !== null &&
                    legacyStatGate.expectedIno !== null &&
                    result.dev === legacyStatGate.expectedDev &&
                    result.ino === legacyStatGate.expectedIno &&
                    result.isDirectory()
                  legacyStatGate.realStatCompleted = true
                }
                if (legacyStatGate.armed && legacyStatGate.path === path) {
                  legacyStatGate.armed = false
                  legacyStatGate.held = true
                  legacyStatGate.entries += 1
                  legacyStatGate.entered?.()
                  await legacyStatGate.released
                }
                return result
              })
              owner.observeReserved('handle-stat-delivery', delivered, 'work')
              return delivered
            }
          if (property === 'close')
            return (...closeArgs: Parameters<typeof target.close>) => {
              owner.reserveOperation('cleanup')
              if (record.closeCalls === 0 && target.fd < 0) {
                const error = fixtureError('descriptor already closed before first observed close')
                record.firstClose = { status: 'rejected', error }
                owner.fail(error)
                owner.observeReserved('first-raw-close', Promise.reject(error), 'cleanup')
                throw error
              }
              record.closeCalls += 1
              let operation: Promise<void>
              try {
                operation = target.close(...closeArgs)
              } catch (error) {
                operation = Promise.reject(error)
              }
              const observation = owner.observeReserved('first-raw-close', operation, 'cleanup')
              if (record.closeCalls === 1) {
                record.firstClosePromise = operation
                record.firstCloseObservation = observation
                void observation.settled.then((outcome) => {
                  record.firstClose = outcome
                })
              }
              return operation
            }
          const value = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value
          return (...methodArgs: unknown[]) => {
            owner.reserveOperation()
            let result: unknown
            try {
              result = Reflect.apply(value, target, methodArgs)
            } catch (error) {
              owner.observeReserved('handle-' + String(property), Promise.reject(error), 'work')
              throw error
            }
            owner.observeReserved('handle-' + String(property), Promise.resolve(result), 'work')
            return result
          }
        }
      })
    }
  }
})

type KeyOutcome = 'pending' | 'fulfilled' | 'rejected'
type FixtureResult<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; error: unknown }
type FixtureRole = 'work' | 'cleanup' | 'opaque'
type FixtureOperation<T> = {
  label: string
  role: FixtureRole
  duringFinalizer: boolean
  settled: Promise<FixtureResult<T>>
  outcome: FixtureResult<T> | null
}
type FixtureResource = {
  kind: 'base' | 'root' | 'writer' | 'key' | 'buffer'
  identity: object
  parent: FixtureResource | null
  cleanup: () => unknown
  attempts: FixtureOperation<unknown>[]
  confirmed: boolean
}
type RawHandleRecord = {
  path: string
  raw: import('node:fs/promises').FileHandle
  originalClose: () => Promise<void>
  closeCalls: number
  firstClosePromise: Promise<void> | null
  firstCloseObservation: FixtureOperation<void> | null
  firstClose: FixtureResult<void> | null
  rescueAttempts: number
  rescueConfirmed: boolean
  stats: Array<{ dev: number | bigint; ino: number | bigint; directory: boolean; file: boolean }>
}
type FixtureFinalization = {
  deadline: number
  bodyOutcome: FixtureResult<unknown> | null
  cleanupFailures: unknown[]
  physical: Promise<FixtureResult<void>>
  wait: Promise<FixtureResult<void>>
}
function fixtureError(message: string): Error {
  return new Error('K1 fixture custody failure: ' + message)
}
function distinctFailures(values: unknown[]): unknown[] {
  const result: unknown[] = []
  for (const value of values) if (!result.some((existing) => Object.is(existing, value))) result.push(value)
  return result
}
class FixtureOwner {
  readonly operations: FixtureOperation<unknown>[] = []
  readonly cleanupOperations: FixtureOperation<unknown>[] = []
  readonly handles: RawHandleRecord[] = []
  readonly resources: FixtureResource[] = []
  readonly reservations = { base: 0, root: 0, writer: 0, key: 0, buffer: 0 }
  readonly releases: Array<() => void> = []
  readonly byPromise = new WeakMap<Promise<unknown>, FixtureOperation<unknown>>()
  readonly stop: Promise<Error>
  private signalStop!: (error: Error) => void
  openReservations = 0
  ordinaryReservations = 0
  cleanupReservations = 0
  finalizerCleanupReservations = 0
  finalizing = false
  stopped = false
  sealed = false
  cleanupExpired = false
  failure: Error | null = null
  body: Promise<FixtureResult<unknown>> | null = null
  finalization: FixtureFinalization | null = null
  constructor(
    readonly context: object,
    readonly restore: () => void,
    readonly clear: () => void
  ) {
    this.stop = new Promise<Error>((resolve) => {
      this.signalStop = resolve
    })
  }
  fail(error: Error): void {
    this.failure ??= error
  }
  checkAdmission(): void {
    if (this.stopped || this.sealed) throw this.failure ?? fixtureError('operation admitted after fixture stop')
  }
  reserveOperation(role: FixtureRole = 'work'): void {
    const cleanup = role === 'cleanup'
    const count = this.finalizing
      ? this.finalizerCleanupReservations
      : cleanup
        ? this.cleanupReservations
        : this.ordinaryReservations
    if (count >= (this.finalizing || cleanup ? 128 : 512)) {
      const error = fixtureError((cleanup ? 'cleanup' : 'started-operation') + ' cap exceeded before operation')
      this.fail(error)
      throw error
    }
    if (this.finalizing) this.finalizerCleanupReservations += 1
    else if (cleanup) this.cleanupReservations += 1
    else this.ordinaryReservations += 1
  }
  observeReserved<T>(label: string, operation: Promise<T>, role: FixtureRole): FixtureOperation<T> {
    const record: FixtureOperation<T> = {
      label,
      role,
      duringFinalizer: this.finalizing,
      settled: null as unknown as Promise<FixtureResult<T>>,
      outcome: null
    }
    record.settled = operation.then<FixtureResult<T>, FixtureResult<T>>(
      (value) => {
        const outcome: FixtureResult<T> = { status: 'fulfilled', value }
        record.outcome = outcome
        return outcome
      },
      (error: unknown) => {
        const outcome: FixtureResult<T> = { status: 'rejected', error }
        record.outcome = outcome
        return outcome
      }
    )
    if (role === 'cleanup') this.cleanupOperations.push(record as FixtureOperation<unknown>)
    else this.operations.push(record as FixtureOperation<unknown>)
    this.byPromise.set(operation, record as FixtureOperation<unknown>)
    return record
  }
  start<T>(label: string, start: () => Promise<T> | T, role: FixtureRole = 'work', identity?: object): Promise<T> {
    if (role !== 'cleanup') this.checkAdmission()
    this.reserveOperation(role)
    let operation: Promise<T>
    try {
      operation = Promise.resolve(start())
    } catch (error) {
      operation = Promise.reject(error)
    }
    const record = this.observeReserved(label, operation, role)
    if (identity) {
      const resource = this.resources.find((item) => item.identity === identity)
      if (!resource) this.fail(fixtureError('cleanup owner missing for ' + label))
      else resource.attempts.push(record as FixtureOperation<unknown>)
    }
    return operation
  }
  record<T>(operation: Promise<T>): FixtureOperation<T> {
    const record = this.byPromise.get(operation)
    if (!record) throw fixtureError('started operation has no custody record')
    return record as FixtureOperation<T>
  }
  async awaitOperation<T>(operation: Promise<T>): Promise<T> {
    const outcome = await Promise.race([
      this.record(operation).settled.then((value) => ({ kind: 'operation' as const, value })),
      this.stop.then((error) => ({ kind: 'stop' as const, error }))
    ])
    if (outcome.kind === 'stop') throw outcome.error
    this.checkAdmission()
    if (outcome.value.status === 'rejected') throw outcome.value.error
    return outcome.value.value
  }
  async step<T>(label: string, start: () => Promise<T> | T, role: FixtureRole = 'work'): Promise<T> {
    return this.awaitOperation(this.start(label, start, role))
  }
  async stage(entered: Promise<unknown> | null, operation: FixtureOperation<unknown>, label: string): Promise<void> {
    if (!entered) throw fixtureError(label + ' entry was not registered')
    const winner = await Promise.race([
      entered.then(() => ({ kind: 'entered' as const })),
      operation.settled.then(() => ({ kind: 'ended' as const })),
      this.stop.then(() => ({ kind: 'stopped' as const }))
    ])
    if (winner.kind !== 'entered') throw fixtureError(label + ' ended or stopped before physical entry')
    this.checkAdmission()
  }
  reserveResource(kind: FixtureResource['kind']): void {
    this.checkAdmission()
    const limits = { base: 1, root: 8, writer: 8, key: 8, buffer: 16 }
    if (this.resources.filter((item) => item.kind === kind).length + this.reservations[kind] >= limits[kind]) {
      const error = fixtureError(kind + ' custody cap exceeded before acquisition')
      this.fail(error)
      throw error
    }
    this.reservations[kind] += 1
  }
  addResource(
    kind: FixtureResource['kind'],
    identity: object,
    cleanup: () => unknown,
    parent: object | null,
    reserved: boolean
  ): void {
    if (reserved) this.reservations[kind] -= 1
    else this.reserveResource(kind)
    const parentRecord = parent ? this.resources.find((item) => item.identity === parent) : null
    if (parent && !parentRecord) this.fail(fixtureError('matching parent owner missing for ' + kind))
    this.resources.push({ kind, identity, cleanup, parent: parentRecord ?? null, attempts: [], confirmed: false })
  }
  reserveOpen(path: string): { path: string; pending: boolean } {
    if (this.handles.length + this.openReservations >= 64) {
      const error = fixtureError('raw-handle cap exceeded before open')
      this.fail(error)
      throw error
    }
    this.openReservations += 1
    return { path, pending: true }
  }
  settleOpen(reservation: { path: string; pending: boolean }): void {
    if (reservation.pending) {
      reservation.pending = false
      this.openReservations -= 1
    }
  }
  adopt(
    reservation: { path: string; pending: boolean },
    path: string,
    raw: import('node:fs/promises').FileHandle
  ): RawHandleRecord {
    this.settleOpen(reservation)
    const record: RawHandleRecord = {
      path,
      raw,
      originalClose: raw.close.bind(raw),
      closeCalls: 0,
      firstClosePromise: null,
      firstCloseObservation: null,
      firstClose: null,
      rescueAttempts: 0,
      rescueConfirmed: false,
      stats: []
    }
    this.handles.push(record)
    return record
  }
  addRelease(release: () => void): void {
    if (this.releases.length >= 8) {
      const error = fixtureError('gate-release cap exceeded')
      this.fail(error)
      throw error
    }
    let released = false
    const once = () => {
      if (!released) {
        released = true
        release()
      }
    }
    this.releases.push(once)
    if (this.stopped || this.sealed) once()
  }
  requestStop(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.fail(error)
    for (const release of this.releases) release()
    this.signalStop(error)
    if (this.body) void this.finalize().wait.then(() => undefined)
  }
  private async drain(): Promise<void> {
    let count = -1
    while (count !== this.operations.length + this.cleanupOperations.length) {
      count = this.operations.length + this.cleanupOperations.length
      await Promise.all([...this.operations, ...this.cleanupOperations].map((item) => item.settled))
    }
  }
  private async physicalCleanup(): Promise<void> {
    this.finalizing = true
    this.sealed = true
    for (const release of this.releases) release()
    const failures = this.finalization!.cleanupFailures
    const body = await this.body
    this.finalization!.bodyOutcome = body
    if (!body) failures.push(fixtureError('actual body missing from finalizer'))
    await this.drain()
    for (const operation of this.operations) {
      if ((operation.role === 'opaque' || operation.duringFinalizer) && operation.outcome?.status === 'rejected')
        failures.push(operation.outcome.error)
    }
    const order: FixtureResource['kind'][] = ['key', 'writer', 'root', 'buffer']
    for (const kind of order) {
      for (const resource of this.resources.filter((item) => item.kind === kind).reverse()) {
        const failedChild = this.resources.some((item) => item.parent === resource && !item.confirmed)
        if (failedChild) {
          failures.push(fixtureError(kind + ' retained after dependent child failure'))
          continue
        }
        if (!resource.attempts.length) {
          try {
            this.start('final-' + kind, resource.cleanup, 'cleanup', resource.identity)
          } catch (error) {
            failures.push(error)
            continue
          }
        }
        await this.drain()
        const outcomes = await Promise.all(resource.attempts.map((item) => item.settled))
        for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.error)
        resource.confirmed = outcomes.length > 0 && outcomes.every((item) => item.status === 'fulfilled')
      }
    }
    for (const handle of this.handles) {
      if (handle.firstCloseObservation) handle.firstClose = await handle.firstCloseObservation.settled
      if (handle.firstClose?.status === 'rejected') failures.push(handle.firstClose.error)
      if (
        handle.closeCalls === 0 &&
        handle.raw.fd >= 0 &&
        !handle.rescueAttempts &&
        this.resources.every((resource) => resource.kind === 'base' || resource.kind === 'buffer' || resource.confirmed)
      ) {
        handle.rescueAttempts += 1
        try {
          const rescue = this.start('raw-rescue', handle.originalClose, 'cleanup')
          const outcome = await this.record(rescue).settled
          if (outcome.status === 'rejected') failures.push(outcome.error)
          else {
            handle.rescueConfirmed = true
            failures.push(fixtureError('unexpected raw handle rescue required'))
          }
        } catch (error) {
          failures.push(error)
        }
      }
      if (handle.closeCalls > 1) failures.push(fixtureError('duplicate delegated raw close observed'))
      if (handle.firstClose?.status !== 'fulfilled') failures.push(fixtureError('raw physical close is unconfirmed'))
    }
    await this.drain()
    if (this.openReservations !== 0 || Object.values(this.reservations).some((value) => value !== 0))
      failures.push(fixtureError('pending acquisition reservation retained'))
    for (const operation of this.cleanupOperations)
      if (operation.outcome?.status === 'rejected') failures.push(operation.outcome.error)
    if (this.failure) failures.push(this.failure)
    if (this.cleanupExpired || Date.now() >= this.finalization!.deadline)
      failures.push(fixtureError('shared cleanup budget expired; fixture directory retained'))
    if (failures.length === 0) {
      try {
        this.restore()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 0) {
      try {
        this.clear()
      } catch (error) {
        failures.push(error)
      }
    }
    if (this.cleanupExpired || Date.now() >= this.finalization!.deadline)
      failures.push(fixtureError('shared cleanup budget expired; fixture directory retained'))
    const bases = this.resources.filter((item) => item.kind === 'base')
    if (failures.length === 0) {
      for (const base of bases) {
        try {
          const operation = this.start('fixture-directory-remove', base.cleanup, 'cleanup', base.identity)
          const outcome = await this.record(operation).settled
          if (outcome.status === 'rejected') failures.push(outcome.error)
          else base.confirmed = true
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (this.cleanupExpired || Date.now() >= this.finalization!.deadline)
      failures.push(fixtureError('shared cleanup budget expired; fixture directory retained'))
    if (failures.length) {
      const reasons = distinctFailures([...(body?.status === 'rejected' ? [body.error] : []), ...failures])
      throw new AggregateError(reasons, 'K1 fixture finalization failed; owned resources are retained')
    }
    fixtureBridge.active = null
    fixturesByContext.delete(this.context)
  }
  finalize(): FixtureFinalization {
    if (this.finalization) return this.finalization
    const deadline = Date.now() + 10_000
    const record = {
      deadline,
      bodyOutcome: null as FixtureResult<unknown> | null,
      cleanupFailures: [] as unknown[],
      physical: null as unknown as Promise<FixtureResult<void>>,
      wait: null as unknown as Promise<FixtureResult<void>>
    }
    this.finalization = record
    if (this.body)
      void this.body.then((outcome) => {
        record.bodyOutcome = outcome
      })
    record.physical = this.physicalCleanup().then<FixtureResult<void>, FixtureResult<void>>(
      (): FixtureResult<void> => ({ status: 'fulfilled', value: undefined }),
      (error: unknown): FixtureResult<void> => ({ status: 'rejected', error })
    )
    let timer: ReturnType<typeof setTimeout>
    const expired = new Promise<FixtureResult<void>>((resolve) => {
      timer = setTimeout(() => {
        this.cleanupExpired = true
        const error = fixtureError('10-second shared cleanup budget expired')
        this.fail(error)
        this.requestStop(error)
        const observedFailures: unknown[] = []
        for (const operation of this.operations)
          if ((operation.role === 'opaque' || operation.duringFinalizer) && operation.outcome?.status === 'rejected')
            observedFailures.push(operation.outcome.error)
        for (const kind of ['key', 'writer', 'root', 'buffer'] as const)
          for (const resource of this.resources.filter((item) => item.kind === kind).reverse())
            for (const attempt of resource.attempts)
              if (attempt.outcome?.status === 'rejected') observedFailures.push(attempt.outcome.error)
        for (const handle of this.handles)
          if (handle.firstCloseObservation?.outcome?.status === 'rejected')
            observedFailures.push(handle.firstCloseObservation.outcome.error)
        for (const operation of this.cleanupOperations)
          if (operation.outcome?.status === 'rejected') observedFailures.push(operation.outcome.error)
        const reasons = distinctFailures([
          ...(record.bodyOutcome?.status === 'rejected' ? [record.bodyOutcome.error] : []),
          ...record.cleanupFailures,
          ...observedFailures,
          ...(this.failure ? [this.failure] : []),
          error
        ])
        resolve({
          status: 'rejected',
          error: new AggregateError(reasons, 'K1 fixture finalization expired; owned resources are retained')
        })
      }, 10_000)
    })
    record.wait = Promise.race([record.physical, expired]).then((outcome) => {
      clearTimeout(timer)
      return outcome
    })
    return record
  }
}
const fixturesByContext = new WeakMap<object, FixtureOwner>()
function activeFixture(): FixtureOwner {
  const owner = fixtureBridge.active as FixtureOwner | null
  if (!owner) throw fixtureError('fixture owner missing')
  return owner
}
function fixtureResource(
  kind: FixtureResource['kind'],
  identity: object,
  cleanup: () => unknown,
  parent: object | null = null,
  reserved = false
): void {
  activeFixture().addResource(kind, identity, cleanup, parent, reserved)
}
function fixtureRelease(release: () => void): void {
  activeFixture().addRelease(release)
}
function fixtureStart<T>(
  label: string,
  start: () => Promise<T> | T,
  role: FixtureRole = 'work',
  identity?: object
): Promise<T> {
  return activeFixture().start(label, start, role, identity)
}
function fixtureStep<T>(label: string, start: () => Promise<T> | T, role: FixtureRole = 'work'): Promise<T> {
  return activeFixture().step(label, start, role)
}
function fixtureCleanup<T>(identity: object, label: string, start: () => Promise<T> | T): Promise<T> {
  activeFixture().checkAdmission()
  return fixtureStart(label, start, 'cleanup', identity)
}
function fixtureWait<T>(operation: Promise<T>): Promise<T> {
  return activeFixture().awaitOperation(operation)
}
async function fixtureJoinObserved<T>(observation: Promise<T>): Promise<T> {
  const owner = activeFixture()
  const winner = await Promise.race([
    observation.then((value) => ({ kind: 'observed' as const, value })),
    owner.stop.then((error) => ({ kind: 'stopped' as const, error }))
  ])
  if (winner.kind === 'stopped') throw winner.error
  owner.checkAdmission()
  return winner.value
}
function fixtureStage(
  entered: Promise<unknown> | null,
  operation: FixtureOperation<unknown>,
  label: string
): Promise<void> {
  return activeFixture().stage(entered, operation, label)
}
function requireLegacyRetirement(status: KeyOutcome, error: unknown): void {
  expect(status).toBe('rejected')
  expect(error instanceof Error && Object.getPrototypeOf(error) === Error.prototype).toBe(true)
  expect((error as Error).message).toMatch(/^Legacy profile key lease (is retired|was retired during use)$/)
}
function observeKeyOperation<T>(operation: Promise<T>, fulfilled?: () => void) {
  const owner = activeFixture()
  const record = owner.record(operation)
  owner.reserveOperation()
  const settled = record.settled.then((outcome) => {
    if (outcome.status === 'fulfilled' && fulfilled) {
      try {
        fulfilled()
      } catch (error) {
        owner.fail(error instanceof Error ? error : fixtureError('fulfillment observer failed'))
      }
    }
    return outcome
  })
  owner.observeReserved('key-outcome-observer', settled, 'work')
  return {
    settled,
    record,
    status: (): KeyOutcome => record.outcome?.status ?? 'pending',
    error: (): unknown => (record.outcome?.status === 'rejected' ? record.outcome.error : undefined)
  }
}
async function runFixture<T>(context: { signal: AbortSignal }, body: () => Promise<T>): Promise<T> {
  if (fixtureBridge.active) throw fixtureError('previous case still owns the module slot')
  const owner = new FixtureOwner(
    context,
    fixtureBridge.restore ?? (() => undefined),
    fixtureBridge.clear ?? (() => undefined)
  )
  fixtureBridge.active = owner
  fixturesByContext.set(context, owner)
  const abort = () => owner.requestStop(fixtureError('test runner aborted the case'))
  context.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => owner.requestStop(fixtureError('15-second body watchdog expired')), 15_000)
  const actual = Promise.resolve().then(() => {
    owner.checkAdmission()
    return body()
  })
  owner.body = actual.then<FixtureResult<T>, FixtureResult<T>>(
    (value) => ({ status: 'fulfilled', value }),
    (error: unknown) => ({ status: 'rejected', error })
  )
  void owner.body.then(() => {
    clearTimeout(timer)
  })
  if (context.signal.aborted) abort()
  const winner = await Promise.race([
    owner.body.then((outcome) => ({ kind: 'body' as const, outcome })),
    owner.stop.then((error) => ({ kind: 'stop' as const, error }))
  ])
  const finalization = owner.finalize()
  const finalOutcome = await finalization.wait
  if (!owner.cleanupExpired) context.signal.removeEventListener('abort', abort)
  ownerReported.add(owner)
  if (finalOutcome.status === 'rejected') throw finalOutcome.error
  if (winner.kind === 'stop') throw winner.error
  if (winner.outcome.status === 'rejected') throw winner.outcome.error
  const value = winner.outcome.value as T
  if (typeof value === 'function') (value as () => void)()
  return value
}
const ownerReported = new WeakSet<FixtureOwner>()
async function finalizeFixture(context: object): Promise<void> {
  const owner = fixturesByContext.get(context)
  if (!owner) return
  const outcome = await owner.finalize().wait
  if (outcome.status === 'rejected' && !ownerReported.has(owner)) throw outcome.error
}
async function rootCloseWitness(owner: FixtureOwner, path: string, dev: number | bigint, ino: number | bigint) {
  const matches = owner.handles.filter(
    (record) =>
      record.path === path &&
      record.stats.some(
        (stat) => stat.directory && BigInt(stat.dev) === BigInt(dev) && BigInt(stat.ino) === BigInt(ino)
      )
  )
  if (matches.length !== 1) throw fixtureError('selected root raw handle identity is ambiguous')
  const record = matches[0]
  if (record.firstCloseObservation) record.firstClose = await record.firstCloseObservation.settled
  if (!record.firstClose || record.firstClose.status !== 'fulfilled' || record.closeCalls !== 1)
    throw fixtureError('selected root first raw close was not uniquely confirmed')
  return { attempts: record.closeCalls, confirmed: 1 }
}
async function writerCloseWitness(owner: FixtureOwner, path: string) {
  const matches = owner.handles.filter((record) => record.path === path && record.stats.some((stat) => stat.file))
  if (matches.length !== 1) throw fixtureError('selected writer raw handle identity is ambiguous')
  const record = matches[0]
  if (record.firstCloseObservation) record.firstClose = await record.firstCloseObservation.settled
  if (!record.firstClose || record.firstClose.status !== 'fulfilled' || record.closeCalls !== 1)
    throw fixtureError('selected writer first raw handle close was not uniquely confirmed')
  return { attempts: record.closeCalls, confirmed: 1 }
}

function armLegacyGate(root: import('./root-registry').OwnedMeetingRoot) {
  let entered!: () => void
  let release!: () => void
  legacyStatGate.path = root.meetingPath
  legacyStatGate.expectedDev = BigInt(root.version.device)
  legacyStatGate.expectedIno = BigInt(root.version.inode)
  legacyStatGate.armed = true
  legacyStatGate.held = false
  legacyStatGate.entries = 0
  legacyStatGate.rawStatCalls = 0
  legacyStatGate.rawMatchesRoot = false
  legacyStatGate.realStatCompleted = false
  legacyStatGate.enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  legacyStatGate.entered = entered
  legacyStatGate.released = new Promise<void>((resolve) => {
    release = resolve
  })
  legacyStatGate.release = release
  fixtureRelease(release)
}

function resetLegacyGate() {
  legacyStatGate.path = null
  legacyStatGate.expectedDev = null
  legacyStatGate.expectedIno = null
  legacyStatGate.armed = false
  legacyStatGate.held = false
  legacyStatGate.entries = 0
  legacyStatGate.rawStatCalls = 0
  legacyStatGate.rawMatchesRoot = false
  legacyStatGate.realStatCompleted = false
  legacyStatGate.entered = null
  legacyStatGate.enteredPromise = null
  legacyStatGate.release = null
  legacyStatGate.released = null
}

describe('profile-bound legacy file-key access', () => {
  let base: string | undefined
  const rootsForCleanup: Array<{ registry: RootRegistry; scope: object; root: OwnedMeetingRoot }> = []
  const ownRoot = (registry: RootRegistry, scope: object, root: OwnedMeetingRoot, reserved = false) => {
    rootsForCleanup.push({ registry, scope, root })
    fixtureResource('root', root, () => registry.closeRoot(scope, root), null, reserved)
    return root
  }
  const ownLease = <T extends { dispose(): Promise<void> }>(lease: T, root: OwnedMeetingRoot, reserved = false): T => {
    fixtureResource('key', lease, () => lease.dispose(), root, reserved)
    return lease
  }
  const adoptFixtureResource = <T>(
    kind: 'root' | 'key',
    label: string,
    start: () => Promise<T>,
    adopt: (value: T) => T
  ): Promise<T> => {
    const owner = fixtureBridge.active as FixtureOwner | null
    owner?.reserveResource(kind)
    try {
      return fixtureStart(label, async () => {
        try {
          return adopt(await start())
        } catch (error) {
          if (owner) owner.reservations[kind] -= 1
          throw error
        }
      })
    } catch (error) {
      if (owner) owner.reservations[kind] -= 1
      throw error
    }
  }
  const createOwnedRoot = (registry: RootRegistry, scope: object, meetingId: string) =>
    adoptFixtureResource(
      'root',
      'root-create',
      () => registry.create(scope, meetingId),
      (root) => ownRoot(registry, scope, root, true)
    )
  const openOwnedRoot = (registry: RootRegistry, scope: object, meetingId: string) =>
    adoptFixtureResource(
      'root',
      'root-open',
      () => registry.openExisting(scope, meetingId),
      (root) => ownRoot(registry, scope, root, true)
    )
  const openOwnedLease = <T extends { dispose(): Promise<void> }>(start: () => Promise<T>, root: OwnedMeetingRoot) =>
    adoptFixtureResource('key', 'legacy-key-open', start, (lease) => ownLease(lease, root, true))
  const createOwnedBase = (prefix: string): Promise<string> => {
    const owner = fixtureBridge.active as FixtureOwner | null
    owner?.reserveResource('base')
    try {
      return fixtureStart('fixture-base', async () => {
        try {
          const path = await mkdtemp(prefix)
          base = path
          fixtureResource('base', { path }, () => rm(path, { recursive: true, force: true }), null, true)
          return path
        } catch (error) {
          if (owner) owner.reservations.base -= 1
          throw error
        }
      })
    } catch (error) {
      if (owner) owner.reservations.base -= 1
      throw error
    }
  }

  fixtureBridge.restore = () => undefined
  fixtureBridge.clear = () => {
    rootsForCleanup.length = 0
    base = undefined
    resetLegacyGate()
  }
  afterEach(async (context) => finalizeFixture(context))

  async function runLegacyCase(context: { signal: AbortSignal }, caseId: 'K05' | 'K06' | 'K07' | 'K08') {
    return runFixture(context, async () => {
      base = await fixtureWait(createOwnedBase(join(tmpdir(), 'metis-' + caseId.toLowerCase() + '-')))
      const scope = Object.freeze({})
      const binding: RootScopeBinding = Object.freeze({
        profileNamespace: 'profile-' + caseId,
        principalAssociation: 'principal-' + caseId,
        generation: 'generation-' + caseId,
        nativeKeyAccess: 'allowed',
        legacyFileKeyAccess: 'authorized',
        maxHeldRoots: 4,
        isCurrent: () => true
      })
      const roots = new RootRegistry({
        userDataRoot: () => base!,
        resolveScope: (candidate) => (candidate === scope ? binding : undefined),
        bindGatewayRoot: async () => undefined
      })
      const root = await fixtureWait(createOwnedRoot(roots, scope, 'meeting-' + caseId))
      activeFixture().reserveResource('buffer')
      const keyBytes = Buffer.alloc(32, 0x5a)
      fixtureResource('buffer', keyBytes, () => keyBytes.fill(0), null, true)
      await fixtureStep(
        'path-write-secret',
        () => writeFile(join(base!, 'secret-key.bin'), keyBytes, { mode: 0o600 }),
        'opaque'
      )
      const access = createProfileBoundLegacyFileKeyAccess({ roots })
      const lease = await fixtureWait(openOwnedLease(() => access.open(scope, root), root))
      const keyReady = lease.keyBinding !== null
      let releaseCallback!: () => void
      let enterCallback!: () => void
      const callbackEntered = new Promise<void>((resolve) => {
        enterCallback = resolve
      })
      const callbackWait = new Promise<void>((resolve) => {
        releaseCallback = resolve
      })
      fixtureRelease(releaseCallback)
      const callbackError = new Error(caseId + ' injected legacy callback refusal')
      let borrow: Uint8Array | undefined
      let callbackCalls = 0
      let callbackCompleted = false
      let lateCallbackCalls = 0
      let rootCloseAttempts = 0
      let rootCloseConfirmed = 0
      let checkpoint = false
      let observedDisposals: KeyOutcome[] = []
      let observedOperation: KeyOutcome = 'pending'
      let observedCallbackCompleted = false
      let observedBorrow: 'absent' | 'nonzero' | 'zero' = 'absent'
      let lateUseStatus: KeyOutcome = 'pending'
      let repeatStatus: KeyOutcome = 'pending'
      let postUseBorrowAtDisposal: 'nonzero' | 'zero' | null = null
      let physicalHeld = false
      let physicalEntries = 0
      let rawMatchesRoot = false
      let realStatCompleted = false
      let extraPhysicalChecks = 0
      let disposals: ReturnType<typeof observeKeyOperation<void>>[] = []
      let useObserver: ReturnType<typeof observeKeyOperation<number>>
      try {
        if (caseId === 'K05') armLegacyGate(root)
        else {
          legacyStatGate.path = root.meetingPath
          legacyStatGate.expectedDev = BigInt(root.version.device)
          legacyStatGate.expectedIno = BigInt(root.version.inode)
        }
        const use = fixtureStart('key-use', () =>
          lease.withKey(async (owned) => {
            callbackCalls += 1
            borrow = owned
            assert(
              owned.byteLength === 32 && owned.some((byte) => byte !== 0),
              caseId + ' callback received a live 32-byte borrow'
            )
            if (caseId === 'K06') {
              enterCallback()
              await callbackWait
              callbackCompleted = true
              return owned.byteLength
            }
            if (caseId === 'K07') {
              callbackCompleted = true
              armLegacyGate(root)
              enterCallback()
              return owned.byteLength
            }
            if (caseId === 'K08') {
              callbackCompleted = true
              throw callbackError
            }
            callbackCompleted = true
            return owned.byteLength
          })
        )
        useObserver = observeKeyOperation(use)
        if (caseId === 'K05') {
          await fixtureStage(legacyStatGate.enteredPromise, useObserver.record, 'legacy admission')
          physicalHeld = true
        } else if (caseId === 'K06') {
          await fixtureStage(callbackEntered, useObserver.record, 'legacy callback')
        } else if (caseId === 'K07') {
          await fixtureStage(callbackEntered, useObserver.record, 'legacy callback')
          await fixtureStage(legacyStatGate.enteredPromise, useObserver.record, 'legacy post-use')
          physicalHeld = true
        } else {
          await fixtureJoinObserved(useObserver.settled)
          expect(useObserver.error()).toBe(callbackError)
          expect([...borrow!]).toEqual(Array.from({ length: 32 }, () => 0))
        }
        const first = fixtureCleanup(lease, 'key-first-dispose', () => lease.dispose())
        const second = fixtureCleanup(lease, 'key-second-dispose', () => lease.dispose())
        disposals = [
          observeKeyOperation(
            first,
            caseId === 'K07'
              ? () => {
                  postUseBorrowAtDisposal = borrow!.some((byte) => byte !== 0) ? 'nonzero' : 'zero'
                }
              : undefined
          ),
          observeKeyOperation(second)
        ]
        const beforeLate = legacyStatGate.rawStatCalls
        const lateUse = observeKeyOperation(
          fixtureStart('key-late-use', () =>
            lease.withKey(async () => {
              lateCallbackCalls += 1
              return 1
            })
          )
        )
        if (caseId !== 'K08') {
          await fixtureStep('checkpoint-lstat', () => lstat(join(root.legacyProfilePath, 'secret-key.bin')))
          checkpoint = true
        }
        await fixtureJoinObserved(lateUse.settled)
        requireLegacyRetirement(lateUse.status(), lateUse.error())
        lateUseStatus = lateUse.status()
        extraPhysicalChecks += legacyStatGate.rawStatCalls - beforeLate
        if (caseId === 'K08') {
          expect(legacyStatGate.rawStatCalls).toBe(beforeLate)
          await fixtureStep('checkpoint-lstat', () => lstat(join(root.legacyProfilePath, 'secret-key.bin')))
          checkpoint = true
        }
        observedDisposals = disposals.map((item) => item.status())
        observedOperation = useObserver.status()
        observedCallbackCompleted = callbackCompleted
        observedBorrow = borrow ? (borrow.some((byte) => byte !== 0) ? 'nonzero' : 'zero') : 'absent'
        if (caseId === 'K05' || caseId === 'K07') legacyStatGate.release?.()
        if (caseId === 'K06') releaseCallback()
        await fixtureJoinObserved(useObserver.settled)
        const disposalResults = await fixtureJoinObserved(Promise.all(disposals.map((item) => item.settled)))
        for (const outcome of disposalResults) if (outcome.status === 'rejected') throw outcome.error
        if (caseId === 'K07') expect(postUseBorrowAtDisposal).not.toBeNull()
        const beforeRepeat = legacyStatGate.rawStatCalls
        const repeat = observeKeyOperation(fixtureCleanup(lease, 'key-repeat-dispose', () => lease.dispose()))
        const repeatOutcome = await fixtureJoinObserved(repeat.settled)
        if (repeatOutcome.status === 'rejected') throw repeatOutcome.error
        expect(repeat.status()).toBe('fulfilled')
        repeatStatus = repeat.status()
        extraPhysicalChecks += legacyStatGate.rawStatCalls - beforeRepeat
        expect(legacyStatGate.entries).toBe(caseId === 'K05' || caseId === 'K07' ? 1 : 0)
        if (caseId === 'K08') expect(useObserver.error()).toBe(callbackError)
        else requireLegacyRetirement(useObserver.status(), useObserver.error())
        if (caseId === 'K05') {
          expect(callbackCalls).toBe(0)
          expect(borrow).toBeUndefined()
        } else {
          expect(borrow).toBeInstanceOf(Uint8Array)
          expect(borrow?.byteLength).toBe(32)
          expect([...borrow!]).toEqual(Array.from({ length: 32 }, () => 0))
        }
        expect(lateCallbackCalls).toBe(0)
        rawMatchesRoot = legacyStatGate.rawMatchesRoot
        realStatCompleted = legacyStatGate.realStatCompleted
        physicalEntries = legacyStatGate.entries
        keyBytes.fill(0)
        await fixtureWait(fixtureCleanup(root, 'root-close', () => roots.closeRoot(scope, root)))
        const rootClose = await rootCloseWitness(
          activeFixture(),
          root.meetingPath,
          root.version.device,
          root.version.inode
        )
        rootCloseAttempts = rootClose.attempts
        rootCloseConfirmed = rootClose.confirmed
      } finally {
        legacyStatGate.release?.()
        releaseCallback()
      }
      const stage =
        caseId === 'K05'
          ? 'admission'
          : caseId === 'K06'
            ? 'callback'
            : caseId === 'K07'
              ? 'post-use'
              : 'completed-refusal'
      const evidence = {
        caseId,
        stage,
        keyReady,
        physical: { rawMatchesRoot, realStatCompleted, held: physicalHeld, entries: physicalEntries },
        observed: {
          operation: observedOperation,
          callbackCalls,
          callbackCompleted: observedCallbackCompleted,
          borrow: observedBorrow,
          disposals: observedDisposals,
          checkpoint
        },
        settled: {
          use: caseId === 'K08' && useObserver!.error() === callbackError ? 'callback-error' : 'retired',
          originalCallbackError: useObserver!.error() === callbackError,
          callbackCalls,
          borrow: caseId === 'K05' ? 'absent' : 'zero',
          disposals: disposals.map((item) => item.status()),
          repeat: repeatStatus,
          lateUse: lateUseStatus === 'rejected' ? 'retired' : lateUseStatus,
          lateCallbackCalls,
          extraPhysicalChecks
        },
        postUseBorrowAtDisposal,
        parents: { writerCloseAttempts: 0, writerCloseConfirmed: 0, rootCloseAttempts, rootCloseConfirmed }
      }
      activeFixture().checkAdmission()
      console.info('PERSISTENCE_SETTLEMENT_EVIDENCE ' + JSON.stringify(evidence))
      return () => {
        if (caseId === 'K05')
          assert(
            observedDisposals.every((status) => status === 'pending'),
            'K05 complete legacy admission must settle before key disposal'
          )
        else if (caseId === 'K07')
          assert(
            observedDisposals.every((status) => status === 'pending') && postUseBorrowAtDisposal === 'zero',
            'K07 legacy post-use physical check and borrowed wipe must precede key disposal'
          )
        else expect(observedDisposals).toEqual(caseId === 'K08' ? ['fulfilled', 'fulfilled'] : ['pending', 'pending'])
      }
    })
  }

  it('reads only an admitted original profile, with no process-global cached key', async (context) =>
    runFixture(context, async () => {
      base = await fixtureWait(createOwnedBase(join(tmpdir(), 'metis-legacy-key-')))
      const scopes = new WeakMap<object, RootScopeBinding>()
      const owner = (profileNamespace: string, allowed: 'authorized' | 'denied') => {
        const scope = Object.freeze({})
        const binding: RootScopeBinding = Object.freeze({
          profileNamespace,
          principalAssociation: `principal-${profileNamespace}`,
          generation: `generation-${profileNamespace}`,
          nativeKeyAccess: 'allowed',
          legacyFileKeyAccess: allowed,
          maxHeldRoots: 4,
          isCurrent: () => true
        })
        scopes.set(scope, binding)
        return scope
      }
      const roots = new RootRegistry({
        userDataRoot: () => base!,
        resolveScope: (scope) => scopes.get(scope),
        bindGatewayRoot: async () => undefined
      })
      const originalScope = owner('profile-original', 'authorized')
      const originalRoot = await fixtureWait(createOwnedRoot(roots, originalScope, 'meeting-original'))
      activeFixture().reserveResource('buffer')
      const legacyKey = Buffer.alloc(32, 0x5a)
      fixtureResource('buffer', legacyKey, () => legacyKey.fill(0), null, true)
      const legacyPath = join(base, 'secret-key.bin')
      await fixtureStep('path-write-legacy', () => writeFile(legacyPath, legacyKey, { mode: 0o600 }), 'opaque')

      const access = createProfileBoundLegacyFileKeyAccess({ roots })
      const lease = await fixtureWait(openOwnedLease(() => access.open(originalScope, originalRoot), originalRoot))
      let supplied: Uint8Array | undefined
      await fixtureStep('legacy-use', () =>
        lease.withKey((key) => {
          supplied = key
          expect(Object.getPrototypeOf(key)).toBe(Uint8Array.prototype)
          expect(key.byteLength).toBe(32)
          expect(Buffer.from(key)).toEqual(legacyKey)
        })
      )
      expect([...supplied!]).toEqual(Array.from({ length: 32 }, () => 0))

      const otherScope = owner('profile-other', 'denied')
      const otherRoot = await fixtureWait(createOwnedRoot(roots, otherScope, 'meeting-other'))
      await expect(
        fixtureWait(openOwnedLease(() => access.open(otherScope, originalRoot), originalRoot))
      ).rejects.toThrow(/capability unavailable/i)
      await expect(fixtureWait(openOwnedLease(() => access.open(otherScope, otherRoot), otherRoot))).rejects.toThrow(
        /no admitted origin/i
      )
      await expect(fixtureStep('path-read-legacy', () => readFile(legacyPath), 'opaque')).resolves.toEqual(legacyKey)
      await fixtureWait(fixtureCleanup(lease, 'legacy-dispose', () => lease.dispose()))

      const alias = join(base, 'foreign-legacy-key-alias')
      await fixtureStep('path-link-legacy', () => link(legacyPath, alias))
      await expect(
        fixtureWait(openOwnedLease(() => access.open(originalScope, originalRoot), originalRoot))
      ).rejects.toThrow(/absent or invalid/i)
      await fixtureStep('path-unlink-legacy', () => unlink(alias))
    }))

  it('joins legacy key admission before disposing the key owner', async (context) => runLegacyCase(context, 'K05'))
  it('keeps legacy key disposal pending while the admitted callback is held', async (context) =>
    runLegacyCase(context, 'K06'))
  it('joins legacy key post-use checks and wipes before disposal completes', async (context) =>
    runLegacyCase(context, 'K07'))
  it('disposes a legacy key after a physically completed callback refusal', async (context) =>
    runLegacyCase(context, 'K08'))
})
