import { EventEmitter } from 'node:events'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { processMeetingSpeechRequest } from '../meeting-speech-worker'
import {
  createMeetingSpeechPersistenceService,
  type MeetingSpeechPersistenceService,
  type MeetingSpeechWorkerFactory,
  type MeetingSpeechWorkerPort
} from '../infra/process/meeting-speech-host'
import {
  isMeetingSpeechReply,
  type MeetingSpeechReply,
  type MeetingSpeechRequest
} from '../infra/process/meeting-speech-protocol'
import {
  discardIncrementalRecordReceipt,
  inspectIncrementalRecordReceipt,
  type IncrementalRecordReceipt,
  type IncrementalRecordReceiptBinding
} from '../infra/process/incremental-record-receipt'
import { commitManagedAuthorityDocument } from '../settings-authority-history'
import { publishSettingsSnapshot } from '../settings-observation'

import {
  createMainPersistenceBootstrapWithSourceFixture,
  type MainPersistenceBootstrapSourceFixture,
  type ReadOnlyMainMeetingJournal,
  type WritableMainMeetingJournal
} from './bootstrap'
import {
  parseProfileCatalog,
  toMeetingSpeechPolicy,
  type AdminPolicyReceipt,
  type ResolvedPersistenceProfile,
  type ResourcePolicyInput,
  type ResourcePolicyResult
} from './resource-policy'
import { RootRegistry } from './root-registry'

type SettlementFixtureHandle = { close: () => Promise<void> }
type SettlementGate = {
  entered: Promise<void>
  notifyEntered: () => void
  wait: Promise<void>
  release: () => void
  error: string | undefined
  attempts: number
  raw: SettlementFixtureHandle | undefined
  thrown: Error | undefined
}
type SettlementWriteFault = {
  error: Error
  attempts: number
  raw: SettlementFixtureHandle | undefined
}
type CanonicalReplyIdentity = { protocol: number; id: number; generation: number; successful: boolean }
type K1RawRecord = {
  path: string
  raw: import('node:fs/promises').FileHandle
  originalClose: () => Promise<void>
  stats: Array<{ dev: number | bigint; ino: number | bigint; directory: boolean; file: boolean }>
  closeCalls: number
  firstClose: Promise<void> | null
  closeOutcome: 'pending' | 'fulfilled' | 'rejected' | null
  rescueAttempts: number
  rescueConfirmed: boolean
}
type K1StoreRecord = {
  object: object
  originalInitialize: (...args: unknown[]) => Promise<unknown>
  originalDispose: () => void
  borrow: Uint8Array
  productionDisposeAttempts: number
  productionDisposed: boolean
  productionDisposeError: unknown
  productionDisposeOutcome: K1OperationOutcome | null
  rescueAttempts: number
  rescued: boolean
  rescueOutcome: K1OperationOutcome | null
  users: Array<Promise<K1OperationOutcome>>
  selected: boolean
}
type K1OperationOutcome = { status: 'fulfilled'; value: unknown } | { status: 'rejected'; error: unknown }
type K1StatPhase = {
  status: 'not-started' | 'pending' | 'fulfilled' | 'rejected'
  promise: Promise<unknown> | null
  outcome: K1OperationOutcome | null
}
type K1StatObservation = {
  observeRaw: (promise: Promise<unknown>) => void
  observeDelivery: (promise: Promise<unknown>) => void
  rejectInvocation: (error: unknown) => void
}
type K1FactoryOwnerRef = {
  rawHandles: K1RawRecord[]
  reserveOperation(role?: 'work' | 'cleanup' | 'opaque'): void
  reserveStat(): K1StatObservation
  observeReserved<T>(
    label: string,
    operation: Promise<T>,
    role?: 'work' | 'cleanup' | 'opaque'
  ): {
    settled: Promise<K1OperationOutcome>
  }
  reserveOpen(): { pending: boolean }
  settleOpen(reservation?: { pending: boolean }): void
  reserveStore(): void
  settleStore(): void
  activeBootstrapUsers(): Promise<K1OperationOutcome>[]
  fail(error: Error): void
}

vi.mock('electron')
vi.mock('../auth', () => ({
  captureMainPersistenceSessionBoundary: () => {
    const epoch = settlementFaults.authEpoch
    const principalAssociation = settlementFaults.authPrincipalAssociation
    return {
      principalAssociation,
      configured: true,
      isCurrent: () =>
        settlementFaults.authEpoch === epoch && settlementFaults.authPrincipalAssociation === principalAssociation
    }
  },
  subscribeSpeechAuthLeaseInvalidation: () => () => {}
}))

const settlementFaults = vi.hoisted(() => ({
  closeGates: new Map<string, SettlementGate>(),
  writeFaults: new Map<string, SettlementWriteFault>(),
  openedHandles: new Map<string, SettlementFixtureHandle>(),
  rootIdentities: new Map<string, { dev: bigint; ino: bigint }>(),
  keyGate: null as SettlementGate | null,
  authEpoch: 0,
  authPrincipalAssociation: 'a'.repeat(64)
}))
const k1Gate = vi.hoisted(() => ({
  owner: null as K1FactoryOwnerRef | null,
  custodyActive: false,
  selectedStore: false,
  rawHandles: [] as K1RawRecord[],
  openReservations: 0,
  operations: [] as Array<{
    label: string
    settled: Promise<K1OperationOutcome>
  }>,
  stores: [] as K1StoreRecord[],
  path: null as string | null,
  armed: false,
  rejectDelivery: false,
  failure: null as Error | null,
  expectedDev: null as bigint | null,
  expectedIno: null as bigint | null,
  rawMatchesRoot: false,
  realStatCompleted: false,
  entries: 0,
  entered: null as (() => void) | null,
  writerCloseAttempts: 0,
  writerCloseConfirmed: 0,
  rootCloseAttempts: 0,
  rootCloseConfirmed: 0,
  enteredPromise: null as Promise<void> | null,
  release: null as (() => void) | null,
  released: null as Promise<void> | null,
  storeHook: null as null | {
    custodyActive: boolean
    selected: boolean
    constructorCalls: number
    actualObject: object | null
    initializeCalls: number
    disposeCalls: number
    sameObject: boolean
    disposedSameObject: boolean
    originalDispose: (() => void) | null
    keySettlements: number
    borrow: Uint8Array | null
  }
}))

function observeK1Operation<T>(label: string, operation: Promise<T>, role: 'work' | 'cleanup' = 'work'): Promise<T> {
  k1Gate.owner?.observeReserved(label, operation, role)
  return operation
}
async function k1RawCloseWitness(path: string, selected: (record: K1RawRecord) => boolean) {
  const matches = k1Gate.rawHandles.filter((record) => record.path === path && selected(record))
  if (matches.length !== 1) throw new Error('K1 fixture custody failure: selected raw descriptor identity is ambiguous')
  const record = matches[0]
  if (record.firstClose) {
    try {
      await record.firstClose
      record.closeOutcome = 'fulfilled'
    } catch {
      record.closeOutcome = 'rejected'
    }
  }
  if (record.closeCalls !== 1 || record.closeOutcome !== 'fulfilled')
    throw new Error('K1 fixture custody failure: first raw descriptor close is not confirmed')
  return { attempts: record.closeCalls, confirmed: 1 }
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const owner = k1Gate.owner
      owner?.reserveOperation()
      const reservation = owner?.reserveOpen()
      const openPromise = actual.open(...args)
      if (owner) observeK1Operation('raw-open', openPromise)
      let handle: Awaited<typeof openPromise>
      try {
        handle = await openPromise
      } catch (error) {
        owner?.settleOpen(reservation)
        throw error
      }
      owner?.settleOpen(reservation)
      const path = String(args[0])
      let k1Record: K1RawRecord | undefined
      if (owner) {
        k1Record = {
          path,
          raw: handle,
          originalClose: handle.close.bind(handle),
          stats: [],
          closeCalls: 0,
          firstClose: null,
          closeOutcome: null,
          rescueAttempts: 0,
          rescueConfirmed: false
        }
        owner.rawHandles.push(k1Record)
      }
      settlementFaults.openedHandles.set(path, handle)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close')
            return async (...closeArgs: Parameters<typeof target.close>) => {
              if (k1Record) {
                owner?.reserveOperation('cleanup')
                if (k1Record.closeCalls === 0 && target.fd < 0) {
                  const error = new Error(
                    'K1 fixture custody failure: raw descriptor was already closed before first observation'
                  )
                  k1Record.closeOutcome = 'rejected'
                  owner?.fail(error)
                  observeK1Operation('raw-close', Promise.reject(error), 'cleanup')
                  throw error
                }
                k1Record.closeCalls += 1
                let physicalClose: Promise<void>
                try {
                  physicalClose = target.close(...closeArgs)
                } catch (error) {
                  physicalClose = Promise.reject(error)
                }
                if (k1Record.closeCalls === 1) {
                  k1Record.firstClose = physicalClose
                  k1Record.closeOutcome = 'pending'
                  void physicalClose.then(
                    () => {
                      if (k1Record) k1Record.closeOutcome = 'fulfilled'
                    },
                    () => {
                      if (k1Record) k1Record.closeOutcome = 'rejected'
                    }
                  )
                }
                observeK1Operation('raw-close', physicalClose, 'cleanup')
                return physicalClose
              }
              const isK1Writer = k1Gate.path !== null && path === join(k1Gate.path, '.journal-writer.lock')
              const isK1Root = k1Gate.path !== null && path === k1Gate.path
              if (isK1Writer) k1Gate.writerCloseAttempts += 1
              if (isK1Root) k1Gate.rootCloseAttempts += 1
              const gate = settlementFaults.closeGates.get(path)
              if (gate) {
                gate.attempts += 1
                gate.raw = target
                gate.notifyEntered()
                await gate.wait
                if (gate.error) {
                  gate.thrown = new Error(gate.error)
                  throw gate.thrown
                }
              }
              await target.close()
              if (isK1Writer) k1Gate.writerCloseConfirmed += 1
              if (isK1Root) k1Gate.rootCloseConfirmed += 1
            }
          if (property === 'stat')
            return (...statArgs: Parameters<typeof target.stat>) => {
              const observation = k1Record && owner ? owner.reserveStat() : null
              let statPromise: ReturnType<typeof target.stat>
              try {
                statPromise = target.stat(...statArgs)
              } catch (error) {
                observation?.rejectInvocation(error)
                throw error
              }
              observation?.observeRaw(statPromise)
              const delivered = statPromise.then(async (result) => {
                if (k1Record)
                  k1Record.stats.push({
                    dev: result.dev,
                    ino: result.ino,
                    directory: result.isDirectory(),
                    file: result.isFile()
                  })
                if (
                  k1Gate.storeHook?.custodyActive &&
                  !settlementFaults.rootIdentities.has(path) &&
                  result.isDirectory() &&
                  typeof result.dev === 'bigint' &&
                  typeof result.ino === 'bigint'
                )
                  settlementFaults.rootIdentities.set(path, { dev: result.dev, ino: result.ino })
                if (k1Gate.path === path && k1Gate.armed) {
                  k1Gate.armed = false
                  k1Gate.entries += 1
                  k1Gate.realStatCompleted = true
                  k1Gate.rawMatchesRoot =
                    k1Gate.expectedDev !== null &&
                    k1Gate.expectedIno !== null &&
                    result.dev === k1Gate.expectedDev &&
                    result.ino === k1Gate.expectedIno &&
                    result.isDirectory()
                  k1Gate.entered?.()
                  await k1Gate.released
                  if (k1Gate.rejectDelivery) throw k1Gate.failure
                }
                return result
              })
              observation?.observeDelivery(delivered)
              return delivered
            }
          if (property === 'writeFile')
            return (...writeArgs: Parameters<typeof target.writeFile>) => {
              if (k1Record) owner?.reserveOperation()
              const fault = settlementFaults.writeFaults.get(path)
              if (fault && fault.attempts === 0) {
                fault.attempts += 1
                fault.raw = target
                const rejected = Promise.reject(fault.error)
                if (k1Record) observeK1Operation('raw-write', rejected)
                return rejected
              }
              const result = target.writeFile(...writeArgs)
              if (k1Record) observeK1Operation('raw-write', result)
              return result
            }
          const value = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value
          return (...methodArgs: unknown[]) => {
            if (k1Record) owner?.reserveOperation()
            let result: unknown
            try {
              result = Reflect.apply(value, target, methodArgs)
            } catch (error) {
              if (k1Record) observeK1Operation('raw-method-failure', Promise.reject(error))
              throw error
            }
            if (k1Record && (!result || typeof (result as { then?: unknown }).then !== 'function'))
              observeK1Operation('raw-method-value', Promise.resolve(result))
            if (k1Record && result && typeof (result as { then?: unknown }).then === 'function')
              observeK1Operation(`raw-${String(property)}`, result as Promise<unknown>)
            return result
          }
        }
      })
    }
  }
})

vi.mock('../features/meetings/incremental-meeting-journal-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/meetings/incremental-meeting-journal-files')>()
  return {
    ...actual,
    createIncrementalMeetingJournalFileStorage: (
      options: Parameters<typeof actual.createIncrementalMeetingJournalFileStorage>[0]
    ) => {
      const owner = k1Gate.owner
      const hook = k1Gate.storeHook
      if (hook?.custodyActive && !owner)
        throw new Error('K1 fixture custody failure: real-store owner missing before construction')
      if (hook?.custodyActive) owner?.reserveStore()
      let storage: ReturnType<typeof actual.createIncrementalMeetingJournalFileStorage>
      try {
        storage = actual.createIncrementalMeetingJournalFileStorage(options)
      } catch (error) {
        if (hook?.custodyActive) owner?.settleStore()
        throw error
      }
      if (hook?.custodyActive) owner?.settleStore()
      if (!storage || !hook?.custodyActive) return storage
      const originalInitialize = storage.initialize.bind(storage)
      const originalDispose = storage.dispose.bind(storage)
      const custody: K1StoreRecord = {
        object: storage,
        originalInitialize: originalInitialize as (...args: unknown[]) => Promise<unknown>,
        originalDispose,
        borrow: options.key,
        productionDisposeAttempts: 0,
        productionDisposed: false,
        productionDisposeError: undefined,
        productionDisposeOutcome: null,
        rescueAttempts: 0,
        rescued: false,
        rescueOutcome: null,
        users: owner?.activeBootstrapUsers() ?? [],
        selected: hook.selected
      }
      k1Gate.stores.push(custody)
      if (hook.selected) {
        hook.constructorCalls += 1
        hook.actualObject = storage
        hook.borrow = options.key
        hook.sameObject = true
        hook.originalDispose = originalDispose
      }
      storage.initialize = async (...args: Parameters<typeof storage.initialize>) => {
        owner?.reserveOperation()
        let operation: ReturnType<typeof originalInitialize>
        try {
          operation = originalInitialize(...args)
        } catch (error) {
          operation = Promise.reject(error) as ReturnType<typeof originalInitialize>
        }
        const record = owner?.observeReserved('store-initialize', operation, 'work')
        if (record) custody.users.push(record.settled)
        const result = await operation
        if (custody.selected) hook.initializeCalls += 1
        return result
      }
      storage.dispose = function (this: typeof storage) {
        custody.productionDisposeAttempts += 1
        try {
          const result = originalDispose()
          custody.productionDisposed = true
          custody.productionDisposeOutcome = { status: 'fulfilled', value: result }
          if (custody.selected) {
            hook.disposeCalls += 1
            hook.disposedSameObject = this === storage
          }
          return result
        } catch (error) {
          custody.productionDisposeError = error
          custody.productionDisposeOutcome = { status: 'rejected', error }
          throw error
        }
      }
      if (!custody.selected) return storage
      const gate = k1Gate
      gate.path = resolve(options.root, '..')
      gate.expectedDev = settlementFaults.rootIdentities.get(gate.path)?.dev ?? null
      gate.expectedIno = settlementFaults.rootIdentities.get(gate.path)?.ino ?? null
      gate.armed = true
      gate.entries = 0
      gate.rawMatchesRoot = false
      gate.realStatCompleted = false
      return storage
    }
  }
})

