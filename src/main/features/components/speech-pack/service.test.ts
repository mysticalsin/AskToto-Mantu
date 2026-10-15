import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createSpeechPackEngine,
  type SpeechPackEngine,
  type SpeechPackEngineOptions,
  type SpeechPackState
} from './engine'
import {
  SPEECH_PACK_COMPONENTS,
  WHISPER_BASE_Q8,
  type SpeechPackComponent,
  type SpeechPackComponentId
} from './manifest'
import * as Resolver from './resolver'
import { componentManifestIdentity } from './resolver'
import type { PackageRuntimeContract } from './package-contract'
import { createSpeechPackService } from '../index'

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('Unexpected real utility host in injected-engine test')
    }
  }
}))

function fakeEngine(): {
  engine: SpeechPackEngine
  update: (id: SpeechPackComponentId, state: SpeechPackState, freshlyVerified?: boolean) => void
  enqueue: ReturnType<
    typeof vi.fn<
      (ids: readonly SpeechPackComponentId[], selected?: SpeechPackComponentId, transaction?: symbol) => void
    >
  >
} {
  const states = new Map(
    SPEECH_PACK_COMPONENTS.map((component) => [component.id, { status: 'not-installed' } as SpeechPackState])
  )
  const listeners = new Set<
    (event: {
      id: (typeof SPEECH_PACK_COMPONENTS)[number]['id']
      state: SpeechPackState
      freshlyVerified?: boolean
    }) => void
  >()
  const update = (
    id: (typeof SPEECH_PACK_COMPONENTS)[number]['id'],
    state: SpeechPackState,
    freshlyVerified = false
  ): void => {
    states.set(id, state)
    for (const listener of listeners) listener({ id, state, freshlyVerified })
  }
  const enqueue = vi.fn(
    (ids: readonly SpeechPackComponentId[], _selected?: SpeechPackComponentId, _transaction?: symbol) => {
      for (const id of ids) update(id, { status: 'queued' })
    }
  )
  const repair = vi.fn((id: SpeechPackComponentId) => update(id, { status: 'queued' }))
  const engine: SpeechPackEngine = {
    initialise: async () => undefined,
    getState: (id) => states.get(id) as SpeechPackState,
    states: () => Object.fromEntries(states) as ReturnType<SpeechPackEngine['states']>,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    enqueue,
    repair,
    pause: vi.fn((id) => update(id, { status: 'paused' })),
    cancel: vi.fn((id) => update(id, { status: 'error', kind: 'cancelled' })),
    whenIdle: async () => undefined
  }
  return { engine, update, enqueue }
}

function setup(overrides: Partial<Parameters<typeof createSpeechPackService>[0]> = {}) {
  const { engine, update } = fakeEngine()
  const createEngine = vi.fn(() => engine)
  const options: Parameters<typeof createSpeechPackService>[0] = {
    resourcesRoot: '/missing-resources',
    packaged: false,
    rootDir: '/speech-packs',
    selectedEngine: () => 'whisper',
    policyAllowsTransfer: () => true,
    featureEnabled: () => true,
    fixtureWavPath: '/fixture.wav',
    createEngine: createEngine as never,
    ...overrides
  }
  return { service: createSpeechPackService(options), engine, createEngine, update }
}

