import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_SPEECH_IPC } from '@shared/cloud-speech'
import type { SpeechBrokerClient } from './broker-client'
import type { CloudSpeechIpcOptions } from '../ipc/cloud-speech-ipc-support'
import { OwnerSessionRefSchema, type OwnerSessionRef } from '@shared/contracts/owner-session'
import { createLanguageChangeAudit, languageChangeAuditRecord } from '../ipc/cloud-speech-language-audit'

const relayHarness = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('./relay-session', () => ({ RelaySpeechSession: { create: relayHarness.create } }))

import { createRelayRevisionTap } from '../features/meetings/relay-revision-adapter'
import { createTranscriptRevisionStore } from '../features/meetings/transcript-revision-store'
import {
  FAKE_CAPTURE_ID,
  captureClock,
  createFakeBrokerHarness,
  createdSession,
  fakeStartRequest,
  readyRelay,
  rotationReceipt,
  type FakeBrokerClient
} from '../test-helpers/fake-broker'

const M = 1_700_000_000_000
const OLD_ID = '93d23d44-347e-490c-841b-0ff31facbc7e'
const CANDIDATE_ID = 'c3d23d44-347c-490c-841b-0ff31facbc7e'
const GRANT_TOKEN = 'A'.repeat(43)

type SegmentView = { text: string; seq: number; state: string; relaySessionId: string; language: string }
type DeltaView = { meetingStartedAt: number; revision: number }

afterEach(() => relayHarness.create.mockReset())

function transcript(
  sessionId: string,
  streamEpoch: number,
  sequence: number,
  segmentIndex: number,
  revision: number,
  text: string,
  final: boolean,
  languages?: string[]
) {
  return {
    protocolVersion: 1,
    sessionId,
    captureGeneration: 7,
    track: 'microphone',
    streamEpoch,
    type: 'transcript',
    sequence,
    segmentIndex,
    revision,
    text,
    startMs: (segmentIndex - 1) * 100,
    endMs: (segmentIndex - 1) * 100 + 50,
    final,
    ...(languages ? { languages } : {})
  }
}

function segmentSends(h: ReturnType<typeof createFakeBrokerHarness>) {
  return h.sender.send.mock.calls
    .map(
      (call) => call[1] as { type?: string; segment?: { final?: boolean; text?: string; stream?: { epoch?: number } } }
    )
    .filter((event) => event.type === 'segment')
}

