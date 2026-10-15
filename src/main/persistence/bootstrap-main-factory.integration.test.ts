import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { describe, expect, it, vi } from 'vitest'
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
} from '../features/meetings/incremental-record-receipt'
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
type CanonicalReplyIdentity = { protocol: number; id: number; generation: number; successful: boolean }

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
  openedHandles: new Map<string, SettlementFixtureHandle>(),
  keyGate: null as SettlementGate | null,
  authEpoch: 0,
  authPrincipalAssociation: 'a'.repeat(64)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      settlementFaults.openedHandles.set(path, handle)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close')
            return async () => {
              const gate = settlementFaults.closeGates.get(path)
              if (gate) {
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

vi.mock('./protected-meeting-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./protected-meeting-keys')>()
  return {
    ...actual,
    createProtectedMeetingKeys: (options: Parameters<typeof actual.createProtectedMeetingKeys>[0]) => {
      const service = actual.createProtectedMeetingKeys(options)
      return {
        ...service,
        settleAndDispose: async (handle: Parameters<typeof service.settleAndDispose>[0]) => {
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
    raw: undefined
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
})
