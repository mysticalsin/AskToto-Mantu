import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { DEFAULT_SPOKEN_REPLIES_SETTINGS, type SpokenRepliesSettings } from '@shared/spoken-replies-settings'
import type { SpokenRepliesState, TtsVoice } from '@shared/spoken-replies'
import { SPOKEN_REPLIES_PREVIEW_TEXT } from '@shared/spoken-replies'
import {
  createSpokenReplies,
  VOICE_LIST_TTL_MS,
  type ReplyLifecycleEvent,
  type SpokenRepliesAudit,
  type SpokenRepliesDeps
} from './spoken-replies-service'
import type { TtsAdapter, TtsPlaybackHandlers, TtsSpeakRequest } from './tts-adapter'

const SAMANTHA: TtsVoice = { id: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US' }
const AMELIE: TtsVoice = { id: 'com.apple.voice.compact.fr-FR.Amelie', name: 'Amelie', language: 'fr-FR' }
const NOVELTY: TtsVoice = { id: 'com.apple.speech.synthesis.voice.BadNews', name: 'Bad News', language: 'en-US' }

interface Play {
  request: TtsSpeakRequest
  handlers: TtsPlaybackHandlers
  cancelled: number
}

function fakeAdapter(voices: TtsVoice[] | null = [SAMANTHA, AMELIE, NOVELTY]) {
  const plays: Play[] = []
  let listCalls = 0
  let listedVoices = voices
  let pendingList: ((value: TtsVoice[] | null) => void) | null = null
  let holdList = false
  const adapter: TtsAdapter = {
    platform: 'darwin',
    listVoices() {
      listCalls += 1
      if (holdList) return new Promise((resolve) => (pendingList = resolve))
      return Promise.resolve(listedVoices)
    },
    speak(request, handlers) {
      const play: Play = { request, handlers, cancelled: 0 }
      plays.push(play)
      return {
        cancel() {
          play.cancelled += 1
        }
      }
    }
  }
  return {
    adapter,
    plays,
    listCalls: () => listCalls,
    setVoices: (value: TtsVoice[] | null) => (listedVoices = value),
    holdVoiceList: () => (holdList = true),
    releaseVoiceList: (value: TtsVoice[] | null) => pendingList?.(value)
  }
}

function harness(
  overrides: Partial<SpokenRepliesSettings> = {},
  options: {
    adapter?: TtsAdapter | null
    fake?: ReturnType<typeof fakeAdapter>
    meeting?: boolean
    onReplyLifecycle?: (event: ReplyLifecycleEvent) => void
  } = {}
) {
  const fake = options.fake ?? fakeAdapter()
  let settings: SpokenRepliesSettings = { ...DEFAULT_SPOKEN_REPLIES_SETTINGS, speakReplies: true, ...overrides }
  let meeting = options.meeting ?? false
  let now = 1_000
  const states: SpokenRepliesState[] = []
  const audits: SpokenRepliesAudit[] = []
  const lifecycle: ReplyLifecycleEvent[] = []
  const deps: SpokenRepliesDeps = {
    adapter: options.adapter === undefined ? fake.adapter : options.adapter,
    platform: 'darwin',
    getSettings: () => ({ spokenReplies: settings }),
    meetingLive: () => meeting,
    now: () => now,
    onState: (state) => states.push(state),
    audit: (event) => audits.push(event),
    // The lifecycle port is intentionally cast during the tests-first slice; production has no port yet.
    onReplyLifecycle: (event: ReplyLifecycleEvent) => {
      lifecycle.push(event)
      options.onReplyLifecycle?.(event)
    }
  }
  const service = createSpokenReplies(deps)
  return {
    service,
    fake,
    states,
    audits,
    lifecycle,
    set: (next: Partial<SpokenRepliesSettings>) => {
      settings = { ...settings, ...next }
    },
    setMeeting: (value: boolean) => {
      meeting = value
    },
    tick: (ms: number) => {
      now += ms
    }
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** A typed ask that streams `text` and completes. */
async function answer(service: ReturnType<typeof harness>['service'], id: string, text: string, mode = 'answer') {
  service.observeAsk({ type: 'begin', id, mode })
  service.observeAsk({ type: 'event', id, channel: IPC.streamDelta, payload: { id, text } })
  service.observeAsk({ type: 'event', id, channel: IPC.streamDone, payload: { id } })
  await flush()
}

describe('speaking a reply (G27)', () => {
  it('reads the answer once it is complete, as sanitized text, with an approved installed voice and the saved rate', async () => {
    const h = harness({ rate: 1.25 })
    await answer(h.service, 'a1', 'The room is **B12**. See [the map](https://example.test/m).')
    expect(h.fake.plays).toHaveLength(1)
    expect(h.fake.plays[0].request).toEqual({
      text: 'The room is B12. See the map.',
      voiceId: SAMANTHA.id,
      rate: 1.25
    })
  })

  it('speaks nothing while speakReplies is off (the default): the ask path is untouched and no process starts', async () => {
    const h = harness({ speakReplies: false })
    await answer(h.service, 'a1', 'Hello there.')
    expect(h.fake.plays).toHaveLength(0)
    expect(h.service.snapshot()).toMatchObject({ muted: 'off', playback: 'idle', available: true })
    expect(h.fake.listCalls()).toBe(0)
  })

  it('speaks the assistant answer only: suggestions, summaries and recaps are never read aloud', async () => {
    const h = harness()
    for (const mode of ['suggest', 'summary', 'recap'])
      await answer(h.service, `m-${mode}`, 'Transcript-derived text.', mode)
    expect(h.fake.plays).toHaveLength(0)
  })

  it('does not speak while a meeting is recording (the speaker would be captured), and reports why', async () => {
    const h = harness({}, { meeting: true })
    await answer(h.service, 'a1', 'Hello there.')
    expect(h.fake.plays).toHaveLength(0)
    expect(h.service.snapshot().muted).toBe('meeting')
  })

  it('an error or a cancel ends the pending reply: nothing is spoken for it', async () => {
    const h = harness()
    h.service.observeAsk({ type: 'begin', id: 'a1', mode: 'answer' })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDelta, payload: { id: 'a1', text: 'partial' } })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamError, payload: { id: 'a1', message: 'x' } })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDone, payload: { id: 'a1' } })
    await flush()
    expect(h.fake.plays).toHaveLength(0)
  })

  it('ignores deltas and a done for an ask it never saw, and malformed payloads', async () => {
    const h = harness()
    h.service.observeAsk({ type: 'event', id: 'ghost', channel: IPC.streamDelta, payload: { id: 'ghost', text: 'x' } })
    h.service.observeAsk({ type: 'event', id: 'ghost', channel: IPC.streamDone, payload: { id: 'ghost' } })
    h.service.observeAsk({ type: 'begin', id: 'a1', mode: 'answer' })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDelta, payload: null })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDelta, payload: { id: 'a1', text: 5 } })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDone, payload: { id: 'a1' } })
    await flush()
    expect(h.fake.plays).toHaveLength(0)
  })

  it('an answer made only of code or links has nothing to say', async () => {
    const h = harness()
    await answer(h.service, 'a1', '```\nonly code\n```')
    expect(h.fake.plays).toHaveLength(0)
  })
})

