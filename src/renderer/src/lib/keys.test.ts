import { describe, it, expect, afterEach, vi } from 'vitest'

// isWindows is resolved at module load from navigator.platform, so each case sets the platform, resets
// the module registry, and re-imports keys.ts fresh to exercise the intended branch.
async function loadKeys(platform: string): Promise<typeof import('./keys')> {
  vi.stubGlobal('navigator', { platform } as Navigator)
  vi.resetModules()
  return import('./keys')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('keys — macOS', () => {
  it('renders modifier glyphs, "+"-joined, for chips', async () => {
    const { displayAccelerator } = await loadKeys('MacIntel')
    expect(displayAccelerator('CommandOrControl+Shift+S')).toBe('⌘+⇧+S')
    expect(displayAccelerator('CommandOrControl+Shift+Return')).toBe('⌘+⇧+↵')
    expect(displayAccelerator('Alt+Left')).toBe('⌥+Left')
  })
  it('compact labels drop the "+" so glyphs run together', async () => {
    const { accelLabel } = await loadKeys('MacIntel')
    expect(accelLabel('CommandOrControl+Shift+S')).toBe('⌘⇧S')
    expect(accelLabel('CommandOrControl+R')).toBe('⌘R')
    expect(accelLabel('Return')).toBe('↵')
  })
})

describe('keys — Windows', () => {
  it('renders word tokens (Ctrl/Alt/Shift/Win/Enter), "+"-joined', async () => {
    const { displayAccelerator } = await loadKeys('Win32')
    expect(displayAccelerator('CommandOrControl+Shift+S')).toBe('Ctrl+Shift+S')
    expect(displayAccelerator('CommandOrControl+Shift+Return')).toBe('Ctrl+Shift+Enter')
    expect(displayAccelerator('Meta+Alt+Delete')).toBe('Win+Alt+Delete')
  })
  it('compact labels keep the "+" so word tokens stay legible', async () => {
    const { accelLabel } = await loadKeys('Win32')
    expect(accelLabel('CommandOrControl+Shift+S')).toBe('Ctrl+Shift+S')
    expect(accelLabel('CommandOrControl+R')).toBe('Ctrl+R')
    expect(accelLabel('Return')).toBe('Enter')
  })
})

describe('keys — edge cases', () => {
  it('empty accelerator returns empty string on both helpers', async () => {
    const { displayAccelerator, accelLabel } = await loadKeys('Win32')
    expect(displayAccelerator('')).toBe('')
    expect(accelLabel('')).toBe('')
  })
})