vi.mock('./protected-meeting-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./protected-meeting-keys')>()
  return {
    ...actual,
    createProtectedMeetingKeys: (options: Parameters<typeof actual.createProtectedMeetingKeys>[0]) => {
      const service = actual.createProtectedMeetingKeys(options)
      return {
        ...service,
        settleAndDispose: async (handle: Parameters<typeof service.settleAndDispose>[0]) => {
          if (k1Gate.storeHook?.custodyActive && k1Gate.storeHook.selected) k1Gate.storeHook.keySettlements += 1
          const gate = settlementFaults.keyGate
          if (gate) {
            gate.attempts += 1
            gate.notifyEntered()
            await gate.wait
            await service.settleAndDispose(handle)
            if (gate.error) throw new Error(gate.error)
            return
          }
          await service.settleAndDispose(handle)
        }
      }
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
    raw: undefined,
    thrown: undefined
  }
}

function fixtureMeetingRoot(userData: string, meetingId: string): string {
  const profileNamespace = createHash('sha256')
    .update(`profile/v2\n${userData}\n${'a'.repeat(64)}`)
    .digest('hex')
    .slice(0, 48)
  return join(userData, 'persistence-v2', profileNamespace, 'meetings', meetingId)
}

async function settlementOutcome(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise
    return { status: 'fulfilled' }
  } catch (error) {
    return {
      status: 'rejected',
      errorName: error instanceof Error ? error.name.slice(0, 80) : typeof error,
      errorMessage: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      ...(error instanceof AggregateError
        ? {
            aggregateMessages: error.errors
              .slice(0, 4)
              .map((cause) => (cause instanceof Error ? cause.message.slice(0, 240) : String(cause).slice(0, 240)))
          }
        : {})
    }
  }
}

function recordSettlementEvidence(caseId: string, evidence: Record<string, unknown>): void {
  console.info(`PERSISTENCE_SETTLEMENT_EVIDENCE ${JSON.stringify({ caseId, ...evidence })}`)
}

function isMatchingCanonicalSuccess(request: MeetingSpeechRequest, value: unknown): value is MeetingSpeechReply {
  return (
    request.operation === 'canonical-record' &&
    isMeetingSpeechReply(value) &&
    value.protocol === request.protocol &&
    value.id === request.id &&
    value.generation === request.generation &&
    value.result.ok
  )
}

async function closeFixtureHandle(path: string): Promise<void> {
  const handle = settlementFaults.openedHandles.get(path) as { close: () => Promise<void> } | undefined
  await handle?.close().catch(() => undefined)
}

class SourceWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  constructor(
    private readonly onRequest?: (request: MeetingSpeechRequest) => void,
    private readonly onPhysicalExit?: () => void,
    private readonly beforeReply?: (request: MeetingSpeechRequest, reply: unknown) => Promise<void>
  ) {
    super()
  }

  postMessage(request: MeetingSpeechRequest): void
  postMessage(request: MeetingSpeechRequest, transferList: ArrayBuffer[]): void
  postMessage(request: MeetingSpeechRequest): void {
    this.onRequest?.(request)
    queueMicrotask(() => {
      const reply = processMeetingSpeechRequest(request)
      if (reply)
        void (async () => {
          await this.beforeReply?.(request, reply)
          this.emit('message', reply)
        })()
    })
  }
  async terminate(): Promise<number> {
    this.emit('exit', 0)
    this.onPhysicalExit?.()
    return 0
  }
}

const fixtureSourceCommit = 'a'.repeat(40)

function sourceFixture(
  readBundledReceipt: MainPersistenceBootstrapSourceFixture['readBundledReceipt'] = async () => null,
  workerFactory?: MeetingSpeechWorkerFactory,
  maxHeldRoots?: number,
  speechObserver?: (
    service: MeetingSpeechPersistenceService,
    context: {
      admittedProfile: ResolvedPersistenceProfile
      policy: ReturnType<typeof toMeetingSpeechPolicy>
      suppliedIsCurrent: () => boolean
    }
  ) => MeetingSpeechPersistenceService,
  enterpriseWindow: ResolvedPersistenceProfile['enterpriseWindow'] = null
): MainPersistenceBootstrapSourceFixture {
  const maxHeldRootsForFixture = maxHeldRoots ?? 4
  if (!Number.isSafeInteger(maxHeldRootsForFixture) || maxHeldRootsForFixture < 1 || maxHeldRootsForFixture > 8)
    throw new Error('Synthetic source fixture maxHeldRoots must be an integer from 1 through 8')
  const bundledCatalog = JSON.parse(
    readFileSync(resolve(process.cwd(), 'resources/persistence-profiles.v1.json'), 'utf8')
  ) as { profiles?: Array<Record<string, unknown>> }
  if (!Array.isArray(bundledCatalog.profiles)) throw new Error('Bundled source fixture catalog has no profiles')
  const catalogBytes = Buffer.from(
    JSON.stringify({
      ...bundledCatalog,
      profiles: bundledCatalog.profiles.map((profile) => ({ ...profile, maxHeldRoots: maxHeldRootsForFixture }))
    }),
    'utf8'
  )
  const parsed = parseProfileCatalog(catalogBytes)
  if (!parsed) throw new Error('Synthetic source fixture catalog failed its real parser')
  const source = parsed.catalog.profiles[0]
  if (!source) throw new Error('Synthetic source fixture catalog has no profile')
  const profile: ResolvedPersistenceProfile = Object.freeze({
    ...source,
    qualification: Object.freeze({ state: 'QUALIFIED', reportSha256: 'b'.repeat(64) }),
    profileDigest: 'c'.repeat(64),
    catalogSha256: 'd'.repeat(64),
    allowedProviders: null,
    publicationAllowed: false,
    retentionAllowed: true,
    enterpriseWindow
  })
  const result: ResourcePolicyResult = Object.freeze({
    status: 'ready',
    profile,
    sourceCommit: fixtureSourceCommit,
    runtime: {
      platform: process.platform as 'linux' | 'darwin' | 'win32',
      arch: process.arch as 'x64' | 'arm64',
      node: process.versions.node,
      electron: process.versions.electron ?? '43.6.0',
      v8: process.versions.v8,
      modules: process.versions.modules
    }
  })
  const resolver = (_input: ResourcePolicyInput): ResourcePolicyResult => result
  return {
    readBundledReceipt,
    readAdminReceipt: async (): Promise<AdminPolicyReceipt> => Object.freeze({}) as AdminPolicyReceipt,
    sourceCommit: () => fixtureSourceCommit,
    resolvePolicy: resolver,
    nativeKeyStore: {
      selectedBackend: () => 'linux-secret-service',
      wrap: (contentKeyBase64) => Buffer.from(`source-fixture:${contentKeyBase64}`, 'utf8'),
      unwrap: (wrapped) => {
        const value = wrapped.toString('utf8')
        if (!value.startsWith('source-fixture:')) throw new Error('Synthetic key envelope is invalid')
        return value.slice('source-fixture:'.length)
      }
    },
    createSpeech: (admittedProfile, suppliedIsCurrent: () => boolean) => {
      const policy = toMeetingSpeechPolicy(admittedProfile)
      const service = createMeetingSpeechPersistenceService({
        readLimits: () => policy.limits,
        readBounds: () => ({
          maxInputBytes: policy.maxInputBytes,
          maxOutputBytes: policy.maxOutputBytes,
          operationDeadlineMs: policy.operationDeadlineMs,
          shutdownDeadlineMs: policy.shutdownDeadlineMs
        }),
        isCurrent: suppliedIsCurrent,
        workerFactory: workerFactory ?? (() => new SourceWorker())
      })
      return speechObserver ? speechObserver(service, { admittedProfile, policy, suppliedIsCurrent }) : service
    }
  }
}

type OwnerSpeechObservation = {
  service: MeetingSpeechPersistenceService | undefined
  isCurrent: (() => boolean) | undefined
  bindings: IncrementalRecordReceiptBinding[]
  canonicalCalls: number
  canonicalDispatches: number
  workerStarts: number
  acceptedReceipts: number
  hostError: 'NONE' | 'CANCELLED' | 'UNCONFIGURED' | 'WORKER_FAILED' | 'OTHER'
}

function ownerSpeechObservation(): OwnerSpeechObservation {
  return {
    service: undefined,
    isCurrent: undefined,
    bindings: [],
    canonicalCalls: 0,
    canonicalDispatches: 0,
    workerStarts: 0,
    acceptedReceipts: 0,
    hostError: 'NONE'
  }
}

function observeOwnerSpeech(
  service: MeetingSpeechPersistenceService,
  isCurrent: () => boolean,
  observation: OwnerSpeechObservation
): MeetingSpeechPersistenceService {
  const canonicalize = service.canonicalizeIncrementalRecord.bind(service)
  const observed: MeetingSpeechPersistenceService = {
    ...service,
    async canonicalizeIncrementalRecord(recordJson, binding) {
      observation.canonicalCalls += 1
      observation.bindings.push(binding)
      try {
        const receipt = await canonicalize(recordJson, binding)
        observation.acceptedReceipts += 1
        return receipt
      } catch (error) {
        observation.hostError =
          error instanceof Error && ['CANCELLED', 'UNCONFIGURED', 'WORKER_FAILED'].includes(error.name)
            ? (error.name as OwnerSpeechObservation['hostError'])
            : 'OTHER'
        throw error
      }
    }
  }
  observation.service = observed
  observation.isCurrent = isCurrent
  return observed
}

function speechRecord(recordId: string, text: string, timestamp: number): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      identity: { kind: 'local', recordId },
      source: 'local-final',
      line: { speaker: 'you', text, t: timestamp }
    })
  )
}

function configureMainProcess(userData: string): void {
  const electronApp = app as unknown as {
    getPath: (name: string) => string
    hasSingleInstanceLock: () => boolean
  }
  vi.spyOn(electronApp, 'getPath').mockReturnValue(userData)
  Object.defineProperty(electronApp, 'hasSingleInstanceLock', {
    configurable: true,
    writable: true,
    value: vi.fn()
  })
  vi.spyOn(electronApp, 'hasSingleInstanceLock').mockReturnValue(true)
}

