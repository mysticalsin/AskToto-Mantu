import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { TranscriptLine } from '@shared/transcript-line'
import { evictOldest } from './bounded-map'
import { journalCommittedLine, retractCommittedLine } from './meeting-journal-seam'

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

describe('ledger forwarding (G13)', () => {
  it('forwards a committed local final to the ledger bridge with text and identity only, never to the journal', () => {
    const appendMeetingJournal = vi.fn(async () => ({ status: 'durable' }))
    const appendSessionLedgerLine = vi.fn(async () => ({ status: 'accepted' }))
    vi.stubGlobal('window', { toto: { appendMeetingJournal, appendSessionLedgerLine } })
    journalCommittedLine(77, { speaker: 'them', text: 'a local sentence', t: 90, name: 'Alice', lang: 'English' })
    expect(appendSessionLedgerLine).toHaveBeenCalledExactlyOnceWith({
      op: 'final',
      startedAt: 77,
      t: 90,
      speaker: 'them',
      text: 'a local sentence'
    })
    expect(appendMeetingJournal).not.toHaveBeenCalled()
  })

  it('never forwards a relay segment (main sees it), a provisional line, or a line with no meeting start', () => {
    const appendSessionLedgerLine = vi.fn(async () => ({ status: 'accepted' }))
    vi.stubGlobal('window', { toto: { appendMeetingJournal: vi.fn(async () => ({})), appendSessionLedgerLine } })
    journalCommittedLine(1, cloudLine)
    journalCommittedLine(1, { speaker: 'you', text: '…', t: 1, provisional: true })
    journalCommittedLine(undefined, { speaker: 'you', text: 'x', t: 1 })
    expect(appendSessionLedgerLine).not.toHaveBeenCalled()
  })

  it('retracts a dropped line by its identity and never needs the bridge to exist', () => {
    const appendSessionLedgerLine = vi.fn(async () => ({ status: 'accepted' }))
    vi.stubGlobal('window', { toto: { appendSessionLedgerLine } })
    retractCommittedLine(77, 90)
    expect(appendSessionLedgerLine).toHaveBeenCalledExactlyOnceWith({ op: 'retract', startedAt: 77, t: 90 })
    retractCommittedLine(undefined, 90)
    expect(appendSessionLedgerLine).toHaveBeenCalledTimes(1)
    vi.stubGlobal('window', { toto: {} })
    expect(retractCommittedLine(77, 90)).toBeUndefined()
    expect(journalCommittedLine(77, { speaker: 'you', text: 'x', t: 1 })).toBeUndefined()
  })

  it('swallows a rejecting or throwing ledger bridge', async () => {
    vi.stubGlobal('window', { toto: { appendSessionLedgerLine: vi.fn(async () => Promise.reject(new Error('no'))) } })
    expect(journalCommittedLine(1, { speaker: 'you', text: 'x', t: 1 })).toBeUndefined()
    vi.stubGlobal('window', {
      toto: {
        appendSessionLedgerLine: vi.fn(() => {
          throw new Error('no')
        })
      }
    })
    expect(journalCommittedLine(1, { speaker: 'you', text: 'x', t: 1 })).toBeUndefined()
    expect(retractCommittedLine(1, 1)).toBeUndefined()
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
