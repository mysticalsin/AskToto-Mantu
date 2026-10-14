import { randomUUID } from 'node:crypto'
import {
  SpeechPackActionRequestSchema,
  SpeechPackActionResultSchema,
  SpeechPackProgressSchema,
  SpeechPackSnapshotSchema,
  type SpeechPackActionRequest,
  type SpeechPackActionResult,
  type SpeechPackComponentSnapshot,
  type SpeechPackProgress,
  type SpeechPackSnapshot
} from '@shared/speech-pack'
import { IPC } from '@shared/ipc'
import type { SpeechPackEngine, SpeechPackState } from './engine'
import { createSpeechPackEngine } from './engine'
import { speechPackEnabled } from './flag'
import {
  PARAKEET_TDT_V3_INT8,
  SPEECH_PACK_COMPONENTS,
  SELF_TEST_FIXTURE,
  WHISPER_BASE_Q8,
  componentBytes,
  componentDownloadBytes,
  isImmutableUrl,
  type SpeechPackComponent,
  type SpeechPackComponentId
} from './manifest'
import { readSpeechPackProfile } from './profile'
import { componentManifestIdentity, resolveSpeechPack } from './resolver'
import { runSpeechPackSelfTest } from './self-test'

export interface SpeechPackServiceOptions {
  resourcesRoot: string
  packaged: boolean
  rootDir: string
  selectedEngine: () => 'whisper' | 'parakeet' | 'apple'
  policyAllowsTransfer: () => boolean
  /** Live authoritative capture state; a throwing getter fails closed. */
  captureActive?: () => boolean
  featureEnabled?: () => boolean
  fixtureWavPath: string
  createEngine?: (options: Parameters<typeof createSpeechPackEngine>[0]) => SpeechPackEngine
  components?: readonly SpeechPackComponent[]
  shutdownTimeoutMs?: number
}

function selectedId(engine: 'whisper' | 'parakeet' | 'apple'): SpeechPackComponentId | null {
  return engine === 'whisper' ? WHISPER_BASE_Q8.id : engine === 'parakeet' ? PARAKEET_TDT_V3_INT8.id : null
}

function finiteState(state: SpeechPackState): SpeechPackProgress['state'] {
  return state.status === 'not-installed' ? 'paused' : state.status === 'error' ? 'error' : state.status
}

function sourceHost(component: SpeechPackComponent): string | null {
  const url = component.source.kind === 'files' ? component.source.baseUrl : component.source.archive?.url
  if (!url || !isImmutableUrl(url)) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.hostname : null
  } catch {
    return null
  }
}