describe('main persistence factory source fixture', () => {
  it('holds new root/key admission while policy publication is pending', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-pending-'))
    configureMainProcess(userData)
    const settings = { ...DEFAULT_SETTINGS, encryptTranscripts: true }
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot(settings, true)
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolveRead) => {
      releaseRead = resolveRead
    })
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(async () => {
        await readGate
        return null
      })
    )
    try {
      const pendingPrime = bootstrap.prime()
      await expect(bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1268')).rejects.toThrow(
        'Retained persistence is not qualified for this runtime'
      )
      expect(readdirSync(userData)).toEqual([])
      releaseRead()
      await expect(pendingPrime).resolves.toMatchObject({ status: 'ready' })
      const journal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1268')
      await journal.settle()
    } finally {
      releaseRead()
      await bootstrap.dispose()
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('creates, appends, settles, freshly reopens read-only, and preserves the durable frontier', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-factory-'))
    configureMainProcess(userData)
    const settings = { ...DEFAULT_SETTINGS, encryptTranscripts: true }
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot(settings, true)
    let bootstrapCanonicalCalls = 0
    let bootstrapCanonicalDispatches = 0
    let controlCanonicalDispatches = 0
    let controlPhysicalExit = false
    let controlDisposal = 'pending'
    let controlReceiptValid = false
    let copiedReceiptRejected = false
    let controlReceiptDiscarded = false
    let controlRecordInputsEqual = false
    let controlPolicyInputsEqual = false
    let controlBindingIdentitySame = false
    let controlOwnerTokenIdentitySame = false
    let controlCallbackIdentitySame = false
    let journalOwnerBeforeControl = false
    let journalOwnerAfterControl = false
    let ownerPredicate = 'missing'
    let bootstrapHostError = 'NONE'
    let instrumented = false
    const services = sourceFixture(
      async () => null,
      () =>
        new SourceWorker((request) => {
          if (request.operation === 'canonical-record') bootstrapCanonicalDispatches += 1
        }),
      undefined,
      (service, { policy, suppliedIsCurrent }) => {
        if (instrumented) return service
        instrumented = true
        ownerPredicate = 'present'
        const originalCanonicalize = service.canonicalizeIncrementalRecord.bind(service)
        return {
          ...service,
          async canonicalizeIncrementalRecord(recordJson, binding) {
            bootstrapCanonicalCalls += 1
            journalOwnerBeforeControl = binding.isCurrent() === true
            const ownedCopy = Uint8Array.from(recordJson)
            controlRecordInputsEqual =
              ownedCopy.byteLength === recordJson.byteLength && Buffer.from(ownedCopy).equals(Buffer.from(recordJson))
            controlPolicyInputsEqual =
              policy.limits.maxRecords === binding.limits.maxRecords &&
              policy.limits.maxWords === binding.limits.maxWords &&
              policy.limits.maxFieldBytes === binding.limits.maxFieldBytes &&
              policy.limits.maxRecordBytes === binding.limits.maxRecordBytes &&
              policy.limits.maxPayloadBytes === binding.limits.maxPayloadBytes
            const controlBinding: IncrementalRecordReceiptBinding = binding

            const controlWorker = new SourceWorker(
              (request) => {
                if (request.operation === 'canonical-record') controlCanonicalDispatches += 1
              },
              () => {
                controlPhysicalExit = true
              }
            )
            const controlService = createMeetingSpeechPersistenceService({
              readLimits: () => policy.limits,
              readBounds: () => ({
                maxInputBytes: policy.maxInputBytes,
                maxOutputBytes: policy.maxOutputBytes,
                operationDeadlineMs: policy.operationDeadlineMs,
                shutdownDeadlineMs: policy.shutdownDeadlineMs
              }),
              isCurrent: controlBinding.isCurrent,
              workerFactory: () => controlWorker
            })
            controlBindingIdentitySame = controlBinding === binding
            controlOwnerTokenIdentitySame = controlBinding.ownerToken === binding.ownerToken
            controlCallbackIdentitySame = controlBinding.isCurrent === binding.isCurrent
            let controlReceipt: IncrementalRecordReceipt | undefined
            try {
              controlReceipt = await controlService.canonicalizeIncrementalRecord(ownedCopy, controlBinding)
              copiedReceiptRejected = inspectIncrementalRecordReceipt({ ...controlReceipt }, controlBinding) === null
              controlReceiptValid = inspectIncrementalRecordReceipt(controlReceipt, controlBinding) !== null
            } finally {
              if (controlReceipt) {
                discardIncrementalRecordReceipt(controlReceipt)
                controlReceiptDiscarded = true
              }
              await controlService.dispose()
              controlDisposal = 'fulfilled'
            }
            journalOwnerAfterControl = binding.isCurrent() === true

            try {
              return await originalCanonicalize(recordJson, binding)
            } catch (error) {
              bootstrapHostError =
                error instanceof Error && ['UNCONFIGURED', 'CANCELLED', 'WORKER_FAILED'].includes(error.name)
                  ? error.name
                  : 'OTHER'
              throw error
            }
          }
        }
      }
    )
    const first = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      services
    )
    let second: ReturnType<typeof createMainPersistenceBootstrapWithSourceFixture> | undefined
    try {
      await expect(first.prime()).resolves.toMatchObject({ status: 'ready' })
      const writable = await first.openNew('16f45c47-6583-45fb-8340-72aa6b6d1268')
      const record = new TextEncoder().encode(
        JSON.stringify({
          identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
          source: 'local-final',
          line: { speaker: 'you', text: 'one bounded record', t: 1_700_000_000_000 }
        })
      )
      const appendResult = await writable.append(record, 0)
      expect({
        journalOwnerBeforeControl,
        journalOwnerAfterControl,
        controlRecordInputsEqual,
        controlPolicyInputsEqual,
        controlBindingIdentitySame,
        controlOwnerTokenIdentitySame,
        controlCallbackIdentitySame,
        controlCanonicalDispatches,
        controlReceiptValid,
        copiedReceiptRejected,
        controlReceiptDiscarded,
        controlDisposal,
        controlPhysicalExit,
        bootstrapCanonicalCalls,
        bootstrapCanonicalDispatches
      }).toEqual({
        journalOwnerBeforeControl: true,
        journalOwnerAfterControl: true,
        controlRecordInputsEqual: true,
        controlPolicyInputsEqual: true,
        controlBindingIdentitySame: true,
        controlOwnerTokenIdentitySame: true,
        controlCallbackIdentitySame: true,
        controlCanonicalDispatches: 1,
        controlReceiptValid: true,
        copiedReceiptRejected: true,
        controlReceiptDiscarded: true,
        controlDisposal: 'fulfilled',
        controlPhysicalExit: true,
        bootstrapCanonicalCalls: 1,
        bootstrapCanonicalDispatches: ownerPredicate === 'present' ? 1 : 0
      })
      recordSettlementEvidence('F02', {
        readyProfile: true,
        openedRealJournal: true,
        ownerPredicate,
        journalOwnerBeforeControl,
        journalOwnerAfterControl,
        recordInputsEqual: controlRecordInputsEqual,
        policyInputsEqual: controlPolicyInputsEqual,
        controlBindingIdentitySame,
        controlOwnerTokenIdentitySame,
        controlCallbackIdentitySame,
        controlCanonicalDispatches,
        controlReceiptValid,
        copiedReceiptRejected,
        controlDisposal,
        controlPhysicalExit,
        controlReceiptDiscarded,
        bootstrapCanonicalCalls,
        bootstrapCanonicalDispatches,
        bootstrapHostError,
        appendStatus: appendResult.status,
        appendReason: appendResult.status === 'refused' ? appendResult.reason : null
      })
      expect(appendResult, 'F02 main-owned speech owner dependency: durable append is required').toMatchObject({
        status: 'durable',
        revision: 1,
        duplicate: false
      })
      const reference = writable.keyReference
      await writable.settle()
      await first.dispose()

      second = createMainPersistenceBootstrapWithSourceFixture(
        { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
        services
      )
      await expect(second.prime()).resolves.toMatchObject({ status: 'ready' })
      const reopened = await second.openExisting(writable.meetingId, reference)
      expect(reopened.snapshot).toMatchObject({ durableRevision: 1, acceptedRevision: 1, recordCount: 1 })
      expect('append' in reopened).toBe(false)
      await reopened.settle()
    } finally {
      await second?.dispose()
      await first.dispose()
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('keeps main settlement pending until a retired worker reports physical exit', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-worker-exit-'))
    configureMainProcess(userData)
    const settings = { ...DEFAULT_SETTINGS, encryptTranscripts: true }
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot(settings, true)
    let allowExit!: () => void
    let markTerminating!: () => void
    let markWorkerCreated!: () => void
    const exitGate = new Promise<void>((resolveExit) => {
      allowExit = resolveExit
    })
    const terminating = new Promise<void>((resolveTerminating) => {
      markTerminating = resolveTerminating
    })
    const workerCreated = new Promise<void>((resolveCreated) => {
      markWorkerCreated = resolveCreated
    })
    class HeldExitWorker extends SourceWorker {
      override async terminate(): Promise<number> {
        markTerminating()
        await exitGate
        this.emit('exit', 0)
        return 0
      }
    }
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(
        async () => null,
        () => {
          markWorkerCreated()
          return new HeldExitWorker()
        }
      )
    )
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const journal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1269')
      const append = journal.append(
        new TextEncoder().encode(
          JSON.stringify({
            identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9e' },
            source: 'local-final',
            line: { speaker: 'you', text: 'held worker exit', t: 1_700_000_000_001 }
          })
        ),
        0
      )
      void append.catch(() => undefined)
      await workerCreated
      bootstrap.retire('test-worker-exit')
      await terminating
      let settled = false
      const disposal = bootstrap.dispose()
      const settlement = disposal.then(() => {
        settled = true
      })
      expect(bootstrap.dispose()).toBe(disposal)
      await Promise.resolve()
      expect(settled).toBe(false)
      allowExit()
      await settlement
      expect(settled).toBe(true)
    } finally {
      allowExit()
      await bootstrap.dispose()
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('admits speech work only after its exact policy owner is published', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-speech-owner-publish-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const observed = ownerSpeechObservation()
    let candidateFalseInFactory = false
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(
        async () => null,
        () => {
          observed.workerStarts += 1
          return new SourceWorker((request) => {
            if (request.operation === 'canonical-record') observed.canonicalDispatches += 1
          })
        },
        undefined,
        (service, { suppliedIsCurrent }) => {
          candidateFalseInFactory = suppliedIsCurrent() === false
          return observeOwnerSpeech(service, suppliedIsCurrent, observed)
        }
      )
    )
    let journal: WritableMainMeetingJournal | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const ownerCurrentAfterPublication = observed.isCurrent?.() === true
      const workerStartsBeforeAppend = observed.workerStarts
      journal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1280')
      const appendResult = await journal.append(
        speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f90', 'published owner', 1_700_000_000_010),
        0
      )
      const workerStartsAfterAppend = observed.workerStarts
      bootstrap.retire('O01-owner-retired')
      const ownerFalseAfterRetire = observed.isCurrent?.() === false
      await journal.settle()
      await bootstrap.dispose()
      const ownerFalseAfterDispose = observed.isCurrent?.() === false
      const evidence = {
        candidateFalseInFactory,
        workerStartsBeforeAppend,
        ownerCurrentAfterPublication,
        appendStatus: appendResult.status,
        workerStartsAfterAppend,
        ownerFalseAfterRetire,
        ownerFalseAfterDispose
      }
      recordSettlementEvidence('O01', evidence)
      expect(evidence).toEqual({
        candidateFalseInFactory: true,
        workerStartsBeforeAppend: 0,
        ownerCurrentAfterPublication: true,
        appendStatus: 'durable',
        workerStartsAfterAppend: 1,
        ownerFalseAfterRetire: true,
        ownerFalseAfterDispose: true
      })
    } finally {
      await journal?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('retires the original speech and journal owners across a same-profile policy refresh', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-speech-owner-refresh-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const exitGate = settlementGate()
    let factoryCalls = 0
    let oldWorkerPhysicalExit = false
    const observedOwners: Array<OwnerSpeechObservation & { profile?: ResolvedPersistenceProfile }> = []
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(
        async () => null,
        () => {
          factoryCalls += 1
          const worker =
            factoryCalls === 1
              ? new (class extends SourceWorker {
                  override async terminate(): Promise<number> {
                    exitGate.attempts += 1
                    exitGate.notifyEntered()
                    await exitGate.wait
                    return super.terminate()
                  }
                })(
                  (request) => {
                    if (request.operation === 'canonical-record') observedOwners[0]!.canonicalDispatches += 1
                  },
                  () => {
                    oldWorkerPhysicalExit = true
                  }
                )
              : new SourceWorker((request) => {
                  const current = observedOwners.at(-1)
                  if (request.operation === 'canonical-record' && current) current.canonicalDispatches += 1
                })
          const current = observedOwners.at(-1)
          if (current) current.workerStarts += 1
          return worker
        },
        undefined,
        (service, { admittedProfile, suppliedIsCurrent }) => {
          const observed = ownerSpeechObservation() as OwnerSpeechObservation & { profile?: ResolvedPersistenceProfile }
          observed.profile = admittedProfile
          observedOwners.push(observed)
          return observeOwnerSpeech(service, suppliedIsCurrent, observed)
        }
      )
    )
    let oldJournal: WritableMainMeetingJournal | undefined
    let freshJournal: WritableMainMeetingJournal | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const firstOwner = observedOwners[0]
      oldJournal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1281')
      const initialAppend = await oldJournal.append(
        speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f91', 'before refresh', 1_700_000_000_011),
        0
      )
      const refresh = bootstrap.prime()
      await exitGate.entered
      const oldOwnerFalseWhilePending = firstOwner?.isCurrent?.() === false
      const newActionBlocked = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1282').then(
        () => false,
        () => true
      )
      const noReplacementBeforeExit = observedOwners.length === 1
      const physicalExitHeld = exitGate.attempts === 1
      exitGate.release()
      await expect(refresh).resolves.toMatchObject({ status: 'ready' })
      const oldOwnerFalseAfterRefresh = firstOwner?.isCurrent?.() === false
      const sameProfileObject = observedOwners.length === 2 && observedOwners[0]?.profile === observedOwners[1]?.profile
      const oldAppend = await oldJournal.append(
        speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f92', 'old journal after refresh', 1_700_000_000_012),
        1
      )
      const freshOwnerCurrent = observedOwners[1]?.isCurrent?.() === true
      freshJournal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1283')
      const freshAppend = await freshJournal.append(
        speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f93', 'fresh journal after refresh', 1_700_000_000_013),
        0
      )
      const evidence = {
        initialAppendStatus: initialAppend.status,
        oldOwnerFalseWhilePending,
        newActionBlocked,
        noReplacementBeforeExit,
        physicalExitHeld,
        physicalExitReleased: oldWorkerPhysicalExit,
        sameProfileObject,
        oldOwnerFalseAfterRefresh,
        oldJournalStatus: oldAppend.status,
        oldJournalReason: oldAppend.status === 'refused' ? oldAppend.reason : null,
        freshOwnerCurrent,
        freshAppendStatus: freshAppend.status
      }
      recordSettlementEvidence('O02', evidence)
      expect(evidence).toEqual({
        initialAppendStatus: 'durable',
        oldOwnerFalseWhilePending: true,
        newActionBlocked: true,
        noReplacementBeforeExit: true,
        physicalExitHeld: true,
        physicalExitReleased: true,
        sameProfileObject: true,
        oldOwnerFalseAfterRefresh: true,
        oldJournalStatus: 'refused',
        oldJournalReason: 'STALE_OWNER',
        freshOwnerCurrent: true,
        freshAppendStatus: 'durable'
      })
    } finally {
      exitGate.release()
      await oldJournal?.settle().catch(() => undefined)
      await freshJournal?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('rejects a held canonical reply after the original settings authority is replaced and restored', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-speech-owner-settings-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    const settings = { ...DEFAULT_SETTINGS, encryptTranscripts: true }
    publishSettingsSnapshot(settings, true)
    const replyGate = settlementGate()
    const observations: OwnerSpeechObservation[] = []
    let heldRequestIdentity: (Omit<CanonicalReplyIdentity, 'successful'> & { operation: string }) | undefined
    let heldReplyIdentity: CanonicalReplyIdentity | undefined
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(
        async () => null,
        () =>
          new SourceWorker(
            (request) => {
              const current = observations[0]
              if (request.operation === 'canonical-record' && current) current.canonicalDispatches += 1
            },
            undefined,
            async (request, reply) => {
              if (!isMatchingCanonicalSuccess(request, reply)) return
              replyGate.attempts += 1
              heldRequestIdentity = {
                protocol: request.protocol,
                id: request.id,
                generation: request.generation,
                operation: request.operation
              }
              heldReplyIdentity = {
                protocol: reply.protocol,
                id: reply.id,
                generation: reply.generation,
                successful: reply.result.ok
              }
              replyGate.notifyEntered()
              await replyGate.wait
            }
          ),
        undefined,
        (service, { suppliedIsCurrent }) => {
          const observed = ownerSpeechObservation()
          observations.push(observed)
          return observeOwnerSpeech(service, suppliedIsCurrent, observed)
        }
      )
    )
    let journal: WritableMainMeetingJournal | undefined
    let reopened: ReadOnlyMainMeetingJournal | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      journal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1284')
      const appendPromise = journal.append(
        speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f94', 'held settings reply', 1_700_000_000_014),
        0
      )
      const appendOutcome = appendPromise.then(
        (result) => ({ status: 'resolved' as const, result }),
        (error: unknown) => ({ status: 'rejected' as const, errorName: error instanceof Error ? error.name : 'OTHER' })
      )
      await replyGate.entered
      publishSettingsSnapshot({ ...settings, encryptTranscripts: false }, true)
      publishSettingsSnapshot(settings, true)
      const oldOwnerFalseAfterRestore = observations[0]?.isCurrent?.() === false
      replyGate.release()
      const completedAppend = await appendOutcome
      const appendResult = completedAppend.status === 'resolved' ? completedAppend.result : undefined
      const heldActualReply =
        replyGate.attempts === 1 &&
        heldRequestIdentity?.operation === 'canonical-record' &&
        heldRequestIdentity.protocol === heldReplyIdentity?.protocol &&
        heldRequestIdentity.id === heldReplyIdentity?.id &&
        heldRequestIdentity.generation === heldReplyIdentity?.generation &&
        heldReplyIdentity.successful === true
      const oldReceiptAccepted = (observations[0]?.acceptedReceipts ?? 0) > 0
      const keyReference = journal.keyReference
      await journal.settle()
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      reopened = await bootstrap.openExisting(journal.meetingId, keyReference)
      const durableRevisionUnchanged = reopened.snapshot.durableRevision === 0
      const recordCountUnchanged = reopened.snapshot.recordCount === 0
      const evidence = {
        heldActualReply,
        canonicalDispatches: observations[0]?.canonicalDispatches ?? 0,
        settingsChangedAndRestored: true,
        oldOwnerFalseAfterRestore,
        hostError: observations[0]?.hostError ?? 'OTHER',
        oldReceiptAccepted,
        appendStatus: appendResult?.status ?? 'threw',
        appendReason: appendResult?.status === 'refused' ? appendResult.reason : null,
        durableRevisionUnchanged,
        recordCountUnchanged
      }
      recordSettlementEvidence('O03', evidence)
      expect(evidence).toEqual({
        heldActualReply: true,
        canonicalDispatches: 1,
        settingsChangedAndRestored: true,
        oldOwnerFalseAfterRestore: true,
        hostError: 'CANCELLED',
        oldReceiptAccepted: false,
        appendStatus: 'refused',
        appendReason: 'UNAVAILABLE',
        durableRevisionUnchanged: true,
        recordCountUnchanged: true
      })
      await reopened.settle()
      await journal.settle()
    } finally {
      replyGate.release()
      await reopened?.settle().catch(() => undefined)
      await journal?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('keeps the original speech owner retired after an observed profile path replacement and restoration', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-speech-owner-path-a-'))
    const replacementUserData = mkdtempSync(resolve(tmpdir(), 'metis-main-speech-owner-path-b-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const observed = ownerSpeechObservation()
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(
        async () => null,
        () =>
          new SourceWorker((request) => {
            if (request.operation === 'canonical-record') observed.canonicalDispatches += 1
          }),
        undefined,
        (service, { suppliedIsCurrent }) => observeOwnerSpeech(service, suppliedIsCurrent, observed)
      )
    )
    let journal: WritableMainMeetingJournal | undefined
    let reopened: ReadOnlyMainMeetingJournal | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      journal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1285')
      const record = speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f95', 'path owner record', 1_700_000_000_015)
      const appendResult = await journal.append(Uint8Array.from(record), 0)
      const binding = observed.bindings[0]
      const originalService = observed.service
      const pathSpy = vi.spyOn(app as unknown as { getPath: (name: string) => string }, 'getPath')
      pathSpy.mockReturnValue(replacementUserData)
      const ownerFalseAtReplacement = observed.isCurrent?.() === false
      pathSpy.mockReturnValue(userData)
      const ownerFalseAfterRestoration = observed.isCurrent?.() === false
      const dispatchesBeforeStaleCall = observed.canonicalDispatches
      const staleHostError =
        binding && originalService
          ? await originalService.canonicalizeIncrementalRecord(Uint8Array.from(record), binding).then(
              () => 'NONE',
              (error: unknown) => (error instanceof Error ? error.name : 'OTHER')
            )
          : 'MISSING_BINDING'
      const dispatchesAfterStaleCall = observed.canonicalDispatches
      const keyReference = journal.keyReference
      await journal.settle()
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      reopened = await bootstrap.openExisting(journal.meetingId, keyReference)
      const frontierUnchanged = reopened.snapshot.durableRevision === 1 && reopened.snapshot.recordCount === 1
      const evidence = {
        initialAppendStatus: appendResult.status,
        bindingCaptured: binding !== undefined,
        serviceCaptured: originalService !== undefined,
        ownerFalseAtReplacement,
        ownerFalseAfterRestoration,
        staleHostError,
        dispatchesBeforeStaleCall,
        dispatchesAfterStaleCall,
        frontierUnchanged
      }
      recordSettlementEvidence('O04', evidence)
      expect(evidence).toEqual({
        initialAppendStatus: 'durable',
        bindingCaptured: true,
        serviceCaptured: true,
        ownerFalseAtReplacement: true,
        ownerFalseAfterRestoration: true,
        staleHostError: 'CANCELLED',
        dispatchesBeforeStaleCall: 1,
        dispatchesAfterStaleCall: 1,
        frontierUnchanged: true
      })
      await reopened.settle()
      await journal.settle()
    } finally {
      await reopened?.settle().catch(() => undefined)
      await journal?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
      rmSync(replacementUserData, { recursive: true, force: true })
    }
  })

  it('rejects a held canonical reply after the original session principal is replaced and restored', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-speech-owner-auth-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const replyGate = settlementGate()
    const observations: OwnerSpeechObservation[] = []
    const originalPrincipal = settlementFaults.authPrincipalAssociation
    const originalEpoch = settlementFaults.authEpoch
    let heldRequestIdentity: (Omit<CanonicalReplyIdentity, 'successful'> & { operation: string }) | undefined
    let heldReplyIdentity: CanonicalReplyIdentity | undefined
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(
        async () => null,
        () =>
          new SourceWorker(
            (request) => {
              const current = observations[0]
              if (request.operation === 'canonical-record' && current) current.canonicalDispatches += 1
            },
            undefined,
            async (request, reply) => {
              if (!isMatchingCanonicalSuccess(request, reply)) return
              replyGate.attempts += 1
              heldRequestIdentity = {
                protocol: request.protocol,
                id: request.id,
                generation: request.generation,
                operation: request.operation
              }
              heldReplyIdentity = {
                protocol: reply.protocol,
                id: reply.id,
                generation: reply.generation,
                successful: reply.result.ok
              }
              replyGate.notifyEntered()
              await replyGate.wait
            }
          ),
        undefined,
        (service, { suppliedIsCurrent }) => {
          const observed = ownerSpeechObservation()
          observations.push(observed)
          return observeOwnerSpeech(service, suppliedIsCurrent, observed)
        }
      )
    )
    let journal: WritableMainMeetingJournal | undefined
    let reopened: ReadOnlyMainMeetingJournal | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      journal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1286')
      const appendPromise = journal.append(
        speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f96', 'held auth reply', 1_700_000_000_016),
        0
      )
      const appendOutcome = appendPromise.then(
        (result) => ({ status: 'resolved' as const, result }),
        (error: unknown) => ({ status: 'rejected' as const, errorName: error instanceof Error ? error.name : 'OTHER' })
      )
      await replyGate.entered
      settlementFaults.authEpoch += 1
      settlementFaults.authPrincipalAssociation = 'b'.repeat(64)
      settlementFaults.authEpoch += 1
      settlementFaults.authPrincipalAssociation = originalPrincipal
      const replacementRestored = settlementFaults.authPrincipalAssociation === originalPrincipal
      const oldOwnerFalseAfterRestore = observations[0]?.isCurrent?.() === false
      replyGate.release()
      const completedAppend = await appendOutcome
      const appendResult = completedAppend.status === 'resolved' ? completedAppend.result : undefined
      const heldActualReply =
        replyGate.attempts === 1 &&
        heldRequestIdentity?.operation === 'canonical-record' &&
        heldRequestIdentity.protocol === heldReplyIdentity?.protocol &&
        heldRequestIdentity.id === heldReplyIdentity?.id &&
        heldRequestIdentity.generation === heldReplyIdentity?.generation &&
        heldReplyIdentity.successful === true
      const oldReceiptAccepted = (observations[0]?.acceptedReceipts ?? 0) > 0
      const keyReference = journal.keyReference
      await journal.settle()
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      reopened = await bootstrap.openExisting(journal.meetingId, keyReference)
      const durableRevisionUnchanged = reopened.snapshot.durableRevision === 0
      const recordCountUnchanged = reopened.snapshot.recordCount === 0
      const evidence = {
        heldActualReply,
        canonicalDispatches: observations[0]?.canonicalDispatches ?? 0,
        originalPrincipalRestored: replacementRestored,
        originalAuthEpochChanged: settlementFaults.authEpoch !== originalEpoch,
        oldOwnerFalseAfterRestore,
        hostError: observations[0]?.hostError ?? 'OTHER',
        oldReceiptAccepted,
        appendStatus: appendResult?.status ?? 'threw',
        appendReason: appendResult?.status === 'refused' ? appendResult.reason : null,
        durableRevisionUnchanged,
        recordCountUnchanged
      }
      recordSettlementEvidence('O05', evidence)
      expect(evidence).toEqual({
        heldActualReply: true,
        canonicalDispatches: 1,
        originalPrincipalRestored: true,
        originalAuthEpochChanged: true,
        oldOwnerFalseAfterRestore: true,
        hostError: 'CANCELLED',
        oldReceiptAccepted: false,
        appendStatus: 'refused',
        appendReason: 'UNAVAILABLE',
        durableRevisionUnchanged: true,
        recordCountUnchanged: true
      })
      await reopened.settle()
      await journal.settle()
    } finally {
      replyGate.release()
      settlementFaults.authPrincipalAssociation = originalPrincipal
      settlementFaults.authEpoch = originalEpoch
      await reopened?.settle().catch(() => undefined)
      await journal?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('permanently refuses expired or regressed speech owner clocks', async () => {
    const clock = { wall: Date.now(), monotonic: performance.now() }
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock.wall)
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => clock.monotonic)
    const outcomes: Array<Record<string, unknown>> = []
    const clockCases = [
      'enterprise-expiry',
      'wall-clock-rollback',
      'monotonic-clock-rollback',
      'non-finite-clock'
    ] as const
    const createdDirectories: string[] = []
    try {
      for (const [index, caseId] of clockCases.entries()) {
        clock.wall += 20
        clock.monotonic += 20
        const baseWall = clock.wall
        const baseMonotonic = clock.monotonic
        const userData = mkdtempSync(resolve(tmpdir(), `metis-main-speech-owner-clock-${index}-`))
        createdDirectories.push(userData)
        configureMainProcess(userData)
        commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
        commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
        publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
        const observed = ownerSpeechObservation()
        const enterpriseWindow =
          caseId === 'enterprise-expiry' ? { notBefore: baseWall - 1000, expiresAt: baseWall + 500 } : null
        const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
          { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
          sourceFixture(
            async () => null,
            () =>
              new SourceWorker((request) => {
                if (request.operation === 'canonical-record') observed.canonicalDispatches += 1
              }),
            undefined,
            (service, { suppliedIsCurrent }) => observeOwnerSpeech(service, suppliedIsCurrent, observed),
            enterpriseWindow
          )
        )
        let journal: WritableMainMeetingJournal | undefined
        try {
          await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
          const ownerCurrentBeforeFault = observed.isCurrent?.() === true
          journal = await bootstrap.openNew(`16f45c47-6583-45fb-8340-72aa6b6d128${index}`)
          const record = speechRecord(
            `6370e1cc-43f4-4976-a912-04d0c3ca8f9${index}`,
            `clock owner ${caseId}`,
            1_700_000_000_020 + index
          )
          const appendResult = await journal.append(Uint8Array.from(record), 0)
          const binding = observed.bindings[0]
          const dispatchesBeforeFault = observed.canonicalDispatches
          if (caseId === 'enterprise-expiry') clock.wall = enterpriseWindow!.expiresAt
          else if (caseId === 'wall-clock-rollback') clock.wall = baseWall - 1
          else if (caseId === 'monotonic-clock-rollback') clock.monotonic = baseMonotonic - 1
          else clock.monotonic = Number.NaN
          const ownerFalseAtFault = observed.isCurrent?.() === false
          const staleHostError =
            binding && observed.service
              ? await observed.service.canonicalizeIncrementalRecord(Uint8Array.from(record), binding).then(
                  () => 'NONE',
                  (error: unknown) => (error instanceof Error ? error.name : 'OTHER')
                )
              : 'MISSING_BINDING'
          const dispatchesAfterFault = observed.canonicalDispatches
          clock.wall = baseWall
          clock.monotonic = baseMonotonic
          const ownerFalseAfterRestore = observed.isCurrent?.() === false
          const evidence = {
            caseId,
            ownerCurrentBeforeFault,
            initialAppendStatus: appendResult.status,
            bindingCaptured: binding !== undefined,
            ownerFalseAtFault,
            staleHostError,
            dispatchesBeforeFault,
            dispatchesAfterFault,
            ownerFalseAfterRestore
          }
          outcomes.push(evidence)
          await journal.settle()
          await bootstrap.dispose()
        } finally {
          clock.wall = baseWall
          clock.monotonic = baseMonotonic
          await journal?.settle().catch(() => undefined)
          await bootstrap.dispose().catch(() => undefined)
        }
      }
      recordSettlementEvidence('O06', { clockCases: outcomes })
      expect(outcomes).toHaveLength(4)
      expect(outcomes).toEqual(
        clockCases.map((caseId) => ({
          caseId,
          ownerCurrentBeforeFault: true,
          initialAppendStatus: 'durable',
          bindingCaptured: true,
          ownerFalseAtFault: true,
          staleHostError: 'CANCELLED',
          dispatchesBeforeFault: 1,
          dispatchesAfterFault: 1,
          ownerFalseAfterRestore: true
        }))
      )
    } finally {
      dateNow.mockRestore()
      monotonicNow.mockRestore()
      vi.restoreAllMocks()
      for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('joins held key writer and root settlement before releasing ownership', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-settlement-order-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const meetingId = '16f45c47-6583-45fb-8340-72aa6b6d1270'
    const rootPath = fixtureMeetingRoot(userData, meetingId)
    const writerPath = join(rootPath, '.journal-writer.lock')
    const keyGate = settlementGate()
    const writerGate = settlementGate()
    const rootGate = settlementGate()
    settlementFaults.keyGate = keyGate
    settlementFaults.closeGates.set(writerPath, writerGate)
    settlementFaults.closeGates.set(rootPath, rootGate)
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture()
    )
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const journal = await bootstrap.openNew(meetingId)
      let settlementState: 'pending' | 'fulfilled' | 'rejected' = 'pending'
      let disposalState: 'pending' | 'fulfilled' | 'rejected' = 'pending'
      const journalSettlement = journal.settle()
      const settlement = journalSettlement.then(
        () => {
          settlementState = 'fulfilled'
        },
        () => {
          settlementState = 'rejected'
        }
      )
      const disposalPromise = bootstrap.dispose()
      const disposal = disposalPromise.then(
        () => {
          disposalState = 'fulfilled'
        },
        () => {
          disposalState = 'rejected'
        }
      )
      expect(bootstrap.dispose()).toBe(disposalPromise)
      await keyGate.entered
      expect(settlementState).toBe('pending')
      expect(disposalState).toBe('pending')
      expect(writerGate.attempts).toBe(0)
      expect(rootGate.attempts).toBe(0)
      keyGate.release()

      await writerGate.entered
      expect(settlementState).toBe('pending')
      expect(disposalState).toBe('pending')
      expect(writerGate.attempts).toBe(1)
      expect(rootGate.attempts).toBe(0)
      writerGate.release()

      await rootGate.entered
      expect(settlementState).toBe('pending')
      expect(disposalState).toBe('pending')
      expect(rootGate.attempts).toBe(1)
      rootGate.release()
      await settlement
      await disposal
      await expect(journalSettlement).resolves.toBeUndefined()
      await expect(disposalPromise).resolves.toBeUndefined()
      expect(settlementState).toBe('fulfilled')
      expect(disposalState).toBe('fulfilled')
    } finally {
      keyGate.release()
      writerGate.release()
      rootGate.release()
      settlementFaults.keyGate = null
      settlementFaults.closeGates.delete(writerPath)
      settlementFaults.closeGates.delete(rootPath)
      await bootstrap.dispose().catch(() => undefined)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('retains a failed key settlement across repeated journal and bootstrap disposal', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-key-settlement-failure-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const keyFailure = 'injected protected-key settlement failure'
    const keyGate = settlementGate(keyFailure)
    keyGate.release()
    settlementFaults.keyGate = keyGate
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(async () => null, undefined, 1)
    )
    let successor: { settle(): Promise<void> } | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const journal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1271')
      const settlement = journal.settle()
      await keyGate.entered
      const journalOutcome = await settlementOutcome(settlement)
      const journalMemoized = journal.settle() === settlement
      const attemptsBeforeSuccessor = keyGate.attempts
      const successorAttempt = bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1272').then((value) => {
        successor = value
        return Promise.resolve()
      })
      const successorOutcome = await settlementOutcome(successorAttempt)
      const disposal = bootstrap.dispose()
      const disposalMemoized = bootstrap.dispose() === disposal
      const disposalOutcome = await settlementOutcome(disposal)
      const evidence = {
        keySettlementAttemptsBeforeSuccessor: attemptsBeforeSuccessor,
        keySettlementAttemptsAfterDisposal: keyGate.attempts,
        journalOutcome,
        journalMemoized,
        successorOutcome,
        successorAdmitted: Boolean(successor),
        disposalMemoized,
        disposalOutcome
      }
      recordSettlementEvidence('F05', {
        ...evidence
      })
      expect(evidence, `${keyFailure} must remain owned through journal and bootstrap disposal`).toMatchObject({
        keySettlementAttemptsBeforeSuccessor: 1,
        keySettlementAttemptsAfterDisposal: 1,
        journalOutcome: { status: 'rejected', errorMessage: keyFailure },
        journalMemoized: true,
        successorOutcome: { status: 'rejected' },
        successorAdmitted: false,
        disposalMemoized: true,
        disposalOutcome: { status: 'rejected', errorMessage: keyFailure }
      })
    } finally {
      settlementFaults.keyGate = null
      await successor?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      const meetingId = '16f45c47-6583-45fb-8340-72aa6b6d1271'
      const rootPath = fixtureMeetingRoot(userData, meetingId)
      await closeFixtureHandle(join(rootPath, '.journal-writer.lock'))
      await closeFixtureHandle(rootPath)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('retains a failed writer close across repeated journal and bootstrap disposal', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-writer-close-failure-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const meetingId = '16f45c47-6583-45fb-8340-72aa6b6d1273'
    const rootPath = fixtureMeetingRoot(userData, meetingId)
    const writerPath = join(rootPath, '.journal-writer.lock')
    const closeFailure = 'injected writer descriptor close failure'
    const writerGate = settlementGate(closeFailure)
    writerGate.release()
    settlementFaults.closeGates.set(writerPath, writerGate)
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(async () => null, undefined, 1)
    )
    let successor: { settle(): Promise<void> } | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const journal = await bootstrap.openNew(meetingId)
      const settlement = journal.settle()
      const journalOutcome = await settlementOutcome(settlement)
      const journalMemoized = journal.settle() === settlement
      const attemptsBeforeSuccessor = writerGate.attempts

      const successorAttempt = bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1274').then((value) => {
        successor = value
        return Promise.resolve()
      })
      const successorOutcome = await settlementOutcome(successorAttempt)
      const disposal = bootstrap.dispose()
      const disposalMemoized = bootstrap.dispose() === disposal
      const disposalOutcome = await settlementOutcome(disposal)
      const evidence = {
        writerCloseAttemptsBeforeSuccessor: attemptsBeforeSuccessor,
        writerCloseAttemptsAfterDisposal: writerGate.attempts,
        journalOutcome,
        journalMemoized,
        successorOutcome,
        successorAdmitted: Boolean(successor),
        disposalMemoized,
        disposalOutcome
      }
      recordSettlementEvidence('F06', evidence)
      expect(evidence, `${closeFailure} must remain owned through journal and bootstrap disposal`).toMatchObject({
        writerCloseAttemptsBeforeSuccessor: 1,
        writerCloseAttemptsAfterDisposal: 1,
        journalOutcome: { status: 'rejected', errorMessage: closeFailure },
        journalMemoized: true,
        successorOutcome: { status: 'rejected' },
        successorAdmitted: false,
        disposalMemoized: true,
        disposalOutcome: { status: 'rejected', errorMessage: closeFailure }
      })
    } finally {
      settlementFaults.closeGates.delete(writerPath)
      writerGate.release()
      await successor?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      await closeFixtureHandle(writerPath)
      await closeFixtureHandle(rootPath)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('retains a failed root close across repeated journal and bootstrap disposal', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-root-close-failure-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const meetingId = '16f45c47-6583-45fb-8340-72aa6b6d1275'
    const rootPath = fixtureMeetingRoot(userData, meetingId)
    const closeFailure = 'injected root descriptor close failure'
    const rootGate = settlementGate(closeFailure)
    rootGate.release()
    settlementFaults.closeGates.set(rootPath, rootGate)
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture(async () => null, undefined, 1)
    )
    let successor: { settle(): Promise<void> } | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const journal = await bootstrap.openNew(meetingId)
      const settlement = journal.settle()
      const journalOutcome = await settlementOutcome(settlement)
      const journalMemoized = journal.settle() === settlement
      const attemptsBeforeSuccessor = rootGate.attempts

      const successorAttempt = bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1276').then((value) => {
        successor = value
        return Promise.resolve()
      })
      const successorOutcome = await settlementOutcome(successorAttempt)
      const disposal = bootstrap.dispose()
      const disposalMemoized = bootstrap.dispose() === disposal
      const disposalOutcome = await settlementOutcome(disposal)
      const evidence = {
        rootCloseAttemptsBeforeSuccessor: attemptsBeforeSuccessor,
        rootCloseAttemptsAfterDisposal: rootGate.attempts,
        journalOutcome,
        journalMemoized,
        successorOutcome,
        successorAdmitted: Boolean(successor),
        disposalMemoized,
        disposalOutcome
      }
      recordSettlementEvidence('F07', evidence)
      expect(evidence, `${closeFailure} must remain owned through journal and bootstrap disposal`).toMatchObject({
        rootCloseAttemptsBeforeSuccessor: 1,
        rootCloseAttemptsAfterDisposal: 1,
        journalOutcome: { status: 'rejected', errorMessage: closeFailure },
        journalMemoized: true,
        successorOutcome: { status: 'rejected' },
        successorAdmitted: false,
        disposalMemoized: true,
        disposalOutcome: { status: 'rejected', errorMessage: closeFailure }
      })
    } finally {
      settlementFaults.closeGates.delete(rootPath)
      rootGate.release()
      await successor?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      await closeFixtureHandle(join(rootPath, '.journal-writer.lock'))
      await closeFixtureHandle(rootPath)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('retains failed open cleanup with the original operation error', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-open-cleanup-failure-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const meetingId = '16f45c47-6583-45fb-8340-72aa6b6d1277'
    const rootPath = fixtureMeetingRoot(userData, meetingId)
    const writerPath = join(rootPath, '.journal-writer.lock')
    const originalFailure = 'injected native key wrapping failure'
    const cleanupFailure = 'injected partial-open writer close failure'
    const writerGate = settlementGate(cleanupFailure)
    writerGate.release()
    settlementFaults.closeGates.set(writerPath, writerGate)
    const baseFixture = sourceFixture(async () => null, undefined, 1)
    let failOriginalWrap = true
    const failingFixture: MainPersistenceBootstrapSourceFixture = {
      ...baseFixture,
      nativeKeyStore: {
        ...baseFixture.nativeKeyStore,
        wrap: (contentKeyBase64) => {
          if (failOriginalWrap) {
            failOriginalWrap = false
            throw new Error(originalFailure)
          }
          return baseFixture.nativeKeyStore.wrap(contentKeyBase64)
        }
      }
    }
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      failingFixture
    )
    let successor: { settle(): Promise<void> } | undefined
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const opening = bootstrap.openNew(meetingId)
      const failure = await opening.then(
        () => undefined,
        (error: unknown) => error
      )
      const openingOutcome =
        failure instanceof Error
          ? {
              status: 'rejected',
              errorName: failure.name.slice(0, 80),
              errorMessage: failure.message.slice(0, 240)
            }
          : { status: 'fulfilled' }
      const aggregateMessages =
        failure instanceof AggregateError
          ? failure.errors
              .slice(0, 4)
              .map((error) => (error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)))
          : []
      const successorAttempt = bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1278').then((value) => {
        successor = value
        return Promise.resolve()
      })
      const successorOutcome = await settlementOutcome(successorAttempt)
      const closeAttemptsBeforeDisposal = writerGate.attempts
      const disposal = bootstrap.dispose()
      const disposalOutcome = await settlementOutcome(disposal)
      const evidence = {
        writerCloseAttemptsBeforeDisposal: closeAttemptsBeforeDisposal,
        writerCloseAttemptsAfterDisposal: writerGate.attempts,
        openingOutcome,
        aggregateMessages,
        successorOutcome,
        successorAdmitted: Boolean(successor),
        disposalOutcome
      }
      recordSettlementEvidence('F08', evidence)
      expect(bootstrap.dispose()).toBe(disposal)
      expect(evidence, `${originalFailure} and ${cleanupFailure} must remain owned after failed open`).toMatchObject({
        writerCloseAttemptsBeforeDisposal: 1,
        writerCloseAttemptsAfterDisposal: 1,
        openingOutcome: { status: 'rejected', errorName: 'AggregateError' },
        aggregateMessages: expect.arrayContaining([originalFailure, cleanupFailure]),
        successorOutcome: {
          status: 'rejected',
          errorMessage: expect.stringMatching(/descriptor limit/i)
        },
        successorAdmitted: false,
        disposalOutcome: {
          status: 'rejected',
          aggregateMessages: expect.arrayContaining([cleanupFailure])
        }
      })
    } finally {
      settlementFaults.closeGates.delete(writerPath)
      writerGate.release()
      await successor?.settle().catch(() => undefined)
      await bootstrap.dispose().catch(() => undefined)
      await closeFixtureHandle(writerPath)
      await closeFixtureHandle(rootPath)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('retains the root owner when writer acquisition fails before returning a lease', async () => {
    const writeFailure = 'injected unreturned-writer write failure'
    const closeFailure = 'injected unreturned-writer close failure'
    const rawHandleCleanups: Array<() => Promise<void>> = []
    const observe = async (failClose: boolean) => {
      const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-unreturned-writer-'))
      configureMainProcess(userData)
      commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
      commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
      publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
      const meetingId = failClose ? '16f45c47-6583-45fb-8340-72aa6b6d1287' : '16f45c47-6583-45fb-8340-72aa6b6d1290'
      const heldSuccessorId = '16f45c47-6583-45fb-8340-72aa6b6d1288'
      const postSuccessorId = failClose
        ? '16f45c47-6583-45fb-8340-72aa6b6d1289'
        : '16f45c47-6583-45fb-8340-72aa6b6d1291'
      const rootPath = fixtureMeetingRoot(userData, meetingId)
      const writerPath = join(rootPath, '.journal-writer.lock')
      rawHandleCleanups.push(async () => {
        await closeFixtureHandle(writerPath)
        await closeFixtureHandle(rootPath)
        rmSync(userData, { recursive: true, force: true })
      })
      const fault: SettlementWriteFault = { error: new Error(writeFailure), attempts: 0, raw: undefined }
      const writerGate = settlementGate(failClose ? closeFailure : undefined)
      const rootGate = settlementGate()
      rootGate.release()
      if (!failClose) writerGate.release()
      settlementFaults.writeFaults.set(writerPath, fault)
      settlementFaults.closeGates.set(writerPath, writerGate)
      settlementFaults.closeGates.set(rootPath, rootGate)
      let writerLeaseFulfillments = 0
      let keyWraps = 0
      const originalAcquireWriter = RootRegistry.prototype.acquireWriter
      const acquireObserver = vi.spyOn(RootRegistry.prototype, 'acquireWriter').mockImplementation(function (
        this: RootRegistry,
        ...args
      ) {
        const originalPromise = originalAcquireWriter.apply(this, args)
        if (args[1].meetingPath === rootPath)
          void originalPromise.then(
            () => {
              writerLeaseFulfillments += 1
            },
            () => undefined
          )
        return originalPromise
      })
      const baseFixture = sourceFixture(async () => null, undefined, 1)
      const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
        { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
        {
          ...baseFixture,
          nativeKeyStore: {
            ...baseFixture.nativeKeyStore,
            wrap: (contentKeyBase64) => {
              keyWraps += 1
              return baseFixture.nativeKeyStore.wrap(contentKeyBase64)
            }
          }
        }
      )
      let openingObserved: Promise<void> | undefined
      let heldSuccessorAttempt: Promise<unknown> | undefined
      let postSuccessorAttempt: Promise<unknown> | undefined
      let heldSuccessor: WritableMainMeetingJournal | undefined
      let postSuccessor: WritableMainMeetingJournal | undefined
      try {
        const primeResult = await bootstrap.prime()
        let openingStatus: 'pending' | 'fulfilled' | 'rejected' = 'pending'
        let openingError: unknown
        const opening = bootstrap.openNew(meetingId)
        openingObserved = opening.then(
          () => {
            openingStatus = 'fulfilled'
          },
          (error: unknown) => {
            openingStatus = 'rejected'
            openingError = error
          }
        )
        await writerGate.entered
        const openingStatusWhileCloseHeld = openingStatus
        const originalRootClosesWhileWriterHeld = rootGate.attempts
        const openedRawHandle = settlementFaults.openedHandles.get(writerPath)
        const realOpenObserved = openedRawHandle !== undefined
        const writeHandleMatchesOpen = realOpenObserved && openedRawHandle === fault.raw
        const closeHandleMatchesOpen = realOpenObserved && openedRawHandle === writerGate.raw

        let heldSuccessorOutcome: Record<string, unknown> | null = null
        let heldSuccessorAdmitted: boolean | null = null
        if (failClose) {
          heldSuccessorAttempt = bootstrap.openNew(heldSuccessorId).then((journal) => {
            heldSuccessor = journal
          })
          heldSuccessorOutcome = await settlementOutcome(heldSuccessorAttempt)
          heldSuccessorAdmitted = Boolean(heldSuccessor)
          await heldSuccessor?.settle().catch(() => undefined)
        }
        writerGate.release()
        await openingObserved
        const openingOutcome = await settlementOutcome(opening)
        const aggregateMembers =
          openingError instanceof AggregateError && Array.isArray(openingError.errors)
            ? openingError.errors.slice(0, 4)
            : []
        const keyWrapsBeforePostSuccessor = keyWraps
        const originalRootClosesBeforePostSuccessor = rootGate.attempts
        const writerClosesBeforePostSuccessor = writerGate.attempts

        postSuccessorAttempt = bootstrap.openNew(postSuccessorId).then((journal) => {
          postSuccessor = journal
        })
        const postSuccessorOutcome = await settlementOutcome(postSuccessorAttempt)
        const postSuccessorAdmitted = Boolean(postSuccessor)
        const postSuccessorSettlement = postSuccessor ? await settlementOutcome(postSuccessor.settle()) : null
        const originalRootClosesBeforeDisposal = rootGate.attempts
        const writerClosesBeforeDisposal = writerGate.attempts
        const disposal = bootstrap.dispose()
        const disposalMemoized = bootstrap.dispose() === disposal
        const disposalError = await disposal.then(
          () => undefined,
          (error: unknown) => error
        )
        const disposalOutcome = await settlementOutcome(disposal)
        const repeatedDisposalError = await bootstrap.dispose().then(
          () => undefined,
          (error: unknown) => error
        )
        return {
          primeReady: primeResult.status === 'ready',
          realOpenObserved,
          writeHandleMatchesOpen,
          closeHandleMatchesOpen,
          writeFaultCount: fault.attempts,
          writerLeaseFulfillments,
          keyWrapsBeforePostSuccessor,
          openingStatusWhileCloseHeld,
          openingOutcome,
          openingAggregateMessages: aggregateMembers.map((member) =>
            member instanceof Error ? member.message.slice(0, 120) : String(member).slice(0, 120)
          ),
          originalErrorIdentity: openingError === fault.error || aggregateMembers.includes(fault.error),
          cleanupErrorIdentity: writerGate.thrown !== undefined && aggregateMembers.includes(writerGate.thrown),
          originalRootClosesWhileWriterHeld,
          originalRootClosesBeforePostSuccessor,
          originalRootClosesBeforeDisposal,
          originalRootClosesAfterDisposal: rootGate.attempts,
          heldSuccessorOutcome,
          heldSuccessorAdmitted,
          postSuccessorOutcome,
          postSuccessorAdmitted,
          postSuccessorSettlement,
          writerClosesBeforePostSuccessor,
          writerClosesBeforeDisposal,
          writerClosesAfterDisposal: writerGate.attempts,
          disposalOutcome,
          disposalMemoized,
          disposalSameRejection: disposalError !== undefined && disposalError === repeatedDisposalError
        }
      } finally {
        writerGate.release()
        rootGate.release()
        settlementFaults.writeFaults.delete(writerPath)
        settlementFaults.closeGates.delete(writerPath)
        settlementFaults.closeGates.delete(rootPath)
        await Promise.allSettled([openingObserved, heldSuccessorAttempt, postSuccessorAttempt].filter(Boolean))
        await heldSuccessor?.settle().catch(() => undefined)
        await postSuccessor?.settle().catch(() => undefined)
        await bootstrap.dispose().catch(() => undefined)
        acquireObserver.mockRestore()
      }
    }

    try {
      const confirmedClose = await observe(false)
      const failedClose = await observe(true)
      const evidence = { confirmedClose, failedClose }
      recordSettlementEvidence('F10', evidence)
      expect(confirmedClose, `${writeFailure} must release capacity after its confirmed writer close`).toMatchObject({
        primeReady: true,
        realOpenObserved: true,
        writeHandleMatchesOpen: true,
        closeHandleMatchesOpen: true,
        writeFaultCount: 1,
        writerLeaseFulfillments: 0,
        keyWrapsBeforePostSuccessor: 0,
        openingOutcome: { status: 'rejected', errorName: 'Error', errorMessage: writeFailure },
        openingAggregateMessages: [],
        originalErrorIdentity: true,
        cleanupErrorIdentity: false,
        originalRootClosesBeforePostSuccessor: 1,
        originalRootClosesAfterDisposal: 1,
        postSuccessorOutcome: { status: 'fulfilled' },
        postSuccessorAdmitted: true,
        postSuccessorSettlement: { status: 'fulfilled' },
        writerClosesAfterDisposal: 1,
        disposalOutcome: { status: 'fulfilled' },
        disposalMemoized: true
      })
      expect(
        failedClose,
        `${writeFailure} and ${closeFailure} must retain the original root owner and max-one capacity`
      ).toMatchObject({
        primeReady: true,
        realOpenObserved: true,
        writeHandleMatchesOpen: true,
        closeHandleMatchesOpen: true,
        writeFaultCount: 1,
        writerLeaseFulfillments: 0,
        keyWrapsBeforePostSuccessor: 0,
        openingStatusWhileCloseHeld: 'pending',
        openingOutcome: { status: 'rejected', errorName: 'AggregateError' },
        openingAggregateMessages: expect.arrayContaining([writeFailure, closeFailure]),
        originalErrorIdentity: true,
        cleanupErrorIdentity: true,
        originalRootClosesWhileWriterHeld: 0,
        originalRootClosesBeforePostSuccessor: 0,
        originalRootClosesBeforeDisposal: 0,
        originalRootClosesAfterDisposal: 0,
        heldSuccessorOutcome: { status: 'rejected', errorMessage: expect.stringMatching(/descriptor limit/i) },
        heldSuccessorAdmitted: false,
        postSuccessorOutcome: { status: 'rejected', errorMessage: expect.stringMatching(/descriptor limit/i) },
        postSuccessorAdmitted: false,
        writerClosesBeforePostSuccessor: 1,
        writerClosesBeforeDisposal: 1,
        writerClosesAfterDisposal: 1,
        disposalOutcome: { status: 'rejected' },
        disposalMemoized: true,
        disposalSameRejection: true
      })
    } finally {
      for (const cleanup of rawHandleCleanups) await cleanup()
      vi.restoreAllMocks()
    }
  })

  it('settles resources after an already completed append refusal', async () => {
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-main-persistence-append-refusal-settle-'))
    configureMainProcess(userData)
    commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
    commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
    publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
    const bootstrap = createMainPersistenceBootstrapWithSourceFixture(
      { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
      sourceFixture()
    )
    try {
      await expect(bootstrap.prime()).resolves.toMatchObject({ status: 'ready' })
      const journal = await bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1279')
      await expect(journal.append(new Uint8Array(), -1)).resolves.toEqual({
        status: 'refused',
        reason: 'INVALID_RECORD'
      })
      await expect(journal.settle()).resolves.toBeUndefined()
      await expect(bootstrap.dispose()).resolves.toBeUndefined()
    } finally {
      await bootstrap.dispose().catch(() => undefined)
      vi.restoreAllMocks()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  type K1BodyOutcome = { status: 'fulfilled'; value: (() => void) | void } | { status: 'rejected'; error: unknown }
  type K1FactoryOperation = {
    label: string
    role: 'work' | 'cleanup' | 'opaque'
    duringFinalizer: boolean
    settled: Promise<K1OperationOutcome>
    outcome: K1OperationOutcome | null
    statPhases: { raw: K1StatPhase; delivery: K1StatPhase } | null
  }
  type K1JournalRecord = {
    journal: Awaited<ReturnType<ReturnType<typeof createMainPersistenceBootstrapWithSourceFixture>['openNew']>>
    stores: K1StoreRecord[]
    attempts: K1FactoryOperation[]
    confirmed: boolean
  }
  type K1Finalization = {
    deadline: number
    bodyOutcome: K1BodyOutcome | null
    cleanupFailures: unknown[]
    physical: Promise<K1OperationOutcome>
    wait: Promise<K1OperationOutcome>
  }
  class K1FactoryOwner {
    readonly operations: K1FactoryOperation[] = []
    readonly cleanupOperations: K1FactoryOperation[] = []
    readonly journals: K1JournalRecord[] = []
    readonly workers: Array<{ exited: Promise<void>; didExit: boolean }> = []
    readonly byPromise = new WeakMap<Promise<unknown>, K1FactoryOperation>()
    readonly stop: Promise<Error>
    private signalStop!: (error: Error) => void
    ordinaryReservations = 0
    cleanupReservations = 0
    finalizerCleanupReservations = 0
    finalizing = false
    openReservations = 0
    pendingJournals = 0
    pendingStores = 0
    stopped = false
    sealed = false
    expired = false
    failure: Error | null = null
    expectedSelectedError: unknown = null
    unexpectedOpeningFailure: { error: unknown } | null = null
    body: Promise<K1BodyOutcome> | null = null
    finalization: K1Finalization | null = null
    bootstrap: { dispose(): Promise<void> } | null = null
    bootstrapAttempts: K1FactoryOperation[] = []
    userData: string | null = null
    reported = false
    constructor(readonly context: object) {
      this.stop = new Promise<Error>((resolve) => {
        this.signalStop = resolve
      })
      k1Gate.owner = this
      k1Gate.custodyActive = true
      k1Gate.selectedStore = false
      k1Gate.rawHandles = []
      k1Gate.openReservations = 0
      k1Gate.operations = []
      k1Gate.stores = []
      k1Gate.path = null
      k1Gate.armed = false
      k1Gate.rejectDelivery = false
      k1Gate.failure = null
      k1Gate.expectedDev = null
      k1Gate.expectedIno = null
      k1Gate.entered = null
      k1Gate.enteredPromise = null
      k1Gate.release = null
      k1Gate.released = null
      k1Gate.storeHook = null
    }
    get rawHandles(): K1RawRecord[] {
      return k1Gate.rawHandles
    }
    get stores(): K1StoreRecord[] {
      return k1Gate.stores
    }
    fail(error: Error): void {
      this.failure ??= error
    }
    checkAdmission(): void {
      if (this.stopped || this.sealed)
        throw this.failure ?? new Error('K1 fixture custody failure: admission after stop')
    }
    reserveOperation(role: 'work' | 'cleanup' | 'opaque' = 'work'): void {
      const cleanup = role === 'cleanup'
      const count = this.finalizing
        ? this.finalizerCleanupReservations
        : cleanup
          ? this.cleanupReservations
          : this.ordinaryReservations
      if (count >= (this.finalizing || cleanup ? 128 : 512)) {
        const error = new Error('K1 fixture custody failure: operation bookkeeping cap exceeded')
        this.fail(error)
        throw error
      }
      if (this.finalizing) this.finalizerCleanupReservations += 1
      else if (cleanup) this.cleanupReservations += 1
      else this.ordinaryReservations += 1
    }
    observeReserved<T>(
      label: string,
      operation: Promise<T>,
      role: 'work' | 'cleanup' | 'opaque' = 'work'
    ): K1FactoryOperation {
      const record: K1FactoryOperation = {
        label,
        role,
        duringFinalizer: this.finalizing,
        settled: null as unknown as Promise<K1OperationOutcome>,
        outcome: null,
        statPhases: null
      }
      record.settled = operation.then(
        (value): K1OperationOutcome => {
          const outcome = { status: 'fulfilled' as const, value }
          record.outcome = outcome
          return outcome
        },
        (error: unknown): K1OperationOutcome => {
          const outcome = { status: 'rejected' as const, error }
          record.outcome = outcome
          return outcome
        }
      )
      if (role === 'cleanup') this.cleanupOperations.push(record)
      else this.operations.push(record)
      k1Gate.operations.push(record)
      this.byPromise.set(operation, record)
      return record
    }
    reserveStat(): K1StatObservation {
      this.reserveOperation()
      const phases = {
        raw: { status: 'not-started', promise: null, outcome: null } as K1StatPhase,
        delivery: { status: 'not-started', promise: null, outcome: null } as K1StatPhase
      }
      let settle!: (outcome: K1OperationOutcome) => void
      const record: K1FactoryOperation = {
        label: 'raw-stat',
        role: 'work',
        duringFinalizer: this.finalizing,
        settled: new Promise<K1OperationOutcome>((resolve) => {
          settle = resolve
        }),
        outcome: null,
        statPhases: phases
      }
      this.operations.push(record)
      k1Gate.operations.push(record)
      const complete = (outcome: K1OperationOutcome) => {
        if (record.outcome) return
        record.outcome = outcome
        settle(outcome)
      }
      const completeAfterBoth = () => {
        if (phases.raw.outcome && phases.delivery.outcome) complete(phases.delivery.outcome)
      }
      return {
        observeRaw: (promise) => {
          phases.raw.promise = promise
          phases.raw.status = 'pending'
          void promise.then(
            (value) => {
              phases.raw.outcome = { status: 'fulfilled', value }
              phases.raw.status = 'fulfilled'
              completeAfterBoth()
            },
            (error: unknown) => {
              phases.raw.outcome = { status: 'rejected', error }
              phases.raw.status = 'rejected'
              completeAfterBoth()
            }
          )
        },
        observeDelivery: (promise) => {
          phases.delivery.promise = promise
          phases.delivery.status = 'pending'
          this.byPromise.set(promise, record)
          void promise.then(
            (value) => {
              phases.delivery.outcome = { status: 'fulfilled', value }
              phases.delivery.status = 'fulfilled'
              completeAfterBoth()
            },
            (error: unknown) => {
              phases.delivery.outcome = { status: 'rejected', error }
              phases.delivery.status = 'rejected'
              completeAfterBoth()
            }
          )
        },
        rejectInvocation: (error) => {
          phases.raw.outcome = { status: 'rejected', error }
          phases.raw.status = 'rejected'
          complete(phases.raw.outcome)
        }
      }
    }
    start<T>(label: string, start: () => Promise<T> | T, role: 'work' | 'cleanup' | 'opaque' = 'work'): Promise<T> {
      if (role !== 'cleanup') this.checkAdmission()
      this.reserveOperation(role)
      let operation: Promise<T>
      try {
        operation = Promise.resolve(start())
      } catch (error) {
        operation = Promise.reject(error)
      }
      this.observeReserved(label, operation, role)
      return operation
    }
    record<T>(operation: Promise<T>): K1FactoryOperation {
      const record = this.byPromise.get(operation)
      if (!record) throw new Error('K1 fixture custody failure: started operation has no record')
      return record
    }
    async wait<T>(operation: Promise<T>): Promise<T> {
      const winner = await Promise.race([
        this.record(operation).settled.then((outcome) => ({ kind: 'operation' as const, outcome })),
        this.stop.then((error) => ({ kind: 'stop' as const, error }))
      ])
      if (winner.kind === 'stop') throw winner.error
      this.checkAdmission()
      if (winner.outcome.status === 'rejected') throw winner.outcome.error
      return winner.outcome.value as T
    }
    step<T>(label: string, start: () => Promise<T> | T, role: 'work' | 'opaque' = 'work'): Promise<T> {
      return this.wait(this.start(label, start, role))
    }
    async stage(entered: Promise<void> | null, operation: Promise<unknown>, label: string): Promise<void> {
      if (!entered) throw new Error('K1 fixture custody failure: ' + label + ' gate missing')
      const winner = await Promise.race([
        entered.then(() => 'entered' as const),
        this.record(operation).settled.then(() => 'ended' as const),
        this.stop.then(() => 'stopped' as const)
      ])
      if (winner !== 'entered')
        throw new Error('K1 fixture custody failure: ' + label + ' ended or stopped before entry')
      this.checkAdmission()
    }
    reserveOpen(): { pending: boolean } {
      if (this.rawHandles.length + this.openReservations >= 64) {
        const error = new Error('K1 fixture custody failure: raw-handle cap exceeded before open')
        this.fail(error)
        throw error
      }
      this.openReservations += 1
      return { pending: true }
    }
    settleOpen(reservation?: { pending: boolean }): void {
      if (reservation?.pending) {
        reservation.pending = false
        this.openReservations -= 1
      }
    }
    acquireJournal(
      label: string,
      start: () => Promise<K1JournalRecord['journal']>
    ): Promise<K1JournalRecord['journal']> {
      this.checkAdmission()
      if (this.journals.length + this.pendingJournals >= 4) {
        const error = new Error('K1 fixture custody failure: journal cap exceeded before open')
        this.fail(error)
        throw error
      }
      this.pendingJournals += 1
      const before = this.stores.length
      let operation: Promise<K1JournalRecord['journal']>
      try {
        operation = this.start(label, start, label === 'control-open' ? 'opaque' : 'work')
      } catch (error) {
        this.pendingJournals -= 1
        throw error
      }
      const record = this.record(operation)
      void record.settled.then((outcome) => {
        this.pendingJournals -= 1
        const stores = this.stores.slice(before)
        for (const store of stores) store.users.push(record.settled)
        if (outcome.status === 'fulfilled') {
          this.journals.push({
            journal: outcome.value as K1JournalRecord['journal'],
            stores,
            attempts: [],
            confirmed: false
          })
        } else if (label === 'selected-open' && outcome.error !== this.expectedSelectedError)
          this.unexpectedOpeningFailure = { error: outcome.error }
      })
      return operation
    }
    reserveStore(): void {
      if (this.stores.length + this.pendingStores >= 4) {
        const error = new Error('K1 fixture custody failure: real-store cap exceeded before construction')
        this.fail(error)
        throw error
      }
      this.pendingStores += 1
    }
    settleStore(): void {
      this.pendingStores -= 1
    }
    activeBootstrapUsers(): Promise<K1OperationOutcome>[] {
      return this.bootstrapAttempts.map((attempt) => attempt.settled)
    }
    journalOperation<T>(
      journal: K1JournalRecord['journal'],
      label: string,
      start: () => Promise<T>,
      cleanup = false
    ): Promise<T> {
      const owned = this.journals.find((item) => item.journal === journal)
      if (!owned) throw new Error('K1 fixture custody failure: journal owner missing')
      const operation = this.start(label, start, cleanup ? 'cleanup' : label.includes('append') ? 'opaque' : 'work')
      const record = this.record(operation)
      for (const store of owned.stores) store.users.push(record.settled)
      if (cleanup) owned.attempts.push(record)
      return operation
    }
    disposeBootstrap(label: string): Promise<void> {
      if (!this.bootstrap) throw new Error('K1 fixture custody failure: bootstrap owner missing')
      const operation = this.start(label, () => this.bootstrap!.dispose(), 'cleanup')
      const record = this.record(operation)
      this.bootstrapAttempts.push(record)
      for (const store of this.stores) store.users.push(record.settled)
      return operation
    }
    registerWorker(make: (onExit: () => void) => SourceWorker): SourceWorker {
      if (this.workers.length >= 2) {
        const error = new Error('K1 fixture custody failure: worker cap exceeded before start')
        this.fail(error)
        throw error
      }
      let finish!: () => void
      const record = {
        exited: new Promise<void>((resolve) => {
          finish = resolve
        }),
        didExit: false
      }
      this.workers.push(record)
      return make(() => {
        record.didExit = true
        finish()
      })
    }
    requestStop(error: Error): void {
      if (this.stopped) return
      this.stopped = true
      this.fail(error)
      k1Gate.release?.()
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
    private collectOperationFailures(operation: K1FactoryOperation, failures: unknown[]): void {
      if (operation.statPhases) {
        const { raw, delivery } = operation.statPhases
        if (raw.outcome?.status === 'rejected') failures.push(raw.outcome.error)
        if (delivery.outcome?.status === 'rejected') failures.push(delivery.outcome.error)
      } else if (operation.outcome?.status === 'rejected') failures.push(operation.outcome.error)
    }
    private async physicalCleanup(): Promise<void> {
      this.finalizing = true
      this.sealed = true
      k1Gate.release?.()
      const failures = this.finalization!.cleanupFailures
      if (this.stopped && this.bootstrap && this.bootstrapAttempts.length === 0) {
        try {
          this.disposeBootstrap('bootstrap-abort-dispose')
        } catch (error) {
          failures.push(error)
        }
      }
      const body = await this.body
      this.finalization!.bodyOutcome = body
      if (!body) failures.push(new Error('K1 fixture custody failure: actual factory body missing'))
      await this.drain()
      for (const operation of this.operations)
        if (operation.role === 'opaque' || operation.duringFinalizer) this.collectOperationFailures(operation, failures)
      if (this.unexpectedOpeningFailure) failures.push(this.unexpectedOpeningFailure.error)
      for (const journal of this.journals) {
        if (journal.attempts.length === 0) {
          try {
            this.journalOperation(journal.journal, 'journal-final-settle', () => journal.journal.settle(), true)
          } catch (error) {
            failures.push(error)
          }
        }
        await this.drain()
        const outcomes = await Promise.all(journal.attempts.map((item) => item.settled))
        for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.error)
        journal.confirmed = outcomes.length > 0 && outcomes.every((item) => item.status === 'fulfilled')
      }
      if (this.bootstrap && this.bootstrapAttempts.length === 0) {
        try {
          this.disposeBootstrap('bootstrap-final-dispose')
        } catch (error) {
          failures.push(error)
        }
      }
      await this.drain()
      for (const attempt of this.bootstrapAttempts)
        if (attempt.outcome?.status === 'rejected') failures.push(attempt.outcome.error)
      for (const store of this.stores) {
        const userOutcomes = await Promise.all(store.users)
        for (const outcome of userOutcomes)
          if (outcome.status === 'rejected' && outcome.error !== this.expectedSelectedError)
            failures.push(outcome.error)
        if (store.productionDisposeAttempts === 0 && store.rescueAttempts === 0) {
          store.rescueAttempts = 1
          try {
            store.originalDispose()
            store.rescued = true
            store.rescueOutcome = { status: 'fulfilled', value: undefined }
          } catch (error) {
            store.rescueOutcome = { status: 'rejected', error }
            failures.push(error)
          }
        } else if (store.productionDisposeAttempts > 0 && !store.productionDisposed) {
          failures.push(
            store.productionDisposeOutcome?.status === 'rejected'
              ? store.productionDisposeOutcome.error
              : new Error('K1 fixture custody failure: production store disposal unconfirmed')
          )
        } else if (store.rescueOutcome?.status === 'rejected') failures.push(store.rescueOutcome.error)
      }
      await Promise.all(this.workers.map((worker) => worker.exited))
      const dependentFailure =
        this.journals.some((item) => !item.confirmed) ||
        this.bootstrapAttempts.some((item) => item.outcome?.status !== 'fulfilled')
      for (const record of this.rawHandles) {
        if (record.firstClose) {
          try {
            await record.firstClose
            record.closeOutcome = 'fulfilled'
          } catch (error) {
            record.closeOutcome = 'rejected'
            failures.push(error)
          }
        } else if (record.closeCalls === 0 && record.raw.fd >= 0 && !dependentFailure && record.rescueAttempts === 0) {
          record.rescueAttempts = 1
          try {
            this.reserveOperation('cleanup')
            const rescue = record.originalClose()
            const outcome = await this.observeReserved('raw-rescue', rescue, 'cleanup').settled
            if (outcome.status === 'fulfilled') {
              record.rescueConfirmed = true
              failures.push(new Error('K1 fixture custody failure: unexpected raw rescue required'))
            } else failures.push(outcome.error)
          } catch (error) {
            failures.push(error)
          }
        }
        if (record.closeCalls > 1) failures.push(new Error('K1 fixture custody failure: duplicate delegated raw close'))
        if (record.closeOutcome !== 'fulfilled')
          failures.push(new Error('K1 fixture custody failure: first raw physical close unconfirmed'))
      }
      await this.drain()
      if (this.openReservations !== 0 || this.pendingJournals !== 0 || this.pendingStores !== 0)
        failures.push(new Error('K1 fixture custody failure: pending acquisition reservations remain'))
      if (this.workers.some((worker) => !worker.didExit))
        failures.push(new Error('K1 fixture custody failure: worker exit unconfirmed'))
      for (const operation of this.cleanupOperations) this.collectOperationFailures(operation, failures)
      if (this.failure) failures.push(this.failure)
      if (this.expired || Date.now() >= this.finalization!.deadline)
        failures.push(new Error('K1 fixture custody failure: shared cleanup budget expired'))
      if (failures.length === 0) {
        try {
          vi.restoreAllMocks()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length === 0 && this.userData) {
        try {
          rmSync(this.userData, { recursive: true, force: true })
        } catch (error) {
          failures.push(error)
        }
      }
      if (this.expired || Date.now() >= this.finalization!.deadline)
        failures.push(new Error('K1 fixture custody failure: shared cleanup budget expired'))
      if (failures.length > 0) {
        const reasons: unknown[] = []
        for (const error of [...(body?.status === 'rejected' ? [body.error] : []), ...failures])
          if (!reasons.some((item) => Object.is(item, error))) reasons.push(error)
        throw new AggregateError(reasons, 'K1 factory finalization failed; owned resources retained')
      }
      k1Gate.custodyActive = false
      k1Gate.selectedStore = false
      k1Gate.storeHook = null
      k1Gate.owner = null
      k1Gate.path = null
      k1Gate.armed = false
      k1Gate.entered = null
      k1Gate.enteredPromise = null
      k1Gate.release = null
      k1Gate.released = null
      settlementFaults.rootIdentities.clear()
      currentK1Runner = null
      k1RunnerByContext.delete(this.context)
    }
    finalize(): K1Finalization {
      if (this.finalization) return this.finalization
      const record = {
        deadline: Date.now() + 10_000,
        bodyOutcome: null as K1BodyOutcome | null,
        cleanupFailures: [] as unknown[],
        physical: null as unknown as Promise<K1OperationOutcome>,
        wait: null as unknown as Promise<K1OperationOutcome>
      }
      this.finalization = record
      if (this.body)
        void this.body.then((outcome) => {
          record.bodyOutcome = outcome
        })
      record.physical = this.physicalCleanup().then(
        (): K1OperationOutcome => ({ status: 'fulfilled', value: undefined }),
        (error: unknown): K1OperationOutcome => ({ status: 'rejected', error })
      )
      let timer: ReturnType<typeof setTimeout>
      const expired = new Promise<K1OperationOutcome>((resolve) => {
        timer = setTimeout(() => {
          this.expired = true
          const error = new Error('K1 fixture custody failure: 10-second shared cleanup budget expired')
          this.fail(error)
          this.requestStop(error)
          const observedFailures: unknown[] = []
          for (const operation of this.operations)
            if (operation.role === 'opaque' || operation.duringFinalizer)
              this.collectOperationFailures(operation, observedFailures)
          if (this.unexpectedOpeningFailure) observedFailures.push(this.unexpectedOpeningFailure.error)
          for (const journal of this.journals)
            for (const attempt of journal.attempts)
              if (attempt.outcome?.status === 'rejected') observedFailures.push(attempt.outcome.error)
          for (const attempt of this.bootstrapAttempts)
            if (attempt.outcome?.status === 'rejected') observedFailures.push(attempt.outcome.error)
          for (const store of this.stores) {
            if (store.productionDisposeOutcome?.status === 'rejected')
              observedFailures.push(store.productionDisposeOutcome.error)
            if (store.rescueOutcome?.status === 'rejected') observedFailures.push(store.rescueOutcome.error)
          }
          for (const operation of this.cleanupOperations) this.collectOperationFailures(operation, observedFailures)
          const reasons: unknown[] = []
          for (const candidate of [
            ...(record.bodyOutcome?.status === 'rejected' ? [record.bodyOutcome.error] : []),
            ...record.cleanupFailures,
            ...observedFailures,
            ...(this.failure ? [this.failure] : []),
            error
          ])
            if (!reasons.some((item) => Object.is(item, candidate))) reasons.push(candidate)
          resolve({
            status: 'rejected',
            error: new AggregateError(reasons, 'K1 factory finalization expired; owned resources retained')
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
  const k1RunnerByContext = new WeakMap<object, K1FactoryOwner>()
  let currentK1Runner: K1FactoryOwner | null = null

  async function runK1FactoryCase(context: { signal: AbortSignal }, caseId: 'K09' | 'K10') {
    if (currentK1Runner) throw new Error('K1 fixture custody failure: previous factory case remains active')
    const state = new K1FactoryOwner(context)
    currentK1Runner = state
    k1RunnerByContext.set(context, state)
    const abort = () => state.requestStop(new Error('K1 fixture custody failure: runner aborted factory case'))
    context.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => state.requestStop(new Error('K1 fixture custody failure: 15-second body watchdog expired')),
      15_000
    )
    const actual = Promise.resolve().then(() => {
      state.checkAdmission()
      return runK1FactoryCaseBody(state, caseId)
    })
    state.body = actual.then<K1BodyOutcome, K1BodyOutcome>(
      (value) => ({ status: 'fulfilled', value }),
      (error: unknown) => ({ status: 'rejected', error })
    )
    void state.body.then(() => {
      clearTimeout(timer)
    })
    if (context.signal.aborted) abort()
    const winner = await Promise.race([
      state.body.then((outcome) => ({ kind: 'body' as const, outcome })),
      state.stop.then((error) => ({ kind: 'stop' as const, error }))
    ])
    const final = await state.finalize().wait
    if (!state.expired) context.signal.removeEventListener('abort', abort)
    state.reported = true
    if (final.status === 'rejected') throw final.error
    if (winner.kind === 'stop') throw winner.error
    if (winner.outcome.status === 'rejected') throw winner.outcome.error
    winner.outcome.value?.()
  }
  afterEach(async (context) => {
    const state = k1RunnerByContext.get(context)
    if (!state) return
    const outcome = await state.finalize().wait
    if (outcome.status === 'rejected' && !state.reported) throw outcome.error
  })

  async function runK1FactoryCaseBody(state: K1FactoryOwner, caseId: 'K09' | 'K10') {
    state.checkAdmission()
    const userData = mkdtempSync(resolve(tmpdir(), 'metis-' + caseId.toLowerCase() + '-'))
    state.userData = userData
    await state.step(
      'factory-configuration',
      () => {
        configureMainProcess(userData)
        commitManagedAuthorityDocument('user', resolve(userData, 'managed-config.json'), null, 'readable')
        commitManagedAuthorityDocument('admin', resolve(userData, 'admin-managed-config.json'), null, 'readable')
        publishSettingsSnapshot({ ...DEFAULT_SETTINGS, encryptTranscripts: true }, true)
      },
      'opaque'
    )
    let workersStarted = 0
    let workerExits = 0
    const services = sourceFixture(
      async () => null,
      () => {
        workersStarted += 1
        return state.registerWorker(
          (onExit) =>
            new SourceWorker(undefined, () => {
              workerExits += 1
              onExit()
            })
        )
      },
      1
    )
    const bootstrap = await state.wait(
      state.start('bootstrap-create', () => {
        const created = createMainPersistenceBootstrapWithSourceFixture(
          { afterFirstShow: () => true, nativeKeyIntent: 'allowed' },
          services
        )
        state.bootstrap = created
        return created
      })
    )
    const failure = new Error('K09 injected constructed-store post-use stat failure')
    state.expectedSelectedError = caseId === 'K09' ? failure : null
    let storeHook!: NonNullable<typeof k1Gate.storeHook>
    let openingStatus: 'pending' | 'fulfilled' | 'rejected' = 'pending'
    let openingAtGate: 'pending' | 'fulfilled' | 'rejected' | 'unknown' = 'unknown'
    let openingError: unknown
    let openingValue: Awaited<ReturnType<typeof bootstrap.openNew>> | undefined
    let appendStatus = 'unavailable'
    let appendRevision = 0
    let journalPromiseSame = true
    let bootstrapPromiseSame = true
    let bootstrapFirstStatus: 'pending' | 'fulfilled' | 'rejected' = 'pending'
    let bootstrapRepeatStatus: 'pending' | 'fulfilled' | 'rejected' = 'pending'
    let journalFirstStatus: 'pending' | 'fulfilled' | 'rejected' = 'pending'
    let journalRepeatStatus: 'pending' | 'fulfilled' | 'rejected' = 'pending'
    let initializeAtGate = 0
    let disposeAtGate = 0
    let disposeAfterOpen = 0
    let disposeAfterAppend = 0
    let disposeAfterJournal = 0
    let disposeAfterBootstrap = 0
    let extraDisposeAfterRepeat = 0
    storeHook = {
      custodyActive: true,
      selected: false,
      constructorCalls: 0,
      actualObject: null,
      initializeCalls: 0,
      disposeCalls: 0,
      sameObject: false,
      disposedSameObject: false,
      originalDispose: null,
      keySettlements: 0,
      borrow: null
    }
    k1Gate.storeHook = storeHook
    try {
      await expect(state.step('bootstrap-prime', () => bootstrap.prime(), 'opaque')).resolves.toMatchObject({
        status: 'ready'
      })
      if (caseId === 'K09') {
        const control = await state.wait(
          state.acquireJournal('control-open', () => bootstrap.openNew('16f45c47-6583-45fb-8340-72aa6b6d1290'))
        )
        const controlAppend = await state.step('control-append', () =>
          state.journalOperation(control, 'control-append-actual', () =>
            control.append(
              speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f97', 'one control record', 1_700_000_000_000),
              0
            )
          )
        )
        expect(controlAppend).toMatchObject({ status: 'durable', revision: 1 })
        await state.wait(state.journalOperation(control, 'control-settle', () => control.settle(), true))
      }
      let gateEnter!: () => void
      let gateRelease!: () => void
      k1Gate.enteredPromise = new Promise<void>((resolveEntered) => {
        gateEnter = resolveEntered
      })
      k1Gate.entered = gateEnter
      k1Gate.released = new Promise<void>((resolveReleased) => {
        gateRelease = resolveReleased
      })
      k1Gate.release = gateRelease
      if (state.stopped || state.sealed) gateRelease()
      k1Gate.rejectDelivery = caseId === 'K09'
      k1Gate.failure = caseId === 'K09' ? failure : null
      k1Gate.writerCloseAttempts = 0
      k1Gate.writerCloseConfirmed = 0
      k1Gate.rootCloseAttempts = 0
      k1Gate.rootCloseConfirmed = 0
      settlementFaults.rootIdentities.clear()
      storeHook.selected = true
      k1Gate.selectedStore = true
      const opening = state.acquireJournal('selected-open', () =>
        bootstrap.openNew(
          caseId === 'K09' ? '16f45c47-6583-45fb-8340-72aa6b6d1291' : '16f45c47-6583-45fb-8340-72aa6b6d1292'
        )
      )
      const openingObserved = opening.then(
        (value) => {
          openingStatus = 'fulfilled'
          openingValue = value
          return value
        },
        (error: unknown) => {
          openingStatus = 'rejected'
          openingError = error
          return undefined
        }
      )
      await state.stage(k1Gate.enteredPromise, opening, 'selected post-use stat')
      expect(openingStatus).toBe('pending')
      openingAtGate = openingStatus
      expect(storeHook.constructorCalls).toBe(1)
      expect(storeHook.actualObject).not.toBeNull()
      expect(storeHook.initializeCalls).toBe(0)
      expect(storeHook.disposeCalls).toBe(0)
      initializeAtGate = storeHook.initializeCalls
      disposeAtGate = storeHook.disposeCalls
      expect(storeHook.borrow).not.toBeNull()
      const borrowZeroAtGate = [...storeHook.borrow!].every((byte) => byte === 0)
      expect(borrowZeroAtGate).toBe(true)
      expect((await state.step('factory-directory-lstat', () => lstatSync(userData))).isDirectory()).toBe(true)
      if (caseId === 'K10') {
        k1Gate.release?.()
        await state.wait(opening)
        await openingObserved
        expect(openingStatus).toBe('fulfilled')
        expect(storeHook.initializeCalls).toBe(1)
        disposeAfterOpen = storeHook.disposeCalls
        const journal = openingValue!
        const append = await state.wait(
          state.journalOperation(journal, 'selected-append', () =>
            journal.append(
              speechRecord('6370e1cc-43f4-4976-a912-04d0c3ca8f98', 'one durable record', 1_700_000_000_001),
              0
            )
          )
        )
        appendStatus = append.status
        appendRevision = append.status === 'durable' ? append.revision : 0
        disposeAfterAppend = storeHook.disposeCalls
        expect(append).toMatchObject({ status: 'durable', revision: 1 })
        expect(storeHook.disposeCalls).toBe(0)
        const firstJournal = state.journalOperation(journal, 'journal-first-settle', () => journal.settle(), true)
        const repeatedJournal = state.journalOperation(journal, 'journal-repeat-settle', () => journal.settle(), true)
        journalPromiseSame = firstJournal === repeatedJournal
        const firstJournalObserved = firstJournal.then(
          () => {
            journalFirstStatus = 'fulfilled'
          },
          () => {
            journalFirstStatus = 'rejected'
          }
        )
        const repeatedJournalObserved = repeatedJournal.then(
          () => {
            journalRepeatStatus = 'fulfilled'
          },
          () => {
            journalRepeatStatus = 'rejected'
          }
        )
        await state.wait(firstJournal)
        await Promise.all([firstJournalObserved, repeatedJournalObserved])
        disposeAfterJournal = storeHook.disposeCalls
        const firstBootstrap = state.disposeBootstrap('bootstrap-first-dispose')
        const repeatedBootstrap = state.disposeBootstrap('bootstrap-repeat-dispose')
        bootstrapPromiseSame = firstBootstrap === repeatedBootstrap
        const firstBootstrapObserved = firstBootstrap.then(
          () => {
            bootstrapFirstStatus = 'fulfilled'
          },
          () => {
            bootstrapFirstStatus = 'rejected'
          }
        )
        const repeatedBootstrapObserved = repeatedBootstrap.then(
          () => {
            bootstrapRepeatStatus = 'fulfilled'
          },
          () => {
            bootstrapRepeatStatus = 'rejected'
          }
        )
        await state.wait(firstBootstrap)
        await Promise.all([firstBootstrapObserved, repeatedBootstrapObserved])
        disposeAfterBootstrap = storeHook.disposeCalls
        await state.wait(repeatedBootstrap)
        await state.wait(state.journalOperation(journal, 'journal-required-repeat', () => journal.settle(), true))
        extraDisposeAfterRepeat = storeHook.disposeCalls - disposeAfterBootstrap
      } else {
        k1Gate.release?.()
        await Promise.race([
          openingObserved,
          state.stop.then((error) => {
            throw error
          })
        ])
        expect(openingStatus).toBe('rejected')
        expect(openingError).toBe(failure)
        disposeAfterOpen = storeHook.disposeCalls
        const firstBootstrap = state.disposeBootstrap('bootstrap-first-dispose')
        const repeatedBootstrap = state.disposeBootstrap('bootstrap-repeat-dispose')
        bootstrapPromiseSame = firstBootstrap === repeatedBootstrap
        const firstBootstrapObserved = firstBootstrap.then(
          () => {
            bootstrapFirstStatus = 'fulfilled'
          },
          () => {
            bootstrapFirstStatus = 'rejected'
          }
        )
        const repeatedBootstrapObserved = repeatedBootstrap.then(
          () => {
            bootstrapRepeatStatus = 'fulfilled'
          },
          () => {
            bootstrapRepeatStatus = 'rejected'
          }
        )
        await state.wait(firstBootstrap)
        await Promise.all([firstBootstrapObserved, repeatedBootstrapObserved])
        disposeAfterBootstrap = storeHook.disposeCalls
        await state.wait(repeatedBootstrap)
        extraDisposeAfterRepeat = storeHook.disposeCalls - disposeAfterBootstrap
      }
      expect(bootstrapPromiseSame).toBe(true)
      expect(workersStarted).toBe(1)
      expect(workerExits).toBe(1)
      expect(k1Gate.rawMatchesRoot).toBe(true)
      expect(k1Gate.realStatCompleted).toBe(true)
      expect(k1Gate.entries).toBe(1)
      expect(storeHook.keySettlements).toBe(1)
      const selectedPath = k1Gate.path!
      const writerClose = await k1RawCloseWitness(join(selectedPath, '.journal-writer.lock'), (record) =>
        record.stats.some((stat) => stat.file)
      )
      const rootClose = await k1RawCloseWitness(selectedPath, (record) =>
        record.stats.some(
          (stat) => stat.directory && stat.dev === k1Gate.expectedDev && stat.ino === k1Gate.expectedIno
        )
      )
      k1Gate.writerCloseAttempts = writerClose.attempts
      k1Gate.writerCloseConfirmed = writerClose.confirmed
      k1Gate.rootCloseAttempts = rootClose.attempts
      k1Gate.rootCloseConfirmed = rootClose.confirmed
      const disposedSameObject = storeHook.disposedSameObject ? true : null
      const evidence =
        caseId === 'K09'
          ? {
              caseId,
              physical: {
                rawMatchesRoot: k1Gate.rawMatchesRoot,
                realStatCompleted: k1Gate.realStatCompleted,
                entries: k1Gate.entries
              },
              store: {
                constructorCalls: storeHook.constructorCalls,
                actualObject: storeHook.actualObject !== null,
                borrowZeroAtGate,
                initializeAtGate,
                disposeAtGate,
                disposeAfterOpen,
                disposeAfterBootstrap,
                extraDisposeAfterRepeat,
                disposedSameObject
              },
              opening: {
                atGate: openingAtGate,
                outcome: openingError === failure ? 'original-stat-error' : 'unexpected-error',
                sameError: openingError === failure
              },
              parents: {
                keySettlements: storeHook.keySettlements,
                writerCloseAttempts: k1Gate.writerCloseAttempts,
                writerCloseConfirmed: k1Gate.writerCloseConfirmed,
                rootCloseAttempts: k1Gate.rootCloseAttempts,
                rootCloseConfirmed: k1Gate.rootCloseConfirmed
              },
              bootstrap: {
                first: bootstrapFirstStatus,
                repeat: bootstrapRepeatStatus,
                samePromise: bootstrapPromiseSame,
                workersStarted,
                workerExits
              }
            }
          : {
              caseId,
              physical: {
                rawMatchesRoot: k1Gate.rawMatchesRoot,
                realStatCompleted: k1Gate.realStatCompleted,
                entries: k1Gate.entries
              },
              store: {
                constructorCalls: storeHook.constructorCalls,
                actualObject: storeHook.actualObject !== null,
                borrowZeroAtGate,
                initializeAtGate,
                disposeAtGate,
                initializeAfterOpen: storeHook.initializeCalls,
                disposeAfterOpen,
                disposeAfterAppend,
                disposeAfterJournal,
                disposeAfterBootstrap,
                extraDisposeAfterRepeat,
                disposedSameObject
              },
              opening: { atGate: openingAtGate, outcome: openingStatus },
              append: { status: appendStatus, revision: appendRevision },
              parents: {
                keySettlements: storeHook.keySettlements,
                writerCloseAttempts: k1Gate.writerCloseAttempts,
                writerCloseConfirmed: k1Gate.writerCloseConfirmed,
                rootCloseAttempts: k1Gate.rootCloseAttempts,
                rootCloseConfirmed: k1Gate.rootCloseConfirmed
              },
              bootstrap: {
                first: bootstrapFirstStatus,
                repeat: bootstrapRepeatStatus,
                samePromise: bootstrapPromiseSame,
                workersStarted,
                workerExits
              },
              journal: { first: journalFirstStatus, repeat: journalRepeatStatus, samePromise: journalPromiseSame }
            }
      state.checkAdmission()
      recordSettlementEvidence(caseId, evidence)
      if (caseId === 'K09') expect(openingError).toBe(failure)
    } finally {
      k1Gate.release?.()
    }
    return () => {
      if (caseId === 'K09')
        assert(
          storeHook.disposeCalls === 1,
          'K09 constructed journal storage must be owned before key post-use failure'
        )
    }
  }

  it('cleans a constructed journal store when the key post-use guard rejects', async (context) =>
    runK1FactoryCase(context, 'K09'))
  it('retains the constructed journal store until successful owner handoff', async (context) =>
    runK1FactoryCase(context, 'K10'))
})