describe('approved voices (G27, D-13)', () => {
  it('uses the saved voice only when approved, otherwise the first approved installed voice', async () => {
    const good = harness({ voiceId: AMELIE.id })
    await answer(good.service, 'a1', 'Bonjour.')
    expect(good.fake.plays[0].request.voiceId).toBe(AMELIE.id)

    const novelty = harness({ voiceId: NOVELTY.id })
    await answer(novelty.service, 'a1', 'Hello.')
    expect(novelty.fake.plays[0].request.voiceId).toBe(SAMANTHA.id)

    const gone = harness({ voiceId: 'com.apple.voice.premium.en-US.Zoe' })
    await answer(gone.service, 'a1', 'Hello.')
    expect(gone.fake.plays[0].request.voiceId).toBe(SAMANTHA.id)
  })

  it('lists installed voices through the approved filter and caches the list for a bounded time', async () => {
    const h = harness()
    expect((await h.service.listVoices()).map((v) => v.name)).toEqual(['Samantha', 'Amelie'])
    await h.service.listVoices()
    expect(h.fake.listCalls()).toBe(1)
    h.tick(VOICE_LIST_TTL_MS + 1)
    await h.service.listVoices()
    expect(h.fake.listCalls()).toBe(2)
  })

  it('an unreachable engine lists nothing and is reported unavailable, with no throw', async () => {
    const fake = fakeAdapter(null)
    const h = harness({}, { adapter: fake.adapter })
    expect(await h.service.listVoices()).toEqual([])
    expect(h.service.snapshot()).toMatchObject({ available: false, muted: 'unavailable' })
  })

  it('an empty approved list reports unavailable and reprobes after a settings change', async () => {
    const fake = fakeAdapter([])
    const h = harness({ voiceId: 'removed-voice' }, { adapter: fake.adapter })
    expect(await h.service.listVoices()).toEqual([])
    expect(h.service.snapshot()).toMatchObject({ available: false, muted: 'unavailable' })

    fake.setVoices([SAMANTHA])
    h.set({ rate: 1.1 })
    h.service.refresh()
    expect(await h.service.listVoices()).toEqual([SAMANTHA])
    expect(h.service.snapshot()).toMatchObject({ available: true, muted: null })
    await answer(h.service, 'voice-recovered', 'Use the approved voice after recovery.')
    expect(fake.plays.map((play) => play.request.voiceId)).toEqual([SAMANTHA.id])
  })

  it('refuses a reply when no approved installed voice is available instead of using a system default', async () => {
    const fake = fakeAdapter([])
    const h = harness({ voiceId: 'removed-voice' }, { adapter: fake.adapter })
    await answer(h.service, 'no-approved-voice', 'Do not use an unchecked default.')
    expect(fake.plays).toHaveLength(0)
  })
})

