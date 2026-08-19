import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSafeAccelerator } from './accelerator'
import { DEFAULT_SHORTCUTS } from './ipc'

/**
 * MQA-184 — the Settings → Shortcuts recorder trapped keyboard focus, and Shift+Tab did not escape it but
 * COMMITTED: 'Shift+Tab' was persisted and registered as an OS-global accelerator, so reverse-tab navigation
 * was swallowed everywhere for as long as Métis ran. The recorder no longer produces it (pinned in
 * src/renderer/src/components/Settings.key-recorder.test.ts), and main no longer binds it either — an
 * already-persisted or hand-edited settings.json must not be able to take a navigation key hostage.
 */
describe('isSafeAccelerator (MQA-184)', () => {
  it('rejects a navigation key, with or without modifiers (MQA-184)', () => {
    expect(isSafeAccelerator('Shift+Tab')).toBe(false)
    expect(isSafeAccelerator('Tab')).toBe(false)
    expect(isSafeAccelerator('CommandOrControl+Alt+tab')).toBe(false)
  })

  it('rejects a bare key, which would fire on ordinary typing (MQA-184)', () => {
    expect(isSafeAccelerator('A')).toBe(false)
    expect(isSafeAccelerator('Return')).toBe(false)
  })

  it('rejects a lone modifier or a malformed string (MQA-184)', () => {
    expect(isSafeAccelerator('CommandOrControl+Shift')).toBe(false)
    expect(isSafeAccelerator('')).toBe(false)
    expect(isSafeAccelerator('Ctrl+')).toBe(false)
    expect(isSafeAccelerator('NotAModifier+A')).toBe(false)
  })

  it('accepts every shipped default binding (MQA-184)', () => {
    for (const accel of Object.values(DEFAULT_SHORTCUTS)) {
      if (!accel) continue // '' is the unbind sentinel — registerShortcuts skips it before the guard
      expect(isSafeAccelerator(accel), accel).toBe(true)
    }
  })

  it('accepts the combos the recorder can produce (MQA-184)', () => {
    expect(isSafeAccelerator('CommandOrControl+Shift+Return')).toBe(true)
    expect(isSafeAccelerator('Alt+Shift+Up')).toBe(true)
    expect(isSafeAccelerator('CommandOrControl+\\')).toBe(true) // the shipped 'hide' binding
    expect(isSafeAccelerator('CommandOrControl+Alt+F5')).toBe(true)
  })
})

const mainSrc = readFileSync(join(__dirname, '..', 'main', 'index.ts'), 'utf8')
const registerShortcuts = mainSrc.slice(
  mainSrc.indexOf('function registerShortcuts()'),
  mainSrc.indexOf('let notifTimer')
)

describe('registerShortcuts refuses an unsafe stored accelerator (MQA-184)', () => {
  it('validates the accelerator before handing it to globalShortcut.register (MQA-184)', () => {
    const guardIdx = registerShortcuts.indexOf('isSafeAccelerator(accel)')
    const registerIdx = registerShortcuts.indexOf('globalShortcut.register(accel')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(registerIdx).toBeGreaterThan(guardIdx)
  })

  it('surfaces the rejection in the Settings failures banner instead of failing silently (MQA-184)', () => {
    const guardIdx = registerShortcuts.indexOf('isSafeAccelerator(accel)')
    expect(registerShortcuts.slice(guardIdx, guardIdx + 300)).toContain('shortcutFailures.push({ action, accel })')
  })
})