/** Explicit-consent-only service. Status is cheap and never creates the engine or touches the network. */
export function createSpeechPackService(options: SpeechPackServiceOptions) {
  const components = options.components ?? SPEECH_PACK_COMPONENTS
  const byId = new Map(components.map((component) => [component.id, component]))
  const createEngine = options.createEngine ?? createSpeechPackEngine
  const featureEnabled = options.featureEnabled ?? (() => speechPackEnabled())
  let engine: SpeechPackEngine | null = null
  let unsubscribe: (() => void) | null = null
  let currentProgress: SpeechPackProgress | null = null
  const activity = new Set<SpeechPackComponentId>()
  let captureActive = false
  const listeners = new Set<(progress: SpeechPackProgress) => void>()
  const repairVerified = new Set<SpeechPackComponentId>()
  const resumeScope = randomUUID()

  const isCaptureActive = (): boolean => {
    if (captureActive) return true
    try {
      return options.captureActive?.() ?? false
    } catch {
      return true
    }
  }

  const getEngine = (): SpeechPackEngine => {
    if (engine) return engine
    engine = createEngine({
      rootDir: options.rootDir,
      fixtureWavPath: options.fixtureWavPath,
      fixture: SELF_TEST_FIXTURE,
      selfTest: runSpeechPackSelfTest,
      components,
      resumeScope,
      authorizeTransfer: (id) =>
        activity.has(id) &&
        options.policyAllowsTransfer() &&
        !isCaptureActive() &&
        selectedId(options.selectedEngine()) === id
    })
    unsubscribe = engine.subscribe(({ id, state, freshlyVerified }) => {
      const manifestIdentity = componentManifestIdentity(byId.get(id) as SpeechPackComponent)
      const progress: SpeechPackProgress =
        state.status === 'downloading'
          ? {
              componentId: id,
              manifestIdentity,
              bytesDone: Math.min(state.bytesDone, state.bytesTotal),
              bytesTotal: state.bytesTotal,
              state: 'downloading'
            }
          : {
              componentId: id,
              manifestIdentity,
              bytesDone: 0,
              bytesTotal: componentBytes(byId.get(id) as SpeechPackComponent),
              state: finiteState(state)
            }
      currentProgress = progress
      const validatedProgress = SpeechPackProgressSchema.parse(progress)
      for (const listener of listeners) listener(validatedProgress)
      if (state.status === 'ready') {
        if (freshlyVerified) repairVerified.add(id)
        else repairVerified.delete(id)
      }
      if (state.status === 'error' || state.status === 'paused') {
        repairVerified.delete(id)
      }
      if (state.status === 'ready' || state.status === 'error' || state.status === 'paused') activity.delete(id)
    })
    return engine
  }

  const snapshot = (): SpeechPackSnapshot => {
    const profileRead = readSpeechPackProfile(options.resourcesRoot, options.packaged)
    const selectedEngine = options.selectedEngine()
    const selectedComponent = selectedId(selectedEngine)
    const profile = profileRead.profile
    const rows = components.map((component): SpeechPackComponentSnapshot => {
      const resolved = resolveSpeechPack(options.rootDir, component)
      if (resolved.status !== 'ready') repairVerified.delete(component.id)
      const state = engine?.getState(component.id)
      const transient = state && state.status !== 'not-installed' && state.status !== 'ready'
      return {
        componentId: component.id,
        manifestIdentity: componentManifestIdentity(component),
        version: component.version,
        state: sourceHost(component) === null ? 'not-configured' : transient ? finiteState(state) : resolved.status,
        downloadBytes: componentDownloadBytes(component),
        installedBytes: component.files.reduce((sum, file) => sum + file.bytes, 0),
        sourceHost: sourceHost(component),
        integrity: repairVerified.has(component.id) ? 'freshly-hash-verified-and-self-tested' : resolved.evidence,
        ...(state?.status === 'error' && state.requiredBytes !== undefined
          ? { requiredBytes: state.requiredBytes }
          : {}),
        ...(state?.status === 'error' && state.freeBytes !== undefined ? { freeBytes: state.freeBytes } : {})
      }
    })
    return SpeechPackSnapshotSchema.parse({
      featureEnabled: featureEnabled(),
      profile,
      profileError: profileRead.profile === null ? profileRead.error : null,
      selectedEngine,
      selectedComponent,
      components: rows,
      progress: currentProgress
    })
  }

  const action = (value: unknown): SpeechPackActionResult => {
    const parsedRequest = SpeechPackActionRequestSchema.safeParse(value)
    if (!parsedRequest.success) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'invalid-request' })
    const request: SpeechPackActionRequest = parsedRequest.data
    const result = (response: SpeechPackActionResult): SpeechPackActionResult =>
      SpeechPackActionResultSchema.parse(response)
    const component = byId.get(request.componentId)
    if (!component) return result({ ok: false, reason: 'invalid-request' })
    if (componentManifestIdentity(component) !== request.manifestIdentity)
      return result({ ok: false, reason: 'stale-manifest' })
    if (sourceHost(component) === null) return result({ ok: false, reason: 'not-configured' })
    const currentEngine = options.selectedEngine()
    if (request.action === 'pause' || request.action === 'cancel') {
      if (!engine) return result({ ok: true })
      if (request.action === 'pause') engine.pause(component.id)
      else engine.cancel(component.id)
      activity.delete(component.id)
      return result({ ok: true })
    }
    if (!featureEnabled()) return result({ ok: false, reason: 'disabled' })
    const profileRead = readSpeechPackProfile(options.resourcesRoot, options.packaged)
    if (profileRead.profile === null) return result({ ok: false, reason: 'profile-invalid' })
    if (selectedId(currentEngine) !== component.id) return result({ ok: false, reason: 'not-selected' })
    if (!options.policyAllowsTransfer()) return result({ ok: false, reason: 'policy-blocked' })
    if (isCaptureActive()) return result({ ok: false, reason: 'busy' })
    const instance = getEngine()
    const state = instance.getState(component.id)
    if (
      state.status === 'queued' ||
      state.status === 'downloading' ||
      state.status === 'verifying' ||
      state.status === 'self-testing'
    ) {
      return result({ ok: false, reason: 'busy' })
    }
    activity.add(component.id)
    currentProgress = {
      componentId: component.id,
      manifestIdentity: request.manifestIdentity,
      bytesDone: 0,
      bytesTotal: componentDownloadBytes(component),
      state: 'queued'
    }
    if (request.action === 'repair') instance.repair(component.id)
    else instance.enqueue([component.id], component.id)
    return result({ ok: true })
  }

  return {
    snapshot,
    action,
    subscribe(listener: (progress: SpeechPackProgress) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    policyChanged(): void {
      if (options.policyAllowsTransfer()) return
      for (const id of activity) engine?.cancel(id)
      activity.clear()
    },
    selectionChanged(): void {
      const selected = selectedId(options.selectedEngine())
      for (const id of activity) {
        if (id !== selected) engine?.cancel(id)
      }
    },
    captureActivityChanged(active: boolean): void {
      captureActive = active
      if (!active) return
      for (const id of activity) engine?.pause(id)
    },
    async shutdown(): Promise<void> {
      if (engine) for (const component of components) engine.cancel(component.id)
      activity.clear()
      if (engine) {
        let timeout: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          engine.whenIdle().catch(() => undefined),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, options.shutdownTimeoutMs ?? 10_000)
          })
        ])
        clearTimeout(timeout)
      }
      unsubscribe?.()
      unsubscribe = null
      listeners.clear()
    },
    /** Test seam: verifies status stays cold and no engine exists before explicit action. */
    hasEngine(): boolean {
      return engine !== null
    }
  }
}

