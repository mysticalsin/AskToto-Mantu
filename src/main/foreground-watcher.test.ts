import { describe, it, expect } from 'vitest'
import { parseForegroundLine, startForegroundWatcher } from './foreground-watcher'

describe('parseForegroundLine', () => {
  it('parses HWND / PID / title', () => {
    expect(parseForegroundLine('12345\t678\tVisual Studio Code')).toEqual({
      windowId: '12345',
      pid: 678,
      title: 'Visual Studio Code'
    })
  })

  it('accepts an empty title (untitled / secure window)', () => {
    expect(parseForegroundLine('999\t1\t')).toEqual({ windowId: '999', pid: 1, title: '' })
  })

  it('strips a trailing CR/LF from the line', () => {
    expect(parseForegroundLine('7\t3\tNotepad\r\n')?.title).toBe('Notepad')
  })

  it('keeps everything after the second tab as the title', () => {
    // The watcher script strips tabs from titles, but joining is safe if one ever slips through.
    expect(parseForegroundLine('1\t2\ta\tb')?.title).toBe('a\tb')
  })

  it('returns null for blank, malformed, or non-numeric-pid lines', () => {
    expect(parseForegroundLine('')).toBeNull()
    expect(parseForegroundLine('   ')).toBeNull()
    expect(parseForegroundLine('no-tabs-here')).toBeNull()
    expect(parseForegroundLine('12345\tNaNpid\ttitle')).toBeNull()
    expect(parseForegroundLine('\t5\ttitle')).toBeNull() // empty hwnd
  })
})

describe('startForegroundWatcher — non-Windows', () => {
  it('returns an inert handle that never fires and never spawns anything', () => {
    let fired = 0
    const w = startForegroundWatcher(() => fired++, { platform: 'darwin' })
    expect(w.current()).toBeNull()
    expect(fired).toBe(0)
    expect(() => w.stop()).not.toThrow() // stop is a safe no-op
  })
})
