import { describe, expect, it, vi } from 'vitest'
import { CloudSpeechEventSchema, type CloudSpeechEvent } from '@shared/cloud-speech'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import { SESSION_OUTPUT_KINDS } from '@shared/kernel/session-context'
import {
  CONTEXT_TRANSCRIPT_WINDOW,
  createMeetingContextRegistry,
  createMeetingScopeResolver,
  type FrameKey,
  type MeetingContextRegistryDeps,
  type MeetingScope
} from './meeting-context-registry'
import { meetingPermissions } from './wiring'
import { transcriptTailText } from './transcript-text'

const CAPTURE = '11111111-1111-4111-8111-111111111111'
const STARTED = 1_700_000_000_000
const FRAME: FrameKey = { processId: 12, routingId: 3 }
const OTHER_FRAME: FrameKey = { processId: 99, routingId: 1 }
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const HEX_T = 'c'.repeat(64)

function ref(ownerKey = HEX_A, frame: FrameKey = FRAME): OwnerSessionRef {
  return {
    v: 1,
    ownerKey,
    tenantKey: HEX_T,
    authGeneration: 1,
    sessionId: '22222222-2222-4222-8222-222222222222',
    frameOwner: `${frame.processId}:${frame.routingId}`,
    contextRevision: 1,
    issuedAt: 1_700_000_000_000
  }
}

function segment(options: {
  sequence: number
  index: number
  text: string
  final?: boolean
  revision?: number
  track?: 'microphone' | 'system'
  epoch?: number
  generation?: number
  startMs?: number
}): CloudSpeechEvent {
  const generation = options.generation ?? 1
  return CloudSpeechEventSchema.parse({
    type: 'segment',
    captureId: CAPTURE,
    captureGeneration: generation,
    sequence: options.sequence,
    segment: {
      stream: { generation, track: options.track ?? 'system', epoch: options.epoch ?? 1 },
      engine: 'deepgram-nova3',
      index: options.index,
      revision: options.revision ?? 1,
      final: options.final ?? true,
      text: options.text,
      startMs: options.startMs ?? options.index * 1_000,
      endMs: (options.startMs ?? options.index * 1_000) + 500
    }
  })
}

interface Harness {
  registry: ReturnType<typeof createMeetingContextRegistry>
  permissions: { current: readonly string[] }
  degraded: ReturnType<typeof vi.fn>
  signedOut(): void
  owner: { current: string }
}

function harness(over: Partial<MeetingContextRegistryDeps> = {}): Harness {
  const permissions = { current: meetingPermissions(false) }
  const degraded = vi.fn()
  const owner = { current: HEX_A }
  let out = false
  const registry = createMeetingContextRegistry({
    resolveScope: (_frame, startedAt): MeetingScope | null =>
      out
        ? null
        : {
            ownerKey: owner.current,
            scope: { tenantId: HEX_T, userId: owner.current, sessionId: `meeting-${startedAt}` }
          },
    permissions: () => permissions.current,
    onDegraded: degraded,
    ...over
  })
  return { registry, permissions, degraded, signedOut: () => (out = true), owner }
}

const text = (h: Harness, frame: FrameKey = FRAME, max = 6_000): string => {
  const handle = h.registry.acquire(frame, 'conversation')
  return handle ? transcriptTailText(handle.snapshot, max) : '<none>'
}

