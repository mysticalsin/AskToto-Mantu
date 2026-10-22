import { describe, expect, it, vi } from 'vitest'
import { HELPER_POLL_MS, HELPER_SUCCESS_CLOSE_MS, type HelperState, type HelperStatus } from '@shared/permission-helper'
import { createPermissionHelper, type PermissionHelperDeps } from './permission-helper'

/** C32 Part D — the helper controller: pane + helper on Continue, a 1 s re-read, success/relaunch, Cancel. */
function harness(platform: NodeJS.Platform, statuses: HelperStatus[]) {
  const sent: HelperState[] = []
  const timers: Array<{ run: () => void; ms: number; live: boolean; repeat: boolean }> = []
  let closedListener: (() => void) | null = null
  const win = {
    send: vi.fn((s: HelperState) => sent.push(s)),
    close: vi.fn(),
    onClosed: (l: () => void) => (closedListener = l)
  }
  const deps: PermissionHelperDeps = {
    platform,
    paneUrl: (kind) =>
      typeof kind === 'string' &&
      (['microphone', 'screenRecording'].includes(kind) ||
        (platform === 'darwin' && ['accessibility', 'inputMonitoring', 'automation'].includes(kind)))
        ? `pane:${kind}`
        : null,
    openPane: vi.fn(),
    readStatus: vi.fn(async () => statuses.shift() ?? { granted: false, needsRelaunch: false }),
    place: () => ({ x: 10, y: 20, towards: 'left' }),
    showWindow: vi.fn(() => win),
    poll: (run, ms) => {
      const t = { run, ms, live: true, repeat: true }
      timers.push(t)
      return () => (t.live = false)
    },
    delay: (run, ms) => {
      const t = { run, ms, live: true, repeat: false }
      timers.push(t)
      return () => (t.live = false)
    },
    relaunch: vi.fn()
  }
  const helper = createPermissionHelper(deps)
  const tick = async (): Promise<void> => {
    for (const t of timers.filter((x) => x.live)) {
      if (!t.repeat) t.live = false
      t.run()
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  return { helper, deps, win, sent, timers, tick, closeWindow: () => closedListener?.() }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createPermissionHelper', () => {
  it('Windows microphone: pane + helper, polls each second, checkmark on grant, then closes itself', async () => {
    const h = harness('win32', [
      { granted: false, needsRelaunch: false },
      { granted: true, needsRelaunch: false }
    ])
    expect(h.helper.open('microphone')).toBe(true)
    expect(h.deps.openPane).toHaveBeenCalledWith('pane:microphone')
    expect(h.deps.showWindow).toHaveBeenCalledWith(expect.objectContaining({ phase: 'waiting', drag: false }), {
      x: 10,
      y: 20,
      towards: 'left'
    })
    await flush()
    expect(h.helper.state()?.phase).toBe('waiting')
    expect(h.timers[0]).toMatchObject({ ms: HELPER_POLL_MS, repeat: true })
    await h.tick()
    expect(h.helper.state()?.phase).toBe('granted')
    expect(h.sent.at(-1)?.phase).toBe('granted')
    expect(h.timers.some((t) => t.live && t.ms === HELPER_SUCCESS_CLOSE_MS)).toBe(true)
    expect(h.timers.find((t) => t.repeat)?.live).toBe(false) // polling stopped
    await h.tick()
    expect(h.helper.state()?.phase).toBe('closed')
    expect(h.win.close).toHaveBeenCalledTimes(1)
  })

  it('macOS Screen Recording: a grant offers Relaunch and relaunches only on request', async () => {
    const h = harness('darwin', [{ granted: true, needsRelaunch: true }])
    h.helper.relaunch()
    expect(h.deps.relaunch).not.toHaveBeenCalled()
    h.helper.open('screenRecording')
    await flush()
    expect(h.helper.state()).toMatchObject({ phase: 'relaunch', drag: true })
    h.helper.relaunch()
    expect(h.deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('G10 macOS Accessibility: pane and drag helper, granted live with no relaunch', async () => {
    const h = harness('darwin', [{ granted: true, needsRelaunch: false }])
    expect(h.helper.open('accessibility')).toBe(true)
    expect(h.deps.openPane).toHaveBeenCalledWith('pane:accessibility')
    expect(h.deps.showWindow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'accessibility', drag: true, pane: 'Accessibility' }),
      expect.anything()
    )
    await flush()
    expect(h.helper.state()?.phase).toBe('granted')
  })

  it('G10 macOS Input Monitoring: a grant offers Relaunch (the running process only sees it next launch)', async () => {
    const h = harness('darwin', [{ granted: true, needsRelaunch: true }])
    h.helper.open('inputMonitoring')
    await flush()
    expect(h.helper.state()).toMatchObject({ phase: 'relaunch', kind: 'inputMonitoring' })
    h.helper.relaunch()
    expect(h.deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('G10 macOS Automation: pane and helper without a drag item', () => {
    const h = harness('darwin', [])
    expect(h.helper.open('automation')).toBe(true)
    expect(h.deps.showWindow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'automation', drag: false }),
      expect.anything()
    )
  })

  it('G10 Windows has no Accessibility, Input Monitoring or Automation consent: nothing opens', () => {
    for (const kind of ['accessibility', 'inputMonitoring', 'automation']) {
      const h = harness('win32', [])
      expect(h.helper.open(kind)).toBe(false)
      expect(h.deps.openPane).not.toHaveBeenCalled()
      expect(h.deps.showWindow).not.toHaveBeenCalled()
    }
  })

  it('macOS microphone keeps its native prompt: the pane opens, no helper', () => {
    const h = harness('darwin', [])
    expect(h.helper.open('microphone')).toBe(false)
    expect(h.deps.openPane).toHaveBeenCalledWith('pane:microphone')
    expect(h.deps.showWindow).not.toHaveBeenCalled()
  })

  it('an unknown kind opens nothing at all', () => {
    const h = harness('win32', [])
    expect(h.helper.open('camera')).toBe(false)
    expect(h.deps.openPane).not.toHaveBeenCalled()
    expect(h.deps.showWindow).not.toHaveBeenCalled()
  })

  it('Cancel, or closing the window, stops polling; a late read never revives it', async () => {
    const h = harness('win32', [])
    h.helper.open('screenRecording')
    h.helper.cancel()
    expect(h.helper.state()?.phase).toBe('closed')
    expect(h.timers.every((t) => !t.live)).toBe(true)
    await flush()
    expect(h.helper.state()?.phase).toBe('closed')

    const g = harness('win32', [])
    g.helper.open('microphone')
    g.closeWindow()
    expect(g.helper.state()?.phase).toBe('closed')
    expect(g.timers.every((t) => !t.live)).toBe(true)
  })

  it('becoming active again re-reads at once', async () => {
    const h = harness('win32', [
      { granted: false, needsRelaunch: false },
      { granted: true, needsRelaunch: false }
    ])
    h.helper.open('microphone')
    await flush()
    h.helper.appActive()
    await flush()
    expect(h.helper.state()?.phase).toBe('granted')
    expect(h.deps.readStatus).toHaveBeenCalledTimes(2)
  })
})
