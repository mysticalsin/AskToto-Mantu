import { EventEmitter } from 'node:events'
import { expect, vi } from 'vitest'
import type { CloudSpeechStartRequest } from '@shared/cloud-speech'
import type { SpeechBrokerClient, SpeechTrack } from '../cloud-stt/broker-client'
import { registerCloudSpeechIpc, type CloudSpeechMainAuthority } from '../ipc/cloud-speech-ipc'
import type { CloudSpeechIpcOptions } from '../ipc/cloud-speech-ipc-support'

type Handler = (event: unknown, ...args: unknown[]) => unknown
export type FakeBrokerClient = Pick<SpeechBrokerClient, 'capability' | 'cancel' | 'status' | 'createSession'>

export const FAKE_ROUTE = {
  engine: 'deepgram-nova3' as const,
  routeId: 'deepgram-via-gateway' as const,
  modelId: 'nova-3' as const
}

export const FAKE_CAPTURE_ID = 'b8ff8685-725b-40e0-a8ef-f343bb10b64f'

export const fakeStartRequest: CloudSpeechStartRequest = {
  captureId: FAKE_CAPTURE_ID,
  capture: {
    generation: 7,
    engine: 'deepgram-nova3',
    requestedTracks: ['microphone'],
    capturedTracks: ['microphone']
  },
  language: 'en-US',
  consent: { accepted: true, disclosureVersion: 'cloud-speech-v1' }
}

export function createdSession(opts: { sessionId: string; streamEpoch: number; wallNow: number }) {
  const { sessionId, streamEpoch, wallNow } = opts
  return {
    ok: true as const,
    value: {
      ok: true as const,
      protocolVersion: 1 as const,
      sessionId,
      routeId: FAKE_ROUTE.routeId,
      model: FAKE_ROUTE.modelId,
      configVersion: 'config-r1',
      policyVersion: 'policy-r1',
      language: 'en-US',
      captureGeneration: 7,
      grantExpiresAt: wallNow + 60_000,
      leaseExpiresAt: wallNow + 60_000,
      limits: {
        maxStreamMs: 60_000,
        drainWindowMs: 5_000,
        maxInputBytesPerTrack: 1_920_000,
        maxClientFrameBytes: 3_200,
        maxOutputBytesPerTrack: 1_048_576,
        audioDeadlineAt: wallNow + 60_000
      },
      grants: [{ track: 'microphone' as const, streamEpoch, token: 'A'.repeat(43) }]
    }
  } satisfies Awaited<ReturnType<SpeechBrokerClient['createSession']>>
}

export function readyCapability(wallNow: number) {
  return {
    ok: true as const,
    value: {
      ok: true as const,
      protocolVersion: 1 as const,
      selected: { routeId: FAKE_ROUTE.routeId, modelId: FAKE_ROUTE.modelId },
      allowed: [{ routeId: FAKE_ROUTE.routeId, modelId: FAKE_ROUTE.modelId }],
      ready: true as const,
      routeId: FAKE_ROUTE.routeId,
      modelId: FAKE_ROUTE.modelId,
      configVersion: 'config-r1',
      policyVersion: 'policy-r1',
      languages: ['multi', 'en-US'],
      format: { encoding: 'pcm_s16le' as const, sampleRate: 16_000 as const, channels: 1 as const },
      validUntil: wallNow + 60_000,
      limits: {
        maxStreamMs: 60_000,
        drainWindowMs: 5_000,
        maxInputBytesPerTrack: 1_920_000,
        maxClientFrameBytes: 3_200,
        maxOutputBytesPerTrack: 1_048_576
      }
    }
  } as unknown as Awaited<ReturnType<FakeBrokerClient['capability']>>
}

export function readyRelay(
  sessionId: string,
  trackDefinitions: Array<{ track: SpeechTrack; streamEpoch: number }>,
  wallNow: number,
  /** The last transcript sequence this session delivered; its finish terminal must report exactly that frontier. */
  lastSequence = 0
) {
  return {
    identity: {
      sessionId,
      captureGeneration: fakeStartRequest.capture.generation,
      routeId: FAKE_ROUTE.routeId,
      model: FAKE_ROUTE.modelId,
      language: fakeStartRequest.language,
      configVersion: 'config-r1',
      policyVersion: 'policy-r1',
      audioDeadlineAt: wallNow + 60_000,
      limits: {
        maxStreamMs: 60_000,
        drainWindowMs: 5_000,
        maxInputBytesPerTrack: 1_920_000,
        maxClientFrameBytes: 3_200,
        maxOutputBytesPerTrack: 1_048_576
      },
      tracks: trackDefinitions
    },
    pushFrame: vi.fn(() => ({ ok: true as const })),
    finish: vi.fn(async () => ({
      complete: true,
      reason: 'normal' as const,
      tracks: trackDefinitions.map((track) => ({
        ...track,
        closeConfirmed: true,
        tail: 'complete' as const,
        lastSequence,
        reason: 'normal' as const
      }))
    })),
    cancel: vi.fn(async (): Promise<void> => undefined)
  }
}

