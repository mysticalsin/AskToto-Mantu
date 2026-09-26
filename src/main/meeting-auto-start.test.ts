import { describe, expect, it, vi } from 'vitest'
import { createMeetingAutoStart } from './meeting-auto-start'
import type { ForegroundInfo, ForegroundWatcher } from './foreground-watcher'
import { DEFAULT_AUTO_START_MEETINGS, type AutoStartGateSettings } from '@shared/meeting-auto-start'

function ready(over: Partial<AutoStartGateSettings> = {}): AutoStartGateSettings {
  return {
    onboardingDone: true,
    recordingConsent: true,
    autoStartMeetings: { ...DEFAULT_AUTO_START_MEETINGS },
    ...over
  }
}

describe('createMeetingAutoStart', () => {
  it('starts the watcher only after onboarding + consent, and pushes one start per Zoom session', () => {
    let settings = ready({ onboardingDone: false, recordingConsent: false })
    let listening = false
    const started: string[] = []
    let onChange: ((info: ForegroundInfo) => void) | null = null
    const stop = vi.fn()
    const handle: ForegroundWatcher = {
      stop,
      current: () => null,
      healthy: () => true
    }

    const ctl = createMeetingAutoStart({
      startWatcher: (cb) => {
        onChange = cb
        return handle
      },
      getSettings: () => settings,
      isListening: () => listening,
      startListen: (platform) => {
        started.push(platform)
        listening = true
      }
    })

    ctl.refresh()
    expect(onChange).toBeNull()

    settings = ready()
    ctl.refresh()
    expect(onChange).toBeTypeOf('function')

    onChange?.({ windowId: 'us.zoom.xos', pid: 10, title: 'zoom.us' })
    onChange?.({ windowId: 'us.zoom.xos', pid: 10, title: 'Zoom Meeting' })
    expect(started).toEqual(['zoom'])

    listening = false
    onChange?.({ windowId: 'com.apple.finder', pid: 2, title: 'Finder' })
    onChange?.({ windowId: 'us.zoom.xos', pid: 10, title: 'zoom.us' })
    expect(started).toEqual(['zoom', 'zoom'])
  })

  it('does not start Listen for Slack or Chrome docs, and never auto-stops', () => {
    const started: string[] = []
    let onChange: ((info: ForegroundInfo) => void) | null = null
    const ctl = createMeetingAutoStart({
      startWatcher: (cb) => {
        onChange = cb
        return { stop: () => {}, current: () => null, healthy: () => true }
      },
      getSettings: () => ready(),
      isListening: () => started.length > 0,
      startListen: (platform) => started.push(platform)
    })
    ctl.refresh()

    onChange?.({ windowId: 'com.tinyspeck.slackmacgap', pid: 3, title: 'Slack' })
    onChange?.({
      windowId: 'com.google.Chrome',
      pid: 4,
      title: 'How to use Zoom - Google Docs - Google Chrome'
    })
    expect(started).toEqual([])

    onChange?.({ windowId: 'com.microsoft.teams2', pid: 5, title: 'Microsoft Teams' })
    expect(started).toEqual(['teams'])
    onChange?.({ windowId: 'com.apple.finder', pid: 2, title: 'Finder' })
    expect(started).toEqual(['teams'])
  })


  it('inject fires zoom once, clears on idle, then fires zoom again', () => {
    let listening = false
    const started: string[] = []
    const ctl = createMeetingAutoStart({
      startWatcher: () => ({ stop: () => {}, current: () => null, healthy: () => true }),
      getSettings: () => ready(),
      isListening: () => listening,
      startListen: (platform) => {
        started.push(platform)
        listening = true
      }
    })
    ctl.refresh()

    const zoom = { windowId: 'us.zoom.xos', title: 'Zoom Meeting', pid: 4242 }
    const idle = { windowId: 'com.apple.finder', title: 'Finder', pid: 1 }

    expect(ctl.inject(zoom)).toEqual({ fired: true, platform: 'zoom' })
    expect(started).toEqual(['zoom'])
    // Same session: no second fire even if listening flips off.
    listening = false
    expect(ctl.inject(zoom)).toEqual({ fired: false, platform: 'zoom' })
    expect(started).toEqual(['zoom'])

    expect(ctl.inject(idle)).toEqual({ fired: false, platform: null })
    expect(ctl.inject(zoom)).toEqual({ fired: true, platform: 'zoom' })
    expect(started).toEqual(['zoom', 'zoom'])
  })

  it('stops the watcher when the master switch or consent turns off', () => {
    let settings = ready()
    const stop = vi.fn()
    let spawned = 0
    const ctl = createMeetingAutoStart({
      startWatcher: () => {
        spawned++
        return { stop, current: () => null, healthy: () => true }
      },
      getSettings: () => settings,
      isListening: () => false,
      startListen: () => {}
    })
    ctl.refresh()
    expect(spawned).toBe(1)
    settings = ready({ autoStartMeetings: { ...DEFAULT_AUTO_START_MEETINGS, enabled: false } })
    ctl.refresh()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