async function driveRotation() {
  const clock = captureClock()
  const store = createTranscriptRevisionStore()
  const tap = createRelayRevisionTap({ store })
  const deltas: DeltaView[] = []
  store.onChange((delta) => deltas.push(delta as unknown as DeltaView))
  const h = createFakeBrokerHarness({ clock, listenStartedAt: M, onSegmentDelivered: tap })

  const invokeLog: string[] = []
  const invokeResults: unknown[] = []
  const invoke = async (channel: string, args: unknown[] = []) => {
    invokeLog.push(channel)
    const result = await h.invoke(channel, args)
    invokeResults.push(result)
    return result
  }

  const oldSession = readyRelay(OLD_ID, [{ track: 'microphone', streamEpoch: 3 }], clock.wallNow(), 3)
  const candidateSession = readyRelay(CANDIDATE_ID, [{ track: 'microphone', streamEpoch: 4 }], clock.wallNow())
  let onTranscript: ((event: unknown, context: unknown) => void) | undefined
  let renewalClient: SpeechBrokerClient | undefined
  relayHarness.create.mockImplementation(
    async (options: {
      client: SpeechBrokerClient
      onAllocated?: (id: string) => void
      onTranscript?: (event: unknown, context: unknown) => void
    }) => {
      options.onAllocated?.(OLD_ID)
      renewalClient = options.client
      onTranscript = options.onTranscript
      return { ok: true, value: oldSession }
    }
  )
  h.client.createSession = vi.fn(async () =>
    createdSession({ sessionId: CANDIDATE_ID, streamEpoch: 4, wallNow: clock.wallNow() })
  ) as FakeBrokerClient['createSession']
  const renew = vi.fn(async (createRequest: unknown) => {
    const created = await renewalClient!.createSession(createRequest as never)
    if (!created.ok) throw new Error('candidate allocation failed')
    candidateSession.identity.audioDeadlineAt = created.value.limits.audioDeadlineAt
    return { ok: true, value: candidateSession }
  })
  ;(oldSession as unknown as { renew: typeof renew }).renew = renew

  const oldContext = { timeBase: 'stream', firstCaptureSampleOffset: 0, sessionId: OLD_ID }
  const candidateContext = { timeBase: 'stream', firstCaptureSampleOffset: 0, sessionId: CANDIDATE_ID }

  await expect(invoke(CLOUD_SPEECH_IPC.start, [fakeStartRequest])).resolves.toMatchObject({ ok: true })

  onTranscript?.(transcript(OLD_ID, 3, 1, 1, 1, 'alpha one', true), oldContext)
  onTranscript?.(transcript(OLD_ID, 3, 2, 2, 1, 'bravo', false), oldContext)
  onTranscript?.(transcript(OLD_ID, 3, 3, 2, 2, 'bravo two', true), oldContext)
  await vi.waitFor(() => expect(segmentSends(h)).toHaveLength(3))
  const bindingBefore = store.bindingOf(M)

  clock.runAt(53_000)
  await vi.waitFor(() => expect(clock.pendingAt(55_000)).toHaveLength(1))
  clock.runAt(55_000)
  const closed = await rotationReceipt(h, 'closed', 3)
  await expect(
    invoke(CLOUD_SPEECH_IPC.transitionAck, [{ ...closed, type: 'epoch-transition-ack' }])
  ).resolves.toMatchObject({ ok: true })
  const opened = await rotationReceipt(h, 'opened', 3)

  onTranscript?.(transcript(CANDIDATE_ID, 4, 1, 1, 1, 'charlie three', true), candidateContext)
  const snapshotBeforeAck = (store.snapshot(M)?.segments ?? []) as unknown as SegmentView[]
  const textsBeforeAck = snapshotBeforeAck.map((segment) => segment.text)

  await invoke(CLOUD_SPEECH_IPC.transitionAck, [{ ...opened, type: 'epoch-transition-ack' }])
  await vi.waitFor(() => expect(segmentSends(h).some((event) => event.segment?.stream?.epoch === 4)).toBe(true))

  onTranscript?.(transcript(CANDIDATE_ID, 4, 2, 2, 1, 'delta four', true), candidateContext)
  await vi.waitFor(() => expect(segmentSends(h).filter((event) => event.segment?.stream?.epoch === 4)).toHaveLength(2))

  const segments = () => (store.snapshot(M)?.segments ?? []) as unknown as SegmentView[]
  return { h, store, deltas, invokeLog, invokeResults, renew, bindingBefore, textsBeforeAck, segments }
}

describe('relay session reconnect', () => {
  it('drop then resume loses no committed final and duplicates none', async () => {
    const run = await driveRotation()
    const segments = run.segments()
    expect(segments.map((segment) => segment.text)).toEqual(['alpha one', 'bravo two', 'charlie three', 'delta four'])
    expect(segments.some((segment) => segment.state === 'partial')).toBe(false)
    expect(run.textsBeforeAck).not.toContain('charlie three')

    const deliveredFinals = segmentSends(run.h)
      .filter((event) => event.segment?.final === true)
      .map((event) => event.segment?.text)
    expect(deliveredFinals.length).toBeGreaterThan(0)
    for (const text of deliveredFinals) {
      expect(segments.filter((segment) => segment.text === text)).toHaveLength(1)
    }
  })

  it('token expiry mid-meeting re-mints through broker without renderer involvement', async () => {
    const run = await driveRotation()
    expect(run.h.client.createSession).toHaveBeenCalledTimes(1)
    expect(run.renew).toHaveBeenCalledTimes(1)
    expect(run.invokeLog).toEqual([
      CLOUD_SPEECH_IPC.start,
      CLOUD_SPEECH_IPC.transitionAck,
      CLOUD_SPEECH_IPC.transitionAck
    ])
    for (const call of run.h.sender.send.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(GRANT_TOKEN)
    }
    expect(run.invokeResults).toHaveLength(3)
    for (const result of run.invokeResults) expect(JSON.stringify(result)).not.toContain(GRANT_TOKEN)
    expect(run.segments().map((segment) => segment.text)).toContain('delta four')
  })

  it('reconnect keeps the same meetingStartedAt and revision lineage', async () => {
    const run = await driveRotation()
    expect(run.deltas.length).toBeGreaterThan(1)
    for (const delta of run.deltas) expect(delta.meetingStartedAt).toBe(M)
    for (let i = 1; i < run.deltas.length; i += 1) {
      expect(run.deltas[i]!.revision).toBe(run.deltas[i - 1]!.revision + 1)
    }

    expect(run.bindingBefore?.frameOwner).toBe('11:2')
    expect(run.store.bindingOf(M)?.frameOwner).toBe('11:2')

    const segments = run.segments()
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.seq).toBeGreaterThan(segments[i - 1]!.seq)
    }

    const ids = [...new Set(segments.map((segment) => segment.relaySessionId))]
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id.startsWith(`${FAKE_CAPTURE_ID}/7/`)).toBe(true)
    expect(ids.filter((id) => id.endsWith('/3'))).toHaveLength(1)
    expect(ids.filter((id) => id.endsWith('/4'))).toHaveLength(1)
  })
})