describe('meeting context registry: delivered relay speech', () => {
  it('feeds finals into the ledger and never partials', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'half a sen', final: false }))
    expect(text(h)).toBe('<none>')
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 2, index: 1, text: 'half a sentence.' }))
    expect(text(h)).toBe('THEM: half a sentence.')
  })

  it('does not duplicate a replayed final and refuses a late event of an older stream epoch', () => {
    const h = harness()
    const first = segment({ sequence: 1, index: 1, text: 'first.', epoch: 2 })
    h.registry.ingestDelivered(FRAME, STARTED, first)
    h.registry.ingestDelivered(FRAME, STARTED, first)
    h.registry.ingestDelivered(
      FRAME,
      STARTED,
      segment({ sequence: 9, index: 4, text: 'late from epoch one.', epoch: 1 })
    )
    expect(text(h)).toBe('THEM: first.')
    expect(h.degraded).not.toHaveBeenCalled()
  })

  it('applies a corrected final revision in place of the earlier one', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'we ship on friday' }))
    h.registry.ingestDelivered(
      FRAME,
      STARTED,
      segment({ sequence: 2, index: 1, text: 'we ship on Monday', revision: 2 })
    )
    expect(text(h)).toBe('THEM: we ship on Monday')
  })

  it('labels the microphone track YOU and the system track THEM, in time order', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'hello', track: 'system' }))
    h.registry.ingestDelivered(
      FRAME,
      STARTED,
      segment({ sequence: 1, index: 2, text: 'hi there', track: 'microphone' })
    )
    expect(text(h)).toBe('THEM: hello\nYOU: hi there')
  })

  it('keeps only a bounded window of recent finals in the context', () => {
    const h = harness()
    for (let index = 1; index <= CONTEXT_TRANSCRIPT_WINDOW + 30; index += 1) {
      h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: index, index, text: `line ${index}` }))
    }
    const handle = h.registry.acquire(FRAME, 'conversation')
    expect(handle?.snapshot.transcript.segments).toHaveLength(CONTEXT_TRANSCRIPT_WINDOW)
    expect(text(h, FRAME, 100_000)).toContain(`line ${CONTEXT_TRANSCRIPT_WINDOW + 30}`)
    expect(text(h, FRAME, 100_000)).not.toContain('line 29\n')
    expect(h.degraded).not.toHaveBeenCalled()
  })

  it('reports a ledger refusal as a code only, keeps the context, and keeps serving what it holds', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'kept' }))
    // Same event id and sequence with different content collides.
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'forged' }))
    expect(h.degraded).toHaveBeenCalledWith('EVENT_ID_COLLISION')
    expect(JSON.stringify(h.degraded.mock.calls)).not.toContain('forged')
    expect(text(h)).toBe('THEM: kept')
  })
})

describe('meeting context registry: renderer-committed local lines', () => {
  it('feeds on-device lines and labels them by speaker', () => {
    const h = harness()
    expect(
      h.registry.ingestLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000, speaker: 'them', text: 'a' })
    ).toBe(true)
    expect(
      h.registry.ingestLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 2_000, speaker: 'you', text: 'b' })
    ).toBe(true)
    expect(text(h)).toBe('THEM: a\nYOU: b')
  })

  it('is idempotent for a replayed line and keeps two same-millisecond lines apart', () => {
    const h = harness()
    const line = { startedAt: STARTED, t: STARTED + 1_000, speaker: 'them' as const, text: 'once' }
    h.registry.ingestLocalLine(FRAME, line)
    h.registry.ingestLocalLine(FRAME, line)
    h.registry.ingestLocalLine(FRAME, { ...line, text: 'same millisecond, other words' })
    expect(text(h)).toBe('THEM: once\nTHEM: same millisecond, other words')
  })

  it('retracts a dropped line (operator echo) so it is never context again', () => {
    const h = harness()
    h.registry.ingestLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000, speaker: 'them', text: 'echo of me' })
    h.registry.ingestLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 2_000, speaker: 'them', text: 'real' })
    expect(h.registry.retractLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000 })).toBe(true)
    expect(text(h)).toBe('THEM: real')
    expect(h.registry.retractLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 5_000 })).toBe(false)
  })
})

