import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { link, lstat, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RootRegistry, type OwnedMeetingRoot, type RootScopeBinding } from './root-registry'
import { createProtectedMeetingKeys, type NativeKeyStore } from './protected-meeting-keys'
import type { MeetingSpeechPersistenceService } from '../infra/process/meeting-speech-host'

const aclHarness = vi.hoisted(() => ({
  prepare: null as ((path: string) => Promise<boolean>) | null,
  verify: null as ((path: string) => Promise<boolean>) | null
}))
const fixtureBridge = vi.hoisted(() => ({
  active: null as any,
  restore: null as null | (() => void),
  clear: null as null | (() => void)
}))
const keyStatGate = vi.hoisted(() => ({
  path: null as string | null,
  expectedDev: null as bigint | null,
  expectedIno: null as bigint | null,
  armed: false,
  rejectDelivery: false,
  failure: null as Error | null,
  rawMatchesRoot: false,
  realStatCompleted: false,
  rawObserved: false,
  entries: 0,
  rawStatCalls: 0,
  entered: null as (() => void) | null,
  enteredPromise: null as Promise<void> | null,
  release: null as (() => void) | null,
  released: null as Promise<void> | null
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
                if (keyStatGate.path === path) {
                  keyStatGate.rawStatCalls += 1
                  keyStatGate.rawMatchesRoot =
                    keyStatGate.expectedDev !== null &&
                    keyStatGate.expectedIno !== null &&
                    result.dev === keyStatGate.expectedDev &&
                    result.ino === keyStatGate.expectedIno &&
                    result.isDirectory()
                  keyStatGate.realStatCompleted = true
                  keyStatGate.rawObserved = true
                }
                if (keyStatGate.armed && keyStatGate.path === path) {
                  keyStatGate.armed = false
                  keyStatGate.entries += 1
                  keyStatGate.entered?.()
                  await keyStatGate.released
                  if (keyStatGate.rejectDelivery) throw keyStatGate.failure
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
vi.mock('../win-security', () => ({
  preparePrivateCurrentUserAcl: (path: string) => aclHarness.prepare?.(path) ?? Promise.resolve(true),
  verifyPrivateCurrentUserAcl: (path: string) => aclHarness.verify?.(path) ?? Promise.resolve(true)
}))

const marker = Buffer.from('ATKENC2\n')
const mockNativeMaster = Buffer.alloc(32, 0x71)
const REAL_PLATFORM = process.platform

function authority(generation: string, scopes = new WeakMap<object, RootScopeBinding>()) {
  let active = true
  const scope = Object.freeze({})
  const binding: RootScopeBinding = Object.freeze({
    profileNamespace: 'profile-test',
    principalAssociation: 'principal-test',
    generation,
    nativeKeyAccess: 'allowed',
    legacyFileKeyAccess: 'denied',
    maxHeldRoots: 4,
    isCurrent: () => active
  })
  scopes.set(scope, binding)
  return {
    scope,
    scopes,
    retire: () => {
      active = false
    }
  }
}

function testNativeKeyStore(): NativeKeyStore {
  const wrap = (contentKeyBase64: string): Buffer => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', mockNativeMaster, iv)
    const ciphertext = Buffer.concat([cipher.update(contentKeyBase64, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  }
  const unwrap = (wrapped: Buffer): string => {
    if (wrapped.byteLength < 28) throw new Error('test key locked')
    const decipher = createDecipheriv('aes-256-gcm', mockNativeMaster, wrapped.subarray(0, 12))
    decipher.setAuthTag(wrapped.subarray(12, 28))
    return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]).toString('utf8')
  }
  return { selectedBackend: () => 'macos-keychain', wrap, unwrap }
}

function testSpeechService(holdFirstEncryption?: {
  started(): void
  wait: Promise<void>
}): MeetingSpeechPersistenceService {
  let held = false
  const service = {
    async encryptEnvelopeV2(content: string, contentKey: Uint8Array, iv: Uint8Array, kLocal: string) {
      if (holdFirstEncryption && !held) {
        held = true
        holdFirstEncryption.started()
        await holdFirstEncryption.wait
      }
      const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
      const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
      const json = Buffer.from(
        JSON.stringify({
          v: 2,
          iv: Buffer.from(iv).toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ct: ciphertext.toString('base64'),
          kLocal
        })
      )
      return Buffer.concat([marker, json])
    },
    async decryptEnvelopeV2(envelopeJson: Uint8Array, contentKey: Uint8Array, kLocal: string) {
      const envelope = JSON.parse(Buffer.from(envelopeJson).toString('utf8')) as {
        v: number
        iv: string
        tag: string
        ct: string
        kLocal: string
      }
      if (envelope.v !== 2 || envelope.kLocal !== kLocal) throw new Error('test v2 envelope invalid')
      const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8')
    }
  }
  return service as unknown as MeetingSpeechPersistenceService
}

function beginKeyStatGate(root: OwnedMeetingRoot, failure?: Error) {
  let enter!: () => void
  let release!: () => void
  keyStatGate.path = root.meetingPath
  keyStatGate.expectedDev = BigInt(root.version.device)
  keyStatGate.expectedIno = BigInt(root.version.inode)
  keyStatGate.armed = true
  keyStatGate.rejectDelivery = failure !== undefined
  keyStatGate.failure = failure ?? null
  keyStatGate.rawMatchesRoot = false
  keyStatGate.realStatCompleted = false
  keyStatGate.rawObserved = false
  keyStatGate.entries = 0
  keyStatGate.rawStatCalls = 0
  keyStatGate.enteredPromise = new Promise<void>((resolve) => {
    enter = resolve
  })
  keyStatGate.entered = enter
  keyStatGate.released = new Promise<void>((resolve) => {
    release = resolve
  })
  keyStatGate.release = release
  fixtureRelease(release)
}

function resetKeyStatGate() {
  keyStatGate.path = null
  keyStatGate.expectedDev = null
  keyStatGate.expectedIno = null
  keyStatGate.armed = false
  keyStatGate.rejectDelivery = false
  keyStatGate.failure = null
  keyStatGate.rawMatchesRoot = false
  keyStatGate.realStatCompleted = false
  keyStatGate.rawObserved = false
  keyStatGate.entries = 0
  keyStatGate.rawStatCalls = 0
  keyStatGate.entered = null
  keyStatGate.enteredPromise = null
  keyStatGate.release = null
  keyStatGate.released = null
}

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
function requireProtectedRetirement(status: KeyOutcome, error: unknown): void {
  expect(status).toBe('rejected')
  expect(error instanceof Error && Object.getPrototypeOf(error) === Error.prototype).toBe(true)
  expect((error as Error).message).toMatch(/^Protected meeting key (is retired|was retired during use)$/)
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

function keyEvidence(value: Record<string, unknown>) {
  console.info(`PERSISTENCE_SETTLEMENT_EVIDENCE ${JSON.stringify(value)}`)
}

describe('protected meeting-key lifecycle', () => {
  let base: string | undefined
  const rootsForCleanup: Array<{ registry: RootRegistry; scope: object; root: OwnedMeetingRoot }> = []
  const ownRoot = (registry: RootRegistry, scope: object, root: OwnedMeetingRoot, reserved = false) => {
    rootsForCleanup.push({ registry, scope, root })
    fixtureResource('root', root, () => registry.closeRoot(scope, root), null, reserved)
    return root
  }
  const ownWriter = <T extends { release(): Promise<void> }>(
    writer: T,
    root: OwnedMeetingRoot,
    reserved = false
  ): T => {
    fixtureResource('writer', writer, () => writer.release(), root, reserved)
    return writer
  }
  const ownKey = <T extends { dispose(): Promise<void> }>(handle: T, parent: object, reserved = false): T => {
    fixtureResource('key', handle, () => handle.dispose(), parent, reserved)
    return handle
  }
  const ownFixtureBuffer = <T extends Buffer>(make: () => T): T => {
    const owner = activeFixture()
    owner.reserveResource('buffer')
    let buffer: T
    try {
      buffer = make()
    } catch (error) {
      owner.reservations.buffer -= 1
      throw error
    }
    fixtureResource('buffer', buffer, () => buffer.fill(0), null, true)
    return buffer
  }
  const adoptFixtureResource = <T>(
    kind: 'root' | 'writer' | 'key',
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
  const acquireOwnedWriter = (registry: RootRegistry, scope: object, root: OwnedMeetingRoot) =>
    adoptFixtureResource(
      'writer',
      'writer-acquire',
      () => registry.acquireWriter(scope, root),
      (writer) => ownWriter(writer, root, true)
    )
  const adoptOwnedKey = <T extends { dispose(): Promise<void> }>(start: () => Promise<T>, parent?: object) => {
    const capturedParent =
      parent ?? [...activeFixture().resources].reverse().find((item) => item.kind === 'writer')?.identity
    if (!capturedParent) throw fixtureError('key acquisition has no captured parent')
    return adoptFixtureResource('key', 'key-acquire', start, (handle) => ownKey(handle, capturedParent, true))
  }
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

  fixtureBridge.restore = () => {
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
    aclHarness.prepare = null
    aclHarness.verify = null
  }
  fixtureBridge.clear = () => {
    mockNativeMaster.fill(0x71)
    rootsForCleanup.length = 0
    base = undefined
    resetKeyStatGate()
  }
  afterEach(async (context) => finalizeFixture(context))

  async function runProtectedKeyCase(context: { signal: AbortSignal }, caseId: 'K01' | 'K02' | 'K03' | 'K04') {
    return runFixture(context, async () => {
      base = await fixtureWait(createOwnedBase(join(tmpdir(), 'metis-' + caseId.toLowerCase() + '-')))
      const authorityOwner = authority('generation-' + caseId)
      const roots = new RootRegistry({
        userDataRoot: () => base!,
        resolveScope: (scope) => authorityOwner.scopes.get(scope),
        bindGatewayRoot: async () => undefined
      })
      const service = createProtectedMeetingKeys({
        roots,
        nativeKeyStore: testNativeKeyStore(),
        speech: testSpeechService()
      })
      const root = await fixtureWait(createOwnedRoot(roots, authorityOwner.scope, 'meeting-' + caseId))
      const writer = await fixtureWait(acquireOwnedWriter(roots, authorityOwner.scope, root))
      const handle = await fixtureWait(
        adoptOwnedKey(() => service.create(authorityOwner.scope, root, writer, 'journal-' + caseId))
      )
      const keyReady = handle.keyId.length > 0
      let releaseCallback!: () => void
      let enterCallback!: () => void
      const callbackEntered = new Promise<void>((resolve) => {
        enterCallback = resolve
      })
      const callbackWait = new Promise<void>((resolve) => {
        releaseCallback = resolve
      })
      fixtureRelease(releaseCallback)
      const callbackError = new Error(caseId + ' injected protected callback refusal')
      let borrow: Uint8Array | undefined
      let callbackCalls = 0
      let callbackCompleted = false
      let lateCallbackCalls = 0
      let writerCloseAttempts = 0
      let writerCloseConfirmed = 0
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
        if (caseId === 'K01') beginKeyStatGate(root)
        else {
          keyStatGate.path = root.meetingPath
          keyStatGate.expectedDev = BigInt(root.version.device)
          keyStatGate.expectedIno = BigInt(root.version.inode)
        }
        const use = fixtureStart('key-use', () =>
          handle.withKey(async (owned) => {
            callbackCalls += 1
            borrow = owned
            assert(
              owned.byteLength === 32 && owned.some((byte) => byte !== 0),
              caseId + ' callback received a live 32-byte borrow'
            )
            if (caseId === 'K02') {
              enterCallback()
              await callbackWait
              callbackCompleted = true
              return owned.byteLength
            }
            if (caseId === 'K03') {
              callbackCompleted = true
              beginKeyStatGate(root)
              enterCallback()
              return owned.byteLength
            }
            if (caseId === 'K04') {
              callbackCompleted = true
              throw callbackError
            }
            callbackCompleted = true
            return owned.byteLength
          })
        )
        useObserver = observeKeyOperation(use)
        if (caseId === 'K01') {
          await fixtureStage(keyStatGate.enteredPromise, useObserver.record, 'protected admission')
          physicalHeld = true
        } else if (caseId === 'K02') {
          await fixtureStage(callbackEntered, useObserver.record, 'protected callback')
        } else if (caseId === 'K03') {
          await fixtureStage(callbackEntered, useObserver.record, 'protected callback')
          await fixtureStage(keyStatGate.enteredPromise, useObserver.record, 'protected post-use')
          physicalHeld = true
        } else {
          await fixtureJoinObserved(useObserver.settled)
          expect(useObserver.error()).toBe(callbackError)
          expect([...borrow!]).toEqual(Array.from({ length: 32 }, () => 0))
        }
        const first = fixtureCleanup(handle, 'key-first-dispose', () => handle.dispose())
        const second = fixtureCleanup(handle, 'key-second-dispose', () => service.settleAndDispose(handle))
        disposals = [
          observeKeyOperation(
            first,
            caseId === 'K03'
              ? () => {
                  postUseBorrowAtDisposal = borrow!.some((byte) => byte !== 0) ? 'nonzero' : 'zero'
                }
              : undefined
          ),
          observeKeyOperation(second)
        ]
        const beforeLate = keyStatGate.rawStatCalls
        const lateUse = observeKeyOperation(
          fixtureStart('key-late-use', () =>
            handle.withKey(async () => {
              lateCallbackCalls += 1
              return 1
            })
          )
        )
        if (caseId !== 'K04') {
          await fixtureStep('checkpoint-lstat', () => lstat(join(root.meetingPath, 'meeting-key.v2')))
          checkpoint = true
        }
        await fixtureJoinObserved(lateUse.settled)
        requireProtectedRetirement(lateUse.status(), lateUse.error())
        lateUseStatus = lateUse.status()
        extraPhysicalChecks += keyStatGate.rawStatCalls - beforeLate
        if (caseId === 'K04') {
          expect(keyStatGate.rawStatCalls).toBe(beforeLate)
          await fixtureStep('checkpoint-lstat', () => lstat(join(root.meetingPath, 'meeting-key.v2')))
          checkpoint = true
        }
        observedDisposals = disposals.map((item) => item.status())
        observedOperation = useObserver.status()
        observedCallbackCompleted = callbackCompleted
        observedBorrow = borrow ? (borrow.some((byte) => byte !== 0) ? 'nonzero' : 'zero') : 'absent'
        if (caseId === 'K01' || caseId === 'K03') keyStatGate.release?.()
        if (caseId === 'K02') releaseCallback()
        await fixtureJoinObserved(useObserver.settled)
        const disposalResults = await fixtureJoinObserved(Promise.all(disposals.map((item) => item.settled)))
        for (const outcome of disposalResults) if (outcome.status === 'rejected') throw outcome.error
        if (caseId === 'K03') expect(postUseBorrowAtDisposal).not.toBeNull()
        const beforeRepeat = keyStatGate.rawStatCalls
        const repeat = observeKeyOperation(fixtureCleanup(handle, 'key-repeat-dispose', () => handle.dispose()))
        const repeatOutcome = await fixtureJoinObserved(repeat.settled)
        if (repeatOutcome.status === 'rejected') throw repeatOutcome.error
        expect(repeat.status()).toBe('fulfilled')
        repeatStatus = repeat.status()
        extraPhysicalChecks += keyStatGate.rawStatCalls - beforeRepeat
        expect(keyStatGate.entries).toBe(caseId === 'K01' || caseId === 'K03' ? 1 : 0)
        if (caseId === 'K04') expect(useObserver.error()).toBe(callbackError)
        else requireProtectedRetirement(useObserver.status(), useObserver.error())
        if (caseId === 'K01') {
          expect(callbackCalls).toBe(0)
          expect(borrow).toBeUndefined()
        } else {
          expect(borrow).toBeInstanceOf(Uint8Array)
          expect(borrow?.byteLength).toBe(32)
          expect([...borrow!]).toEqual(Array.from({ length: 32 }, () => 0))
        }
        expect(lateCallbackCalls).toBe(0)
        rawMatchesRoot = keyStatGate.rawMatchesRoot
        realStatCompleted = keyStatGate.realStatCompleted
        physicalEntries = keyStatGate.entries
        await fixtureWait(fixtureCleanup(writer, 'writer-release', () => writer.release()))
        const writerClose = await writerCloseWitness(activeFixture(), writer.lockPath)
        writerCloseAttempts = writerClose.attempts
        writerCloseConfirmed = writerClose.confirmed
        await fixtureWait(fixtureCleanup(root, 'root-close', () => roots.closeRoot(authorityOwner.scope, root)))
        const rootClose = await rootCloseWitness(
          activeFixture(),
          root.meetingPath,
          root.version.device,
          root.version.inode
        )
        rootCloseAttempts = rootClose.attempts
        rootCloseConfirmed = rootClose.confirmed
      } finally {
        keyStatGate.release?.()
        releaseCallback()
      }
      const stage =
        caseId === 'K01'
          ? 'admission'
          : caseId === 'K02'
            ? 'callback'
            : caseId === 'K03'
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
          use: caseId === 'K04' && useObserver!.error() === callbackError ? 'callback-error' : 'retired',
          originalCallbackError: useObserver!.error() === callbackError,
          callbackCalls,
          borrow: caseId === 'K01' ? 'absent' : 'zero',
          disposals: disposals.map((item) => item.status()),
          repeat: repeatStatus,
          lateUse: lateUseStatus === 'rejected' ? 'retired' : lateUseStatus,
          lateCallbackCalls,
          extraPhysicalChecks
        },
        postUseBorrowAtDisposal,
        parents: { writerCloseAttempts, writerCloseConfirmed, rootCloseAttempts, rootCloseConfirmed }
      }
      activeFixture().checkAdmission()
      keyEvidence(evidence)
      return () => {
        if (caseId === 'K01')
          assert(
            observedDisposals.every((status) => status === 'pending'),
            'K01 complete protected admission must settle before key disposal'
          )
        else if (caseId === 'K03')
          assert(
            observedDisposals.every((status) => status === 'pending') && postUseBorrowAtDisposal === 'zero',
            'K03 protected post-use physical check and borrowed wipe must precede key disposal'
          )
        else expect(observedDisposals).toEqual(caseId === 'K04' ? ['fulfilled', 'fulfilled'] : ['pending', 'pending'])
      }
    })
  }

  it('joins protected key admission before disposing the key owner', async (context) =>
    runProtectedKeyCase(context, 'K01'))
  it('keeps protected key disposal pending while the admitted callback is held', async (context) =>
    runProtectedKeyCase(context, 'K02'))
  it('joins protected key post-use checks and wipes before disposal completes', async (context) =>
    runProtectedKeyCase(context, 'K03'))
  it('disposes a protected key after a physically completed callback refusal', async (context) =>
    runProtectedKeyCase(context, 'K04'))

  it('retires a held key publication permanently, then admits a live successor', async (context) =>
    runFixture(context, async () => {
      base = await fixtureWait(createOwnedBase(join(tmpdir(), 'metis-key-race-')))
      let release!: () => void
      let markStarted!: () => void
      fixtureRelease(() => release())
      const held = {
        started: () => markStarted(),
        wait: new Promise<void>((resolve) => {
          release = resolve
        })
      }
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const oldOwner = authority('generation-one')
      const roots = new RootRegistry({
        userDataRoot: () => base!,
        resolveScope: (scope) => oldOwner.scopes.get(scope),
        bindGatewayRoot: async () => undefined
      })
      const keyService = createProtectedMeetingKeys({
        roots,
        nativeKeyStore: testNativeKeyStore(),
        speech: testSpeechService(held)
      })
      const root = await fixtureWait(createOwnedRoot(roots, oldOwner.scope, 'meeting-race'))
      const writer = await fixtureWait(acquireOwnedWriter(roots, oldOwner.scope, root))
      const pending = adoptOwnedKey(() => keyService.create(oldOwner.scope, root, writer, 'journal-race'))
      await fixtureStage(started, activeFixture().record(pending), 'held encryption')

      roots.retireScope(oldOwner.scope)
      oldOwner.retire()
      release()
      await expect(fixtureWait(pending)).rejects.toThrow(/retired/i)
      await fixtureWait(fixtureCleanup(writer, 'writer-release', () => writer.release()))
      await expect(
        fixtureStep('path-lstat-missing', () => lstat(join(root.meetingPath, 'meeting-key.v2')))
      ).rejects.toMatchObject({ code: 'ENOENT' })

      const successor = authority('generation-two', oldOwner.scopes)
      const successorRoot = await fixtureWait(openOwnedRoot(roots, successor.scope, 'meeting-race'))
      const successorWriter = await fixtureWait(acquireOwnedWriter(roots, successor.scope, successorRoot))
      const recovered = await fixtureWait(
        adoptOwnedKey(() => keyService.create(successor.scope, successorRoot, successorWriter, 'journal-race'))
      )
      const supplied: Uint8Array[] = []
      const byteLength = await fixtureStep('recovered-key-use', () =>
        recovered.withKey((owned) => {
          supplied.push(owned)
          expect(Object.getPrototypeOf(owned)).toBe(Uint8Array.prototype)
          expect(owned.byteLength).toBe(32)
          return owned.byteLength
        })
      )
      expect(byteLength).toBe(32)
      expect([...supplied[0]]).toEqual(Array.from({ length: 32 }, () => 0))

      const reopened = await fixtureWait(
        adoptOwnedKey(() => keyService.open(successor.scope, successorRoot, recovered.reference))
      )
      await expect(fixtureStep('reopened-key-use', () => reopened.withKey((owned) => owned.byteLength))).resolves.toBe(
        32
      )
      await fixtureWait(fixtureCleanup(reopened, 'reopened-key-dispose', () => reopened.dispose()))
      await fixtureWait(fixtureCleanup(recovered, 'recovered-key-dispose', () => recovered.dispose()))
      await fixtureWait(fixtureCleanup(successorWriter, 'successor-writer-release', () => successorWriter.release()))
    }))

  it('reopen is read-only and a corrupt key record is preserved', async (context) =>
    runFixture(context, async () => {
      base = await fixtureWait(createOwnedBase(join(tmpdir(), 'metis-key-readonly-')))
      const owner = authority('generation-one')
      const roots = new RootRegistry({
        userDataRoot: () => base!,
        resolveScope: (scope) => owner.scopes.get(scope),
        bindGatewayRoot: async () => undefined
      })
      const missingRoot = await fixtureWait(createOwnedRoot(roots, owner.scope, 'meeting-no-key'))
      const keyService = createProtectedMeetingKeys({
        roots,
        nativeKeyStore: testNativeKeyStore(),
        speech: testSpeechService()
      })
      const missingRef = {
        profileNamespace: missingRoot.profileNamespace,
        principalAssociation: missingRoot.principalAssociation,
        meetingId: missingRoot.meetingId,
        journalGeneration: missingRoot.ownerGeneration,
        journalId: 'journal-missing',
        keyId: 'key-missing'
      }
      await expect(
        fixtureWait(adoptOwnedKey(() => keyService.open(owner.scope, missingRoot, missingRef), missingRoot))
      ).rejects.toThrow()
      await expect(
        fixtureStep('missing-key-lstat', () => lstat(join(missingRoot.meetingPath, 'meeting-key.v2')))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      const foreignScope = Object.freeze({})
      await expect(
        fixtureWait(adoptOwnedKey(() => keyService.open(foreignScope, missingRoot, missingRef), missingRoot))
      ).rejects.toThrow(/capability unavailable/i)

      const writer = await fixtureWait(acquireOwnedWriter(roots, owner.scope, missingRoot))
      const handle = await fixtureWait(
        adoptOwnedKey(() => keyService.create(owner.scope, missingRoot, writer, 'journal-existing'))
      )
      const path = join(missingRoot.meetingPath, 'meeting-key.v2')
      const alias = join(base, 'outside-key-alias')
      await fixtureStep('path-link', () => link(path, alias))
      await expect(
        fixtureWait(adoptOwnedKey(() => keyService.open(owner.scope, missingRoot, handle.reference), missingRoot))
      ).rejects.toThrow(/unavailable or invalid/i)
      await fixtureStep('path-unlink', () => unlink(alias))
      const corrupted = ownFixtureBuffer(() => Buffer.from('invalid-but-preserved'))
      await fixtureStep('path-write-corrupt', () => writeFile(path, corrupted), 'opaque')
      await expect(
        fixtureWait(adoptOwnedKey(() => keyService.open(owner.scope, missingRoot, handle.reference), missingRoot))
      ).rejects.toThrow()
      await expect(fixtureStep('path-read-corrupt', () => readFile(path), 'opaque')).resolves.toEqual(corrupted)
      await fixtureWait(fixtureCleanup(handle, 'key-dispose', () => handle.dispose()))
      await fixtureWait(fixtureCleanup(writer, 'writer-release', () => writer.release()))
    }))

  it('fails closed when the native backend becomes unavailable and preserves the valid key record', async (context) =>
    runFixture(context, async () => {
      base = await fixtureWait(createOwnedBase(join(tmpdir(), 'metis-key-native-unavailable-')))
      const owner = authority('generation-one')
      const roots = new RootRegistry({
        userDataRoot: () => base!,
        resolveScope: (scope) => owner.scopes.get(scope),
        bindGatewayRoot: async () => undefined
      })
      let enabled = true
      const delegate = testNativeKeyStore()
      const native: NativeKeyStore = {
        selectedBackend: () => (enabled ? delegate.selectedBackend() : undefined),
        wrap: (value) => delegate.wrap(value),
        unwrap: (value) => delegate.unwrap(value)
      }
      const service = createProtectedMeetingKeys({ roots, nativeKeyStore: native, speech: testSpeechService() })
      const root = await fixtureWait(createOwnedRoot(roots, owner.scope, 'meeting-native-unavailable'))
      const writer = await fixtureWait(acquireOwnedWriter(roots, owner.scope, root))
      const created = await fixtureWait(
        adoptOwnedKey(() => service.create(owner.scope, root, writer, 'journal-native-unavailable'))
      )
      const path = join(root.meetingPath, 'meeting-key.v2')
      const fixtureOwner = activeFixture()
      fixtureOwner.reserveResource('buffer')
      const before = await fixtureWait(
        fixtureStart(
          'path-read-before',
          async () => {
            try {
              const bytes = await readFile(path)
              fixtureResource('buffer', bytes, () => bytes.fill(0), null, true)
              return bytes
            } catch (error) {
              fixtureOwner.reservations.buffer -= 1
              throw error
            }
          },
          'opaque'
        )
      )

      enabled = false
      await expect(
        fixtureWait(adoptOwnedKey(() => service.open(owner.scope, root, created.reference), root))
      ).rejects.toThrow(/backend unavailable/i)
      await expect(fixtureStep('path-read-preserved', () => readFile(path), 'opaque')).resolves.toEqual(before)
      before.fill(0)
      await fixtureWait(fixtureCleanup(created, 'key-dispose', () => created.dispose()))
      await fixtureWait(fixtureCleanup(writer, 'writer-release', () => writer.release()))
    }))

  it('does not publish a key or unlink a replacement after a held ACL proof', async (context) =>
    runFixture(context, async () => {
      base = await fixtureWait(createOwnedBase(join(tmpdir(), 'metis-key-acl-replacement-')))
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      let release!: () => void
      let markStarted!: (path: string) => void
      const started = new Promise<string>((resolve) => {
        markStarted = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      fixtureRelease(() => release())
      aclHarness.prepare = async (path) => {
        if (!path.endsWith('.tmp')) return true
        markStarted(path)
        await held
        return true
      }
      const owner = authority('generation-one')
      const roots = new RootRegistry({
        userDataRoot: () => base!,
        resolveScope: (scope) => owner.scopes.get(scope),
        bindGatewayRoot: async () => undefined
      })
      const service = createProtectedMeetingKeys({
        roots,
        nativeKeyStore: testNativeKeyStore(),
        speech: testSpeechService()
      })
      const root = await fixtureWait(createOwnedRoot(roots, owner.scope, 'meeting-acl-replacement'))
      const writer = await fixtureWait(acquireOwnedWriter(roots, owner.scope, root))
      const pending = adoptOwnedKey(() => service.create(owner.scope, root, writer, 'journal-acl-replacement'))
      const temporary = await fixtureStage(started, activeFixture().record(pending), 'held ACL proof').then(
        () => started
      )
      await fixtureStep('path-unlink-temporary', () => unlink(temporary))
      const replacement = ownFixtureBuffer(() => Buffer.from('foreign replacement'))
      await fixtureStep('path-write-replacement', () => writeFile(temporary, replacement), 'opaque')
      release()
      await expect(fixtureWait(pending)).rejects.toThrow(/temp physical version changed/i)
      await expect(
        fixtureStep('path-lstat-no-key', () => lstat(join(root.meetingPath, 'meeting-key.v2')))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fixtureStep('path-read-replacement', () => readFile(temporary), 'opaque')).resolves.toEqual(
        replacement
      )
      replacement.fill(0)
      await fixtureWait(fixtureCleanup(writer, 'writer-release', () => writer.release()))
      Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
    }))

  it('retires the original scope during a held ACL proof before any key bytes are written', async (context) =>
    runFixture(context, async () => {
      base = await fixtureWait(createOwnedBase(join(tmpdir(), 'metis-key-acl-retirement-')))
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      let release!: () => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      fixtureRelease(() => release())
      aclHarness.prepare = async (path) => {
        if (!path.endsWith('.tmp')) return true
        markStarted()
        await held
        return true
      }
      const owner = authority('generation-one')
      const roots = new RootRegistry({
        userDataRoot: () => base!,
        resolveScope: (scope) => owner.scopes.get(scope),
        bindGatewayRoot: async () => undefined
      })
      const service = createProtectedMeetingKeys({
        roots,
        nativeKeyStore: testNativeKeyStore(),
        speech: testSpeechService()
      })
      const root = await fixtureWait(createOwnedRoot(roots, owner.scope, 'meeting-acl-retirement'))
      const writer = await fixtureWait(acquireOwnedWriter(roots, owner.scope, root))
      const pending = adoptOwnedKey(() => service.create(owner.scope, root, writer, 'journal-acl-retirement'))
      await fixtureStage(started, activeFixture().record(pending), 'held ACL proof')
      roots.retireScope(owner.scope)
      owner.retire()
      release()
      await expect(fixtureWait(pending)).rejects.toThrow(/retired/i)
      await expect(
        fixtureStep('path-lstat-no-key', () => lstat(join(root.meetingPath, 'meeting-key.v2')))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      const leftovers = await fixtureStep('path-readdir-leftovers', () =>
        import('node:fs/promises').then(({ readdir }) => readdir(root.meetingPath))
      )
      expect(leftovers.some((name) => name.startsWith('.meeting-key-'))).toBe(false)
      await fixtureWait(fixtureCleanup(writer, 'writer-release', () => writer.release()))
      Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
    }))
})