export function captureClock(wallStart = 1_700_000_000_000, monotonicStart = 0) {
  let wallNow = wallStart
  let monotonicNow = monotonicStart
  const tasks: Array<{ dueAt: number; active: boolean; callback: () => void }> = []
  const pendingAt = (dueAt: number) => tasks.filter((task) => task.active && task.dueAt === dueAt)
  const advanceTo = (executedAt: number) => {
    expect(executedAt).toBeGreaterThanOrEqual(monotonicNow)
    monotonicNow = executedAt
    wallNow = wallStart + Math.floor(executedAt - monotonicStart)
  }
  return {
    wallNow: () => wallNow,
    monotonicNow: () => monotonicNow,
    advanceTo,
    pendingAt,
    schedule: (callback: () => void, delayMs: number) => {
      const task = { dueAt: monotonicNow + delayMs, active: true, callback }
      tasks.push(task)
      return () => {
        task.active = false
      }
    },
    runAt: (dueAt: number, executedAt = dueAt) => {
      const matching = pendingAt(dueAt)
      expect(matching).toHaveLength(1)
      expect(executedAt).toBeGreaterThanOrEqual(dueAt)
      const task = matching[0]!
      advanceTo(executedAt)
      task.active = false
      task.callback()
    }
  }
}

export function createFakeBrokerHarness(opts: {
  clock: ReturnType<typeof captureClock>
  listenStartedAt: number
  onSegmentDelivered?: CloudSpeechIpcOptions['onSegmentDelivered']
}) {
  const { clock, listenStartedAt, onSegmentDelivered } = opts
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
  const mainFrame = { url: 'app://index.html', processId: 11, routingId: 2, parent: null }
  const sender = Object.assign(new EventEmitter(), {
    mainFrame,
    isDestroyed: () => false,
    getURL: () => mainFrame.url,
    send: vi.fn()
  })
  const event = { sender, senderFrame: mainFrame } as never
  const authority = {
    enabled: true,
    authenticated: true,
    captureAllowed: true,
    policyReady: true,
    selectedEngine: 'deepgram-nova3',
    allowedEngines: ['deepgram-nova3'],
    allowedLanguages: ['multi', 'en-US'],
    credentials: {
      operatorUrl: 'https://operator.example',
      operatorLicenseToken: 'METIS-OP-1.test',
      deviceIdHash: 'device-hash'
    },
    credentialRevision: 'credential-r1',
    policyRevision: 'policy-r1',
    egressAllowlist: ['operator.example'],
    captureContext: { webContents: sender, frame: mainFrame, navigationEpoch: 1, listenStartedAt },
    finishAllowed: true
  } as unknown as CloudSpeechMainAuthority
  const client: FakeBrokerClient = {
    capability: vi.fn(async () => readyCapability(clock.wallNow())),
    cancel: vi.fn(async () => ({
      ok: true as const,
      value: {
        ok: true as const,
        protocolVersion: 1 as const,
        sessionId: '93d23d44-347e-490c-841b-0ff31facbc7e',
        cancelled: true,
        cancellationRequested: true
      }
    })),
    status: vi.fn(async () => ({ ok: false as const, code: 'TRANSPORT' as const })),
    createSession: vi.fn(async () => ({ ok: false as const, code: 'TRANSPORT' as const }))
  }
  const readAuthority = vi.fn(() => authority)
  const registered = registerCloudSpeechIpc({
    ipcMain: ipcMain as never,
    assertMainWindow: vi.fn(() => true) as never,
    readAuthority,
    clientFactory: vi.fn(() => client as SpeechBrokerClient),
    now: clock.wallNow,
    monotonicNow: clock.monotonicNow,
    scheduleCaptureDeadline: clock.schedule,
    ...(onSegmentDelivered ? { onSegmentDelivered } : {})
  })
  const invoke = async (channel: string, args: unknown[] = [], callerEvent: unknown = event) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`No IPC handler registered for ${channel}`)
    return handler(callerEvent, ...args)
  }
  return { handlers, event, mainFrame, sender, client, readAuthority, registered, invoke }
}

export type FakeBrokerHarness = ReturnType<typeof createFakeBrokerHarness>

export async function rotationReceipt(
  h: FakeBrokerHarness,
  stage: 'closed' | 'opened',
  previousEpoch: number
): Promise<Record<string, unknown>> {
  return vi.waitFor(() => {
    const events = h.sender.send.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter(
        (event) =>
          event.type === 'epoch-transition' &&
          event.stage === stage &&
          (event.streams as Array<{ previousEpoch: number }>).some((stream) => stream.previousEpoch === previousEpoch)
      )
    expect(events).toHaveLength(1)
    return events[0]!
  })
}
