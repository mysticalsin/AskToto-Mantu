import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDefinition, TaskOwner, TaskPolicy } from './task-contract'
import { encodeTaskRuntimeState } from './task-persistence'
import {
  authorizeDispatch,
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  recordEffectOutcome
} from './task-state'

const mocks = vi.hoisted(() => {
  const ownerSession = {
    currentOwnerKey: vi.fn(() => 'a'.repeat(64)),
    currentTenantKey: vi.fn(() => 'b'.repeat(64))
  }
  return {
    ownerSession,
    currentOwnerSession: vi.fn(() => ownerSession),
    archive: null as string | null,
    acknowledgements: [] as string[],
    adapter: {
      exec: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', timedOut: false })),
      spawnGui: vi.fn(async () => ({ ok: true })),
      automationStatus: vi.fn(async () => 'granted' as const),
      accessibilityTrusted: vi.fn(() => true),
      frontmost: { observe: vi.fn(() => ({ ready: async () => true, matched: async () => true, cancel: vi.fn() })) }
    }
  }
})

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/isolated/asktoto-userdata' } }))
vi.mock('../desktop-adapter-deps', () => ({ createProductionDesktopAdapterDeps: () => mocks.adapter }))
vi.mock('../auth', () => ({ authSessionGeneration: () => 1 }))
vi.mock('../lifecycle/owner-session-wiring', () => ({ currentOwnerSession: () => mocks.currentOwnerSession() }))
vi.mock('../logger', () => ({ auditLog: vi.fn(), mainLog: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('../qa-identity', () => ({ QA_IDENTITY_BUILD: false }))
vi.mock('../qa-voice-hooks', () => ({ qaDesktopSinkEnabled: vi.fn(() => false), createQaDesktopSink: vi.fn() }))
vi.mock('../secrets', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }))
vi.mock('../infra/storage/atomic-saved-write', () => ({
  atomicSavedWrite: vi.fn(async (_file: string, data: Uint8Array) => {
    mocks.acknowledgements = JSON.parse(new TextDecoder().decode(data)) as string[]
  })
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (file: string) =>
      file.endsWith('desktop-action-acks.json') ? JSON.stringify(mocks.acknowledgements) : ''
    )
  }
})
vi.mock('./encrypted-task-file-store', () => ({
  createEncryptedTaskFileStore: () => ({
    read: async () =>
      mocks.archive === null ? { kind: 'not-found' as const } : { kind: 'found' as const, serialized: mocks.archive },
    write: async (serialized: string) => {
      mocks.archive = serialized
    },
    quarantine: async () => {
      mocks.archive = null
    }
  })
}))

import { createDesktopActionTaskBridge } from './desktop-action-task-runtime'

const OWNER: TaskOwner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 1,
  contextRevision: 1
}
const POLICY: TaskPolicy = {
  allowedTaskTypes: ['desktop-action'],
  allowedCapabilities: ['desktop.create_note'],
  resourceBudgets: { actions: 1 },
  maxRetentionMs: 60_000,
  maxGrantTtlMs: 1_000
}
const RECOVERY_OWNER = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }

function uncertainArchive(): string {
  const definition: TaskDefinition = {
    taskId: 'desktop-action:runtime-owner-fixture',
    revision: 1,
    taskType: 'desktop-action',
    owner: OWNER,
    argumentsDigest: 'sha256:synthetic-fixture',
    scope: { capabilities: ['desktop.create_note'], resources: { actions: 1 } },
    createdAt: 100,
    retentionMs: 5_000,
    recoveryOwner: RECOVERY_OWNER
  }
  const created = createTask(createTaskRuntimeState(), definition, POLICY)
  if (!created.ok) throw new Error(`fixture task creation failed: ${created.reason}`)
  const issued = issueDispatchGrant(created.state, {
    taskId: definition.taskId,
    grantId: 'runtime-owner-grant',
    scope: { capability: 'desktop.create_note', resources: { actions: 1 } },
    now: 200,
    ttlMs: 500,
    policy: POLICY
  })
  if (!issued.ok) throw new Error(`fixture grant failed: ${issued.reason}`)
  const authorized = authorizeDispatch(issued.state, {
    grantId: 'runtime-owner-grant',
    attemptId: 'runtime-owner-attempt',
    taskId: definition.taskId,
    taskRevision: 1,
    owner: OWNER,
    argumentsDigest: definition.argumentsDigest,
    scope: { capability: 'desktop.create_note', resources: { actions: 1 } },
    now: 201
  })
  if (!authorized.decision.allowed) throw new Error(`fixture authorization failed: ${authorized.decision.reason}`)
  const uncertain = recordEffectOutcome(authorized.state, definition.taskId, 'runtime-owner-attempt', 'uncertain')
  if (!uncertain.ok) throw new Error(`fixture settlement failed: ${uncertain.reason}`)
  return encodeTaskRuntimeState(uncertain.state, {
    maxBytes: 64_000,
    maxTasks: 100,
    maxAttempts: 200,
    maxConsumedGrantIds: 300,
    maxCapabilitiesPerScope: 32,
    maxResourcesPerScope: 32
  })
}

describe('production task runtime recovery principal wiring', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    mocks.archive = uncertainArchive()
    mocks.acknowledgements = []
    mocks.ownerSession.currentOwnerKey.mockReturnValue(RECOVERY_OWNER.ownerKey)
    mocks.ownerSession.currentTenantKey.mockReturnValue(RECOVERY_OWNER.tenantKey)
  })

  afterEach(() => {
    nowSpy.mockRestore()
  })

  it('lazily reads both HMAC keys from the current main-owned owner session', async () => {
    const bridge = createDesktopActionTaskBridge()
    expect(mocks.currentOwnerSession).not.toHaveBeenCalled()
    await bridge.recover()
    expect(mocks.currentOwnerSession).not.toHaveBeenCalled()

    const notices = await bridge.takeRecoveryNotices()
    expect(notices).toMatchObject([{ taskId: 'desktop-action:runtime-owner-fixture' }])
    expect(mocks.currentOwnerSession).toHaveBeenCalled()
    expect(mocks.ownerSession.currentOwnerKey).toHaveBeenCalled()
    expect(mocks.ownerSession.currentTenantKey).toHaveBeenCalled()
    expect(mocks.acknowledgements).toEqual(['desktop-action:runtime-owner-fixture'])
    expect(JSON.stringify(notices)).not.toContain('synthetic-fixture')
  })
})