describe('playback generation and barge-in (G27)', () => {
  it('keeps the ask identity through pending enumeration and settles one terminal despite duplicate/late callbacks', async () => {
    let h!: ReturnType<typeof harness>
    const listCallsAtPending: number[] = []
    h = harness(
      { voiceId: AMELIE.id },
      {
        onReplyLifecycle(event) {
          if (event.phase === 'pending') listCallsAtPending.push(h.fake.listCalls())
          throw new Error('observer is isolated')
        }
      }
    )
    h.fake.holdVoiceList()
    await answer(h.service, 'ask-lifecycle', 'A synthetic answer.')
    const generation = h.service.snapshot().generation

    expect(h.lifecycle).toEqual([{ phase: 'pending', askId: 'ask-lifecycle', generation }])
    expect(listCallsAtPending).toEqual([0])
    expect(h.fake.listCalls()).toBe(1)

    h.fake.releaseVoiceList([SAMANTHA, AMELIE])
    await vi.waitFor(() => expect(h.fake.plays).toHaveLength(1))
    h.fake.plays[0].handlers.onStarted()
    h.fake.plays[0].handlers.onStarted()
    h.fake.plays[0].handlers.onEnded('finished')
    h.fake.plays[0].handlers.onEnded('finished')
    h.fake.plays[0].handlers.onFailed('spawn')

    expect(h.lifecycle).toEqual([
      { phase: 'pending', askId: 'ask-lifecycle', generation },
      { phase: 'started', askId: 'ask-lifecycle', generation },
      { phase: 'settled', askId: 'ask-lifecycle', generation, outcome: 'finished' }
    ])
    expect(h.service.snapshot().playback).toBe('idle')
  })

  it('settles muted, unavailable, meeting and empty answers without starting playback', async () => {
    const off = harness({ speakReplies: false })
    await answer(off.service, 'off-answer', 'Muted answer.')
    expect(off.lifecycle.map((event) => (event.phase === 'settled' ? event.outcome : event.phase))).toEqual([
      'pending',
      'off'
    ])

    const unavailable = harness({}, { adapter: null })
    await answer(unavailable.service, 'unavailable-answer', 'Unavailable answer.')
    expect(unavailable.lifecycle.map((event) => (event.phase === 'settled' ? event.outcome : event.phase))).toEqual([
      'pending',
      'unavailable'
    ])

    const meeting = harness({}, { meeting: true })
    await answer(meeting.service, 'meeting-answer', 'Muted meeting answer.')
    expect(meeting.lifecycle.map((event) => (event.phase === 'settled' ? event.outcome : event.phase))).toEqual([
      'pending',
      'meeting'
    ])

    const empty = harness()
    await answer(empty.service, 'empty-answer', '```\ncode only\n```')
    expect(empty.lifecycle.map((event) => (event.phase === 'settled' ? event.outcome : event.phase))).toEqual([
      'pending',
      'empty'
    ])
    expect(off.fake.plays).toHaveLength(0)
    expect(unavailable.fake.plays).toHaveLength(0)
    expect(meeting.fake.plays).toHaveLength(0)
    expect(empty.fake.plays).toHaveLength(0)
  })

  it('settles an engine failure once, even when the adapter reports more callbacks afterward', async () => {
    const h = harness()
    await answer(h.service, 'failed-answer', 'A synthetic answer.')
    h.fake.plays[0].handlers.onFailed('spawn')
    h.fake.plays[0].handlers.onEnded('finished')
    h.fake.plays[0].handlers.onFailed('spawn')

    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'failed-answer', generation: 1, outcome: 'failed' }
    ])
  })

  it('settles an Ask stream error while its answer is still being collected', () => {
    const h = harness()
    h.service.observeAsk({ type: 'begin', id: 'collection-error', mode: 'answer' })
    const pending = h.lifecycle.find((event) => event.phase === 'pending')
    if (!pending || pending.phase !== 'pending') throw new Error('expected identity at Ask begin')
    h.service.observeAsk({
      type: 'event',
      id: 'collection-error',
      channel: IPC.streamDelta,
      payload: { id: 'collection-error', text: 'Partial only.' }
    })
    h.service.observeAsk({
      type: 'event',
      id: 'collection-error',
      channel: IPC.streamError,
      payload: { id: 'collection-error', message: 'Synthetic failure.' }
    })

    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: pending.askId, generation: pending.generation, outcome: 'failed' }
    ])
    expect(h.fake.plays).toHaveLength(0)
  })

  it('settles a collecting Ask as cancelled immediately when its main ask id is cancelled', () => {
    const h = harness()
    h.service.observeAsk({ type: 'begin', id: 'collection-cancel', mode: 'vision' })
    const pending = h.lifecycle.find((event) => event.phase === 'pending')
    if (!pending || pending.phase !== 'pending') throw new Error('expected identity at Ask begin')
    h.service.observeAsk({ type: 'cancel', id: 'collection-cancel' })

    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: pending.askId, generation: pending.generation, outcome: 'cancelled' }
    ])
  })

  it('settles a pending answer on Stop before enumeration resolves and ignores its late result', async () => {
    const h = harness()
    h.fake.holdVoiceList()
    await answer(h.service, 'pending-stop', 'Must not play after Stop.')
    const pending = h.lifecycle.find((event) => event.phase === 'pending')
    if (!pending || pending.phase !== 'pending') throw new Error('expected pending lifecycle event')

    h.service.stop()
    h.fake.releaseVoiceList([SAMANTHA])
    await flush()

    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: pending.askId, generation: pending.generation, outcome: 'cancelled' }
    ])
    expect(h.fake.plays).toHaveLength(0)
  })

  it('settles a pending ask as superseded, then speaks only the newer ask from the shared voice load', async () => {
    const h = harness()
    h.fake.holdVoiceList()
    await answer(h.service, 'older-pending', 'Older answer.')
    const older = h.lifecycle.find((event) => event.phase === 'pending')
    if (!older || older.phase !== 'pending') throw new Error('expected older pending lifecycle event')

    h.service.observeAsk({ type: 'begin', id: 'newer-answer', mode: 'answer' })
    h.service.observeAsk({
      type: 'event',
      id: 'newer-answer',
      channel: IPC.streamDelta,
      payload: { id: 'newer-answer', text: 'Newer answer.' }
    })
    h.service.observeAsk({
      type: 'event',
      id: 'newer-answer',
      channel: IPC.streamDone,
      payload: { id: 'newer-answer' }
    })
    const newer = h.lifecycle.find((event) => event.phase === 'pending' && event.askId === 'newer-answer')
    if (!newer || newer.phase !== 'pending') throw new Error('expected newer pending lifecycle event')

    expect(h.lifecycle).toContainEqual({
      phase: 'settled',
      askId: older.askId,
      generation: older.generation,
      outcome: 'superseded'
    })
    h.fake.releaseVoiceList([SAMANTHA])
    await vi.waitFor(() => expect(h.fake.plays).toHaveLength(1))
    expect(h.fake.plays[0].request.text).toBe('Newer answer.')
    expect(h.lifecycle.some((event) => event.phase === 'started' && event.askId === 'older-pending')).toBe(false)
    h.fake.plays[0].handlers.onEnded('finished')
    expect(h.lifecycle.filter((event) => event.phase === 'settled' && event.askId === 'newer-answer')).toHaveLength(1)
  })

  it('settles superseded identities before the bounded pending map needs eviction', () => {
    const h = harness()
    for (let index = 0; index < 9; index += 1) {
      h.service.observeAsk({ type: 'begin', id: `bounded-${index}`, mode: 'answer' })
    }
    expect(h.lifecycle.filter((event) => event.phase === 'pending')).toHaveLength(9)
    for (let index = 0; index < 8; index += 1) {
      expect(h.lifecycle.filter((event) => event.phase === 'settled' && event.askId === `bounded-${index}`)).toEqual([
        expect.objectContaining({ phase: 'settled', outcome: 'superseded' })
      ])
    }
    expect(h.lifecycle.filter((event) => event.phase === 'settled' && event.askId === 'bounded-8')).toHaveLength(0)
  })

  it('settles active playback on Stop and ignores late adapter callbacks', async () => {
    const h = harness()
    await answer(h.service, 'active-stop', 'A synthetic answer.')
    h.fake.plays[0].handlers.onStarted()
    h.service.stop()
    h.fake.plays[0].handlers.onEnded('finished')
    h.fake.plays[0].handlers.onFailed('spawn')

    expect(h.fake.plays[0].cancelled).toBe(1)
    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toHaveLength(1)
    expect(h.lifecycle.filter((event) => event.phase === 'settled')[0]).toMatchObject({
      askId: 'active-stop',
      generation: 1,
      outcome: 'cancelled'
    })
  })

  it('settles active Ask A as superseded when Ask B begins and ignores A callbacks afterward', async () => {
    const h = harness()
    await answer(h.service, 'active-older', 'Older synthetic answer.')
    const older = h.lifecycle.find((event) => event.phase === 'pending')
    if (!older || older.phase !== 'pending') throw new Error('expected older pending lifecycle event')
    h.fake.plays[0].handlers.onStarted()

    h.service.observeAsk({ type: 'begin', id: 'active-newer', mode: 'answer' })
    h.fake.plays[0].handlers.onEnded('finished')
    h.fake.plays[0].handlers.onFailed('spawn')

    expect(h.fake.plays[0].cancelled).toBe(1)
    expect(h.lifecycle.filter((event) => event.phase === 'settled' && event.askId === older.askId)).toEqual([
      { phase: 'settled', askId: older.askId, generation: older.generation, outcome: 'superseded' }
    ])
    expect(h.service.snapshot().playback).toBe('idle')
  })

  it('cancels a synchronous onStarted callback when the observer stops before speak returns its handle', async () => {
    let h!: ReturnType<typeof harness>
    const fake = fakeAdapter()
    const speak = fake.adapter.speak.bind(fake.adapter)
    fake.adapter.speak = (request, handlers) => {
      handlers.onStarted()
      return speak(request, handlers)
    }
    h = harness(
      {},
      {
        fake,
        onReplyLifecycle(event) {
          if (event.phase === 'started') h.service.stop()
        }
      }
    )

    await answer(h.service, 'sync-start-stop', 'Started before speak returns.')

    expect(fake.plays).toHaveLength(1)
    expect(fake.plays[0].cancelled).toBe(1)
    expect(h.service.snapshot().playback).toBe('idle')
    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'sync-start-stop', generation: 1, outcome: 'cancelled' }
    ])
  })

  it('settles synchronous adapter failure once and handles a thrown speak without leaking an active reply', async () => {
    const syncFailure = harness()
    const failingPlay = syncFailure.fake.adapter.speak.bind(syncFailure.fake.adapter)
    syncFailure.fake.adapter.speak = (request, handlers) => {
      handlers.onFailed('spawn')
      return failingPlay(request, handlers)
    }
    await answer(syncFailure.service, 'sync-failure', 'The adapter fails before returning.')
    syncFailure.fake.plays[0].handlers.onEnded('finished')
    expect(syncFailure.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'sync-failure', generation: 1, outcome: 'failed' }
    ])
    expect(syncFailure.service.snapshot().playback).toBe('idle')

    const thrown = harness()
    thrown.fake.adapter.speak = () => {
      throw new Error('synthetic adapter failure')
    }
    await expect(answer(thrown.service, 'thrown-speak', 'The adapter throws.')).resolves.toBeUndefined()
    expect(thrown.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'thrown-speak', generation: 1, outcome: 'failed' }
    ])
    expect(thrown.service.snapshot().playback).toBe('idle')
  })

  it('an Ask A terminal observer can start Ask B without A cleanup clobbering B', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(
      {},
      {
        onReplyLifecycle(event) {
          if (event.phase === 'settled' && event.askId === 'settled-a' && event.outcome === 'finished') {
            h.service.observeAsk({ type: 'begin', id: 'reentrant-b', mode: 'answer' })
            h.service.observeAsk({
              type: 'event',
              id: 'reentrant-b',
              channel: IPC.streamDelta,
              payload: { id: 'reentrant-b', text: 'B remains current.' }
            })
            h.service.observeAsk({
              type: 'event',
              id: 'reentrant-b',
              channel: IPC.streamDone,
              payload: { id: 'reentrant-b' }
            })
          }
        }
      }
    )
    await answer(h.service, 'settled-a', 'A finishes.')
    h.fake.plays[0].handlers.onStarted()
    h.fake.plays[0].handlers.onEnded('finished')
    await vi.waitFor(() => expect(h.fake.plays).toHaveLength(2))
    h.fake.plays[1].handlers.onStarted()
    h.service.observeAsk({ type: 'cancel', id: 'reentrant-b' })

    expect(h.fake.plays[1].cancelled).toBe(1)
    expect(h.lifecycle.filter((event) => event.phase === 'settled' && event.askId === 'reentrant-b')).toEqual([
      { phase: 'settled', askId: 'reentrant-b', generation: 2, outcome: 'cancelled' }
    ])
  })

  it('settles immediately on mute or hard-stop before and after voice enumeration resolves', async () => {
    const muted = harness()
    muted.fake.holdVoiceList()
    await answer(muted.service, 'mute-before-list', 'Do not play muted speech.')
    muted.set({ speakReplies: false })
    muted.service.refresh()
    expect(muted.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'mute-before-list', generation: 1, outcome: 'off' }
    ])
    muted.fake.releaseVoiceList([SAMANTHA])
    await flush()
    expect(muted.lifecycle.filter((event) => event.phase === 'settled')).toHaveLength(1)
    expect(muted.fake.plays).toHaveLength(0)

    const beforeResolve = harness()
    beforeResolve.fake.holdVoiceList()
    await answer(beforeResolve.service, 'stop-before-list', 'Do not play after hard-stop.')
    const beforePending = beforeResolve.lifecycle.find((event) => event.phase === 'pending')
    if (!beforePending || beforePending.phase !== 'pending') throw new Error('expected Ask identity before hard-stop')
    beforeResolve.service.bargeIn('hard-stop')
    expect(beforeResolve.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: beforePending.askId, generation: beforePending.generation, outcome: 'cancelled' }
    ])
    beforeResolve.fake.releaseVoiceList([SAMANTHA])
    await flush()
    expect(beforeResolve.lifecycle.filter((event) => event.phase === 'settled')).toHaveLength(1)
    expect(beforeResolve.fake.plays).toHaveLength(0)

    const afterResolve = harness()
    afterResolve.fake.holdVoiceList()
    await answer(afterResolve.service, 'stop-after-list', 'Do not play after hard-stop.')
    const afterPending = afterResolve.lifecycle.find((event) => event.phase === 'pending')
    if (!afterPending || afterPending.phase !== 'pending')
      throw new Error('expected Ask identity before resolved hard-stop')
    afterResolve.fake.releaseVoiceList([SAMANTHA])
    afterResolve.service.bargeIn('hard-stop')
    await flush()
    expect(afterResolve.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: afterPending.askId, generation: afterPending.generation, outcome: 'cancelled' }
    ])
    expect(afterResolve.fake.plays).toHaveLength(0)
  })

  it('maps an interrupted playback end to one cancellation terminal, never a finish', async () => {
    const h = harness()
    await answer(h.service, 'interrupted-answer', 'This reply was interrupted.')
    h.fake.plays[0].handlers.onStarted()
    h.fake.plays[0].handlers.onEnded('interrupted')
    h.fake.plays[0].handlers.onEnded('finished')

    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'interrupted-answer', generation: 1, outcome: 'cancelled' }
    ])
  })

  it('allows a pending lifecycle observer to dispose reentrantly without speaking or double-settling', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(
      {},
      {
        onReplyLifecycle(event) {
          if (event.phase === 'pending') h.service.dispose()
        }
      }
    )
    h.fake.holdVoiceList()
    await answer(h.service, 'dispose-pending', 'Must not play after disposal.')
    h.fake.releaseVoiceList([SAMANTHA])
    await flush()

    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toHaveLength(1)
    expect(h.lifecycle.filter((event) => event.phase === 'settled')[0]).toMatchObject({
      askId: 'dispose-pending',
      generation: 1,
      outcome: 'cancelled'
    })
    expect(h.fake.plays).toHaveLength(0)
  })

  it('does not let a started observer reentrant Stop duplicate the cancellation terminal', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(
      {},
      {
        onReplyLifecycle(event) {
          if (event.phase === 'started') h.service.stop()
        }
      }
    )
    await answer(h.service, 'stop-from-started', 'A synthetic answer.')
    h.fake.plays[0].handlers.onStarted()
    h.fake.plays[0].handlers.onEnded('finished')

    expect(h.fake.plays[0].cancelled).toBe(1)
    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'stop-from-started', generation: 1, outcome: 'cancelled' }
    ])
  })

  it('never emits Ask playback lifecycle events for an explicit preview', async () => {
    const h = harness()
    await h.service.preview({ voiceId: AMELIE.id })
    h.fake.plays[0].handlers.onStarted()
    h.fake.plays[0].handlers.onEnded('finished')
    expect(h.lifecycle).toEqual([])
  })

  it('does not let a settled reply observer stop reentrant mutation get adopted by the outer preview', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(
      {},
      {
        onReplyLifecycle(event) {
          if (event.phase === 'settled' && event.askId === 'preview-stop-a') h.service.stop()
        }
      }
    )
    await answer(h.service, 'preview-stop-a', 'A synthetic answer.')
    h.fake.plays[0].handlers.onStarted()

    await expect(h.service.preview({ voiceId: AMELIE.id })).resolves.toEqual({ ok: false, reason: 'interrupted' })

    expect(h.fake.plays).toHaveLength(1)
    expect(h.service.snapshot().playback).toBe('idle')
  })

  it('does not let a settled reply observer start Ask B that the outer preview replaces', async () => {
    let h!: ReturnType<typeof harness>
    h = harness(
      {},
      {
        onReplyLifecycle(event) {
          if (event.phase !== 'settled' || event.askId !== 'preview-start-b') return
          h.service.observeAsk({ type: 'begin', id: 'preview-reentrant-b', mode: 'answer' })
          h.service.observeAsk({
            type: 'event',
            id: 'preview-reentrant-b',
            channel: IPC.streamDelta,
            payload: { id: 'preview-reentrant-b', text: 'B remains current.' }
          })
          h.service.observeAsk({
            type: 'event',
            id: 'preview-reentrant-b',
            channel: IPC.streamDone,
            payload: { id: 'preview-reentrant-b' }
          })
        }
      }
    )
    await answer(h.service, 'preview-start-b', 'A synthetic answer.')
    h.fake.plays[0].handlers.onStarted()

    await expect(h.service.preview({ voiceId: AMELIE.id })).resolves.toEqual({ ok: false, reason: 'interrupted' })

    expect(h.fake.plays).toHaveLength(2)
    expect(h.fake.plays[1].request.text).toBe('B remains current.')
    expect(h.service.snapshot().playback).toBe('reply')
    expect(
      h.lifecycle.filter((event) => event.phase === 'settled' && event.askId === 'preview-reentrant-b')
    ).toHaveLength(0)
  })

  it('every user input raises the generation: a new typed ask, a voice hold and a stop', () => {
    const h = harness()
    const g0 = h.service.snapshot().generation
    h.service.observeAsk({ type: 'begin', id: 'a1', mode: 'answer' })
    const g1 = h.service.snapshot().generation
    h.service.bargeIn('voice-hold')
    const g2 = h.service.snapshot().generation
    h.service.stop()
    const g3 = h.service.snapshot().generation
    expect(g1).toBeGreaterThan(g0)
    expect(g2).toBeGreaterThan(g1)
    expect(g3).toBeGreaterThan(g2)
  })

  it('a reply whose input was superseded is dropped, never spoken late', async () => {
    const h = harness()
    h.service.observeAsk({ type: 'begin', id: 'a1', mode: 'answer' })
    const pending = h.lifecycle.find((event) => event.phase === 'pending')
    if (!pending || pending.phase !== 'pending') throw new Error('expected captured Ask identity')
    h.service.observeAsk({
      type: 'event',
      id: 'a1',
      channel: IPC.streamDelta,
      payload: { id: 'a1', text: 'Old answer.' }
    })
    h.service.bargeIn('voice-hold')
    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: pending.askId, generation: pending.generation, outcome: 'cancelled' }
    ])
    expect(h.audits.some((a) => a.phase === 'dropped' && a.reason === 'stale')).toBe(true)
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDone, payload: { id: 'a1' } })
    await flush()
    expect(h.fake.plays).toHaveLength(0)
    expect(h.lifecycle.filter((event) => event.phase === 'settled')).toHaveLength(1)
  })

  it('a hold that starts mid-playback cancels the voice at once: idle immediately, the child killed, late events ignored', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'A long answer.')
    h.fake.plays[0].handlers.onStarted()
    expect(h.service.snapshot().playback).toBe('reply')
    h.service.bargeIn('voice-hold')
    expect(h.fake.plays[0].cancelled).toBe(1)
    expect(h.service.snapshot().playback).toBe('idle')
    h.fake.plays[0].handlers.onEnded('finished')
    h.fake.plays[0].handlers.onStarted()
    expect(h.service.snapshot().playback).toBe('idle')
  })

  it('a new typed ask cancels the previous reply before its own answer arrives', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'First answer.')
    h.fake.plays[0].handlers.onStarted()
    h.service.observeAsk({ type: 'begin', id: 'a2', mode: 'answer' })
    expect(h.fake.plays[0].cancelled).toBe(1)
    await answer(h.service, 'a3', 'Third answer.')
    expect(h.fake.plays).toHaveLength(2)
    expect(h.fake.plays[1].request.text).toBe('Third answer.')
  })

  it('a live suggestion is not user input: it does not interrupt a reply that is playing', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'First answer.')
    h.fake.plays[0].handlers.onStarted()
    h.service.observeAsk({ type: 'begin', id: 's1', mode: 'suggest' })
    expect(h.fake.plays[0].cancelled).toBe(0)
    expect(h.service.snapshot().playback).toBe('reply')
  })

  it('Stop silences playback', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'First answer.')
    h.fake.plays[0].handlers.onStarted()
    h.service.stop()
    expect(h.fake.plays[0].cancelled).toBe(1)
    expect(h.service.snapshot().playback).toBe('idle')
  })

  it('a cancelled ask is forgotten: its late done is never spoken. A cancel of an unknown ask changes nothing', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'First answer.')
    h.fake.plays[0].handlers.onStarted()
    h.service.observeAsk({ type: 'cancel', id: 'unknown' })
    expect(h.fake.plays[0].cancelled).toBe(0)
    h.service.observeAsk({ type: 'begin', id: 'a2', mode: 'answer' })
    h.service.observeAsk({ type: 'event', id: 'a2', channel: IPC.streamDelta, payload: { id: 'a2', text: 'Second.' } })
    h.service.observeAsk({ type: 'cancel', id: 'a2' })
    h.service.observeAsk({ type: 'event', id: 'a2', channel: IPC.streamDone, payload: { id: 'a2' } })
    await flush()
    expect(h.fake.plays).toHaveLength(1)
  })

  it('an input that arrives while the voice list is loading still wins: the reply is not spoken', async () => {
    const h = harness({ voiceId: AMELIE.id })
    h.fake.holdVoiceList()
    h.service.observeAsk({ type: 'begin', id: 'a1', mode: 'answer' })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDelta, payload: { id: 'a1', text: 'Hello.' } })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDone, payload: { id: 'a1' } })
    await flush()
    h.service.bargeIn('typed-ask')
    h.fake.releaseVoiceList([SAMANTHA, AMELIE])
    await flush()
    expect(h.fake.plays).toHaveLength(0)
  })

  it('turning replies off while approved voices are loading drops the pending reply', async () => {
    const h = harness({ voiceId: AMELIE.id })
    h.fake.holdVoiceList()
    await answer(h.service, 'pending-off', 'This answer must stay silent.')
    expect(h.fake.listCalls()).toBe(1)
    h.set({ speakReplies: false })
    h.service.refresh()
    h.fake.releaseVoiceList([SAMANTHA, AMELIE])
    await flush()
    expect(h.fake.plays).toHaveLength(0)
  })

  it('turning replies off then on while approved voices are loading does not revive the old reply', async () => {
    const h = harness({ voiceId: AMELIE.id })
    h.fake.holdVoiceList()
    await answer(h.service, 'pending-off-on', 'This answer must not revive.')
    expect(h.fake.listCalls()).toBe(1)
    h.set({ speakReplies: false })
    h.service.refresh()
    h.set({ speakReplies: true })
    h.service.refresh()
    h.fake.releaseVoiceList([SAMANTHA, AMELIE])
    await flush()
    expect(h.fake.plays).toHaveLength(0)
  })

  it('a meeting that starts silences the voice', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'First answer.')
    h.fake.plays[0].handlers.onStarted()
    h.service.bargeIn('meeting')
    expect(h.fake.plays[0].cancelled).toBe(1)
  })

  it('turning spoken replies off while a reply plays silences it; a preview in progress is not cut off', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'First answer.')
    h.fake.plays[0].handlers.onStarted()
    h.set({ speakReplies: false })
    h.service.refresh()
    expect(h.fake.plays[0].cancelled).toBe(1)
    expect(h.service.snapshot()).toMatchObject({ playback: 'idle', muted: 'off' })

    await h.service.preview({})
    h.fake.plays[1].handlers.onStarted()
    h.service.refresh()
    expect(h.fake.plays[1].cancelled).toBe(0)
  })

  it('turning automatic replies off while an explicit preview plays leaves the preview running', async () => {
    const h = harness()
    await h.service.preview({ voiceId: AMELIE.id })
    h.fake.plays[0].handlers.onStarted()
    h.set({ speakReplies: false })
    h.service.refresh()
    expect(h.fake.plays[0].cancelled).toBe(0)
    expect(h.service.snapshot().playback).toBe('preview')
  })

  it('turning automatic replies off while preview voice enumeration is pending preserves the preview', async () => {
    const h = harness()
    h.fake.holdVoiceList()
    const preview = h.service.preview({ voiceId: AMELIE.id })
    await flush()
    expect(h.fake.listCalls()).toBe(1)
    h.set({ speakReplies: false })
    h.service.refresh()
    h.fake.releaseVoiceList([SAMANTHA, AMELIE])
    await expect(preview).resolves.toEqual({ ok: true })
    expect(h.fake.plays).toHaveLength(1)
    expect(h.fake.plays[0].request.text).toBe(SPOKEN_REPLIES_PREVIEW_TEXT)
  })

  it('refuses a pending preview if meeting recording starts before voice enumeration finishes', async () => {
    const h = harness()
    h.fake.holdVoiceList()
    const preview = h.service.preview({ voiceId: AMELIE.id })
    await flush()
    h.setMeeting(true)
    h.fake.releaseVoiceList([SAMANTHA, AMELIE])
    await expect(preview).resolves.toEqual({ ok: false, reason: 'meeting' })
    expect(h.fake.plays).toHaveLength(0)
  })

  it('dispose silences the voice and refuses any later speech', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'First answer.')
    h.service.dispose()
    expect(h.fake.plays[0].cancelled).toBe(1)
    await answer(h.service, 'a2', 'Later answer.')
    expect(await h.service.preview({})).toMatchObject({ ok: false })
    expect(h.fake.plays).toHaveLength(1)
  })
})

