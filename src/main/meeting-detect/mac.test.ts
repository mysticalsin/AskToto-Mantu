import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn(() => Promise.resolve([])) }
}))

import { buildFullMacScript } from './mac'

describe('buildFullMacScript', () => {
  it('does not emit Chromium browser dictionary blocks for browsers that are not running', () => {
    const script = buildFullMacScript(new Set(['Safari']))

    expect(script).not.toContain('using terms from application "Google Chrome"')
    expect(script).not.toContain('using terms from application "Brave Browser"')
    expect(script).not.toContain('using terms from application "Microsoft Edge"')
    expect(script).not.toContain('using terms from application "Vivaldi"')
    expect(script).toContain('tell application "Safari"')
  })

  it('emits a Chromium URL block for a browser that is running', () => {
    const script = buildFullMacScript(new Set(['Google Chrome']))

    expect(script).toContain('using terms from application "Google Chrome"')
    expect(script).toContain('tell application "Google Chrome"')
    expect(script).not.toContain('using terms from application "Brave Browser"')
  })
})
