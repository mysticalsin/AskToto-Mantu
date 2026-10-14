import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_SPEECH_IPC, type CloudSpeechStartRequest } from '@shared/cloud-speech'
import type { SpeechBrokerClient, SpeechTrack } from '../cloud-stt/broker-client'

const relayHarness = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../cloud-stt/relay-session', () => ({ RelaySpeechSession: { create: relayHarness.create } }))

import { registerCloudSpeechIpc, type CloudSpeechMainAuthority } from './cloud-speech-ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown
type FakeClient = Pick<SpeechBrokerClient, 'capability' | 'cancel' | 'status' | 'createSession'>

const routeA = {
  engine: 'deepgram-nova3' as const,
  routeId: 'deepgram-via-gateway' as const,
  modelId: 'nova-3' as const
}
const captureId = 'b8ff8685-725b-40e0-a8ef-f343bb10b64f'
const otherCaptureId = '7f61720f-67ac-4cb7-9ce2-8ac744f6c681'
const request: CloudSpeechStartRequest = {
  captureId,
  capture: {
    generation: 7,
    engine: 'deepgram-nova3',
    requestedTracks: ['microphone'],
    capturedTracks: ['microphone']
  },
  language: 'en-US',
  consent: { accepted: true, disclosureVersion: 'cloud-speech-v1' }
}

function createdSession(configVersion = 'config-r1', policyVersion = 'policy-r1') {
  return {
    ok: true as const,
    value: {
      ok: true as const,
      protocolVersion: 1 as const,
      sessionId: '93d23d44-347e-490c-841b-0ff31facbc7e',
      routeId: routeA.routeId,
      model: routeA.modelId,
      configVersion,
      policyVersion,
      language: 'en-US',
      captureGeneration: 7,
      grantExpiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 60_000,
      limits: {
        maxStreamMs: 60_000,
        drainWindowMs: 5_000,
        maxInputBytesPerTrack: 1_920_000,
        maxClientFrameBytes: 3_200,
        maxOutputBytesPerTrack: 1_048_576,
        audioDeadlineAt: Date.now() + 60_000
      },
      grants: [{ track: 'microphone' as const, streamEpoch: 3, token: 'A'.repeat(43) }]
    }
  } as unknown as Awaited<ReturnType<SpeechBrokerClient['createSession']>>
}

function readyCapability() {
  return {
    ok: true as const,
    value: {
      ok: true as const,
      protocolVersion: 1 as const,
      selected: { routeId: routeA.routeId, modelId: routeA.modelId },
      allowed: [{ routeId: routeA.routeId, modelId: routeA.modelId }],
      ready: true as const,
      routeId: routeA.routeId,
      modelId: routeA.modelId,
      configVersion: 'config-r1',
      policyVersion: 'policy-r1',
      languages: ['multi', 'en-US'],
      format: { encoding: 'pcm_s16le' as const, sampleRate: 16_000 as const, channels: 1 as const },
      validUntil: Date.now() + 60_000,
      limits: {
        maxStreamMs: 60_000,
        drainWindowMs: 5_000,
        maxInputBytesPerTrack: 1_920_000,
        maxClientFrameBytes: 3_200,
        maxOutputBytesPerTrack: 1_048_576
      }
    }
  } as unknown as Awaited<ReturnType<FakeClient['capability']>>
}

function makeHarness(
  now?: () => number,
  prepareAuthority?: () => Promise<void>,
  scheduleCaptureDeadline?: (callback: () => void, delayMs: number) => () => void,
  releaseCaptureOwner?: (owner: object) => void
) {
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
  const authority: CloudSpeechMainAuthority = {
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
    egressAllowlist: ['operator.example']
  }
  const currentAuthority = { value: authority }
  const client: FakeClient = {
    capability: vi.fn(async () => readyCapability()),
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
  const assertMainWindow = vi.fn(() => true)
  const readAuthority = vi.fn(() => currentAuthority.value)
  const clientFactory = vi.fn(() => client as SpeechBrokerClient)
  const registered = registerCloudSpeechIpc({
    ipcMain: ipcMain as never,
    assertMainWindow,
    readAuthority,
    ...(releaseCaptureOwner ? { releaseCaptureOwner } : {}),
    clientFactory,
    ...(prepareAuthority ? { prepareAuthority } : {}),
    ...(scheduleCaptureDeadline ? { scheduleCaptureDeadline } : {}),
    ...(now ? { now } : {})
  })
  const invoke = (channel: string, args: unknown[] = [], callerEvent: unknown = event) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`No IPC handler registered for ${channel}`)
    return handler(callerEvent, ...args)
  }
  return {
    handlers,
    ipcMain,
    event,
    mainFrame,
    sender,
    currentAuthority,
    client,
    assertMainWindow,
    readAuthority,
    clientFactory,
    registered,
    invoke
  }
}