describe('muted and unavailable keep everything else unchanged (G27)', () => {
  it('no adapter (a platform with no engine): nothing starts, nothing throws, state says unavailable', async () => {
    const h = harness({}, { adapter: null })
    await answer(h.service, 'a1', 'Hello.')
    expect(h.service.snapshot()).toMatchObject({ available: false, muted: 'unavailable', playback: 'idle' })
    expect(await h.service.listVoices()).toEqual([])
    expect(await h.service.preview({})).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('a failed engine start marks it unavailable and stops retrying until the settings change', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'Hello.')
    h.fake.plays[0].handlers.onFailed('spawn')
    expect(h.service.snapshot()).toMatchObject({ available: false, muted: 'unavailable', playback: 'idle' })
    await answer(h.service, 'a2', 'Again.')
    expect(h.fake.plays).toHaveLength(1)
    h.service.refresh()
    await answer(h.service, 'a2b', 'Still failed.')
    expect(h.fake.plays).toHaveLength(1)
    h.set({ rate: 1.1 })
    h.service.refresh()
    await answer(h.service, 'a3', 'Third.')
    expect(h.fake.plays).toHaveLength(2)
  })

  it('a voice that cannot be found is not an engine failure', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'Hello.')
    h.fake.plays[0].handlers.onFailed('no_voice')
    expect(h.service.snapshot().available).toBe(true)
  })

  it('a normal end returns to idle', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'Hello.')
    h.fake.plays[0].handlers.onStarted()
    h.fake.plays[0].handlers.onEnded('finished')
    expect(h.service.snapshot().playback).toBe('idle')
  })
})

