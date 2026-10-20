import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import { z } from 'zod'
import {
  CLOUD_SPEECH_DISCLOSURE_VERSION,
  CLOUD_SPEECH_IPC,
  CloudSpeechEventSchema,
  type CloudSpeechCapability,
  type CloudSpeechEngine,
  type CloudSpeechFailure,
  type CloudSpeechRouteSelection,
  type CloudSpeechStartRequest
} from '@shared/cloud-speech'
import { SpeechBrokerClient, type SpeechBrokerClientOptions, type SpeechTrack } from '../cloud-stt/broker-client'
import type { RelaySpeechSession } from '../cloud-stt/relay-session'
import type { MainSpeechCaptureSession } from '../cloud-stt/capture-session'
import type { CaptureDeadlineScheduler } from '../infra/scheduler/capture-deadline'
import { hostAllowed } from '../net/egress-policy'

export const TRACKS: readonly SpeechTrack[] = ['microphone', 'system']
export const ROUTES: Record<
  CloudSpeechEngine,
  { routeId: 'deepgram-via-gateway' | 'workers-ai-nova3'; modelId: 'nova-3' | '@cf/deepgram/nova-3' }
> = {
  'deepgram-nova3': { routeId: 'deepgram-via-gateway', modelId: 'nova-3' },
  'cloudflare-nova3': { routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3' }
}
export const IPC_CHANNELS = Object.values(CLOUD_SPEECH_IPC)
export const identityKey = (captureId: string, generation: number): string => `${captureId}:${generation}`
export const identityOf = (
  owner: Pick<Owner, 'captureId' | 'generation'>
): { captureId: string; captureGeneration: number } => ({
  captureId: owner.captureId,
  captureGeneration: owner.generation
})

export function createIpcHandlerRegistrar(ipcMain: SpeechIpcMain) {
  const registered: string[] = []
  for (const channel of IPC_CHANNELS) {
    try {
      ipcMain.removeHandler(channel)
    } catch {
      /* first registration */
    }
  }
  return (channel: string, handler: (event: SpeechIpcEvent, payload?: unknown) => unknown): void => {
    try {
      ipcMain.handle(channel, (event, payload) => handler(event, payload))
      registered.push(channel)
    } catch (error) {
      for (const previous of registered) {
        try {
          ipcMain.removeHandler(previous)
        } catch {
          /* keep cleaning the rest of this partially registered adapter */
        }
      }
      throw error
    }
  }
}

export type SpeechIpcMain = Pick<IpcMain, 'handle' | 'removeHandler'>
export type SpeechIpcEvent = IpcMainInvokeEvent
export type Authority = {
  enabled: boolean
  authenticated: boolean
  captureAllowed: boolean
  policyReady: boolean
  selectedEngine: CloudSpeechEngine | null
  allowedEngines: readonly CloudSpeechEngine[]
  allowedLanguages: readonly string[]
  credentials: SpeechBrokerClientOptions | null
  credentialRevision: string
  policyRevision: string
  egressAllowlist: readonly string[] | null
  captureContext?: {
    webContents: object
    frame: object
    navigationEpoch: number
    listenStartedAt: number
  } | null
  finishAllowed?: boolean
}
export type FrameBinding = {
  sender: WebContents
  frame: WebFrameMain
  processId: number
  routingId: number
  frameUrl: string
  senderUrl: string
}
export type OwnerPhase = 'starting' | 'active' | 'rotating' | 'finishing' | 'cancelled' | 'closed'
export type SpeechAllocation = { attempted: boolean; sessionId: string | null }
export type Owner = {
  binding: FrameBinding
  captureId: string
  generation: number
  engine: CloudSpeechEngine
  tracks: SpeechTrack[]
  authorityRevision: string
  captureContext: {
    webContents: object
    frame: object
    navigationEpoch: number
    listenStartedAt: number
  } | null
  client: SpeechBrokerClient | null
  captureSession: MainSpeechCaptureSession | null
  phase: OwnerPhase
  primaryAllocation: SpeechAllocation
  session: RelaySpeechSession | null
  candidateSession: RelaySpeechSession | null
  finishPromise: Promise<unknown> | null
  finishCheckpoint: string | null
  frontier: Map<SpeechTrack, { nextSequence: number; nextSampleOffset: number | null }>
  sealedTracks: Set<SpeechTrack>
  eventFrontier: Map<string, number>
  outputIntegrityFailure: boolean
  event: SpeechIpcEvent
  request: CloudSpeechStartRequest
  startSettled: boolean
  pendingEvents: Array<z.infer<typeof CloudSpeechEventSchema>>
  pendingEventBytes: number
  eventOverflow: boolean
  closureConfirmed: boolean | null
  finishContextReleased: boolean
  rotationPromise: Promise<void> | null
  rotationAbort: AbortController | null
  cancelRotationSchedule: (() => void) | null
  cancelCeilingSchedule: (() => void) | null
  ceilingRequested: boolean
  ceilingAcked: boolean
  ceilingFrameDeadlineAt: number | null
  preflightBinding: { configVersion: string; policyVersion: string } | null
  targetLanguage: string | null
  rotationDeadlineAt: number | null
  candidateAllocation: SpeechAllocation | null
  candidatePendingEvents: Array<z.infer<typeof CloudSpeechEventSchema>>
  candidateEventBytes: number
  candidateEventFrontier: Map<string, number>
  finishAfterRotation: import('../../shared/cloud-speech').CloudSpeechFinishRequest | null
}

export type CloudSpeechMainAuthority = Authority
export type CloudSpeechIpcOptions = {
  ipcMain: SpeechIpcMain
  assertMainWindow: (event: SpeechIpcEvent) => void
  /** Synchronous, main-owned snapshot. `captureAllowed` is admission only, never part of stable authority. */
  readAuthority: (
    event: SpeechIpcEvent,
    request?: CloudSpeechStartRequest,
    captureOwner?: object
  ) => CloudSpeechMainAuthority
  /** Release the exact Listen finish reservation only after main confirms cleanup. */
  releaseCaptureOwner?: (captureOwner: object) => void
  /** Refresh cached async speech metadata only at explicit capability/start boundaries. */
  prepareAuthority?: (event: SpeechIpcEvent, request?: CloudSpeechStartRequest) => Promise<void>
  monotonicNow?: () => number
  scheduleCaptureDeadline?: CaptureDeadlineScheduler
  clientFactory?: (credentials: SpeechBrokerClientOptions) => SpeechBrokerClient
  now?: () => number
  /** Observes each segment event after it was delivered to the owning renderer. Must not throw. */
  onSegmentDelivered?: (owner: Owner, event: z.infer<typeof CloudSpeechEventSchema>) => void
  /**
   * Observes each user language change request once its capture owner resolved, with the settled outcome. Carries no
   * language value. Must not throw.
   */
  onLanguageChange?: (owner: Owner, outcome: LanguageChangeOutcome) => void
}

export type LanguageChangeOutcome = { ok: true; changed: boolean } | { ok: false; code: CloudSpeechFailure['code'] }

const PositiveRevision = z.string().min(1).max(256)

export function routeFor(engine: CloudSpeechEngine): CloudSpeechRouteSelection {
  return { engine, ...ROUTES[engine] }
}

export function authorityRevision(authority: Authority): string | null {
  const credential = authority.credentials
  if (
    !credential ||
    !PositiveRevision.safeParse(authority.credentialRevision).success ||
    !PositiveRevision.safeParse(authority.policyRevision).success ||
    !authority.selectedEngine ||
    !Array.isArray(authority.allowedEngines) ||
    !Array.isArray(authority.allowedLanguages) ||
    (authority.egressAllowlist !== null && !Array.isArray(authority.egressAllowlist))
  )
    return null
  try {
    const url = new URL(credential.operatorUrl)
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !credential.operatorLicenseToken ||
      !credential.deviceIdHash ||
      !hostAllowed(url.hostname, authority.egressAllowlist)
    )
      return null
    return JSON.stringify([
      authority.credentialRevision,
      authority.policyRevision,
      authority.selectedEngine,
      [...authority.allowedEngines].sort(),
      [...authority.allowedLanguages].sort(),
      url.origin,
      credential.operatorLicenseToken,
      credential.deviceIdHash,
      authority.egressAllowlist === null ? null : [...authority.egressAllowlist].sort()
    ])
  } catch {
    return null
  }
}

