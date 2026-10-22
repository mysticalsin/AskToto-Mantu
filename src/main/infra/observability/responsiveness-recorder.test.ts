import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_LATENCY_SAMPLES, ResponsivenessReportSchema } from '../../../shared/responsiveness-metrics'
import {
  createAskTiming,
  createFileResponsivenessStore,
  createFirstPartialProbe,
  createResponsivenessRecorder,
  type ResponsivenessStore
} from './responsiveness-recorder'

const identity = { platform: 'darwin', arch: 'arm64', appVersion: '0.0.0-test' }

function clock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    }
  }
}

function memoryStore(initial: string | null = null): ResponsivenessStore & { text: string | null; writes: number } {
  const store = {
    text: initial,
    writes: 0,
    async read() {
      return store.text
    },
    async write(text: string) {
      store.writes += 1
      store.text = text
    }
  }
  return store
}

describe('createResponsivenessRecorder', () => {
  it('starts with nothing measured', () => {
    const rec = createResponsivenessRecorder({ identity })
    expect(rec.snapshot()).toEqual({ latencies: {}, counters: {}, peaks: {} })
    for (const entry of rec.report().entries) expect(entry.status).toBe('not_measured')
  })

  it('records latencies, counters and peaks and reports them', () => {
    const rec = createResponsivenessRecorder({ identity })
    rec.recordLatency('first_partial_ms', 420)
    rec.recordLatency('first_partial_ms', 880)
    rec.increment('asks_cancelled')
    rec.increment('asks_cancelled', 2)
    rec.observePeak('queue_depth_peak', 2)
    rec.observePeak('queue_depth_peak', 1)
    expect(rec.snapshot()).toEqual({
      latencies: { first_partial_ms: [420, 880] },
      counters: { asks_cancelled: 3 },
      peaks: { queue_depth_peak: 2 }
    })
    const entry = rec.report().entries.find((e) => e.id === 'first_partial_ms')
    expect(entry).toMatchObject({ status: 'measured', count: 2, p95Ms: 880 })
  })

  it('ignores a sample that is not a real measurement and an id that is not in the catalogue', () => {
    const rec = createResponsivenessRecorder({ identity })
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 * 60 * 60 * 1000, '12' as unknown as number]) {
      rec.recordLatency('first_partial_ms', bad)
    }
    rec.recordLatency('not_a_metric' as never, 5)
    rec.increment('not_a_metric' as never)
    rec.increment('asks_cancelled', -4)
    rec.increment('asks_cancelled', 1.5)
    rec.observePeak('queue_depth_peak', -1)
    expect(rec.snapshot()).toEqual({ latencies: {}, counters: {}, peaks: {} })
  })

  it('keeps only the newest MAX_LATENCY_SAMPLES per metric', () => {
    const rec = createResponsivenessRecorder({ identity })
    for (let i = 0; i < MAX_LATENCY_SAMPLES + 25; i++) rec.recordLatency('useful_suggestion_ms', i)
    const sample = rec.snapshot().latencies.useful_suggestion_ms ?? []
    expect(sample).toHaveLength(MAX_LATENCY_SAMPLES)
    expect(sample[0]).toBe(25)
    expect(sample[sample.length - 1]).toBe(MAX_LATENCY_SAMPLES + 24)
  })

  it('measures a span on the injected monotonic clock, once', () => {
    const c = clock()
    const rec = createResponsivenessRecorder({ identity, now: c.now })
    rec.beginSpan('display_receipt_ms', 'ask-1')
    c.advance(120)
    expect(rec.endSpan('display_receipt_ms', 'ask-1')).toBe(120)
    expect(rec.endSpan('display_receipt_ms', 'ask-1')).toBeNull()
    expect(rec.snapshot().latencies.display_receipt_ms).toEqual([120])
  })

  it('does not restart a span that is already open, and never records one that was never opened', () => {
    const c = clock()
    const rec = createResponsivenessRecorder({ identity, now: c.now })
    rec.beginSpan('first_partial_ms', 's1')
    c.advance(100)
    rec.beginSpan('first_partial_ms', 's1')
    c.advance(100)
    expect(rec.endSpan('first_partial_ms', 's1')).toBe(200)
    expect(rec.endSpan('first_partial_ms', 'unknown')).toBeNull()
  })

  it('bounds open spans so an ask that never finishes cannot grow the table', () => {
    const rec = createResponsivenessRecorder({ identity, maxOpenSpans: 4 })
    for (let i = 0; i < 10; i++) rec.beginSpan('useful_suggestion_ms', `ask-${i}`)
    expect(rec.openSpanCount()).toBe(4)
    expect(rec.endSpan('useful_suggestion_ms', 'ask-0')).toBeNull()
    expect(rec.endSpan('useful_suggestion_ms', 'ask-9')).not.toBeNull()
  })

  it('drops an open span without recording it', () => {
    const rec = createResponsivenessRecorder({ identity })
    rec.beginSpan('display_receipt_ms', 'ask-1')
    rec.dropSpan('display_receipt_ms', 'ask-1')
    expect(rec.endSpan('display_receipt_ms', 'ask-1')).toBeNull()
    expect(rec.snapshot().latencies).toEqual({})
  })
})

