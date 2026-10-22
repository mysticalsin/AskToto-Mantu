/**
 * responsiveness-recorder.ts — main-process recorder for the G12 responsiveness metrics.
 *
 * Counts and latencies only, kept on this device. No prompt, answer, transcript or screen ever reaches this
 * module: callers pass a metric id and a number, plus an opaque ask or session id that is used to pair a
 * start with an end and is never stored beyond the open span. Elapsed time uses a monotonic clock, so sleep
 * or a wall-clock step cannot fake a latency.
 *
 * Nothing leaves the device from here. The Operator payload is not widened by this module.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { app } from 'electron'
import {
  COUNTER_METRICS,
  LATENCY_METRICS,
  MAX_LATENCY_SAMPLES,
  MAX_PLAUSIBLE_LATENCY_MS,
  PEAK_METRICS,
  ResponsivenessReportSchema,
  buildResponsivenessReport,
  emptySnapshot,
  type CounterMetricId,
  type LatencyMetricId,
  type PeakMetricId,
  type ResponsivenessReport,
  type ResponsivenessSnapshot
} from '../../../shared/responsiveness-metrics'

export interface HostIdentity {
  platform: string
  arch: string
  appVersion: string
}

/** Where the report is kept between runs. Async only: nothing here may block the main process. */
export interface ResponsivenessStore {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

export interface ResponsivenessRecorderOptions {
  identity: HostIdentity | (() => HostIdentity)
  store?: ResponsivenessStore
  /** Monotonic milliseconds. */
  now?: () => number
  wallClock?: () => Date
  maxOpenSpans?: number
}

export interface ResponsivenessRecorder {
  recordLatency(id: LatencyMetricId, ms: number): void
  increment(id: CounterMetricId, by?: number): void
  observePeak(id: PeakMetricId, value: number): void
  /** Opens a span; a span that is already open under the same key keeps its original start. */
  beginSpan(id: LatencyMetricId, key: string): void
  /** Closes a span and records its latency. Returns the latency, or null when no such span was open. */
  endSpan(id: LatencyMetricId, key: string): number | null
  dropSpan(id: LatencyMetricId, key: string): void
  openSpanCount(): number
  snapshot(): ResponsivenessSnapshot
  report(): ResponsivenessReport
  /** Resolves once the previous run has been merged in. */
  ready(): Promise<void>
  /** Resolves once everything recorded so far has been written. */
  flush(): Promise<void>
}

const DEFAULT_MAX_OPEN_SPANS = 64
/** A stored report larger than this is not ours; it is ignored rather than parsed. */
const MAX_STORED_BYTES = 1024 * 1024

const LATENCY_SET: ReadonlySet<string> = new Set(LATENCY_METRICS)
const COUNTER_SET: ReadonlySet<string> = new Set(COUNTER_METRICS)
const PEAK_SET: ReadonlySet<string> = new Set(PEAK_METRICS)

function validLatency(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= MAX_PLAUSIBLE_LATENCY_MS
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function mergeSnapshots(older: ResponsivenessSnapshot, newer: ResponsivenessSnapshot): ResponsivenessSnapshot {
  const merged = emptySnapshot()
  for (const id of LATENCY_METRICS) {
    const joined = [...(older.latencies[id] ?? []), ...(newer.latencies[id] ?? [])]
    if (joined.length) merged.latencies[id] = joined.slice(-MAX_LATENCY_SAMPLES)
  }
  for (const id of COUNTER_METRICS) {
    const sum = (older.counters[id] ?? 0) + (newer.counters[id] ?? 0)
    if (sum > 0) merged.counters[id] = Math.min(sum, Number.MAX_SAFE_INTEGER)
  }
  for (const id of PEAK_METRICS) {
    const peak = Math.max(older.peaks[id] ?? 0, newer.peaks[id] ?? 0)
    if (peak > 0) merged.peaks[id] = peak
  }
  return merged
}

function parseStored(text: string | null): ResponsivenessSnapshot | null {
  if (!text) return null
  try {
    const parsed = ResponsivenessReportSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data.snapshot : null
  } catch {
    return null
  }
}

export function createResponsivenessRecorder(options: ResponsivenessRecorderOptions): ResponsivenessRecorder {
  const now = options.now ?? ((): number => performance.now())
  const wallClock = options.wallClock ?? ((): Date => new Date())
  const maxOpenSpans = options.maxOpenSpans ?? DEFAULT_MAX_OPEN_SPANS
  const store = options.store
  let current: ResponsivenessSnapshot = emptySnapshot()
  const spans = new Map<string, number>()
  let hydrating: Promise<void> | null = null
  let dirty = false
  let writing: Promise<void> | null = null

  const spanKey = (id: string, key: string): string => `${id}\u0000${key}`
  const identity = (): HostIdentity => (typeof options.identity === 'function' ? options.identity() : options.identity)

  function hydrate(): Promise<void> {
    hydrating ??= (async (): Promise<void> => {
      if (!store) return
      try {
        const stored = parseStored(await store.read())
        if (stored) current = mergeSnapshots(stored, current)
      } catch {
        // An unreadable report starts a fresh one; measurement must never fail the app.
      }
    })()
    return hydrating
  }

  async function drain(): Promise<void> {
    await hydrate()
    while (dirty && store) {
      dirty = false
      try {
        await store.write(JSON.stringify(report()))
      } catch {
        // Best effort: the next record writes again.
      }
    }
  }

  function markDirty(): void {
    if (!store) return
    dirty = true
    if (writing) return
    writing = drain().finally(() => {
      writing = null
    })
  }

  function report(): ResponsivenessReport {
    return buildResponsivenessReport(current, { identity: identity(), generatedAt: wallClock() })
  }

  const recorder: ResponsivenessRecorder = {
    recordLatency(id, ms) {
      if (!LATENCY_SET.has(id) || !validLatency(ms)) return
      const list = current.latencies[id] ?? []
      list.push(ms)
      if (list.length > MAX_LATENCY_SAMPLES) list.splice(0, list.length - MAX_LATENCY_SAMPLES)
      current.latencies[id] = list
      markDirty()
    },
    increment(id, by = 1) {
      if (!COUNTER_SET.has(id) || !nonNegativeInt(by) || by === 0) return
      current.counters[id] = Math.min((current.counters[id] ?? 0) + by, Number.MAX_SAFE_INTEGER)
      markDirty()
    },
    observePeak(id, value) {
      if (!PEAK_SET.has(id) || !nonNegativeInt(value)) return
      if (value > (current.peaks[id] ?? 0)) {
        current.peaks[id] = value
        markDirty()
      }
    },
    beginSpan(id, key) {
      if (!LATENCY_SET.has(id)) return
      const k = spanKey(id, key)
      if (spans.has(k)) return
      spans.set(k, now())
      while (spans.size > maxOpenSpans) {
        const oldest = spans.keys().next()
        if (oldest.done) break
        spans.delete(oldest.value)
      }
    },
    endSpan(id, key) {
      const k = spanKey(id, key)
      const startedAt = spans.get(k)
      if (startedAt === undefined) return null
      spans.delete(k)
      const elapsed = now() - startedAt
      if (!validLatency(elapsed)) return null
      recorder.recordLatency(id, elapsed)
      return elapsed
    },
    dropSpan(id, key) {
      spans.delete(spanKey(id, key))
    },
    openSpanCount: () => spans.size,
    snapshot: () => JSON.parse(JSON.stringify(current)) as ResponsivenessSnapshot,
    report,
    ready: hydrate,
    async flush() {
      await hydrate()
      if (writing) await writing
    }
  }
  return recorder
}

/** A report file on disk: written through a temp file and renamed, so a crash never leaves half a report. */
export function createFileResponsivenessStore(path: string): ResponsivenessStore {
  return {
    async read() {
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > MAX_STORED_BYTES) return null
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    async write(text) {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, text, 'utf8')
      await rename(temp, path)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Event-site helpers
// ---------------------------------------------------------------------------------------------------------

type RecorderSource = ResponsivenessRecorder | (() => ResponsivenessRecorder)
const resolve = (source: RecorderSource): ResponsivenessRecorder => (typeof source === 'function' ? source() : source)

/** A recorder fault must never reach the path it measures. */
function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // Measurement is best effort by contract.
  }
}

export interface FirstPartialProbe {
  audioSent(): void
  textSeen(): void
}

let probeSeq = 0

/**
 * One per live speech session. Starts the clock when the first PCM chunk is sent and stops it at the first
 * text handed to the renderer, once. The start includes any leading silence: it is not speech onset.
 */
export function createFirstPartialProbe(source: RecorderSource = getResponsivenessRecorder): FirstPartialProbe {
  const key = `stt-${++probeSeq}`
  let started = false
  let done = false
  return {
    audioSent() {
      if (started) return
      started = true
      safely(() => resolve(source).beginSpan('first_partial_ms', key))
    },
    textSeen() {
      if (!started || done) return
      done = true
      safely(() => void resolve(source).endSpan('first_partial_ms', key))
    }
  }
}

export interface AskTiming {
  /** The ask reached main. Only suggestions are timed. */
  start(askId: string, mode: string): void
  /** The first visible token of the ask was sent to the renderer. */
  firstVisible(askId: string): void
  /** The renderer confirmed the first visible token is on screen. */
  displayed(askId: string): void
  /** Cancel an ask: abort and release its stream, and record how long that took in main. */
  cancel(streams: Map<string, { abort: () => void }>, askId: string): void
}

export function createAskTiming(source: RecorderSource, now: () => number = () => performance.now()): AskTiming {
  return {
    start(askId, mode) {
      if (mode !== 'suggest') return
      safely(() => resolve(source).beginSpan('useful_suggestion_ms', askId))
    },
    firstVisible(askId) {
      safely(() => {
        const rec = resolve(source)
        if (rec.endSpan('useful_suggestion_ms', askId) === null) return
        rec.increment('suggestions_shown')
        rec.beginSpan('display_receipt_ms', askId)
      })
    },
    displayed(askId) {
      safely(() => {
        const rec = resolve(source)
        if (rec.endSpan('display_receipt_ms', askId) !== null) rec.increment('suggestions_displayed')
      })
    },
    cancel(streams, askId) {
      const handle = streams.get(askId)
      const startedAt = now()
      try {
        handle?.abort()
      } catch {
        // Like abortAllAskStreams: a handle that throws must still be released.
      }
      streams.delete(askId)
      if (!handle) return
      const elapsed = now() - startedAt
      safely(() => {
        const rec = resolve(source)
        rec.dropSpan('useful_suggestion_ms', askId)
        rec.dropSpan('display_receipt_ms', askId)
        rec.recordLatency('ask_cancel_release_ms', elapsed)
        rec.increment('asks_cancelled')
      })
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// The process-wide recorder
// ---------------------------------------------------------------------------------------------------------

/** The file the support bundle copies. */
export const RESPONSIVENESS_REPORT_FILE = 'responsiveness-report.json'

let shared: ResponsivenessRecorder | null = null

function hostIdentity(): HostIdentity {
  let appVersion = 'unknown'
  try {
    appVersion = app.getVersion()
  } catch {
    // Not in an Electron main process (a unit test): leave the version unknown rather than invent one.
  }
  return { platform: process.platform, arch: process.arch, appVersion }
}

function defaultStore(): ResponsivenessStore | undefined {
  try {
    return createFileResponsivenessStore(join(app.getPath('userData'), 'logs', RESPONSIVENESS_REPORT_FILE))
  } catch {
    return undefined
  }
}

export function getResponsivenessRecorder(): ResponsivenessRecorder {
  shared ??= createResponsivenessRecorder({ identity: hostIdentity, store: defaultStore() })
  return shared
}

/** Test seam: replaces (or clears) the process-wide recorder. */
export function setResponsivenessRecorderForTest(recorder: ResponsivenessRecorder | null): void {
  shared = recorder
}

/** What the report says when nothing may be shown (signed out): every metric not measured. */
export function emptyResponsivenessReport(): ResponsivenessReport {
  return buildResponsivenessReport(emptySnapshot(), { identity: hostIdentity(), generatedAt: new Date() })
}

export const askTiming: AskTiming = createAskTiming(getResponsivenessRecorder)