describe('meeting context registry: ownership', () => {
  it('serves a meeting only to the frame that opened it', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'private' }))
    expect(text(h, OTHER_FRAME)).toBe('<none>')
    expect(
      h.registry.ingestLocalLine(OTHER_FRAME, { startedAt: STARTED, t: STARTED + 1, speaker: 'you', text: 'x' })
    ).toBe(false)
    expect(text(h)).toBe('THEM: private')
  })

  it('refuses a frame the scope resolver does not know (signed out) and holds nothing', () => {
    const h = harness()
    h.signedOut()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'nobody' }))
    expect(h.registry.acquire(FRAME, 'conversation')).toBeNull()
  })

  it('serves nothing once the signed-in owner is not the owner that opened the meeting', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'mine' }))
    h.owner.current = HEX_B
    expect(h.registry.acquire(FRAME, 'conversation')).toBeNull()
  })

  it('a new meeting ends the previous one, and its in-flight snapshots go stale', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'old meeting' }))
    const old = h.registry.acquire(FRAME, 'conversation')
    h.registry.ingestDelivered(FRAME, STARTED + 60_000, segment({ sequence: 1, index: 1, text: 'new meeting' }))
    expect(old?.check()).toEqual({ state: 'stale', code: 'SESSION_STOPPED' })
    expect(text(h)).toBe('THEM: new meeting')
  })

  it('closing a meeting (saved, discarded, owner revoked) stops its context', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'x' }))
    const handle = h.registry.acquire(FRAME, 'conversation')
    h.registry.closeFrame('12:3')
    expect(handle?.check()).toEqual({ state: 'stale', code: 'SESSION_STOPPED' })
    expect(h.registry.acquire(FRAME, 'conversation')).toBeNull()
    h.registry.ingestDelivered(FRAME, STARTED + 5, segment({ sequence: 1, index: 1, text: 'y' }))
    h.registry.close(STARTED + 5)
    expect(h.registry.acquire(FRAME, 'conversation')).toBeNull()
  })
})

describe('GATE-11: one revision reaches every output', () => {
  it('ask, suggest, screen and follow-up read the same context revision and the same transcript', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'we need a decision by friday' }))
    h.registry.ingestLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 9_000, speaker: 'you', text: 'agreed' })
    const handles = SESSION_OUTPUT_KINDS.map((kind) => h.registry.acquire(FRAME, kind))
    expect(handles.every((handle) => handle !== null)).toBe(true)
    const revisions = new Set(handles.map((handle) => handle!.snapshot.contextRevision))
    const generations = new Set(handles.map((handle) => handle!.snapshot.generation))
    const transcripts = new Set(handles.map((handle) => JSON.stringify(handle!.snapshot.transcript)))
    const rendered = new Set(handles.map((handle) => transcriptTailText(handle!.snapshot, 6_000)))
    expect([...revisions]).toHaveLength(1)
    expect([...generations]).toHaveLength(1)
    expect([...transcripts]).toHaveLength(1)
    expect([...rendered]).toEqual(['THEM: we need a decision by friday\nYOU: agreed'])
    expect(handles.map((handle) => handle!.snapshot.outputKind)).toEqual([...SESSION_OUTPUT_KINDS])
  })

  it('a new final advances the revision for every output at once', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'one' }))
    const before = SESSION_OUTPUT_KINDS.map((kind) => h.registry.acquire(FRAME, kind)!)
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 2, index: 2, text: 'two' }))
    const after = SESSION_OUTPUT_KINDS.map((kind) => h.registry.acquire(FRAME, kind)!)
    const revisionBefore = before[0]!.snapshot.contextRevision
    const revisionAfter = after[0]!.snapshot.contextRevision
    expect(revisionAfter).toBeGreaterThan(revisionBefore)
    expect(new Set(after.map((handle) => handle.snapshot.contextRevision))).toEqual(new Set([revisionAfter]))
    expect(new Set(before.map((handle) => handle.check().state))).toEqual(new Set(['advanced']))
    expect(new Set(after.map((handle) => handle.check().state))).toEqual(new Set(['current']))
  })

  it('an unrelated partial moves nothing: the revision only advances with usable text', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'one' }))
    const before = h.registry.acquire(FRAME, 'conversation')!
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 2, index: 2, text: 'tw', final: false }))
    expect(before.check()).toEqual({ state: 'current' })
  })
})

