import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalAck, JournalEntry } from '@shared/contracts/journal'
import { createJournalCadence, FINALS_BATCH_MS, REVISION_DEBOUNCE_MS } from './cadence'

const line = (text: string, t: number) => ({ speaker: 'them' as const, text, t })

function harness(fail = false) {
  const writes: { at: number; entries: JournalEntry[] }[] = []
  let seq = 0
  const sink = vi.fn(async (entries: JournalEntry[]): Promise<JournalAck> => {
    writes.push({ at: Date.now(), entries })
    if (fail) throw new Error('disk full')
    const fromSeq = seq + 1
    seq += entries.length
    return { sessionId: 's1', fromSeq, toSeq: seq, savedAt: Date.now() }
  })
  const onAck = vi.fn()
  const onError = vi.fn()
  return { writes, sink, onAck, onError, cadence: createJournalCadence(sink, { onAck, onError }) }
}

describe('journal cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('batches transcript finals into one write at most every 2 s', async () => {
    const { writes, cadence } = harness()
    cadence.final(line('a', 0))
    await vi.advanceTimersByTimeAsync(500)
    cadence.final(line('b', 500))
    await vi.advanceTimersByTimeAsync(1400)
    cadence.final(line('c', 1900))
    await vi.advanceTimersByTimeAsync(99)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(writes).toEqual([{ at: FINALS_BATCH_MS, entries: [{ kind: 'finals', lines: [line('a', 0), line('b', 500), line('c', 1900)] }] }])

    await vi.advanceTimersByTimeAsync(100)
    cadence.final(line('d', 2100))
    await vi.advanceTimersByTimeAsync(FINALS_BATCH_MS)
    expect(writes.map((w) => w.at)).toEqual([2000, 4100])
    expect(writes[1].entries).toEqual([{ kind: 'finals', lines: [line('d', 2100)] }])
  })

  it('never journals a provisional caption', async () => {
    const { writes, cadence } = harness()
    cadence.final({ ...line('typing…', 0), provisional: true })
    await vi.advanceTimersByTimeAsync(FINALS_BATCH_MS * 2)
    expect(writes).toEqual([])
  })

  it('debounces recap and note revisions 500 ms each and writes only the newest text', async () => {
    const { writes, cadence } = harness()
    cadence.revise('recap', 'D')
    await vi.advanceTimersByTimeAsync(300)
    cadence.revise('recap', 'Decisions')
    cadence.revise('note', 'call Ana')
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS - 1)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(writes).toEqual([
      { at: 800, entries: [{ kind: 'revision', doc: 'recap', text: 'Decisions' }] },
      { at: 800, entries: [{ kind: 'revision', doc: 'note', text: 'call Ana' }] }
    ])
  })

  it('reports the ack once the sink has made the records durable', async () => {
    const { onAck, onError, cadence } = harness()
    cadence.revise('note', 'x')
    await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS)
    expect(onAck).toHaveBeenCalledWith({ sessionId: 's1', fromSeq: 1, toSeq: 1, savedAt: REVISION_DEBOUNCE_MS })
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a failed write instead of an ack', async () => {
    const { onAck, onError, cadence } = harness(true)
    cadence.final(line('a', 0))
    await vi.advanceTimersByTimeAsync(FINALS_BATCH_MS)
    expect(onAck).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(new Error('disk full'))
  })

  it('flush writes everything pending in one append and cancels the pending timers', async () => {
    const { writes, onAck, cadence } = harness()
    cadence.final(line('a', 0))
    cadence.revise('recap', 'R')
    cadence.revise('note', 'N')
    await cadence.flush()
    expect(writes).toEqual([
      {
        at: 0,
        entries: [
          { kind: 'finals', lines: [line('a', 0)] },
          { kind: 'revision', doc: 'recap', text: 'R' },
          { kind: 'revision', doc: 'note', text: 'N' }
        ]
      }
    ])
    expect(onAck).toHaveBeenCalledWith({ sessionId: 's1', fromSeq: 1, toSeq: 3, savedAt: 0 })
    await vi.advanceTimersByTimeAsync(FINALS_BATCH_MS * 2)
    expect(writes).toHaveLength(1)
    await cadence.flush()
    expect(writes).toHaveLength(1)
  })
})
