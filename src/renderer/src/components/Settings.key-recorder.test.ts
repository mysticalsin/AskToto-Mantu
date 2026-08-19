import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * MQA-184 — Settings → Shortcuts key recorder was a keyboard trap (WCAG 2.1.2, No Keyboard Trap).
 *
 * Its keydown handler ran `preventDefault(); stopPropagation()` on every key except Escape, so once a
 * keyboard-only user opened a recorder, Tab could not move focus out and Shift+Tab did not escape either —
 * it COMMITTED, binding 'Shift+Tab' as an OS-global accelerator that then swallowed reverse-tab navigation
 * for as long as Métis ran. The one exit that did work, Escape, appeared in no user-visible string, and
 * taking it bubbled to App's window-level Escape handler, closing the entire Settings panel, with focus
 * dropped onto <body>.
 *
 * KeyRecorder is a closure inside a 7k-line component and there is no DOM test environment in this repo
 * (vitest runs `environment: 'node'`), so — like the *.contract.test.ts files in src/main — the wiring is
 * pinned against source. The accelerator-shape half of the fix is behaviour-tested in
 * src/shared/accelerator.test.ts.
 */
const settingsSrc = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8')
const recorder = settingsSrc.slice(settingsSrc.indexOf('function KeyRecorder('), settingsSrc.indexOf('function Shortcuts('))
const handler = recorder.slice(recorder.indexOf('const onKeyDown'), recorder.indexOf('const onBlur'))

describe('the shortcut recorder does not trap keyboard focus (MQA-184)', () => {
  it('lets Tab through before anything cancels the event, so focus can still move out (MQA-184)', () => {
    const tabIdx = handler.indexOf("e.key === 'Tab'")
    const preventIdx = handler.indexOf('e.preventDefault()')
    expect(tabIdx).toBeGreaterThan(-1)
    expect(preventIdx).toBeGreaterThan(-1)
    // Tab must be decided BEFORE preventDefault/stopPropagation — a guard placed after them (or inside
    // keyEventToAccelerator) leaves the key swallowed and focus stuck.
    expect(tabIdx).toBeLessThan(preventIdx)
    expect(handler.slice(tabIdx, preventIdx)).toContain('return')
  })

  it('never turns Tab into a global accelerator (MQA-184)', () => {
    const accel = settingsSrc.slice(settingsSrc.indexOf('function keyEventToAccelerator'), settingsSrc.indexOf('function KeyChips'))
    expect(accel).not.toContain("'Tab'")
  })
})

describe('the recorder advertises its exit and keeps the user in place (MQA-184)', () => {
  it('names Escape on screen, not just in the handler (MQA-184)', () => {
    expect(recorder).toContain('Press Esc to cancel')
  })

  it('stops the cancelling Escape from also closing the whole Settings panel (MQA-184)', () => {
    const escIdx = handler.indexOf("e.key === 'Escape'")
    const stopIdx = handler.indexOf('e.stopPropagation()')
    expect(escIdx).toBeGreaterThan(-1)
    expect(stopIdx).toBeGreaterThan(-1)
    // App.tsx's window-level Escape handler sends the view back to 'answer'. A cancel that also closes
    // Settings is not an exit, so the recorder's Escape must be stopped before it bubbles.
    expect(stopIdx).toBeLessThan(escIdx)
  })

  it('hands focus back to the row trigger when the recorder closes (MQA-184)', () => {
    expect(recorder).toContain('ref={triggerRef}')
    expect(recorder).toMatch(/triggerRef\.current\?\.focus\(\)/)
  })

  it('does not blame another app for a binding Metis itself refused (MQA-184)', () => {
    // main now rejects an unsafe stored accelerator (a navigation key) into the same shortcutFailures
    // list the banner renders, so the banner can no longer claim one cause it cannot know.
    const banner = settingsSrc.slice(
      settingsSrc.indexOf("These shortcuts couldn't"),
      settingsSrc.indexOf("These shortcuts couldn't") + 400
    )
    expect(banner).not.toContain('Another app likely owns the key combo')
    expect(banner).toContain('navigation key')
  })
})
