import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveDraftTranscriptResult, SaveMeeting, TranscriptLine } from '@shared/ipc'
import { startDraftAutosave } from './draft-autosave'

const line = { t: 1, speaker: 'them', text: 'hello' } as TranscriptLine

function harness(save: (meeting: SaveMeeting) => Promise<SaveDraftTranscriptResult>) {
  const failures = { current: 0 }
  const warn = vi.fn()
  const stop = startDraftAutosave({
    mode: 'meeting',
    getLines: () => [line],
    getStartedAt: () => 1000,
    title: () => 'Standup',
    save,
    failures,
    warn
  })
  return { failures, warn, stop }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startDraftAutosave in-flight guard', () => {
  it('skips a tick while the previous save is pending', async () => {
    const save = vi.fn(() => new Promise<SaveDraftTranscriptResult>(() => {}))
    const { stop } = harness(save)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000 * 3)
    // three more ticks fired while the first save never settled: none queued another full-transcript save
    expect(save).toHaveBeenCalledTimes(1)
    stop()
  })

  it('starts a new save once the pending one settles', async () => {
    let finish!: (r: SaveDraftTranscriptResult) => void
    const save = vi
      .fn<(m: SaveMeeting) => Promise<SaveDraftTranscriptResult>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue({ status: 'saved' })
    const { stop, failures } = harness(save)
    await vi.advanceTimersByTimeAsync(60_000)
    finish({ status: 'saved' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(save).toHaveBeenCalledTimes(2)
    expect(failures.current).toBe(0)
    stop()
  })

  it('a save past the deadline counts as a failure', async () => {
    const save = vi.fn(() => new Promise<SaveDraftTranscriptResult>(() => {}))
    const { stop, failures, warn } = harness(save)
    await vi.advanceTimersByTimeAsync(60_000) // save starts
    await vi.advanceTimersByTimeAsync(44_000)
    expect(failures.current).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000) // 45 s after it started
    expect(failures.current).toBe(1)
    expect(warn).not.toHaveBeenCalledWith(true)
    stop()
  })

  it('warns when a save stays stalled across ticks (the existing two-failure rule)', async () => {
    const save = vi.fn(() => new Promise<SaveDraftTranscriptResult>(() => {}))
    const { stop, failures, warn } = harness(save)
    await vi.advanceTimersByTimeAsync(60_000 + 45_000)
    expect(failures.current).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000) // the next tick cannot start: counted, warning raised
    expect(failures.current).toBe(2)
    expect(warn).toHaveBeenLastCalledWith(true)
    stop()
  })

  it('a stalled save that finally succeeds clears the warning', async () => {
    let finish!: (r: SaveDraftTranscriptResult) => void
    const save = vi.fn(() => new Promise<SaveDraftTranscriptResult>((resolve) => (finish = resolve)))
    const { stop, failures, warn } = harness(save)
    await vi.advanceTimersByTimeAsync(60_000 + 60_000 + 45_000)
    expect(warn).toHaveBeenLastCalledWith(true)
    finish({ status: 'saved' })
    await vi.advanceTimersByTimeAsync(0)
    expect(failures.current).toBe(0)
    expect(warn).toHaveBeenLastCalledWith(false)
    stop()
  })

  it('keeps the existing behaviour for fast failures and disabled snapshots', async () => {
    const save = vi
      .fn<(m: SaveMeeting) => Promise<SaveDraftTranscriptResult>>()
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'disabled' })
    const { stop, failures, warn } = harness(save)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(failures.current).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(failures.current).toBe(2)
    expect(warn).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(failures.current).toBe(2) // disabled is neither a success nor a failure
    stop()
  })
})
