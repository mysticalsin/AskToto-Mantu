import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { JournalAck } from '@shared/contracts/journal'
import { resetSecretKeyCache } from '../../secrets'
import { createJournalCadence, FINALS_BATCH_MS, REVISION_DEBOUNCE_MS } from './cadence'
import { encodeFrame, scanFrames } from './segment'
import { openJournal, openJournalIfEnabled, readJournal } from './store'

vi.mock('electron')

const line = (text: string, t: number) => ({ speaker: 'you' as const, text, t })
const ENVELOPE_MARKER = Buffer.from('ATKENC2\n')

describe('the durable local journal', () => {
  let userData: string
  let clock: number
  const now = () => clock

  const sessionDir = (id: string) => join(userData, 'journal', id)
  const segment = (id: string, n: number) => readFileSync(join(sessionDir(id), `seg-${n}.jnl`))

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-journal-'))
    vi.mocked(app.getPath).mockReturnValue(userData)
    resetSecretKeyCache()
    clock = 1000
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetSecretKeyCache()
    rmSync(userData, { recursive: true, force: true })
  })

  it('appends envelope-encrypted records to userData/journal/<id>/seg-1.jnl and reads them back', async () => {
    const store = await openJournal({ sessionId: 'meet-1', now })
    const first = await store.append([{ kind: 'finals', lines: [line('Budget is approved', 10)] }])
    clock = 1500
    const second = await store.append([
      { kind: 'revision', doc: 'recap', text: 'Decision: budget approved' },
      { kind: 'revision', doc: 'note', text: 'Send the deck' }
    ])
    await store.close()

    expect(first).toEqual({ sessionId: 'meet-1', fromSeq: 1, toSeq: 1, savedAt: 1000 })
    expect(second).toEqual({ sessionId: 'meet-1', fromSeq: 2, toSeq: 3, savedAt: 1500 })
    expect(readdirSync(sessionDir('meet-1'))).toEqual(['seg-1.jnl'])

    const bytes = segment('meet-1', 1)
    for (const secret of ['Budget is approved', 'Decision: budget', 'Send the deck']) expect(bytes.includes(secret)).toBe(false)
    const scan = scanFrames(bytes)
    expect(scan.tornTail).toBe(false)
    expect(scan.payloads).toHaveLength(3)
    for (const payload of scan.payloads) expect(payload.subarray(0, ENVELOPE_MARKER.length)).toEqual(ENVELOPE_MARKER)

    expect(await readJournal({ sessionId: 'meet-1' })).toEqual({
      records: [
        { kind: 'finals', lines: [line('Budget is approved', 10)], v: 1, seq: 1, at: 1000 },
        { kind: 'revision', doc: 'recap', text: 'Decision: budget approved', v: 1, seq: 2, at: 1500 },
        { kind: 'revision', doc: 'note', text: 'Send the deck', v: 1, seq: 3, at: 1500 }
      ],
      tornTailSegments: [],
      unreadable: 0
    })
  })

  it('only ever appends: earlier bytes stay an unchanged prefix of the segment', async () => {
    const store = await openJournal({ sessionId: 's1', now })
    await store.append([{ kind: 'revision', doc: 'note', text: 'v1' }])
    const before = segment('s1', 1)
    await store.append([{ kind: 'revision', doc: 'note', text: 'v2' }])
    const after = segment('s1', 1)
    await store.close()
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.subarray(0, before.length)).toEqual(before)
  })

  it('a reopened journal continues the seq in a new segment and leaves the old one untouched', async () => {
    const first = await openJournal({ sessionId: 's1', now })
    await first.append([{ kind: 'revision', doc: 'note', text: 'before restart' }])
    await first.close()
    const seg1 = segment('s1', 1)

    const second = await openJournal({ sessionId: 's1', now })
    expect(await second.append([{ kind: 'revision', doc: 'note', text: 'after restart' }])).toMatchObject({ fromSeq: 2, toSeq: 2 })
    await second.close()

    expect(segment('s1', 1)).toEqual(seg1)
    expect((await readJournal({ sessionId: 's1' })).records.map((r) => r.seq)).toEqual([1, 2])
    expect(readdirSync(sessionDir('s1')).sort()).toEqual(['seg-1.jnl', 'seg-2.jnl'])
  })

  it('keeps every whole record before a torn tail and appends after it only in a new segment', async () => {
    const crashed = await openJournal({ sessionId: 's1', now })
    await crashed.append([{ kind: 'finals', lines: [line('kept', 1)] }])
    await crashed.close()
    // A process killed mid-append leaves the start of a frame at the end of its segment.
    appendFileSync(join(sessionDir('s1'), 'seg-1.jnl'), encodeFrame(Buffer.from('half-written')).subarray(0, 7))

    const afterCrash = await readJournal({ sessionId: 's1' })
    expect(afterCrash.records.map((r) => r.seq)).toEqual([1])
    expect(afterCrash.tornTailSegments).toEqual([1])

    const resumed = await openJournal({ sessionId: 's1', now })
    await resumed.append([{ kind: 'finals', lines: [line('after', 2)] }])
    await resumed.close()
    const replay = await readJournal({ sessionId: 's1' })
    expect(replay.records.map((r) => r.kind === 'finals' && r.lines[0].text)).toEqual(['kept', 'after'])
    expect(replay.tornTailSegments).toEqual([1])
  })

  it('never reads a frame that is not envelope-encrypted', async () => {
    const store = await openJournal({ sessionId: 's1', now })
    await store.append([{ kind: 'revision', doc: 'note', text: 'sealed' }])
    await store.close()
    const forged = { kind: 'revision', doc: 'note', text: 'planted', v: 1, seq: 2, at: 0 }
    appendFileSync(join(sessionDir('s1'), 'seg-1.jnl'), encodeFrame(Buffer.from(JSON.stringify(forged))))
    const replay = await readJournal({ sessionId: 's1' })
    expect(replay.records.map((r) => r.seq)).toEqual([1])
    expect(replay.unreadable).toBe(1)
  })

  it('starts the next segment once a segment reaches its size limit', async () => {
    const store = await openJournal({ sessionId: 's1', now, segmentMaxBytes: 1 })
    for (const text of ['a', 'b', 'c']) await store.append([{ kind: 'revision', doc: 'note', text }])
    await store.close()
    expect(readdirSync(sessionDir('s1')).sort()).toEqual(['seg-1.jnl', 'seg-2.jnl', 'seg-3.jnl'])
    expect((await readJournal({ sessionId: 's1' })).records.map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('refuses a session id that is not one plain directory name, creating nothing', async () => {
    await expect(openJournal({ sessionId: '../escape', now })).rejects.toThrow()
    await expect(readJournal({ sessionId: 'a/b' })).rejects.toThrow()
    expect(existsSync(join(userData, 'journal'))).toBe(false)
    expect(existsSync(join(userData, 'escape'))).toBe(false)
  })

  it('rejects an invalid entry without writing it, and any append after close', async () => {
    const store = await openJournal({ sessionId: 's1', now })
    await expect(
      store.append([{ kind: 'finals', lines: [{ ...line('typing…', 0), provisional: true }] }])
    ).rejects.toThrow()
    await expect(store.append([])).rejects.toThrow()
    await store.close()
    await expect(store.append([{ kind: 'revision', doc: 'note', text: 'late' }])).rejects.toThrow('closed')
    expect(readdirSync(sessionDir('s1'))).toEqual([])
  })

  it('stays off unless the journal flag is on, and then creates nothing on disk', async () => {
    vi.stubEnv('ASKTOTO_FLAG_JOURNAL', '')
    expect(await openJournalIfEnabled({ sessionId: 's1', now })).toBeNull()
    expect(existsSync(join(userData, 'journal'))).toBe(false)

    vi.stubEnv('ASKTOTO_FLAG_JOURNAL', '1')
    const store = await openJournalIfEnabled({ sessionId: 's1', now })
    expect(store).not.toBeNull()
    await store!.close()
    expect(existsSync(sessionDir('s1'))).toBe(true)
  })

  it('journals cadence-batched finals and debounced revisions, acknowledging each after it is on disk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const store = await openJournal({ sessionId: 's1', now })
      const acks: JournalAck[] = []
      const framesOnDiskAtAck: number[] = []
      const errors: unknown[] = []
      let ackArrived: () => void = () => {}
      const nextAck = () => new Promise<void>((resolve) => (ackArrived = resolve))
      const cadence = createJournalCadence((entries) => store.append(entries), {
        onAck: (ack) => {
          acks.push(ack)
          framesOnDiskAtAck.push(scanFrames(segment('s1', 1)).payloads.length)
          ackArrived()
        },
        onError: (e) => errors.push(e)
      })
      cadence.final(line('first', 0))
      cadence.final(line('second', 1))
      cadence.revise('recap', 'draft')
      cadence.revise('recap', 'final recap')
      const revisionAck = nextAck()
      await vi.advanceTimersByTimeAsync(REVISION_DEBOUNCE_MS)
      await revisionAck
      expect(acks).toHaveLength(1)
      const finalsAck = nextAck()
      await vi.advanceTimersByTimeAsync(FINALS_BATCH_MS - REVISION_DEBOUNCE_MS)
      await finalsAck
      await store.close()

      expect(errors).toEqual([])
      expect(acks.map((a) => [a.fromSeq, a.toSeq])).toEqual([
        [1, 1],
        [2, 2]
      ])
      // Each ack fired only once its record was already in the segment file.
      expect(framesOnDiskAtAck).toEqual([1, 2])
      const { records } = await readJournal({ sessionId: 's1' })
      expect(records.map(({ v: _v, at: _at, seq: _seq, ...entry }) => entry)).toEqual([
        { kind: 'revision', doc: 'recap', text: 'final recap' },
        { kind: 'finals', lines: [line('first', 0), line('second', 1)] }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
