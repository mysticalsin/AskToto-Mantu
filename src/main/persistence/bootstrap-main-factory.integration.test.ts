import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
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

vi.mock('electron')
vi.mock('../auth', () => ({
  captureMainPersistenceSessionBoundary: () => ({
    principalAssociation: 'a'.repeat(64),
    configured: true,
    isCurrent: () => true
  }),
  subscribeSpeechAuthLeaseInvalidation: () => () => {}
}))

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
  workerFactory?: MeetingSpeechWorkerFactory
): MainPersistenceBootstrapSourceFixture {
  const catalogBytes = new Uint8Array(readFileSync(resolve(process.cwd(), 'resources/persistence-profiles.v1.json')))
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
      sourceFixture(async () => null, () => {
        markWorkerCreated()
        return new HeldExitWorker()
      })
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
      const settlement = bootstrap.settle().then(() => {
        settled = true
      })
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
})