function readyRelay(
  sessionId = '93d23d44-347e-490c-841b-0ff31facbc7e',
  trackDefinitions: Array<{ track: SpeechTrack; streamEpoch: number }> = [{ track: 'microphone', streamEpoch: 3 }],
  finalEventSequence = 0
) {
  const session = {
    identity: {
      sessionId,
      captureGeneration: request.capture.generation,
      routeId: routeA.routeId,
      model: routeA.modelId,
      language: request.language,
      configVersion: 'config-r1',
      policyVersion: 'policy-r1',
      audioDeadlineAt: Date.now() + 60_000,
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
        lastSequence: finalEventSequence,
        reason: 'normal' as const
      }))
    })),
    cancel: vi.fn(async (): Promise<void> => undefined)
  }
  return session
}

afterEach(() => relayHarness.create.mockReset())

describe('cloud speech main IPC authority boundary', () => {
  it('refuses subframes before reading authority or touching credentials', async () => {
    const h = makeHarness()
    const childFrame = { ...h.mainFrame, routingId: 3, parent: h.mainFrame }
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.capability, [], { sender: h.sender, senderFrame: childFrame })
    ).resolves.toMatchObject({
      ready: false,
      refusal: 'AUTH'
    })
    expect(h.assertMainWindow).toHaveBeenCalledTimes(1)
    expect(h.readAuthority).not.toHaveBeenCalled()
    expect(h.clientFactory).not.toHaveBeenCalled()
  })

  it.each([
    ['expired', 4_999, false],
    ['at the expiry boundary', 5_000, false],
    ['one millisecond before expiry', 5_001, true]
  ])('does not report a broker capability ready when it is %s', async (_label, validUntil, ready) => {
    const h = makeHarness(() => 5_000)
    const capability = readyCapability()
    if (!capability.ok) throw new Error('test fixture must be ready')
    h.client.capability = vi.fn(async () => ({
      ...capability,
      value: { ...capability.value, validUntil }
    })) as FakeClient['capability']
    await expect(h.invoke(CLOUD_SPEECH_IPC.capability)).resolves.toMatchObject(
      ready ? { ready: true, refusal: null } : { ready: false, refusal: 'NOT_READY' }
    )
  })

  it('installs a cancellable start owner before awaiting capability and never creates after cancellation', async () => {
    const h = makeHarness()
    let resolveCapability!: (value: Awaited<ReturnType<FakeClient['capability']>>) => void
    h.client.capability = vi.fn(
      () => new Promise((resolve) => (resolveCapability = resolve))
    ) as FakeClient['capability']
    const starting = h.invoke(CLOUD_SPEECH_IPC.start, [request]) as Promise<unknown>
    await vi.waitFor(() => expect(h.client.capability).toHaveBeenCalledTimes(1))

    await expect(h.invoke(CLOUD_SPEECH_IPC.cancel, [{ captureId, captureGeneration: 7 }])).resolves.toMatchObject({
      ok: true,
      captureId,
      captureGeneration: 7,
      closure: 'unknown'
    })
    resolveCapability({ ok: false, code: 'TRANSPORT' })
    await expect(starting).resolves.toMatchObject({ ok: false, code: 'CLOSED', captureId, captureGeneration: 7 })
    expect(relayHarness.create).not.toHaveBeenCalled()
    expect(h.client.cancel).not.toHaveBeenCalledWith(expect.anything())
  })

  it('keeps the exact start owner reserved while cached authority preparation is pending', async () => {
    let releasePreparation!: () => void
    const prepareAuthority = vi.fn(() => new Promise<void>((resolve) => (releasePreparation = resolve)))
    const h = makeHarness(undefined, prepareAuthority)
    const starting = h.invoke(CLOUD_SPEECH_IPC.start, [request]) as Promise<unknown>
    await vi.waitFor(() => expect(prepareAuthority).toHaveBeenCalledTimes(1))
    expect(h.readAuthority).not.toHaveBeenCalled()

    await expect(h.invoke(CLOUD_SPEECH_IPC.cancel, [{ captureId, captureGeneration: 7 }])).resolves.toMatchObject({
      ok: true,
      closure: 'unknown'
    })
    releasePreparation()
    await expect(starting).resolves.toMatchObject({ ok: false, code: 'CLOSED', captureId, captureGeneration: 7 })
    expect(h.readAuthority).not.toHaveBeenCalled()
    expect(h.client.capability).not.toHaveBeenCalled()
    expect(relayHarness.create).not.toHaveBeenCalled()
  })

  it('binds create to the selected route, actual tracks, approved language and main-stamped consent', async () => {
    const h = makeHarness()
    const session = readyRelay()
    relayHarness.create.mockImplementation(async (options: { onAllocated?: (id: string) => void }) => {
      options.onAllocated?.(session.identity.sessionId)
      return { ok: true, value: session }
    })
    const result = (await h.invoke(CLOUD_SPEECH_IPC.start, [request])) as Record<string, unknown>
    expect(result).toMatchObject({
      ok: true,
      captureId,
      captureGeneration: 7,
      engine: 'deepgram-nova3',
      streams: [{ track: 'microphone', streamEpoch: 3 }]
    })
    expect(JSON.stringify(result)).not.toContain(session.identity.sessionId)
    expect(relayHarness.create).toHaveBeenCalledTimes(1)
    const options = relayHarness.create.mock.calls[0]?.[0] as {
      createRequest: Record<string, unknown>
      expectedSelection: Record<string, unknown>
      expectedCapability: Record<string, unknown>
      client: SpeechBrokerClient
      isCurrent: () => boolean
    }
    expect(options.createRequest).toMatchObject({
      operation: 'create-session',
      captureGeneration: 7,
      tracks: ['microphone'],
      language: 'en-US'
    })
    expect(options.createRequest.consent).toMatchObject({
      accepted: true,
      captureGeneration: 7,
      tracks: ['microphone']
    })
    expect(options.expectedSelection).toEqual({ routeId: routeA.routeId, modelId: routeA.modelId, language: 'en-US' })
    expect(options.expectedCapability).toEqual({ configVersion: 'config-r1', policyVersion: 'policy-r1' })
    expect(options.isCurrent()).toBe(true)
    expect(h.clientFactory).toHaveBeenCalledTimes(1)
  })

  it('buffers early relay results until the exact Start has passed ownership validation', async () => {
    const h = makeHarness()
    const session = readyRelay()
    relayHarness.create.mockImplementation(
      async (options: {
        onAllocated?: (id: string) => void
        onTranscript?: (event: unknown, context: unknown) => void
      }) => {
        options.onAllocated?.(session.identity.sessionId)
        options.onTranscript?.(
          {
            protocolVersion: 1,
            sessionId: session.identity.sessionId,
            captureGeneration: 7,
            track: 'microphone',
            streamEpoch: 3,
            type: 'transcript',
            sequence: 1,
            segmentIndex: 1,
            revision: 1,
            text: 'early result',
            startMs: 0,
            endMs: 50,
            final: false
          },
          { timeBase: 'stream', firstCaptureSampleOffset: 0 }
        )
        expect(h.sender.send).not.toHaveBeenCalled()
        return { ok: true, value: session }
      }
    )
    await h.invoke(CLOUD_SPEECH_IPC.start, [request])
    expect(h.sender.send).toHaveBeenCalledTimes(1)
    expect(h.sender.send).toHaveBeenCalledWith(
      CLOUD_SPEECH_IPC.event,
      expect.objectContaining({ type: 'segment', captureId, captureGeneration: 7 })
    )
  })

  it('keeps transcript and terminal sequences independent for interleaved tracks', async () => {
    const h = makeHarness()
    const twoTrackRequest: CloudSpeechStartRequest = {
      ...request,
      capture: {
        ...request.capture,
        requestedTracks: ['microphone', 'system'],
        capturedTracks: ['microphone', 'system']
      }
    }
    const session = readyRelay(
      '93d23d44-347e-490c-841b-0ff31facbc7e',
      [
        { track: 'microphone', streamEpoch: 3 },
        { track: 'system', streamEpoch: 4 }
      ],
      1
    )
    relayHarness.create.mockImplementation(
      async (options: {
        onAllocated?: (id: string) => void
        onTranscript?: (event: unknown, context: unknown) => void
      }) => {
        options.onAllocated?.(session.identity.sessionId)
        for (const [track, epoch] of [
          ['microphone', 3],
          ['system', 4]
        ] as const) {
          options.onTranscript?.(
            {
              protocolVersion: 1,
              sessionId: session.identity.sessionId,
              captureGeneration: 7,
              track,
              streamEpoch: epoch,
              type: 'transcript',
              sequence: 1,
              segmentIndex: 1,
              revision: 1,
              text: 'track result',
              startMs: 0,
              endMs: 50,
              final: true
            },
            { timeBase: 'stream', firstCaptureSampleOffset: 0 }
          )
        }
        return { ok: true, value: session }
      }
    )
    await expect(h.invoke(CLOUD_SPEECH_IPC.start, [twoTrackRequest])).resolves.toMatchObject({ ok: true })
    const transcripts = h.sender.send.mock.calls.map((call) => call[1] as { type: string; sequence?: number })
    expect(transcripts.map(({ sequence }) => sequence)).toEqual([1, 1])

    for (const track of ['microphone', 'system'] as const) {
      await expect(
        h.invoke(CLOUD_SPEECH_IPC.frame, [
          {
            captureId,
            captureGeneration: 7,
            track,
            sequence: 1,
            sampleOffset: 0,
            kind: 'full',
            pcm16le: new ArrayBuffer(3_200)
          }
        ])
      ).resolves.toMatchObject({ ok: true, nextSequence: 2 })
    }
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.finish, [
        {
          captureId,
          captureGeneration: 7,
          tracks: [
            { track: 'microphone', finalSequence: 1, finalSampleOffset: 1_600 },
            { track: 'system', finalSequence: 1, finalSampleOffset: 1_600 }
          ]
        }
      ])
    ).resolves.toMatchObject({ ok: true, complete: true })
    const terminals = h.sender.send.mock.calls
      .map((call) => call[1] as { type: string; stream?: { track: string }; lastSequence?: number })
      .filter((item) => item.type === 'terminal')
    expect(terminals.map(({ stream, lastSequence }) => [stream?.track, lastSequence])).toEqual([
      ['microphone', 1],
      ['system', 1]
    ])
  })

  it.each([
    ['config', createdSession('config-r2')],
    ['policy', createdSession('config-r1', 'policy-r2')]
  ])('cancels an allocation with %s-version drift before the relay can open tracks', async (_name, mismatch) => {
    const h = makeHarness()
    h.client.createSession = vi.fn(async () => mismatch) as FakeClient['createSession']
    const session = readyRelay()
    relayHarness.create.mockImplementation(async (options: { client: SpeechBrokerClient }) => {
      const result = await options.client.createSession({ operation: 'create-session' })
      return result.ok ? { ok: true, value: session } : { ok: false, code: 'SCHEMA' }
    })
    await expect(h.invoke(CLOUD_SPEECH_IPC.start, [request])).resolves.toMatchObject({
      ok: false,
      code: 'POLICY',
      captureId,
      captureGeneration: 7
    })
    expect(h.client.cancel).toHaveBeenCalledWith('93d23d44-347e-490c-841b-0ff31facbc7e', 1_000)
    expect(session.pushFrame).not.toHaveBeenCalled()
  })

  it('does not create if credential or policy authority changes while capability is pending', async () => {
    const h = makeHarness()
    const ready = readyCapability()
    let resolveCapability!: (value: Awaited<ReturnType<FakeClient['capability']>>) => void
    h.client.capability = vi.fn(
      () => new Promise((resolve) => (resolveCapability = resolve))
    ) as FakeClient['capability']
    const starting = h.invoke(CLOUD_SPEECH_IPC.start, [request]) as Promise<unknown>
    await vi.waitFor(() => expect(h.client.capability).toHaveBeenCalledTimes(1))
    h.currentAuthority.value = { ...h.currentAuthority.value, policyRevision: 'policy-r2' }
    resolveCapability(ready)
    await expect(starting).resolves.toMatchObject({ ok: false, code: 'POLICY', captureId, captureGeneration: 7 })
    expect(relayHarness.create).not.toHaveBeenCalled()
  })

  it('refuses a successor until a predecessor allocation has confirmed closure', async () => {
    const h = makeHarness()
    const session = readyRelay()
    relayHarness.create.mockImplementation(async (options: { onAllocated?: (id: string) => void }) => {
      options.onAllocated?.(session.identity.sessionId)
      return { ok: true, value: session }
    })
    await expect(h.invoke(CLOUD_SPEECH_IPC.start, [request])).resolves.toMatchObject({ ok: true })
    const successor: CloudSpeechStartRequest = {
      ...request,
      captureId: otherCaptureId,
      capture: { ...request.capture, generation: 8 }
    }
    await expect(h.invoke(CLOUD_SPEECH_IPC.start, [successor])).resolves.toMatchObject({
      ok: false,
      code: 'CLOSURE_UNCONFIRMED',
      captureId: otherCaptureId,
      captureGeneration: 8
    })
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(h.client.capability).toHaveBeenCalledTimes(1)
  })

  it('bounds overlapping start records while predecessor closure is unresolved', async () => {
    const h = makeHarness()
    const session = readyRelay()
    relayHarness.create.mockImplementation(async (options: { onAllocated?: (id: string) => void }) => {
      options.onAllocated?.(session.identity.sessionId)
      return { ok: true, value: session }
    })
    await h.invoke(CLOUD_SPEECH_IPC.start, [request])
    let finishCancel!: () => void
    session.cancel = vi.fn(() => new Promise<void>((resolve) => (finishCancel = resolve)))
    const second: CloudSpeechStartRequest = {
      ...request,
      captureId: otherCaptureId,
      capture: { ...request.capture, generation: 8 }
    }
    const secondStart = h.invoke(CLOUD_SPEECH_IPC.start, [second]) as Promise<unknown>
    await vi.waitFor(() => expect(session.cancel).toHaveBeenCalledTimes(1))
    const third: CloudSpeechStartRequest = {
      ...request,
      captureId: 'e152bda5-dd86-48cc-8f60-0dcb28529e61',
      capture: { ...request.capture, generation: 9 }
    }
    await expect(h.invoke(CLOUD_SPEECH_IPC.start, [third])).resolves.toMatchObject({
      ok: false,
      code: 'CLOSURE_UNCONFIRMED',
      captureId: third.captureId,
      captureGeneration: 9
    })
    finishCancel()
    await expect(secondStart).resolves.toMatchObject({
      ok: false,
      code: 'CLOSURE_UNCONFIRMED',
      captureId: otherCaptureId,
      captureGeneration: 8
    })
    expect(relayHarness.create).toHaveBeenCalledTimes(1)
  })

  it('rejects wrong capture owners and preserves exact frame frontiers through a normal stop', async () => {
    const releaseCaptureOwner = vi.fn()
    const h = makeHarness(undefined, undefined, undefined, releaseCaptureOwner)
    const session = readyRelay()
    relayHarness.create.mockImplementation(async (options: { onAllocated?: (id: string) => void }) => {
      options.onAllocated?.(session.identity.sessionId)
      return { ok: true, value: session }
    })
    await h.invoke(CLOUD_SPEECH_IPC.start, [request])
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.frame, [
        {
          captureId: otherCaptureId,
          captureGeneration: 7,
          track: 'microphone',
          sequence: 1,
          sampleOffset: 0,
          kind: 'full',
          pcm16le: new ArrayBuffer(3_200)
        }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'STALE' })

    const frame = {
      captureId,
      captureGeneration: 7,
      track: 'microphone' as const,
      sequence: 1,
      sampleOffset: 400,
      kind: 'full' as const,
      pcm16le: new ArrayBuffer(3_200)
    }
    await expect(h.invoke(CLOUD_SPEECH_IPC.frame, [frame])).resolves.toMatchObject({
      ok: true,
      nextSampleOffset: 2_000
    })
    await expect(h.invoke(CLOUD_SPEECH_IPC.frame, [frame])).resolves.toMatchObject({ ok: false, code: 'ORDER' })
    expect(session.pushFrame).toHaveBeenCalledTimes(1)

    h.registered.closeInput()
    h.currentAuthority.value = { ...h.currentAuthority.value, captureAllowed: false }
    const finishRequest = {
      captureId,
      captureGeneration: 7,
      tracks: [{ track: 'microphone', finalSequence: 1, finalSampleOffset: 2_000 }]
    }
    const finished = await h.invoke(CLOUD_SPEECH_IPC.finish, [finishRequest])
    expect(finished).toMatchObject({ ok: true, complete: true, reason: 'normal' })
    await expect(h.invoke(CLOUD_SPEECH_IPC.finish, [finishRequest])).resolves.toEqual(finished)
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.finish, [
        { ...finishRequest, tracks: [{ track: 'microphone', finalSequence: 0, finalSampleOffset: 0 }] }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'ORDER' })
    expect(session.finish).toHaveBeenCalledTimes(1)
    expect(session.cancel).not.toHaveBeenCalled()
    expect(releaseCaptureOwner).toHaveBeenCalledTimes(1)
  })

  it('seals the exact four-hour frontier and finishes only after an applied ceiling receipt', async () => {
    const tasks: Array<{ callback: () => void; delay: number }> = []
    const h = makeHarness(
      undefined,
      undefined,
      (callback, delay) => {
        tasks.push({ callback, delay })
        return () => undefined
      }
    )
    const session = readyRelay(undefined, [{ track: 'microphone', streamEpoch: 3 }], 1)
    relayHarness.create.mockImplementation(async (options: { onAllocated?: (id: string) => void }) => {
      options.onAllocated?.(session.identity.sessionId)
      return { ok: true, value: session }
    })
    await expect(h.invoke(CLOUD_SPEECH_IPC.start, [request])).resolves.toMatchObject({ ok: true })
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.frame, [
        {
          captureId,
          captureGeneration: 7,
          track: 'microphone',
          sequence: 1,
          sampleOffset: 0,
          kind: 'sealed-final',
          pcm16le: new ArrayBuffer(3_200)
        }
      ])
    ).resolves.toMatchObject({ ok: true, nextSampleOffset: 1_600 })
    const captureDeadline = tasks.find((task) => task.delay === 4 * 60 * 60 * 1_000)
    expect(captureDeadline).toBeDefined()
    captureDeadline!.callback()
    const ceilingEvent = h.sender.send.mock.calls
      .map((call) => call[1] as { type: string; ceilingId?: string })
      .find((value) => value.type === 'capture-ceiling')
    expect(ceilingEvent).toBeDefined()
    const ack = {
      type: 'capture-ceiling-ack',
      captureId,
      captureGeneration: 7,
      ceilingId: ceilingEvent!.ceilingId,
      tracks: [{ track: 'microphone', finalSequence: 1, finalSampleOffset: 1_600 }]
    }
    await expect(h.invoke(CLOUD_SPEECH_IPC.ceilingAck, [ack])).resolves.toEqual({
      ok: true,
      captureId,
      captureGeneration: 7,
      ceilingId: ceilingEvent!.ceilingId,
      tracks: ack.tracks
    })
    expect(session.finish).toHaveBeenCalledTimes(1)
    await expect(h.invoke(CLOUD_SPEECH_IPC.ceilingAck, [ack])).resolves.toEqual({
      ok: true,
      captureId,
      captureGeneration: 7,
      ceilingId: ceilingEvent!.ceilingId,
      tracks: ack.tracks
    })
  })

  it('does not route an old microphone owner through a newer accepted Listen context', async () => {
    const h = makeHarness()
    const original = {
      webContents: h.sender,
      frame: h.mainFrame,
      navigationEpoch: 3,
      listenStartedAt: 1_900_000_000_000
    }
    h.currentAuthority.value = {
      ...h.currentAuthority.value,
      captureContext: original,
      finishAllowed: true
    }
    const session = readyRelay()
    relayHarness.create.mockImplementation(async (options: { onAllocated?: (id: string) => void }) => {
      options.onAllocated?.(session.identity.sessionId)
      return { ok: true, value: session }
    })
    await expect(h.invoke(CLOUD_SPEECH_IPC.start, [request])).resolves.toMatchObject({ ok: true })
    h.currentAuthority.value = {
      ...h.currentAuthority.value,
      captureContext: { ...original, listenStartedAt: original.listenStartedAt + 1 },
      finishAllowed: false
    }
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.frame, [
        {
          captureId,
          captureGeneration: 7,
          track: 'microphone',
          sequence: 1,
          sampleOffset: 0,
          kind: 'full',
          pcm16le: new ArrayBuffer(3_200)
        }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'CLOSED' })
    expect(session.pushFrame).not.toHaveBeenCalled()
  })

  it('latches sealed-final per track before admitting another frame', async () => {
    const h = makeHarness()
    const session = readyRelay()
    relayHarness.create.mockImplementation(async (options: { onAllocated?: (id: string) => void }) => {
      options.onAllocated?.(session.identity.sessionId)
      return { ok: true, value: session }
    })
    await h.invoke(CLOUD_SPEECH_IPC.start, [request])
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.frame, [
        {
          captureId,
          captureGeneration: 7,
          track: 'microphone',
          sequence: 1,
          sampleOffset: 0,
          kind: 'sealed-final',
          pcm16le: new ArrayBuffer(2)
        }
      ])
    ).resolves.toMatchObject({ ok: true, nextSequence: 2, nextSampleOffset: 1 })
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.frame, [
        {
          captureId,
          captureGeneration: 7,
          track: 'microphone',
          sequence: 2,
          sampleOffset: 1,
          kind: 'full',
          pcm16le: new ArrayBuffer(3_200)
        }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'ORDER' })
    expect(session.pushFrame).toHaveBeenCalledTimes(1)
  })

  it('refuses a normal finish whose terminal frontier omits an emitted transcript', async () => {
    const h = makeHarness()
    const session = readyRelay()
    relayHarness.create.mockImplementation(
      async (options: {
        onAllocated?: (id: string) => void
        onTranscript?: (event: unknown, context: unknown) => void
      }) => {
        options.onAllocated?.(session.identity.sessionId)
        options.onTranscript?.(
          {
            protocolVersion: 1,
            sessionId: session.identity.sessionId,
            captureGeneration: 7,
            track: 'microphone',
            streamEpoch: 3,
            type: 'transcript',
            sequence: 1,
            segmentIndex: 1,
            revision: 1,
            text: 'accepted transcript',
            startMs: 0,
            endMs: 50,
            final: true
          },
          { timeBase: 'stream', firstCaptureSampleOffset: 0 }
        )
        return { ok: true, value: session }
      }
    )
    await expect(h.invoke(CLOUD_SPEECH_IPC.start, [request])).resolves.toMatchObject({ ok: true })
    await expect(
      h.invoke(CLOUD_SPEECH_IPC.finish, [
        { captureId, captureGeneration: 7, tracks: [{ track: 'microphone', finalSequence: 0, finalSampleOffset: 0 }] }
      ])
    ).resolves.toMatchObject({ ok: false, code: 'TRANSPORT' })
    expect(h.sender.send.mock.calls.some((call) => (call[1] as { type?: string }).type === 'terminal')).toBe(false)
  })

  it('refuses to emit a successful finish if policy changes while relay closure is pending', async () => {
    const h = makeHarness()
    const session = readyRelay()
    let resolveFinish!: (value: Awaited<ReturnType<typeof session.finish>>) => void
    session.finish = vi.fn(() => new Promise((resolve) => (resolveFinish = resolve)))
    relayHarness.create.mockImplementation(async (options: { onAllocated?: (id: string) => void }) => {
      options.onAllocated?.(session.identity.sessionId)
      return { ok: true, value: session }
    })
    await h.invoke(CLOUD_SPEECH_IPC.start, [request])
    await h.invoke(CLOUD_SPEECH_IPC.frame, [
      {
        captureId,
        captureGeneration: 7,
        track: 'microphone',
        sequence: 1,
        sampleOffset: 0,
        kind: 'full',
        pcm16le: new ArrayBuffer(3_200)
      }
    ])
    const finish = h.invoke(CLOUD_SPEECH_IPC.finish, [
      { captureId, captureGeneration: 7, tracks: [{ track: 'microphone', finalSequence: 1, finalSampleOffset: 1_600 }] }
    ]) as Promise<unknown>
    await vi.waitFor(() => expect(session.finish).toHaveBeenCalledTimes(1))
    h.currentAuthority.value = { ...h.currentAuthority.value, policyRevision: 'policy-r2' }
    resolveFinish({
      complete: true,
      reason: 'normal',
      tracks: [
        {
          track: 'microphone',
          streamEpoch: 3,
          closeConfirmed: true,
          tail: 'complete',
          lastSequence: 1,
          reason: 'normal'
        }
      ]
    })
    await expect(finish).resolves.toMatchObject({ ok: false, code: 'POLICY' })
    expect(h.sender.send.mock.calls.some((call) => (call[1] as { type?: string }).type === 'terminal')).toBe(false)
  })
})
