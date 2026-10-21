import { describe, expect, it, vi } from 'vitest'
import { micMeterMode, onAppActive } from './permission-ask'

/** A focusable window and a document whose visibility the test controls, both real EventTargets. */
function activeEnv(): {
  env: Parameters<typeof onAppActive>[1]
  focus: () => void
  show: () => void
  hide: () => void
} {
  const win = new EventTarget()
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
  return {
    env: { window: win as unknown as Window, document: doc as unknown as Document },
    focus: () => win.dispatchEvent(new Event('focus')),
    show: () => {
      doc.visibilityState = 'visible'
      doc.dispatchEvent(new Event('visibilitychange'))
    },
    hide: () => {
      doc.visibilityState = 'hidden'
      doc.dispatchEvent(new Event('visibilitychange'))
    }
  }
}

describe('C26 (HIG P5) — re-check permission status when Métis becomes active again', () => {
  it('does not check on subscribe; checks when the window regains focus or the page becomes visible', () => {
    const { env, focus, show, hide } = activeEnv()
    const recheck = vi.fn()
    const stop = onAppActive(recheck, env)
    expect(recheck).not.toHaveBeenCalled()
    focus()
    expect(recheck).toHaveBeenCalledTimes(1)
    hide()
    expect(recheck).toHaveBeenCalledTimes(1)
    show()
    expect(recheck).toHaveBeenCalledTimes(2)
    stop()
    focus()
    show()
    expect(recheck).toHaveBeenCalledTimes(2)
  })
})

describe('C26 (HIG P1) — Settings → Audio opens the microphone only once permission allows it', () => {
  const mac = { tested: false, windows: false }

  it('waits for the status before opening anything', () => {
    expect(micMeterMode(null, mac)).toBe('pending')
    expect(micMeterMode(undefined, mac)).toBe('pending')
  })

  it('opens the meter on mount only when access is already granted (or not required)', () => {
    expect(micMeterMode('granted', mac)).toBe('meter')
    expect(micMeterMode('not-required', mac)).toBe('meter')
  })

  it('a not-determined microphone shows Test Microphone, even after an unanswered test on macOS', () => {
    expect(micMeterMode('unknown', mac)).toBe('test')
    expect(micMeterMode('unknown', { tested: true, windows: false })).toBe('test')
  })

  it('on Windows the test itself opens the meter: getUserMedia is the only thing that resolves consent there', () => {
    expect(micMeterMode('unknown', { tested: false, windows: true })).toBe('test')
    expect(micMeterMode('unknown', { tested: true, windows: true })).toBe('meter')
  })

  it('a denied microphone never opens and never re-prompts: it shows the System Settings deep link', () => {
    expect(micMeterMode('denied', mac)).toBe('denied')
    expect(micMeterMode('denied', { tested: true, windows: true })).toBe('denied')
  })
})