describe('persistence', () => {
  it('writes a report that parses under the strict schema and holds only ids and numbers', async () => {
    const store = memoryStore()
    const rec = createResponsivenessRecorder({ identity, store })
    rec.recordLatency('first_partial_ms', 640)
    rec.increment('suggestions_shown')
    await rec.flush()
    const parsed = ResponsivenessReportSchema.parse(JSON.parse(store.text ?? ''))
    expect(parsed.snapshot.latencies.first_partial_ms).toEqual([640])
    expect(parsed.snapshot.counters.suggestions_shown).toBe(1)
    expect(parsed.host).toEqual(identity)
  })

  it('reloads the previous run and appends the new one after it', async () => {
    const store = memoryStore()
    const first = createResponsivenessRecorder({ identity, store })
    first.recordLatency('first_partial_ms', 100)
    first.increment('asks_cancelled', 2)
    first.observePeak('queue_depth_peak', 3)
    await first.flush()

    const second = createResponsivenessRecorder({ identity, store })
    second.recordLatency('first_partial_ms', 200)
    second.increment('asks_cancelled')
    second.observePeak('queue_depth_peak', 1)
    await second.flush()

    expect(second.snapshot()).toEqual({
      latencies: { first_partial_ms: [100, 200] },
      counters: { asks_cancelled: 3 },
      peaks: { queue_depth_peak: 3 }
    })
    expect(ResponsivenessReportSchema.parse(JSON.parse(store.text ?? '')).snapshot).toEqual(second.snapshot())
  })

  it('treats a corrupt, foreign or oversized file as empty instead of failing or trusting it', async () => {
    for (const text of [
      'not json',
      '{}',
      '{"kind":"other"}',
      JSON.stringify({ kind: 'metis-responsiveness-report', schema: 9 })
    ]) {
      const rec = createResponsivenessRecorder({ identity, store: memoryStore(text) })
      await rec.flush()
      expect(rec.snapshot()).toEqual({ latencies: {}, counters: {}, peaks: {} })
    }
  })

  it('never throws when the store cannot read or write', async () => {
    const broken: ResponsivenessStore = {
      async read() {
        throw new Error('synthetic read failure')
      },
      async write() {
        throw new Error('synthetic write failure')
      }
    }
    const rec = createResponsivenessRecorder({ identity, store: broken })
    rec.recordLatency('first_partial_ms', 10)
    await expect(rec.flush()).resolves.toBeUndefined()
    expect(rec.snapshot().latencies.first_partial_ms).toEqual([10])
  })

  it('coalesces a burst of records into at most two writes', async () => {
    const store = memoryStore()
    const rec = createResponsivenessRecorder({ identity, store })
    for (let i = 0; i < 50; i++) rec.recordLatency('first_partial_ms', i)
    await rec.flush()
    expect(store.writes).toBeLessThanOrEqual(2)
    expect(
      ResponsivenessReportSchema.parse(JSON.parse(store.text ?? '')).snapshot.latencies.first_partial_ms
    ).toHaveLength(50)
  })

  it('does not write at all while nothing has been recorded', async () => {
    const store = memoryStore()
    const rec = createResponsivenessRecorder({ identity, store })
    await rec.flush()
    expect(store.writes).toBe(0)
  })
})

describe('file store', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('round-trips through a real file, creating the folder and leaving no temp file behind', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'synthetic-responsiveness-')))
    dirs.push(root)
    const path = join(root, 'logs', 'responsiveness-report.json')
    const store = createFileResponsivenessStore(path)
    expect(await store.read()).toBeNull()
    const rec = createResponsivenessRecorder({ identity, store })
    rec.recordLatency('ask_cancel_release_ms', 3)
    await rec.flush()
    expect(JSON.parse(await readFile(path, 'utf8')).snapshot.latencies.ask_cancel_release_ms).toEqual([3])
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(join(root, 'logs'))).toEqual(['responsiveness-report.json'])
    await writeFile(path, 'garbage', 'utf8')
    const again = createResponsivenessRecorder({ identity, store })
    await again.flush()
    expect(again.snapshot()).toEqual({ latencies: {}, counters: {}, peaks: {} })
  })
})