describe('preview (G27)', () => {
  it('plays the fixed sentence with the pending voice and rate, even while spoken replies are off', async () => {
    const h = harness({ speakReplies: false })
    expect(await h.service.preview({ voiceId: AMELIE.id, rate: 1.5 })).toEqual({ ok: true })
    expect(h.fake.plays[0].request).toEqual({ text: SPOKEN_REPLIES_PREVIEW_TEXT, voiceId: AMELIE.id, rate: 1.5 })
    h.fake.plays[0].handlers.onStarted()
    expect(h.service.snapshot().playback).toBe('preview')
  })

  it('is interruptible: a second preview replaces the first, and stop ends it', async () => {
    const h = harness()
    await h.service.preview({ voiceId: SAMANTHA.id })
    h.fake.plays[0].handlers.onStarted()
    await h.service.preview({ voiceId: AMELIE.id })
    expect(h.fake.plays[0].cancelled).toBe(1)
    h.fake.plays[1].handlers.onStarted()
    h.service.stop()
    expect(h.fake.plays[1].cancelled).toBe(1)
    expect(h.service.snapshot().playback).toBe('idle')
  })

  it('clamps the rate, ignores an unapproved voice and falls back to an approved voice choice', async () => {
    const h = harness({ voiceId: AMELIE.id, rate: 0.75 })
    await h.service.preview({ voiceId: NOVELTY.id, rate: 99 })
    expect(h.fake.plays[0].request).toMatchObject({ voiceId: SAMANTHA.id, rate: 1.5 })
    await h.service.preview({})
    expect(h.fake.plays[1].request).toMatchObject({ voiceId: AMELIE.id, rate: 0.75 })
  })

  it('returns unavailable when voice enumeration fails and starts no preview with a system default', async () => {
    const fake = fakeAdapter(null)
    const h = harness({}, { adapter: fake.adapter })
    await expect(h.service.preview({ voiceId: AMELIE.id })).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(fake.plays).toHaveLength(0)
  })

  it('refuses preview when no approved installed voice is available', async () => {
    const fake = fakeAdapter([])
    const h = harness({}, { adapter: fake.adapter })
    await expect(h.service.preview({ voiceId: AMELIE.id })).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(fake.plays).toHaveLength(0)
  })

  it('cancels a reply that is playing and a reply that arrives later is dropped', async () => {
    const h = harness()
    h.service.observeAsk({ type: 'begin', id: 'a1', mode: 'answer' })
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDelta, payload: { id: 'a1', text: 'Hi.' } })
    await h.service.preview({})
    h.service.observeAsk({ type: 'event', id: 'a1', channel: IPC.streamDone, payload: { id: 'a1' } })
    await flush()
    expect(h.fake.plays).toHaveLength(1)
    expect(h.fake.plays[0].request.text).toBe(SPOKEN_REPLIES_PREVIEW_TEXT)
  })

  it('is refused while a meeting records', async () => {
    const h = harness({}, { meeting: true })
    expect(await h.service.preview({})).toMatchObject({ ok: false, reason: 'meeting' })
    expect(h.fake.plays).toHaveLength(0)
  })
})

