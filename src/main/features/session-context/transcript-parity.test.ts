import { describe, expect, it } from 'vitest'
import { CloudSpeechEventSchema, type CloudSpeechEvent } from '@shared/cloud-speech'
import type { TranscriptLine } from '@shared/transcript-line'
import { cloudUtteranceId } from '@shared/transcript-line-identity'
import { transcriptToText } from '@shared/transcript-text'
import { createMeetingContextRegistry, type FrameKey } from './meeting-context-registry'
import { transcriptTailText } from './transcript-text'
import { meetingPermissions } from './wiring'

/**
 * Parity (G13): the tail main builds from its ledger snapshot is the tail the renderer used to send, byte for byte,
 * including speaker names (enrolled or Teams-backfilled), the unknown-speaker label, control characters in a name,
 * and the "[conversation switches to ...]" markers. The old path was `transcriptToText(lines).slice(-6000)`.
 */
const FRAME: FrameKey = { processId: 5, routingId: 2 }
const STARTED = 1_700_000_000_000
const HEX = 'a'.repeat(64)
const CAPTURE = '11111111-1111-4111-8111-111111111111'

type Fixture = {
  speaker: 'you' | 'them' | 'unknown'
  text: string
  name?: string
  lang?: string
  relay?: boolean
  offsetMs: number
}

const FIXTURE: Fixture[] = [
  {
    speaker: 'you',
    text: 'Thanks for joining, shall we start?',
    name: 'Tony Walteur',
    lang: 'English',
    offsetMs: 1_000
  },
  {
    speaker: 'them',
    text: 'Yes, the renewal is on the agenda.',
    name: 'Alice Doe',
    lang: 'English',
    relay: true,
    offsetMs: 2_000
  },
  {
    speaker: 'them',
    text: 'Podemos falar do preço?',
    name: 'Bruno Silva',
    lang: 'Portuguese',
    relay: true,
    offsetMs: 3_000
  },
  { speaker: 'unknown', text: 'An imported voice with no side.', name: 'Teams Guest', offsetMs: 4_000 },
  { speaker: 'them', text: 'No name here, no language either.', relay: true, offsetMs: 5_000 },
  {
    speaker: 'them',
    text: 'Name\u0000with\tcontrol   chars',
    name: 'Eve\u0007 \n Adams',
    lang: 'English',
    offsetMs: 6_000
  },
  { speaker: 'you', text: 'Back to English, thanks.', lang: 'English', relay: true, offsetMs: 7_000 }
]

function relayEvent(index: number, row: Fixture): Extract<CloudSpeechEvent, { type: 'segment' }> {
  const parsed = CloudSpeechEventSchema.parse({
    type: 'segment',
    captureId: CAPTURE,
    captureGeneration: 1,
    sequence: index + 1,
    segment: {
      stream: { generation: 1, track: row.speaker === 'you' ? 'microphone' : 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index: index + 1,
      revision: 1,
      final: true,
      text: row.text,
      startMs: row.offsetMs,
      endMs: row.offsetMs + 400
    }
  })
  if (parsed.type !== 'segment') throw new Error('segment expected')
  return parsed
}

function mainTail(maxChars: number): string {
  const registry = createMeetingContextRegistry({
    resolveScope: (_frame, startedAt) => ({
      ownerKey: HEX,
      scope: { tenantId: HEX, userId: HEX, sessionId: `meeting-${startedAt}` }
    }),
    permissions: () => meetingPermissions(false)
  })
  FIXTURE.forEach((row, index) => {
    if (row.relay) {
      const event = relayEvent(index, row)
      registry.ingestDelivered(FRAME, STARTED, event)
      // What the renderer's seam sends for a committed relay line: its name and language, by utterance id.
      if (row.name || row.lang)
        registry.labelLine(FRAME, {
          startedAt: STARTED,
          utteranceId: cloudUtteranceId(event.segment.stream, event.segment.index),
          ...(row.name ? { name: row.name } : {}),
          ...(row.lang ? { lang: row.lang } : {})
        })
    } else {
      registry.ingestLocalLine(FRAME, {
        startedAt: STARTED,
        t: STARTED + row.offsetMs,
        speaker: row.speaker,
        text: row.text,
        ...(row.name ? { name: row.name } : {}),
        ...(row.lang ? { lang: row.lang } : {})
      })
    }
  })
  const handle = registry.acquire(FRAME, 'conversation')
  if (!handle) throw new Error('no context')
  return transcriptTailText(handle.snapshot, maxChars)
}

const rendererLines = (): TranscriptLine[] =>
  FIXTURE.map((row) => ({
    speaker: row.speaker,
    text: row.text,
    t: STARTED + row.offsetMs,
    ...(row.name ? { name: row.name } : {}),
    ...(row.lang ? { lang: row.lang } : {})
  }))

describe('main-built tail equals the tail the renderer used to send', () => {
  it('carries speaker names, the unknown-speaker label and language switch markers', () => {
    const old = transcriptToText(rendererLines()).slice(-6000)
    expect(old).toContain('YOU (Tony Walteur): Thanks for joining')
    expect(old).toContain('THEM (Alice Doe): Yes')
    expect(old).toContain('[conversation switches to Portuguese]')
    expect(old).toContain('Teams Guest: An imported voice')
    expect(old).toContain('THEM (Eve Adams)')
    expect(mainTail(6_000)).toBe(old)
  })

  it.each([40, 120, 333])('cuts the same %i-character tail after the labels are in', (size) => {
    expect(mainTail(size)).toBe(transcriptToText(rendererLines()).slice(-size))
  })

  it('shows a name that resolved after the line committed (a voiceprint match)', () => {
    const registry = createMeetingContextRegistry({
      resolveScope: (_frame, startedAt) => ({
        ownerKey: HEX,
        scope: { tenantId: HEX, userId: HEX, sessionId: `meeting-${startedAt}` }
      }),
      permissions: () => meetingPermissions(false)
    })
    registry.ingestLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000, speaker: 'them', text: 'hello' })
    const before = registry.acquire(FRAME, 'conversation')!
    expect(transcriptTailText(before.snapshot, 500)).toBe('THEM: hello')
    expect(registry.labelLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000, name: 'Jane Doe' })).toBe(true)
    // The label changes what every output would read, so a snapshot taken before it is advanced, not current.
    expect(before.check()).toEqual({ state: 'advanced' })
    expect(transcriptTailText(registry.acquire(FRAME, 'conversation')!.snapshot, 500)).toBe('THEM (Jane Doe): hello')
    // A label for a line main does not know changes nothing.
    expect(registry.labelLine(FRAME, { startedAt: STARTED, t: STARTED + 9_999, name: 'Nobody' })).toBe(false)
  })
})
