import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSpeechPackEngine, type SpeechPackEngine, type SpeechPackState } from './engine'
import {
  SPEECH_PACK_COMPONENTS,
  WHISPER_BASE_Q8,
  type SpeechPackComponent,
  type SpeechPackComponentId
} from './manifest'
import * as Resolver from './resolver'
import { componentManifestIdentity } from './resolver'
import { createSpeechPackService } from './service'

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
  const enqueue = vi.fn((ids: readonly SpeechPackComponentId[], _selected?: SpeechPackComponentId) => {
    for (const id of ids) update(id, { status: 'queued' })
  })
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
  return { engine, update }
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

describe('explicit speech-pack service boundary', () => {
  it('keeps boot/status cold: no engine, downloads or self-test are constructed', () => {
    const { service, createEngine } = setup()
    const state = service.snapshot()
    expect(state.profile).toBe('development')
    expect(state.selectedComponent).toBe(WHISPER_BASE_Q8.id)
    expect(state.components).toHaveLength(2)
    expect(state.components.every((item) => item.downloadBytes > 0 && item.installedBytes > 0)).toBe(true)
    expect(createEngine).not.toHaveBeenCalled()
    expect(service.hasEngine()).toBe(false)
  })

  it('starts exactly the selected component only after an explicit current-manifest action', () => {
    const { service, engine, createEngine } = setup()
    const result = service.action({
      componentId: WHISPER_BASE_Q8.id,
      action: 'download',
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    })
    expect(result).toEqual({ ok: true })
    expect(createEngine).toHaveBeenCalledTimes(1)
    expect(engine.enqueue).toHaveBeenCalledWith([WHISPER_BASE_Q8.id], WHISPER_BASE_Q8.id)
    expect(service.snapshot().progress?.componentId).toBe(WHISPER_BASE_Q8.id)
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
      expect(
        service.action({
          componentId: component.id,
          action: 'download',
          manifestIdentity: componentManifestIdentity(component)
        })
      ).toEqual({ ok: true })
      const activeEngine = currentEngine()
      if (!activeEngine) throw new Error('expected service to create its engine after explicit consent')
      await activeEngine.whenIdle()
      expect(service.snapshot().components[0]).toMatchObject({
        state: 'ready',
        integrity: 'freshly-hash-verified-and-self-tested'
      })
    } finally {
      await service.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects stale, unselected, disabled and policy-blocked requests before constructing the engine', () => {
    const { service, createEngine } = setup({
      featureEnabled: () => false,
      policyAllowsTransfer: () => false
    })
    const identity = componentManifestIdentity(WHISPER_BASE_Q8)
    expect(
      service.action({ componentId: WHISPER_BASE_Q8.id, action: 'download', manifestIdentity: '0'.repeat(64) })
    ).toEqual({ ok: false, reason: 'stale-manifest' })
    expect(service.action({ componentId: WHISPER_BASE_Q8.id, action: 'download', manifestIdentity: identity })).toEqual(
      { ok: false, reason: 'disabled' }
    )
    expect(createEngine).not.toHaveBeenCalled()

    const { service: blocked, createEngine: blockedCreate } = setup({ policyAllowsTransfer: () => false })
    expect(blocked.action({ componentId: WHISPER_BASE_Q8.id, action: 'download', manifestIdentity: identity })).toEqual(
      { ok: false, reason: 'policy-blocked' }
    )
    expect(blockedCreate).not.toHaveBeenCalled()

    const { service: other, createEngine: otherCreate } = setup({ selectedEngine: () => 'parakeet' })
    expect(other.action({ componentId: WHISPER_BASE_Q8.id, action: 'download', manifestIdentity: identity })).toEqual({
      ok: false,
      reason: 'not-selected'
    })
    expect(otherCreate).not.toHaveBeenCalled()
  })

  it('can pause or cancel an existing selected-only transfer without making a new one', () => {
    const { service, engine } = setup()
    const identity = componentManifestIdentity(WHISPER_BASE_Q8)
    service.action({ componentId: WHISPER_BASE_Q8.id, action: 'download', manifestIdentity: identity })
    expect(service.action({ componentId: WHISPER_BASE_Q8.id, action: 'pause', manifestIdentity: identity })).toEqual({
      ok: true
    })
    expect(engine.pause).toHaveBeenCalledWith(WHISPER_BASE_Q8.id)
    expect(service.action({ componentId: WHISPER_BASE_Q8.id, action: 'cancel', manifestIdentity: identity })).toEqual({
      ok: true
    })
    expect(engine.cancel).toHaveBeenCalledWith(WHISPER_BASE_Q8.id)
    expect(engine.enqueue).toHaveBeenCalledTimes(1)
  })

  it('refuses a newly requested pack while capture is already active', () => {
    const { service, createEngine } = setup()
    service.captureActivityChanged(true)
    expect(
      service.action({
        componentId: WHISPER_BASE_Q8.id,
        action: 'download',
        manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
      })
    ).toEqual({ ok: false, reason: 'busy' })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('uses live capture authority for each action and fails closed when that getter throws', () => {
    let active = false
    const { service, createEngine } = setup({ captureActive: () => active })
    const request = {
      componentId: WHISPER_BASE_Q8.id,
      action: 'download' as const,
      manifestIdentity: componentManifestIdentity(WHISPER_BASE_Q8)
    }
    active = true
    expect(service.action(request)).toEqual({ ok: false, reason: 'busy' })
    expect(createEngine).not.toHaveBeenCalled()

    const failClosed = setup({
      captureActive: () => {
        throw new Error('capture state unavailable')
      }
    })
    expect(failClosed.service.action(request)).toEqual({ ok: false, reason: 'busy' })
    expect(failClosed.createEngine).not.toHaveBeenCalled()
  })

  it('does not claim fresh hash and self-test evidence for a ready shortcut, and clears it after repair failure', () => {
    const c = WHISPER_BASE_Q8
    const readiness: Resolver.SpeechPackReadiness = {
      status: 'ready',
      componentId: c.id,
      version: c.version,
      manifestIdentity: componentManifestIdentity(c),
      evidence: 'prior-activation-and-size-checked'
    }
    const resolve = vi.spyOn(Resolver, 'resolveSpeechPack').mockReturnValue(readiness)
    try {
      const { service, update } = setup()
      service.action({ componentId: c.id, action: 'download', manifestIdentity: componentManifestIdentity(c) })
      update(c.id, { status: 'ready' }) // existing-install shortcut, with no self-test event
      expect(service.snapshot().components.find((item) => item.componentId === c.id)?.integrity).toBe(
        'prior-activation-and-size-checked'
      )

      update(c.id, { status: 'self-testing' })
      update(c.id, { status: 'ready' }, true)
      expect(service.snapshot().components.find((item) => item.componentId === c.id)?.integrity).toBe(
        'freshly-hash-verified-and-self-tested'
      )

      update(c.id, { status: 'self-testing' })
      update(c.id, { status: 'error', kind: 'tamper' })
      expect(service.snapshot().components.find((item) => item.componentId === c.id)?.integrity).toBe(
        'prior-activation-and-size-checked'
      )
    } finally {
      resolve.mockRestore()
    }
  })

  it('reports malformed action payloads with a finite result and no side effects', () => {
    const { service, createEngine } = setup()
    expect(
      service.action({
        componentId: WHISPER_BASE_Q8.id,
        action: 'download',
        manifestIdentity: 'x',
        url: 'https://attacker.invalid'
      })
    ).toEqual({ ok: false, reason: 'invalid-request' })
    expect(createEngine).not.toHaveBeenCalled()
  })

  it('shows and refuses a component whose immutable source has not been configured', () => {
    const component = { ...WHISPER_BASE_Q8, source: { kind: 'files' as const, baseUrl: null } }
    const { service, createEngine } = setup({ components: [component] })
    const snapshot = service.snapshot()
    expect(snapshot.components[0]).toMatchObject({
      state: 'not-configured',
      sourceHost: null,
      downloadBytes: component.files.reduce((sum, file) => sum + file.bytes, 0)
    })
    expect(
      service.action({
        componentId: component.id,
        action: 'download',
        manifestIdentity: componentManifestIdentity(component)
      })
    ).toEqual({ ok: false, reason: 'not-configured' })
    expect(createEngine).not.toHaveBeenCalled()
  })
})
