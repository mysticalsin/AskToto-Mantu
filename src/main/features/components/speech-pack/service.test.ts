import { describe, expect, it, vi } from 'vitest'
import type { SpeechPackEngine, SpeechPackState } from './engine'
import { SPEECH_PACK_COMPONENTS, WHISPER_BASE_Q8, type SpeechPackComponentId } from './manifest'
import { componentManifestIdentity } from './resolver'
import { createSpeechPackService } from './service'

function fakeEngine(): SpeechPackEngine {
  const states = new Map(
    SPEECH_PACK_COMPONENTS.map((component) => [component.id, { status: 'not-installed' } as SpeechPackState])
  )
  const listeners = new Set<
    (event: { id: (typeof SPEECH_PACK_COMPONENTS)[number]['id']; state: SpeechPackState }) => void
  >()
  const update = (id: (typeof SPEECH_PACK_COMPONENTS)[number]['id'], state: SpeechPackState): void => {
    states.set(id, state)
    for (const listener of listeners) listener({ id, state })
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
  return engine
}

function setup(overrides: Partial<Parameters<typeof createSpeechPackService>[0]> = {}) {
  const engine = fakeEngine()
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
  return { service: createSpeechPackService(options), engine, createEngine }
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