function deferredPackageContract(): {
  promise: Promise<PackageRuntimeContract>
  release: (contract: PackageRuntimeContract) => void
} {
  let release!: (contract: PackageRuntimeContract) => void
  const promise = new Promise<PackageRuntimeContract>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function install(
  service: ReturnType<typeof createSpeechPackService>,
  component: SpeechPackComponent = WHISPER_BASE_Q8,
  action: 'install' | 'repair' = 'install'
): Promise<{ ok: boolean; reason?: string }> {
  const preview = await service.planPreview({
    componentId: component.id,
    manifestIdentity: componentManifestIdentity(component),
    action
  })
  if (!preview.ok) return preview
  return service.installWithPlan({ planId: preview.plan.planId, action })
}

describe('explicit speech-pack service boundary', () => {
  it('keeps boot/status cold: no engine, downloads or self-test are constructed', async () => {
    const { service, createEngine } = setup()
    const state = await service.snapshot()
    expect(state.profile).toBe('development')
    expect(state.selectedComponent).toBe(WHISPER_BASE_Q8.id)
    expect(state.components).toHaveLength(2)
    expect(state.components.every((item) => item.downloadBytes > 0 && item.installedBytes > 0)).toBe(true)
    expect(createEngine).not.toHaveBeenCalled()
    expect(service.hasEngine()).toBe(false)
  })

  it('uses asynchronous runtime/model metadata and fails closed when the selected engine changes mid-read', async () => {
    let selectionIdentity = 'selection:0'
    const { service } = setup({
      selectionIdentity: () => selectionIdentity,
      engineRuntimeReady: async () => true,
      engineModelReady: async () => {
        selectionIdentity = 'selection:1'
        return true
      }
    })
    const snapshot = await service.snapshot()
    expect(snapshot.engineReadiness.state).toBe('unavailable')
  })

  it('reports a missing runtime separately and does not claim model readiness', async () => {
    const engineModelReady = vi.fn(async () => true)
    const { service } = setup({
      engineRuntimeReady: async () => false,
      engineModelReady
    })
    const snapshot = await service.snapshot()
    expect(snapshot.engineReadiness.state).toBe('runtime-needed')
    expect(engineModelReady).not.toHaveBeenCalled()
  })

  it('does not present a model-only lean pack as a ready engine or an installable plan', async () => {
    const leanContract = {
      status: 'verified' as const,
      profile: 'lean' as const,
      inventory: {
        schema: 1 as const,
        profile: 'lean' as const,
        platform: 'darwin' as const,
        arch: 'arm64' as const,
        appVersion: '2.1.0',
        electronVersion: '43.6.0',
        sourceCommit: 'a'.repeat(40),
        coreFiles: [],
        identity: 'b'.repeat(64)
      }
    }
    const { service, createEngine } = setup({ packageRuntimeContract: async () => leanContract })
    const snapshot = await service.snapshot()
    expect(snapshot.engineReadiness).toMatchObject({
      state: 'not-configured',
      runtimeComponentIds: ['runtime.asr-whisper-worker']
    })
    await expect(
      service.planPreview({
        componentId: WHISPER_BASE_Q8.id,
        action: 'install',
        manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
      })
    ).resolves.toEqual({ ok: false, reason: 'not-configured' })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('starts exactly the selected component only after explicit plan preview and affirmative execution', async () => {
    const { service, engine, createEngine } = setup()
    const preview = await service.planPreview({
      componentId: WHISPER_BASE_Q8.id,
      action: 'install',
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('expected an install plan')
    expect(createEngine).not.toHaveBeenCalled()
    const result = await service.installWithPlan({ planId: preview.plan.planId, action: 'install' })
    expect(result).toEqual({ ok: true })
    expect(createEngine).toHaveBeenCalledTimes(1)
    expect(engine.enqueue).toHaveBeenCalledWith([WHISPER_BASE_Q8.id], WHISPER_BASE_Q8.id, expect.any(Symbol))
    expect((await service.snapshot()).progress?.componentId).toBe(WHISPER_BASE_Q8.id)
  })

  it('makes each plan single-use and invalidates it when capture becomes active', async () => {
    const { service, engine, createEngine } = setup()
    const request = {
      componentId: WHISPER_BASE_Q8.id,
      action: 'install' as const,
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    }
    const preview = await service.planPreview(request)
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('expected plan preview')
    service.captureActivityChanged(true)
    await expect(service.installWithPlan({ planId: preview.plan.planId, action: 'install' })).resolves.toEqual({
      ok: false,
      reason: 'stale-plan'
    })
    expect(createEngine).not.toHaveBeenCalled()

    service.captureActivityChanged(false)
    const next = await service.planPreview(request)
    expect(next.ok).toBe(true)
    if (!next.ok) throw new Error('expected a fresh plan after capture ended')
    await expect(service.installWithPlan({ planId: next.plan.planId, action: 'install' })).resolves.toEqual({
      ok: true
    })
    await expect(service.installWithPlan({ planId: next.plan.planId, action: 'install' })).resolves.toEqual({
      ok: false,
      reason: 'plan-expired'
    })
    expect(engine.enqueue).toHaveBeenCalledTimes(1)
  })

  it('rejects a plan after the effective policy identity changes while transfer remains allowed', async () => {
    let policyIdentity = 'tenant-policy:1'
    const { service, createEngine } = setup({ policyIdentity: () => policyIdentity })
    const preview = await service.planPreview({
      componentId: WHISPER_BASE_Q8.id,
      action: 'install',
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('expected plan preview')
    policyIdentity = 'tenant-policy:2'
    await expect(service.installWithPlan({ planId: preview.plan.planId, action: 'install' })).resolves.toEqual({
      ok: false,
      reason: 'policy-blocked'
    })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('keeps consent plans valid across unchanged status polls', async () => {
    const { service } = setup()
    const preview = await service.planPreview({
      componentId: WHISPER_BASE_Q8.id,
      action: 'install',
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('expected plan preview')
    service.selectionChanged()
    await expect(service.installWithPlan({ planId: preview.plan.planId, action: 'install' })).resolves.toEqual({
      ok: true
    })
    await service.shutdown()
  })

  it('completes a real engine activation after its ready event clears the service activity lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'speech-pack-service-engine-'))
    const fixturePath = join(root, 'fixture.wav')
    const fixture = Buffer.from('synthetic pinned fixture for this engine/service boundary test')
    writeFileSync(fixturePath, fixture)
    const model = Buffer.from('verified model file')
    const component: SpeechPackComponent = {
      ...WHISPER_BASE_Q8,
      files: [
        {
          path: 'model.bin',
          bytes: model.length,
          sha256: createHash('sha256').update(model).digest('hex')
        }
      ],
      source: { kind: 'files', baseUrl: `https://huggingface.co/test/resolve/${'b'.repeat(40)}` }
    }
    let createdEngine: SpeechPackEngine | null = null
    const currentEngine = (): SpeechPackEngine | null => createdEngine
    const service = createSpeechPackService({
      resourcesRoot: join(root, 'resources'),
      packaged: false,
      rootDir: join(root, 'speech-packs'),
      selectedEngine: () => 'whisper',
      policyAllowsTransfer: () => true,
      featureEnabled: () => true,
      fixtureWavPath: fixturePath,
      components: [component],
      createEngine: (options) => {
        createdEngine = createSpeechPackEngine({
          ...options,
          fixture: { bytes: fixture.length, sha256: createHash('sha256').update(fixture).digest('hex') },
          freeBytes: () => Number.MAX_SAFE_INTEGER,
          emitIntervalMs: 0,
          fetch: async () => new Response(model),
          selfTest: async () => 'Ask not what your country can do for you, ask what you can do for your country.'
        })
        return createdEngine
      }
    })
    try {
      await expect(install(service, component)).resolves.toEqual({ ok: true })
      const activeEngine = currentEngine()
      if (!activeEngine) throw new Error('expected service to create its engine after explicit consent')
      await activeEngine.whenIdle()
      expect((await service.snapshot()).components[0]).toMatchObject({
        state: 'ready',
        integrity: 'freshly-hash-verified-and-self-tested'
      })
    } finally {
      await service.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects stale, unselected, disabled and policy-blocked requests before constructing the engine', async () => {
    const { service, createEngine } = setup({
      featureEnabled: () => false,
      policyAllowsTransfer: () => false
    })
    const identity = componentManifestIdentity(WHISPER_BASE_Q8)
    await expect(
      service.planPreview({ componentId: WHISPER_BASE_Q8.id, action: 'install', manifestIdentity: '0'.repeat(64) })
    ).resolves.toEqual({ ok: false, reason: 'stale-manifest' })
    await expect(
      service.planPreview({ componentId: WHISPER_BASE_Q8.id, action: 'install', manifestIdentity: identity })
    ).resolves.toEqual({ ok: false, reason: 'disabled' })
    expect(createEngine).not.toHaveBeenCalled()

    const { service: blocked, createEngine: blockedCreate } = setup({ policyAllowsTransfer: () => false })
    await expect(
      blocked.planPreview({ componentId: WHISPER_BASE_Q8.id, action: 'install', manifestIdentity: identity })
    ).resolves.toEqual({ ok: false, reason: 'policy-blocked' })
    expect(blockedCreate).not.toHaveBeenCalled()

    const { service: other, createEngine: otherCreate } = setup({ selectedEngine: () => 'parakeet' })
    await expect(
      other.planPreview({ componentId: WHISPER_BASE_Q8.id, action: 'install', manifestIdentity: identity })
    ).resolves.toEqual({ ok: false, reason: 'not-selected' })
    expect(otherCreate).not.toHaveBeenCalled()
  })

  it('can pause or cancel an existing selected-only transfer without making a new one', async () => {
    const { service, engine } = setup()
    const identity = componentManifestIdentity(WHISPER_BASE_Q8)
    await install(service)
    await expect(
      service.action({ componentId: WHISPER_BASE_Q8.id, action: 'pause', manifestIdentity: identity })
    ).resolves.toEqual({
      ok: true
    })
    expect(engine.pause).toHaveBeenCalledWith(WHISPER_BASE_Q8.id)
    await expect(
      service.action({ componentId: WHISPER_BASE_Q8.id, action: 'cancel', manifestIdentity: identity })
    ).resolves.toEqual({
      ok: true
    })
    expect(engine.cancel).toHaveBeenCalledWith(WHISPER_BASE_Q8.id)
    expect(engine.enqueue).toHaveBeenCalledTimes(1)
  })

  it('refuses a newly requested pack while capture is already active', async () => {
    const { service, createEngine } = setup()
    service.captureActivityChanged(true)
    await expect(
      service.planPreview({
        componentId: WHISPER_BASE_Q8.id,
        action: 'install',
        manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
      })
    ).resolves.toEqual({ ok: false, reason: 'busy' })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('uses live capture authority for each action and fails closed when that getter throws', async () => {
    let active = false
    const { service, createEngine } = setup({ captureActive: () => active })
    const request = {
      componentId: WHISPER_BASE_Q8.id,
      action: 'install' as const,
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    }
    active = true
    await expect(service.planPreview(request)).resolves.toEqual({ ok: false, reason: 'busy' })
    expect(createEngine).not.toHaveBeenCalled()

    const failClosed = setup({
      captureActive: () => {
        throw new Error('capture state unavailable')
      }
    })
    await expect(failClosed.service.planPreview(request)).resolves.toEqual({ ok: false, reason: 'busy' })
    expect(failClosed.createEngine).not.toHaveBeenCalled()
  })

  it('invalidates an action whose package admission is pending when the user cancels', async () => {
    const pendingContract = deferredPackageContract()
    const { service, createEngine } = setup({ packageRuntimeContract: () => pendingContract.promise })
    const request = {
      componentId: WHISPER_BASE_Q8.id,
      action: 'install' as const,
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    }
    const pending = service.planPreview(request)
    await expect(service.action({ ...request, action: 'cancel' })).resolves.toEqual({ ok: true })
    pendingContract.release({ status: 'development', profile: 'development', inventory: null })
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale-plan' })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('does not let obsolete package admission supersede a newer same-component plan', async () => {
    const pendingContract = deferredPackageContract()
    const { service, engine } = setup({ packageRuntimeContract: () => pendingContract.promise })
    const request = {
      componentId: WHISPER_BASE_Q8.id,
      action: 'install' as const,
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    }
    const obsolete = service.planPreview(request)
    await Promise.resolve()
    await service.action({ ...request, action: 'cancel' })
    const current = service.planPreview(request)
    pendingContract.release({ status: 'development', profile: 'development', inventory: null })

    await expect(obsolete).resolves.toEqual({ ok: false, reason: 'stale-plan' })
    expect(engine.enqueue).not.toHaveBeenCalled()
    const plan = await current
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('expected a current install plan')
    await service.installWithPlan({ planId: plan.plan.planId, action: 'install' })
    expect(engine.enqueue).toHaveBeenCalledTimes(1)
  })

  it('rechecks selection, policy, capture and shutdown after async package admission', async () => {
    const identity = componentManifestIdentity(WHISPER_BASE_Q8)
    const run = async (
      invalidate: (
        service: ReturnType<typeof createSpeechPackService>,
        state: { selected: 'whisper' | 'parakeet'; policy: boolean; capture: boolean }
      ) => void | Promise<void>,
      expected: 'busy' | 'not-selected'
    ): Promise<void> => {
      const pendingContract = deferredPackageContract()
      const pendingState = { selected: 'whisper' as 'whisper' | 'parakeet', policy: true, capture: false }
      const { service, createEngine } = setup({
        selectedEngine: () => pendingState.selected,
        policyAllowsTransfer: () => pendingState.policy,
        captureActive: () => pendingState.capture,
        packageRuntimeContract: () => pendingContract.promise
      })
      const pending = service.planPreview({
        componentId: WHISPER_BASE_Q8.id,
        action: 'install',
        manifestIdentity: identity
      })
      await Promise.resolve()
      await invalidate(service, pendingState)
      pendingContract.release({ status: 'development', profile: 'development', inventory: null })
      await expect(pending).resolves.toEqual({
        ok: false,
        reason: expected === 'not-selected' ? 'not-selected' : 'stale-plan'
      })
      expect(createEngine).not.toHaveBeenCalled()
    }

    await run((service, state) => {
      state.selected = 'parakeet'
      service.selectionChanged()
    }, 'busy')
    await run((service, state) => {
      state.policy = false
      service.policyChanged()
    }, 'busy')
    await run((service, state) => {
      state.capture = true
      service.captureActivityChanged(true)
    }, 'busy')
    await run((service) => service.shutdown(), 'busy')
  })

  it('invalidates a reviewed plan after policy authority changes away and back', async () => {
    let policyIdentity = 'speech-proof:4:scope-a:revision-1'
    const { service, createEngine } = setup({ policyIdentity: () => policyIdentity })
    const preview = await service.planPreview({
      componentId: WHISPER_BASE_Q8.id,
      action: 'install',
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('expected a current install plan')

    policyIdentity = 'speech-proof:5:scope-b:revision-2'
    service.policyChanged()
    policyIdentity = 'speech-proof:6:scope-a:revision-1'
    service.policyChanged()

    await expect(service.installWithPlan({ planId: preview.plan.planId, action: 'install' })).resolves.toEqual({
      ok: false,
      reason: 'plan-expired'
    })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('keeps same-transaction prior-pack rollback authority after policy revocation, but never during capture', async () => {
    let policyIdentity = 'speech-proof:4:scope-a:revision-1'
    let capture = false
    let engineOptions: SpeechPackEngineOptions | null = null
    const fake = fakeEngine()
    const createEngine = (options: SpeechPackEngineOptions): SpeechPackEngine => {
      engineOptions = options
      return { ...fake.engine, cancel: vi.fn() }
    }
    const { service } = setup({
      policyIdentity: () => policyIdentity,
      captureActive: () => capture,
      createEngine: createEngine as never
    })
    expect(await install(service)).toMatchObject({ ok: true })
    const admittedOptions = engineOptions as unknown as SpeechPackEngineOptions
    const marker = { version: '1', manifestIdentity: 'a'.repeat(64) }
    const transaction = fake.enqueue.mock.calls[0][2]
    expect(transaction).toEqual(expect.any(Symbol))
    if (!transaction) throw new Error('expected engine transaction token')

    policyIdentity = 'speech-proof:5:scope-b:revision-2'
    service.policyChanged()
    await expect(admittedOptions.authorizeActivation?.(WHISPER_BASE_Q8.id)).resolves.toBe(false)
    await expect(admittedOptions.authorizeRollback?.(WHISPER_BASE_Q8.id, marker, transaction)).resolves.toBe(true)
    expect(admittedOptions.authorizeRollbackCurrent?.(WHISPER_BASE_Q8.id, marker, transaction)).toBe(true)
    await expect(admittedOptions.authorizeRollback?.(WHISPER_BASE_Q8.id, marker, Symbol('stale'))).resolves.toBe(false)
    admittedOptions.onTransactionSettled?.(WHISPER_BASE_Q8.id, transaction)
    await expect(admittedOptions.authorizeRollback?.(WHISPER_BASE_Q8.id, marker, transaction)).resolves.toBe(false)

    fake.update(WHISPER_BASE_Q8.id, { status: 'error', kind: 'http' })
    policyIdentity = 'speech-proof:7:scope-a:revision-3'
    service.policyChanged()
    expect(await install(service)).toMatchObject({ ok: true })
    const nextTransaction = fake.enqueue.mock.calls[1][2]
    expect(nextTransaction).toEqual(expect.any(Symbol))
    if (!nextTransaction) throw new Error('expected successor transaction token')
    await expect(admittedOptions.authorizeRollback?.(WHISPER_BASE_Q8.id, marker, transaction)).resolves.toBe(false)
    expect(admittedOptions.authorizeRollbackCurrent?.(WHISPER_BASE_Q8.id, marker, nextTransaction)).toBe(true)

    capture = true
    service.captureActivityChanged(true)
    expect(admittedOptions.authorizeRollbackCurrent?.(WHISPER_BASE_Q8.id, marker, nextTransaction)).toBe(false)
    await service.shutdown()
  })

  it('keeps the real engine transaction busy until ready-listener cancel rollback settles', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'speech-pack-service-rollback-'))
    const bytes = Buffer.from('tiny pinned pack')
    const file = { path: 'weights.bin', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const component: SpeechPackComponent = {
      ...WHISPER_BASE_Q8,
      version: 'integration-test',
      files: [file],
      source: { kind: 'files', baseUrl: `https://example.test/resolve/${'a'.repeat(40)}` }
    }
    const fixtureWavPath = join(__dirname, '../../../../../resources/speech-pack-fixtures/en.wav')
    let engine: SpeechPackEngine | null = null
    const activeEngine = (): SpeechPackEngine | null => engine
    let cancelResult: Promise<unknown> | null = null
    let signalRollback!: () => void
    const rollbackEntered = new Promise<void>((resolve) => {
      signalRollback = resolve
    })
    let releaseRollback!: (allowed: boolean) => void
    const heldRollback = new Promise<boolean>((resolve) => {
      releaseRollback = resolve
    })
    const service = createSpeechPackService({
      resourcesRoot: '/missing-resources',
      packaged: false,
      rootDir,
      selectedEngine: () => 'whisper',
      selectionIdentity: () => 'engine:1:whisper',
      policyAllowsTransfer: () => true,
      policyIdentity: () => 'policy:1:unmanaged',
      refreshAuthority: () => true,
      refreshRollbackAuthority: async () => {
        signalRollback()
        return heldRollback
      },
      rollbackAuthorityCurrent: () => true,
      captureActive: () => false,
      captureIdentity: () => 'capture:0',
      featureEnabled: () => true,
      fixtureWavPath,
      components: [component],
      packageRuntimeContract: async () => ({ status: 'development', profile: 'development', inventory: null }),
      engineRuntimeReady: () => true,
      engineModelReady: () => true,
      createEngine: (options) => {
        engine = createSpeechPackEngine({
          ...options,
          emitIntervalMs: 0,
          freeBytes: () => Number.MAX_SAFE_INTEGER,
          fetch: async () =>
            new Response(bytes, {
              headers: { 'content-length': String(bytes.length), etag: '"pinned"' }
            }),
          selfTest: async () => 'fixture decoded'
        })
        return engine
      }
    })
    service.subscribe((progress) => {
      if (progress.state === 'ready' && cancelResult === null) {
        cancelResult = service.action({
          componentId: component.id,
          manifestIdentity: componentManifestIdentity(component),
          action: 'cancel'
        })
      }
    })
    try {
      const preview = await service.planPreview({
        componentId: component.id,
        action: 'install',
        manifestIdentity: componentManifestIdentity(component)
      })
      expect(preview.ok).toBe(true)
      if (!preview.ok) throw new Error('expected an install plan')
      await expect(service.installWithPlan({ planId: preview.plan.planId, action: 'install' })).resolves.toMatchObject({
        ok: true
      })
      const runningEngine = activeEngine()
      if (!runningEngine) throw new Error('expected the production engine adapter')
      await rollbackEntered
      const successor = await service.planPreview({
        componentId: component.id,
        manifestIdentity: componentManifestIdentity(component),
        action: 'repair'
      })
      expect(successor.ok).toBe(true)
      if (!successor.ok) throw new Error('expected a repair plan while rollback is held')
      await expect(service.installWithPlan({ planId: successor.plan.planId, action: 'repair' })).resolves.toMatchObject(
        { ok: false, reason: 'busy' }
      )
      releaseRollback(true)
      await runningEngine.whenIdle()
      await expect(cancelResult).resolves.toMatchObject({ ok: true })
      expect(existsSync(join(rootDir, component.id, component.version))).toBe(false)
      expect(existsSync(join(rootDir, component.id, 'active.json'))).toBe(false)
    } finally {
      releaseRollback(true)
      await service.shutdown()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('does not admit a transfer after shutdown has started', async () => {
    const { service, createEngine } = setup()
    await service.shutdown()
    await expect(
      service.planPreview({
        componentId: WHISPER_BASE_Q8.id,
        action: 'install',
        manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
      })
    ).resolves.toEqual({ ok: false, reason: 'busy' })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('does not claim fresh hash and self-test evidence for a ready shortcut, and clears it after repair failure', async () => {
    const c = WHISPER_BASE_Q8
    const readiness: Resolver.SpeechPackReadiness = {
      status: 'ready',
      componentId: c.id,
      version: c.version,
      manifestIdentity: componentManifestIdentity(c),
      evidence: 'prior-activation-and-size-checked'
    }
    const resolve = vi.spyOn(Resolver, 'resolveSpeechPack').mockResolvedValue(readiness)
    try {
      const { service, update } = setup()
      const preview = await service.planPreview({
        componentId: c.id,
        action: 'repair',
        manifestIdentity: componentManifestIdentity(c)
      })
      if (!preview.ok) throw new Error('expected explicit repair plan')
      await service.installWithPlan({ planId: preview.plan.planId, action: 'repair' })
      update(c.id, { status: 'ready' }) // existing-install shortcut, with no self-test event
      expect((await service.snapshot()).components.find((item) => item.componentId === c.id)?.integrity).toBe(
        'prior-activation-and-size-checked'
      )

      update(c.id, { status: 'self-testing' })
      update(c.id, { status: 'ready' }, true)
      expect((await service.snapshot()).components.find((item) => item.componentId === c.id)?.integrity).toBe(
        'freshly-hash-verified-and-self-tested'
      )

      update(c.id, { status: 'self-testing' })
      update(c.id, { status: 'error', kind: 'tamper' })
      expect((await service.snapshot()).components.find((item) => item.componentId === c.id)?.integrity).toBe(
        'prior-activation-and-size-checked'
      )
    } finally {
      resolve.mockRestore()
    }
  })

  it('reports malformed action payloads with a finite result and no side effects', async () => {
    const { service, createEngine } = setup()
    await expect(
      service.action({
        componentId: WHISPER_BASE_Q8.id,
        action: 'download',
        manifestIdentity: 'x',
        url: 'https://attacker.invalid'
      })
    ).resolves.toEqual({ ok: false, reason: 'invalid-request' })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('shows and refuses a component whose immutable source has not been configured', async () => {
    const component = { ...WHISPER_BASE_Q8, source: { kind: 'files' as const, baseUrl: null } }
    const { service, createEngine } = setup({ components: [component] })
    const snapshot = await service.snapshot()
    expect(snapshot.components[0]).toMatchObject({
      state: 'not-configured',
      sourceHost: null,
      downloadBytes: component.files.reduce((sum, file) => sum + file.bytes, 0)
    })
    await expect(
      service.planPreview({
        componentId: component.id,
        action: 'install',
        manifestIdentity: componentManifestIdentity(component)
      })
    ).resolves.toEqual({ ok: false, reason: 'not-configured' })
    expect(createEngine).not.toHaveBeenCalled()
  })
})