describe('a stale snapshot is refused', () => {
  it('a permission change (Private View on) makes snapshots taken before it stale, not merely advanced', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'x' }))
    const handle = h.registry.acquire(FRAME, 'screen')!
    expect(handle.check()).toEqual({ state: 'current' })
    h.permissions.current = meetingPermissions(true)
    expect(handle.check()).toEqual({ state: 'stale', code: 'STALE_GENERATION' })
    // A snapshot taken after the change is in force again.
    expect(h.registry.acquire(FRAME, 'screen')?.check()).toEqual({ state: 'current' })
  })

  it('a snapshot is advanced (not stale) when only the transcript moved on', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'a' }))
    const handle = h.registry.acquire(FRAME, 'manual')!
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 2, index: 2, text: 'b' }))
    expect(handle.check()).toEqual({ state: 'advanced' })
  })

  it('stopping everything (quit, sign-out) refuses every snapshot still in flight', () => {
    const h = harness()
    h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: 1, index: 1, text: 'a' }))
    const fromA = h.registry.acquire(FRAME, 'conversation')!
    expect(fromA.check().state).toBe('current')
    h.registry.closeAll()
    expect(fromA.check()).toEqual({ state: 'stale', code: 'SESSION_STOPPED' })
    expect(h.registry.acquire(FRAME, 'conversation')).toBeNull()
  })
})

describe('meeting scope resolver', () => {
  const authority = (current: OwnerSessionRef | null, minted: OwnerSessionRef | null = null) => ({
    current: vi.fn(() => current),
    mint: vi.fn(() => minted)
  })

  it('builds the scope from the trusted owner ref and the meeting, never the per-sign-in session id', () => {
    const resolve = createMeetingScopeResolver({
      ownerSession: authority(ref()),
      contextRevision: () => 1,
      unsignedAllowed: () => false
    })
    const resolved = resolve(FRAME, STARTED)
    expect(resolved).toEqual({
      ownerKey: HEX_A,
      scope: { tenantId: HEX_T, userId: HEX_A, sessionId: `meeting-${STARTED}` }
    })
  })

  it('mints a ref when none is live yet (main-side, from the IPC frame)', () => {
    const owner = authority(null, ref())
    const resolve = createMeetingScopeResolver({
      ownerSession: owner,
      contextRevision: () => 7,
      unsignedAllowed: () => false
    })
    expect(resolve(FRAME, STARTED)?.ownerKey).toBe(HEX_A)
    expect(owner.mint).toHaveBeenCalledWith(FRAME, 7)
  })

  it('holds nothing for a signed-out app that has sign-in configured', () => {
    const resolve = createMeetingScopeResolver({
      ownerSession: authority(null),
      contextRevision: () => 1,
      unsignedAllowed: () => false
    })
    expect(resolve(FRAME, STARTED)).toBeNull()
  })

  it('uses a fixed local scope only while sign-in is not configured at all', () => {
    const resolve = createMeetingScopeResolver({
      ownerSession: authority(null),
      contextRevision: () => 1,
      unsignedAllowed: () => true
    })
    expect(resolve(FRAME, STARTED)).toEqual({
      ownerKey: 'local',
      scope: { tenantId: 'local', userId: 'local', sessionId: `meeting-${STARTED}` }
    })
  })

  it('treats a throwing mint as no owner', () => {
    const resolve = createMeetingScopeResolver({
      ownerSession: {
        current: () => null,
        mint: () => {
          throw new Error('owner-session-refused')
        }
      },
      contextRevision: () => 1,
      unsignedAllowed: () => false
    })
    expect(resolve(FRAME, STARTED)).toBeNull()
  })
})

describe('meetingPermissions', () => {
  it('drops the screen permission while Private View is on', () => {
    expect(meetingPermissions(false)).toEqual(['screen.read', 'transcript.read'])
    expect(meetingPermissions(true)).toEqual(['transcript.read'])
  })
})
