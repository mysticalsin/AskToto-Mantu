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
  type MeetingSpeechWorkerFactory,
  type MeetingSpeechWorkerPort
} from '../infra/process/meeting-speech-host'
import type { MeetingSpeechRequest } from '../infra/process/meeting-speech-protocol'
import { commitManagedAuthorityDocument } from '../settings-authority-history'
import { publishSettingsSnapshot } from '../settings-observation'

import {
  createMainPersistenceBootstrapWithSourceFixture,
  type MainPersistenceBootstrapSourceFixture
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

vi.mock('electron')
vi.mock('../auth', () => ({
  captureMainPersistenceSessionBoundary: () => ({
    principalAssociation: 'a'.repeat(64),
    configured: true,
    isCurrent: () => true
  }),
  subscribeSpeechAuthLeaseInvalidation: () => () => {}
}))

const settlementFaults = vi.hoisted(() => ({
  closeGates: new Map<string, SettlementGate>(),
  openedHandles: new Map<string, SettlementFixtureHandle>(),
  keyGate: null as SettlementGate | null
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

async function closeFixtureHandle(path: string): Promise<void> {
  const handle = settlementFaults.openedHandles.get(path) as { close: () => Promise<void> } | undefined
  await handle?.close().catch(() => undefined)
}

class SourceWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  postMessage(request: MeetingSpeechRequest): void
  postMessage(request: MeetingSpeechRequest, transferList: ArrayBuffer[]): void
  postMessage(request: MeetingSpeechRequest): void {
    queueMicrotask(() => {
      const reply = processMeetingSpeechRequest(request)
      if (reply) this.emit('message', reply)
    })
  }
  async terminate(): Promise<number> {
    this.emit('exit', 0)
    return 0
  }
}

const fixtureSourceCommit = 'a'.repeat(40)

function sourceFixture(
  readBundledReceipt: MainPersistenceBootstrapSourceFixture['readBundledReceipt'] = async () => null,
  workerFactory?: MeetingSpeechWorkerFactory,
  maxHeldRoots?: number
): MainPersistenceBootstrapSourceFixture {
  const catalogBytes = new Uint8Array(readFileSync(resolve(process.cwd(), 'resources/persistence-profiles.v1.json')))
  const parsed = parseProfileCatalog(catalogBytes)
  if (!parsed) throw new Error('Synthetic source fixture catalog failed its real parser')
  const source = parsed.catalog.profiles[0]
  if (!source) throw new Error('Synthetic source fixture catalog has no profile')
  const profile: ResolvedPersistenceProfile = Object.freeze({
    ...source,
    ...(maxHeldRoots ? { maxHeldRoots } : {}),
    qualification: Object.freeze({ state: 'QUALIFIED', reportSha256: 'b'.repeat(64) }),
    profileDigest: 'c'.repeat(64),
    catalogSha256: 'd'.repeat(64),
    allowedProviders: null,
    publicationAllowed: false,
    retentionAllowed: true,
    enterpriseWindow: null
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
    createSpeech: (admittedProfile) => {
      const policy = toMeetingSpeechPolicy(admittedProfile)
      return createMeetingSpeechPersistenceService({
        readLimits: () => policy.limits,
        readBounds: () => ({
          maxInputBytes: policy.maxInputBytes,
          maxOutputBytes: policy.maxOutputBytes,
          operationDeadlineMs: policy.operationDeadlineMs,
          shutdownDeadlineMs: policy.shutdownDeadlineMs
        }),
        workerFactory: workerFactory ?? (() => new SourceWorker())
      })
    }
  }
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
    const services = sourceFixture()
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
      await expect(writable.append(record, 0)).resolves.toMatchObject({
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