export function failure(
  code: CloudSpeechFailure['code'],
  identity?: { captureId: string; captureGeneration: number }
): CloudSpeechFailure {
  return identity ? { ok: false, code, ...identity } : { ok: false, code }
}

export function refusedCapability(refusal: NonNullable<CloudSpeechCapability['refusal']>): CloudSpeechCapability {
  return {
    disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION,
    selected: null,
    allowed: [],
    ready: false,
    refusal
  }
}

export function toSafeCapability(
  authority: Authority,
  broker: Awaited<ReturnType<SpeechBrokerClient['capability']>> | null,
  currentTime = Date.now()
): CloudSpeechCapability {
  if (!authority.enabled)
    return {
      disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION,
      selected: null,
      allowed: [],
      ready: false,
      refusal: 'DISABLED'
    }
  if (!authority.authenticated)
    return {
      disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION,
      selected: null,
      allowed: [],
      ready: false,
      refusal: 'AUTH'
    }
  if (!authority.policyReady || authorityRevision(authority) === null)
    return {
      disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION,
      selected: null,
      allowed: [],
      ready: false,
      refusal: 'POLICY'
    }
  if (!broker?.ok || !broker.value.ready) {
    return {
      disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION,
      selected: null,
      allowed: [],
      ready: false,
      refusal: broker?.ok ? 'NOT_READY' : 'TRANSPORT'
    }
  }
  const allowed = authority.allowedEngines
    .filter((engine) =>
      broker.value.allowed.some(
        (route) => route.routeId === ROUTES[engine].routeId && route.modelId === ROUTES[engine].modelId
      )
    )
    .map(routeFor)
  const selected =
    authority.selectedEngine && allowed.some((route) => route.engine === authority.selectedEngine)
      ? routeFor(authority.selectedEngine)
      : null
  const ready =
    selected !== null &&
    broker.value.routeId === selected.routeId &&
    broker.value.modelId === selected.modelId &&
    broker.value.selected.routeId === selected.routeId &&
    broker.value.selected.modelId === selected.modelId &&
    Number.isSafeInteger(broker.value.validUntil) &&
    broker.value.validUntil > currentTime
  return {
    disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION,
    selected,
    allowed,
    ready,
    refusal: ready ? null : 'NOT_READY'
  }
}