async function startLanguageRun(
  opts: {
    startLanguage?: string
    allowedLanguages?: string[]
    candidateLanguage?: string
    oldLastSequence?: number
    onLanguageChange?: CloudSpeechIpcOptions['onLanguageChange']
  } = {}
) {
  const startLanguage = opts.startLanguage ?? fakeStartRequest.language
  const candidateLanguage = opts.candidateLanguage ?? startLanguage
  const clock = captureClock()
  const store = createTranscriptRevisionStore()
  const tap = createRelayRevisionTap({ store })
  const h = createFakeBrokerHarness({
    clock,
    listenStartedAt: M,
    onSegmentDelivered: tap,
    ...(opts.onLanguageChange ? { onLanguageChange: opts.onLanguageChange } : {}),
    ...(opts.allowedLanguages ? { allowedLanguages: opts.allowedLanguages } : {})
  })
  const invokeLog: string[] = []
  const invoke = async (channel: string, args: unknown[] = []) => {
    invokeLog.push(channel)
    return h.invoke(channel, args)
  }
  const oldSession = readyRelay(
    OLD_ID,
    [{ track: 'microphone', streamEpoch: 3 }],
    clock.wallNow(),
    opts.oldLastSequence ?? 0,
    startLanguage
  )
  const candidateSession = readyRelay(
    CANDIDATE_ID,
    [{ track: 'microphone', streamEpoch: 4 }],
    clock.wallNow(),
    0,
    candidateLanguage
  )
  let onTranscript: ((event: unknown, context: unknown) => void) | undefined
  let renewalClient: SpeechBrokerClient | undefined
  relayHarness.create.mockImplementation(
    async (options: {
      client: SpeechBrokerClient
      onAllocated?: (id: string) => void
      onTranscript?: (event: unknown, context: unknown) => void
    }) => {
      options.onAllocated?.(OLD_ID)
      renewalClient = options.client
      onTranscript = options.onTranscript
      return { ok: true, value: oldSession }
    }
  )
  h.client.createSession = vi.fn(async () =>
    createdSession({ sessionId: CANDIDATE_ID, streamEpoch: 4, wallNow: clock.wallNow(), language: candidateLanguage })
  ) as FakeBrokerClient['createSession']
  const renew = vi.fn(async (createRequest: unknown) => {
    const created = await renewalClient!.createSession(createRequest as never)
    if (!created.ok) throw new Error('candidate allocation failed')
    candidateSession.identity.audioDeadlineAt = created.value.limits.audioDeadlineAt
    return { ok: true, value: candidateSession }
  })
  ;(oldSession as unknown as { renew: typeof renew }).renew = renew

  const oldContext = { timeBase: 'stream', firstCaptureSampleOffset: 0, sessionId: OLD_ID }
  const candidateContext = { timeBase: 'stream', firstCaptureSampleOffset: 0, sessionId: CANDIDATE_ID }

  await expect(
    invoke(CLOUD_SPEECH_IPC.start, [{ ...fakeStartRequest, language: startLanguage }])
  ).resolves.toMatchObject({ ok: true })

  const capabilityCalls = () => (h.client.capability as unknown as { mock: { calls: unknown[] } }).mock.calls.length
  return {
    h,
    store,
    clock,
    oldSession,
    candidateSession,
    renew,
    invoke,
    invokeLog,
    capabilityCalls,
    capabilityCallsAtStart: capabilityCalls(),
    emitOld: (sequence: number, text: string, languages?: string[]) =>
      onTranscript?.(transcript(OLD_ID, 3, sequence, sequence, 1, text, true, languages), oldContext),
    emitCandidate: (sequence: number, text: string, languages?: string[]) =>
      onTranscript?.(transcript(CANDIDATE_ID, 4, sequence, sequence, 1, text, true, languages), candidateContext),
    segments: () => (store.snapshot(M)?.segments ?? []) as unknown as SegmentView[],
    languages: () => ((store.snapshot(M) as unknown as { languages?: string[] } | null)?.languages ?? []) as string[]
  }
}

