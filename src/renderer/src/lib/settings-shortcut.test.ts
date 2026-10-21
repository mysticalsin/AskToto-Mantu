import { describe, expect, it } from 'vitest'
import { isSettingsShortcut } from './overlay-window-effects'

const key = (over: Partial<KeyboardEvent>) => ({
  key: ',',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...over
})

describe('Command-Comma opens Settings (HIG Settings)', () => {
  it('matches Command-Comma on macOS only', () => {
    expect(isSettingsShortcut(key({ metaKey: true }), false)).toBe(true)
    expect(isSettingsShortcut(key({ ctrlKey: true }), false)).toBe(false)
    expect(isSettingsShortcut(key({}), false)).toBe(false)
  })

  it('matches Control-Comma on Windows only', () => {
    expect(isSettingsShortcut(key({ ctrlKey: true }), true)).toBe(true)
    expect(isSettingsShortcut(key({ metaKey: true }), true)).toBe(false)
  })

  it('ignores other modifiers, other keys and IME composition', () => {
    expect(isSettingsShortcut(key({ metaKey: true, shiftKey: true }), false)).toBe(false)
    expect(isSettingsShortcut(key({ metaKey: true, altKey: true }), false)).toBe(false)
    expect(isSettingsShortcut(key({ metaKey: true, key: '.' }), false)).toBe(false)
    expect(isSettingsShortcut(key({ metaKey: true, isComposing: true }), false)).toBe(false)
  })
})