export type SpeechPackService = ReturnType<typeof createSpeechPackService>
export type {
  SpeechPackActionRequest,
  SpeechPackActionResult,
  SpeechPackComponentSnapshot,
  SpeechPackProgress,
  SpeechPackSnapshot
} from '@shared/speech-pack'

/**
 * Thin IPC adapter. The caller supplies the application's existing main-window sender check and
 * progress broadcaster; this module never accepts paths, URLs, manifests or engine choices from IPC.
 */
export function registerSpeechPackIpc(options: {
  ipcMain: {
    handle(channel: string, listener: (event: { sender: unknown }, request?: unknown) => unknown): void
    removeHandler(channel: string): void
  }
  assertMainWindow: (event: { sender: unknown }) => void
  sendProgress: (progress: SpeechPackProgress) => void
  service: SpeechPackService
}): () => void {
  const channels = [IPC.speechPackState, IPC.speechPackAction] as const
  const cleanups = channels.map((channel) => {
    options.ipcMain.removeHandler(channel)
    return channel
  })
  options.ipcMain.handle(IPC.speechPackState, (event) => {
    options.assertMainWindow(event)
    return options.service.snapshot()
  })
  options.ipcMain.handle(IPC.speechPackAction, (event, request) => {
    options.assertMainWindow(event)
    return options.service.action(request)
  })
  const unsubscribe = options.service.subscribe(options.sendProgress)
  return () => {
    unsubscribe()
    for (const channel of cleanups) options.ipcMain.removeHandler(channel)
  }
}