describe('relay session language change', () => {
  it('provider language event mid-stream labels later segments only', async () => {
    const run = await startLanguageRun({ startLanguage: 'multi' })
    run.emitOld(1, 'hello', ['en'])
    run.emitOld(2, 'bonjour', ['fr'])
    run.emitOld(3, 'encore')
    run.emitOld(4, 'again', ['en'])
    run.emitOld(5, 'still')
    await vi.waitFor(() => expect(segmentSends(run.h)).toHaveLength(5))

    const segments = run.segments()
    expect(segments.map((segment) => segment.text)).toEqual(['hello', 'bonjour', 'encore', 'again', 'still'])
    expect(segments.map((segment) => segment.language)).toEqual(['en', 'fr', 'fr', 'en', 'en'])
    expect(segments[0]!.language).toBe('en')
    expect(run.languages()).toEqual(['fr', 'en'])

    const types = run.h.sender.send.mock.calls.map((call) => String((call[1] as { type?: string }).type))
    expect(new Set(types)).toEqual(new Set(['segment']))
    expect(run.oldSession.finish).not.toHaveBeenCalled()
    expect(run.oldSession.cancel).not.toHaveBeenCalled()
  })

  it('user language change takes effect without stopping the relay session', async () => {
    const run = await startLanguageRun({
      allowedLanguages: ['multi', 'en-US', 'fr'],
      candidateLanguage: 'fr',
      oldLastSequence: 1
    })
    run.emitOld(1, 'hello')
    await vi.waitFor(() => expect(segmentSends(run.h)).toHaveLength(1))
    expect(run.segments()[0]!.language).toBe('en-US')
    const bindingBefore = run.store.bindingOf(M)

    const request = { captureId: FAKE_CAPTURE_ID, captureGeneration: 7, language: 'fr' }
    await expect(run.invoke(CLOUD_SPEECH_IPC.language, [request])).resolves.toMatchObject({
      ok: true,
      language: 'fr',
      changed: true
    })

    const closed = await rotationReceipt(run.h, 'closed', 3)
    await expect(
      run.invoke(CLOUD_SPEECH_IPC.transitionAck, [{ ...closed, type: 'epoch-transition-ack' }])
    ).resolves.toMatchObject({ ok: true })
    const opened = await rotationReceipt(run.h, 'opened', 3)
    run.emitCandidate(1, 'bonjour')
    await run.invoke(CLOUD_SPEECH_IPC.transitionAck, [{ ...opened, type: 'epoch-transition-ack' }])
    await vi.waitFor(() => expect(segmentSends(run.h).some((event) => event.segment?.stream?.epoch === 4)).toBe(true))

    expect(run.renew).toHaveBeenCalledTimes(1)
    expect((run.renew.mock.calls[0]![0] as { language?: string }).language).toBe('fr')

    const segments = run.segments()
    expect(segments.map((segment) => segment.text)).toEqual(['hello', 'bonjour'])
    expect(segments.map((segment) => segment.language)).toEqual(['en-US', 'fr'])
    expect(run.languages().at(-1)).toBe('fr')
    expect(bindingBefore).not.toBeNull()
    expect(run.store.bindingOf(M)).toEqual(bindingBefore)

    expect(run.oldSession.cancel).not.toHaveBeenCalled()
    expect(run.invokeLog).not.toContain(CLOUD_SPEECH_IPC.finish)
    expect(run.invokeLog).not.toContain(CLOUD_SPEECH_IPC.cancel)

    await vi.waitFor(async () => {
      await expect(run.invoke(CLOUD_SPEECH_IPC.language, [request])).resolves.toMatchObject({
        ok: true,
        language: 'fr',
        changed: false
      })
    })
  })

  it('refuses a language the authority does not allow without touching the session', async () => {
    const run = await startLanguageRun({ allowedLanguages: ['multi', 'en-US', 'fr'] })
    await expect(
      run.invoke(CLOUD_SPEECH_IPC.language, [{ captureId: FAKE_CAPTURE_ID, captureGeneration: 7, language: 'de' }])
    ).resolves.toMatchObject({ ok: false, code: 'POLICY' })
    expect(run.renew).not.toHaveBeenCalled()
    expect(run.capabilityCalls()).toBe(run.capabilityCallsAtStart)
    expect(run.oldSession.cancel).not.toHaveBeenCalled()
  })

  it('refuses a language change from another frame', async () => {
    const run = await startLanguageRun({ allowedLanguages: ['multi', 'en-US', 'fr'], candidateLanguage: 'fr' })
    const otherSender = Object.assign(new EventEmitter(), {
      mainFrame: run.h.mainFrame,
      isDestroyed: () => false,
      getURL: () => run.h.mainFrame.url,
      send: vi.fn()
    })
    const otherEvent = { sender: otherSender, senderFrame: run.h.mainFrame } as never
    await expect(
      run.h.invoke(
        CLOUD_SPEECH_IPC.language,
        [{ captureId: FAKE_CAPTURE_ID, captureGeneration: 7, language: 'fr' }],
        otherEvent
      )
    ).resolves.toMatchObject({ ok: false, code: 'STALE' })
    expect(run.renew).not.toHaveBeenCalled()
    const types = run.h.sender.send.mock.calls.map((call) => (call[1] as { type?: string }).type)
    expect(types.includes('epoch-transition')).toBe(false)
  })
})