export function getBinding(
  event: SpeechIpcEvent,
  assertMainWindow: (event: SpeechIpcEvent) => void
): FrameBinding | null {
  try {
    assertMainWindow(event)
    const sender = event.sender
    const frame = event.senderFrame
    const mainFrame = sender.mainFrame
    if (
      sender.isDestroyed() ||
      !frame ||
      frame !== mainFrame ||
      frame.parent !== null ||
      frame.processId !== mainFrame.processId ||
      frame.routingId !== mainFrame.routingId ||
      frame.url !== sender.getURL()
    )
      return null
    return {
      sender,
      frame,
      processId: frame.processId,
      routingId: frame.routingId,
      frameUrl: frame.url,
      senderUrl: sender.getURL()
    }
  } catch {
    return null
  }
}

export function sameBinding(binding: FrameBinding): boolean {
  try {
    return (
      !binding.sender.isDestroyed() &&
      binding.sender.mainFrame === binding.frame &&
      binding.frame.parent === null &&
      binding.frame.processId === binding.processId &&
      binding.frame.routingId === binding.routingId &&
      binding.frame.url === binding.frameUrl &&
      binding.sender.getURL() === binding.senderUrl &&
      binding.frame.url === binding.senderUrl
    )
  } catch {
    return false
  }
}

