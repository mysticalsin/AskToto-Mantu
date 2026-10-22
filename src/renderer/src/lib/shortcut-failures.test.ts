import { describe, expect, it } from 'vitest'
import { createShortcutFailureAnnouncer, shortcutFailureMessage } from './shortcut-failures'

const plain = (a: string): string => a
const hide = { action: 'hide', accel: 'CommandOrControl+Shift+H' }
const listen = { action: 'toggle-listen', accel: 'Control+Alt+L' }

describe('shortcutFailureMessage (D10-5)', () => {
  it('names the action and keys and points at Settings → Shortcuts', () => {
    expect(shortcutFailureMessage([hide], plain)).toBe(
      'Show / hide shortcut CommandOrControl+Shift+H is used by another app. Choose a different one in Settings → Shortcuts.'
    )
  })

  it('names the first failure and counts the rest', () => {
    expect(shortcutFailureMessage([hide, listen], plain)).toBe(
      'Show / hide shortcut CommandOrControl+Shift+H and 1 more are used by another app. Choose different ones in Settings → Shortcuts.'
    )
  })

  it('has no message for an empty list', () => {
    expect(shortcutFailureMessage([], plain)).toBeNull()
  })

  it('falls back to the raw action id when it has no label', () => {
    expect(shortcutFailureMessage([{ action: 'mystery', accel: 'F13' }], plain)).toContain('mystery shortcut F13')
  })
})

describe('createShortcutFailureAnnouncer (D10-5)', () => {
  it('announces a failure set once per session, in any order', () => {
    const announce = createShortcutFailureAnnouncer(plain)
    expect(announce([hide, listen])).toContain('Show / hide')
    expect(announce([listen, hide])).toBeNull()
    expect(announce([hide, listen])).toBeNull()
  })

  it('announces again when the set changes, and never for an empty set', () => {
    const announce = createShortcutFailureAnnouncer(plain)
    expect(announce([])).toBeNull()
    expect(announce([hide])).not.toBeNull()
    expect(announce([hide, listen])).not.toBeNull()
    expect(announce([])).toBeNull()
  })
})
