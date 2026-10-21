import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { TranscriptLine } from '@shared/transcript-line'
import { evictOldest } from './bounded-map'
import { journalCommittedLine } from './meeting-journal-seam'

const speech = (final: boolean): Extract<CloudSpeechEvent, { type: 'segment' }> => ({
  type: 'segment',
  captureId: '11111111-1111-4111-8111-111111111111',
  captureGeneration: 1,
  sequence: 1,
  segment: {
    stream: { generation: 1, track: 'system', epoch: 1 },
    engine: 'deepgram-nova3',
    index: 1,
    revision: 1,
    final,
    text: 'hello there',
    startMs: 0,
    endMs: 900
  }
})
const cloudLine: TranscriptLine = { speaker: 'them', text: 'hello there', t: 5, speech: speech(true) }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('journalCommittedLine', () => {
  it('calls the bridge once with only the meeting start and the line', () => {
    const appendMeetingJournal = vi.fn(async () => ({ status: 'durable' }))
    vi.stubGlobal('window', { toto: { appendMeetingJournal } })
    journalCommittedLine(1_700_000_000_000, cloudLine)
    expect(appendMeetingJournal).toHaveBeenCalledExactlyOnceWith({ startedAt: 1_700_000_000_000, line: cloudLine })
  })

  it('ignores local lines, provisional lines, non-final speech and a missing meeting start', () => {
    const appendMeetingJournal = vi.fn(async () => ({ status: 'durable' }))
    vi.stubGlobal('window', { toto: { appendMeetingJournal } })
    journalCommittedLine(1, { speaker: 'you', text: 'local', t: 1 })
    journalCommittedLine(1, { ...cloudLine, provisional: true })
    journalCommittedLine(1, { ...cloudLine, speech: speech(false) })
    journalCommittedLine(undefined, cloudLine)
    expect(appendMeetingJournal).not.toHaveBeenCalled()
  })

  it('returns synchronously and swallows a rejecting, throwing or absent bridge', async () => {
    vi.stubGlobal('window', { toto: { appendMeetingJournal: vi.fn(async () => Promise.reject(new Error('no'))) } })
    expect(journalCommittedLine(1, cloudLine)).toBeUndefined()
    vi.stubGlobal('window', {
      toto: {
        appendMeetingJournal: vi.fn(() => {
          throw new Error('no')
        })
      }
    })
    expect(journalCommittedLine(1, cloudLine)).toBeUndefined()
    vi.stubGlobal('window', { toto: {} })
    expect(journalCommittedLine(1, cloudLine)).toBeUndefined()
    await Promise.resolve()
  })
})

describe('evictOldest', () => {
  it('drops the oldest-inserted entries down to the cap and leaves a smaller map alone', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3]
    ])
    evictOldest(map, 5)
    expect([...map.keys()]).toEqual(['a', 'b', 'c'])
    evictOldest(map, 2)
    expect([...map.keys()]).toEqual(['b', 'c'])
    evictOldest(map, 0)
    expect(map.size).toBe(0)
  })
})