describe('speech.language.change audit hook (WP02 catalog, S13 path)', () => {
  const request = (language: string, captureGeneration = 7) => ({
    captureId: FAKE_CAPTURE_ID,
    captureGeneration,
    language
  })

  it('observes each resolved request once with its outcome and no language value', async () => {
    const onSettled = vi.fn()
    const onLanguageChange = vi.fn(
      (_owner: Parameters<NonNullable<CloudSpeechIpcOptions['onLanguageChange']>>[0]) => onSettled
    )
    const run = await startLanguageRun({
      allowedLanguages: ['multi', 'en-US', 'fr'],
      candidateLanguage: 'fr',
      onLanguageChange
    })
    await expect(run.invoke(CLOUD_SPEECH_IPC.language, [request('de')])).resolves.toMatchObject({ code: 'POLICY' })
    await expect(run.invoke(CLOUD_SPEECH_IPC.language, [request('fr')])).resolves.toMatchObject({ changed: true })
    expect(onLanguageChange).toHaveBeenCalledTimes(2)
    expect(onSettled.mock.calls.map((call) => call[0])).toEqual([
      { ok: false, code: 'POLICY' },
      { ok: true, changed: true }
    ])
    for (const [owner] of onLanguageChange.mock.calls) {
      expect(owner).toMatchObject({ captureId: FAKE_CAPTURE_ID, generation: 7 })
    }
    for (const [outcome] of onSettled.mock.calls) {
      const record = languageChangeAuditRecord(null, outcome, 1)
      expect(record).not.toBeNull()
      expect(JSON.stringify(record)).not.toMatch(/"(fr|de|en-US)"|language":/)
    }
  })

  it('does not observe a request whose capture owner never resolved', async () => {
    const onLanguageChange = vi.fn()
    const run = await startLanguageRun({ allowedLanguages: ['multi', 'en-US', 'fr'], onLanguageChange })
    await expect(run.invoke(CLOUD_SPEECH_IPC.language, [request('fr', 8)])).resolves.toMatchObject({ code: 'STALE' })
    const otherSender = Object.assign(new EventEmitter(), {
      mainFrame: run.h.mainFrame,
      isDestroyed: () => false,
      getURL: () => run.h.mainFrame.url,
      send: vi.fn()
    })
    await expect(
      run.h.invoke(CLOUD_SPEECH_IPC.language, [request('fr')], { sender: otherSender, senderFrame: run.h.mainFrame })
    ).resolves.toMatchObject({ code: 'STALE' })
    await expect(run.invoke(CLOUD_SPEECH_IPC.language, [{ captureId: 'nope' }])).resolves.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(onLanguageChange).not.toHaveBeenCalled()
  })

  it.each([
    'replacement',
    'sign-out',
    'sign-in'
  ] as const)('retains the requesting owner when %s happens during preflight', async (change) => {
    const original = OwnerSessionRefSchema.parse({
      v: 1,
      ownerKey: 'ab'.repeat(32),
      tenantKey: 'cd'.repeat(32),
      authGeneration: 1,
      sessionId: OLD_ID,
      frameOwner: '11:2',
      contextRevision: 1,
      issuedAt: M
    })
    let current: OwnerSessionRef | null = change === 'sign-in' ? null : original
    const admitted = current
    const audit = vi.fn()
    const run = await startLanguageRun({
      onLanguageChange: createLanguageChangeAudit({ resolveOwner: () => current, audit })
    })
    const capability = run.h.client.capability
    let release!: () => void
    const pendingCapability = new Promise<void>((resolve) => {
      release = resolve
    })
    const delayed = vi.fn(async (...args: Parameters<typeof capability>) => {
      await pendingCapability
      return capability(...args)
    })
    run.h.client.capability = delayed
    const pending = run.invoke(CLOUD_SPEECH_IPC.language, [request('en-US')])
    await vi.waitFor(() => expect(delayed).toHaveBeenCalledTimes(1))
    expect(audit).not.toHaveBeenCalled()
    current = change === 'sign-out' ? null : { ...original, ownerKey: 'cd'.repeat(32), sessionId: CANDIDATE_ID }
    release()
    await expect(pending).resolves.toMatchObject({ ok: true, changed: false })
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(
      'speech.language.change',
      expect.objectContaining({
        ownerKey: admitted?.ownerKey ?? null,
        sessionId: admitted?.sessionId ?? null,
        outcome: 'allowed'
      })
    )
  })

  it('a throwing audit hook never changes the language result', async () => {
    const onLanguageChange = vi.fn(() => {
      throw new Error('audit sink down')
    })
    const run = await startLanguageRun({
      allowedLanguages: ['multi', 'en-US', 'fr'],
      candidateLanguage: 'fr',
      onLanguageChange
    })
    await expect(run.invoke(CLOUD_SPEECH_IPC.language, [request('fr')])).resolves.toMatchObject({
      ok: true,
      language: 'fr',
      changed: true
    })
    expect(onLanguageChange).toHaveBeenCalledTimes(1)
    expect(run.oldSession.cancel).not.toHaveBeenCalled()
  })

  it('a throwing settlement observer never changes the language result', async () => {
    const onSettled = vi.fn(() => {
      throw new Error('audit sink down')
    })
    const run = await startLanguageRun({ onLanguageChange: () => onSettled })
    await expect(run.invoke(CLOUD_SPEECH_IPC.language, [request('en-US')])).resolves.toMatchObject({
      ok: true,
      language: 'en-US',
      changed: false
    })
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(run.oldSession.cancel).not.toHaveBeenCalled()
  })

  it('provider-detected language changes never start or emit a user audit', async () => {
    const onSettled = vi.fn()
    const onLanguageChange = vi.fn(() => onSettled)
    const run = await startLanguageRun({ startLanguage: 'multi', onLanguageChange })
    run.emitOld(1, 'hello', ['en'])
    run.emitOld(2, 'bonjour', ['fr'])
    await vi.waitFor(() => expect(segmentSends(run.h)).toHaveLength(2))
    expect(run.languages()).toEqual(['en', 'fr'])
    expect(onLanguageChange).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })
})
