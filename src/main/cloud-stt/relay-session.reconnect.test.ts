import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_SPEECH_IPC } from '@shared/cloud-speech'
import type { SpeechBrokerClient } from './broker-client'

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

type SegmentView = { text: string; seq: number; state: string; relaySessionId: string }
type DeltaView = { meetingStartedAt: number; revision: number }

afterEach(() => relayHarness.create.mockReset())

function transcript(
  sessionId: string,
  streamEpoch: number,
  sequence: number,
  segmentIndex: number,
  revision: number,
  text: string,
  final: boolean
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
    final
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