describe('createFirstPartialProbe', () => {
  it('measures from the first audio sent to the first text, once per session', () => {
    const c = clock()
    const rec = createResponsivenessRecorder({ identity, now: c.now })
    const probe = createFirstPartialProbe(rec)
    probe.textSeen() // text before any audio proves nothing about this session's latency
    probe.audioSent()
    c.advance(300)
    probe.audioSent() // a later chunk must not move the start
    c.advance(200)
    probe.textSeen()
    c.advance(900)
    probe.textSeen()
    expect(rec.snapshot().latencies.first_partial_ms).toEqual([500])
  })

  it('records nothing when no text ever arrives', () => {
    const rec = createResponsivenessRecorder({ identity })
    const probe = createFirstPartialProbe(rec)
    probe.audioSent()
    expect(rec.snapshot().latencies).toEqual({})
  })

  it('gives every session its own probe', () => {
    const c = clock()
    const rec = createResponsivenessRecorder({ identity, now: c.now })
    for (const gap of [100, 250]) {
      const probe = createFirstPartialProbe(rec)
      probe.audioSent()
      c.advance(gap)
      probe.textSeen()
    }
    expect(rec.snapshot().latencies.first_partial_ms).toEqual([100, 250])
  })
})

describe('createAskTiming', () => {
  function setup() {
    const c = clock()
    const rec = createResponsivenessRecorder({ identity, now: c.now })
    return { c, rec, timing: createAskTiming(rec, c.now) }
  }

  it('measures a suggestion from request to first visible token, then to the display receipt', () => {
    const { c, rec, timing } = setup()
    timing.start('ask-1', 'suggest')
    c.advance(1800)
    timing.firstVisible('ask-1')
    c.advance(60)
    timing.displayed('ask-1')
    expect(rec.snapshot()).toEqual({
      latencies: { useful_suggestion_ms: [1800], display_receipt_ms: [60] },
      counters: { suggestions_shown: 1, suggestions_displayed: 1 },
      peaks: {}
    })
  })

  it('counts a shown suggestion that never gets a receipt as shown, not displayed', () => {
    const { c, rec, timing } = setup()
    timing.start('ask-1', 'suggest')
    c.advance(500)
    timing.firstVisible('ask-1')
    expect(rec.snapshot().counters).toEqual({ suggestions_shown: 1 })
    expect(rec.snapshot().latencies.display_receipt_ms).toBeUndefined()
  })

  it('ignores every mode other than suggest', () => {
    const { c, rec, timing } = setup()
    for (const mode of ['answer', 'vision', 'summary', 'recap']) {
      timing.start(`ask-${mode}`, mode)
      c.advance(100)
      timing.firstVisible(`ask-${mode}`)
      timing.displayed(`ask-${mode}`)
    }
    expect(rec.snapshot()).toEqual({ latencies: {}, counters: {}, peaks: {} })
  })

  it('takes a display receipt only for a suggestion that was shown, and only once', () => {
    const { c, rec, timing } = setup()
    timing.displayed('forged-id')
    timing.start('ask-1', 'suggest')
    timing.displayed('ask-1') // not shown yet
    c.advance(100)
    timing.firstVisible('ask-1')
    timing.firstVisible('ask-1') // a second token is not a second "shown"
    c.advance(10)
    timing.displayed('ask-1')
    timing.displayed('ask-1')
    expect(rec.snapshot().counters).toEqual({ suggestions_shown: 1, suggestions_displayed: 1 })
    expect(rec.snapshot().latencies.display_receipt_ms).toEqual([10])
  })

  it('records a cancel only when a stream was actually released, and drops that ask’s open spans', () => {
    const { c, rec, timing } = setup()
    const aborted: string[] = []
    const streams = new Map([['ask-1', { abort: () => aborted.push('ask-1') }]])
    timing.start('ask-1', 'suggest')
    c.advance(5)
    timing.cancel(streams, 'ask-1')
    timing.cancel(streams, 'ask-1') // already gone
    timing.cancel(streams, 'never-existed')
    expect(aborted).toEqual(['ask-1'])
    expect(streams.size).toBe(0)
    expect(rec.snapshot().counters).toEqual({ asks_cancelled: 1 })
    expect(rec.snapshot().latencies.ask_cancel_release_ms).toHaveLength(1)
    // The cancelled suggestion never shows, so it must not leave a pending span behind.
    expect(rec.openSpanCount()).toBe(0)
  })

  it('still releases the stream and records the cancel when the abort handle throws', () => {
    const { rec, timing } = setup()
    const streams = new Map([
      [
        'ask-1',
        {
          abort: () => {
            throw new Error('synthetic abort failure')
          }
        }
      ]
    ])
    expect(() => timing.cancel(streams, 'ask-1')).not.toThrow()
    expect(streams.size).toBe(0)
    expect(rec.snapshot().counters).toEqual({ asks_cancelled: 1 })
  })

  it('never lets a recorder fault break the ask path', () => {
    const rec = createResponsivenessRecorder({ identity })
    const faulty = {
      ...rec,
      beginSpan: () => {
        throw new Error('synthetic recorder fault')
      }
    }
    const timing = createAskTiming(faulty as unknown as typeof rec)
    expect(() => timing.start('ask-1', 'suggest')).not.toThrow()
  })
})