export function mapBrokerFailure(code: string): CloudSpeechFailure['code'] {
  if (code === 'AUTH') return 'AUTH'
  if (code === 'CONFIG') return 'NOT_CONFIGURED'
  if (code === 'REFUSED') return 'NOT_READY'
  if (code === 'SCHEMA') return 'POLICY'
  return 'TRANSPORT'
}

export type CapabilityBinding = {
  routeId: 'deepgram-via-gateway' | 'workers-ai-nova3'
  modelId: 'nova-3' | '@cf/deepgram/nova-3'
  language: string
  configVersion: string
  policyVersion: string
}
export type SpeechAllocationSlot = SpeechAllocation

export function capabilityBinding(value: unknown, language: string): CapabilityBinding | null {
  if (typeof value !== 'object' || value === null) return null
  try {
    const routeId = Reflect.get(value, 'routeId')
    const modelId = Reflect.get(value, 'modelId')
    const configVersion = Reflect.get(value, 'configVersion')
    const policyVersion = Reflect.get(value, 'policyVersion')
    if (
      (routeId !== 'deepgram-via-gateway' && routeId !== 'workers-ai-nova3') ||
      (modelId !== 'nova-3' && modelId !== '@cf/deepgram/nova-3') ||
      typeof configVersion !== 'string' ||
      configVersion.length < 1 ||
      configVersion.length > 128 ||
      typeof policyVersion !== 'string' ||
      policyVersion.length < 1 ||
      policyVersion.length > 128
    )
      return null
    return { routeId, modelId, language, configVersion, policyVersion }
  } catch {
    return null
  }
}

export function bindCreateToCapability(
  client: SpeechBrokerClient,
  /** A getter is read at each allocation, so a main-approved language change re-binds later renewals. */
  expected: CapabilityBinding | (() => CapabilityBinding),
  onAllocated: (sessionId: string, slot: SpeechAllocationSlot) => void,
  beginAttempt: () => SpeechAllocationSlot = () => ({ attempted: false, sessionId: null })
): SpeechBrokerClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'createSession') {
        return async (request: unknown, operation?: import('../cloud-stt/broker-client').SpeechBrokerOperation) => {
          const slot = beginAttempt()
          slot.attempted = true
          const created = await target.createSession(request, operation)
          if (!created.ok) return created
          const value = created.value
          slot.sessionId = value.sessionId
          onAllocated(value.sessionId, slot)
          const want = typeof expected === 'function' ? expected() : expected
          if (
            value.routeId !== want.routeId ||
            value.model !== want.modelId ||
            value.language !== want.language ||
            value.configVersion !== want.configVersion ||
            value.policyVersion !== want.policyVersion
          ) {
            await target.cancel(value.sessionId, 1_000).catch(() => undefined)
            return { ok: false as const, code: 'SCHEMA' as const }
          }
          return created
        }
      }
      const member = Reflect.get(target, property, target) as unknown
      return typeof member === 'function' ? member.bind(target) : member
    }
  })
}

export function validTrackList(value: readonly SpeechTrack[]): boolean {
  return (
    value.length > 0 &&
    value.length <= 2 &&
    new Set(value).size === value.length &&
    value.every((track) => TRACKS.includes(track))
  )
}

export function mapClosureReason(
  reason: string
):
  | 'normal'
  | 'cancelled'
  | 'lease-expired'
  | 'upstream-error'
  | 'client-disconnected'
  | 'limit'
  | 'revoked'
  | 'unknown' {
  return reason === 'normal' ||
    reason === 'cancelled' ||
    reason === 'lease-expired' ||
    reason === 'upstream-error' ||
    reason === 'client-disconnected' ||
    reason === 'limit' ||
    reason === 'revoked'
    ? reason
    : 'unknown'
}