describe('state (G27)', () => {
  it('pushes a new revision only when something visible changed', async () => {
    const h = harness()
    const start = h.service.snapshot().revision
    h.service.bargeIn('stop')
    h.service.bargeIn('stop')
    expect(h.states).toHaveLength(0)
    await answer(h.service, 'a1', 'Hello.')
    h.fake.plays[0].handlers.onStarted()
    expect(h.states.at(-1)).toMatchObject({ playback: 'reply' })
    h.fake.plays[0].handlers.onEnded('finished')
    expect(h.states.at(-1)).toMatchObject({ playback: 'idle' })
    expect(h.service.snapshot().revision).toBeGreaterThan(start)
    const revisions = h.states.map((s) => s.revision)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(new Set(revisions).size).toBe(revisions.length)
  })

  it('never carries reply text, a voice id or a transcript', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'Secret words.')
    h.fake.plays[0].handlers.onStarted()
    expect(JSON.stringify(h.states)).not.toContain('Secret')
    expect(Object.keys(h.service.snapshot()).sort()).toEqual([
      'available',
      'generation',
      'muted',
      'playback',
      'revision'
    ])
  })

  it('audits phases and machine reasons only, never text', async () => {
    const h = harness()
    await answer(h.service, 'a1', 'Secret words.')
    h.fake.plays[0].handlers.onStarted()
    h.service.bargeIn('voice-hold')
    expect(h.audits.length).toBeGreaterThan(0)
    expect(JSON.stringify(h.audits)).not.toContain('Secret')
    expect(h.audits.some((a) => a.phase === 'cancelled' && a.reason === 'voice-hold')).toBe(true)
  })
})
