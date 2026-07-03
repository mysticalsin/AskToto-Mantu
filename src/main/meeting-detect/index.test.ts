import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// detectMeeting delegates to detectMac/detectWindows based on process.platform. The watcher tests
// don't care which platform branch runs — they mock the module's own detectMeeting export via a
// hoisted stub so createMeetingWatcher's edge-latch logic can be tested in isolation.
const detectMeetingMock = vi.fn<(customApps?: string[]) => Promise<string>>()

vi.mock('./mac', () => ({ detectMac: (...args: unknown[]) => detectMeetingMock(...(args as [string[]])) }))
vi.mock('./win', () => ({ detectWindows: (...args: unknown[]) => detectMeetingMock(...(args as [string[]])) }))

import { createMeetingWatcher } from './index'

const REAL_PLATFORM = process.platform

describe('createMeetingWatcher', () => {
  beforeEach(() => {
    // detectMeeting's platform branch only decides which mocked module (./mac vs ./win) it calls —
    // pin it to darwin so these edge-latch tests behave identically on any CI runner OS.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    vi.useFakeTimers()
    detectMeetingMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  })

  it('fires onChange({ active: true }) on the rising edge only, not on repeated hits', async () => {
    detectMeetingMock.mockResolvedValue('Zoom|Zoom Meeting')
    const onChange = vi.fn()
    const watcher = createMeetingWatcher({ intervalMs: 1000, getApps: () => [], onChange })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ app: 'Zoom', active: true })
    watcher.stop()
  })

  it('fires onChange({ active: false }) on the falling edge when the meeting ends', async () => {
    detectMeetingMock.mockResolvedValue('Zoom|Zoom Meeting')
    const onChange = vi.fn()
    const watcher = createMeetingWatcher({ intervalMs: 1000, getApps: () => [], onChange })

    await vi.advanceTimersByTimeAsync(1000) // rising edge
    detectMeetingMock.mockResolvedValue('')
    await vi.advanceTimersByTimeAsync(1000) // falling edge

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenNthCalledWith(1, { app: 'Zoom', active: true })
    expect(onChange).toHaveBeenNthCalledWith(2, { app: '', active: false })
    watcher.stop()
  })

  it('never calls onChange while no meeting is present', async () => {
    detectMeetingMock.mockResolvedValue('')
    const onChange = vi.fn()
    const watcher = createMeetingWatcher({ intervalMs: 1000, getApps: () => [], onChange })

    await vi.advanceTimersByTimeAsync(5000)

    expect(onChange).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('reads getApps() fresh on every poll rather than capturing it once', async () => {
    detectMeetingMock.mockResolvedValue('')
    let apps = ['Around']
    const watcher = createMeetingWatcher({ intervalMs: 1000, getApps: () => apps, onChange: vi.fn() })

    await vi.advanceTimersByTimeAsync(1000)
    expect(detectMeetingMock).toHaveBeenLastCalledWith(['Around'])

    apps = ['Chime']
    await vi.advanceTimersByTimeAsync(1000)
    expect(detectMeetingMock).toHaveBeenLastCalledWith(['Chime'])
    watcher.stop()
  })

  it('skips a tick instead of overlapping when the previous poll is still in flight', async () => {
    let resolveFirst: (v: string) => void = () => {}
    detectMeetingMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    const watcher = createMeetingWatcher({ intervalMs: 1000, getApps: () => [], onChange: vi.fn() })

    await vi.advanceTimersByTimeAsync(1000) // kicks off the first (still-pending) poll
    await vi.advanceTimersByTimeAsync(1000) // second tick should be skipped — first poll unresolved

    expect(detectMeetingMock).toHaveBeenCalledTimes(1)

    resolveFirst('')
    await vi.advanceTimersByTimeAsync(0)
    watcher.stop()
  })

  it('calls onError and keeps polling when a poll rejects', async () => {
    detectMeetingMock.mockRejectedValueOnce(new Error('osascript timeout'))
    detectMeetingMock.mockResolvedValue('Zoom|Zoom Meeting')
    const onChange = vi.fn()
    const onError = vi.fn()
    const watcher = createMeetingWatcher({ intervalMs: 1000, getApps: () => [], onChange, onError })

    await vi.advanceTimersByTimeAsync(1000) // rejects
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)

    await vi.advanceTimersByTimeAsync(1000) // recovers, rising edge
    expect(onChange).toHaveBeenCalledWith({ app: 'Zoom', active: true })
    watcher.stop()
  })

  it('stop() clears the interval so no further polling happens', async () => {
    detectMeetingMock.mockResolvedValue('')
    const watcher = createMeetingWatcher({ intervalMs: 1000, getApps: () => [], onChange: vi.fn() })

    await vi.advanceTimersByTimeAsync(1000)
    expect(detectMeetingMock).toHaveBeenCalledTimes(1)

    watcher.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(detectMeetingMock).toHaveBeenCalledTimes(1)
  })

  it('stop() is safe to call more than once', async () => {
    detectMeetingMock.mockResolvedValue('')
    const watcher = createMeetingWatcher({ intervalMs: 1000, getApps: () => [], onChange: vi.fn() })
    watcher.stop()
    expect(() => watcher.stop()).not.toThrow()
  })
})
