import { describe, it, expect, vi, beforeEach } from 'vitest'

// foreground-watcher.ts imports mac-helper.ts (electron + logger chain) for the darwin spawn spec — mock
// it so these tests are hermetic AND deterministic: on a dev mac the real helper binary exists at
// resources/mac-helper and an unmocked darwin test would spawn it for real.
const macHelperMock = vi.hoisted(() => ({
  macWatcherSpawnSpec: vi.fn((): { command: string; args: string[] } | null => null)
}))
vi.mock('./mac-helper', () => macHelperMock)

import { parseForegroundLine, startForegroundWatcher, winWatcherSpawnSpec } from './foreground-watcher'

// Accepts either separator so the assertion holds when a non-Windows host resolves the pinned path.
const ABSOLUTE_SYSTEM32_POWERSHELL =
  /^[A-Za-z]:[\\/](.+[\\/])?System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i

beforeEach(() => {
  macHelperMock.macWatcherSpawnSpec.mockReturnValue(null)
})

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

  it('parses the mac helper shape too — bundle id as windowId, app name as title (live-verified)', () => {
    expect(parseForegroundLine('com.apple.finder\t769\tFinder')).toEqual({
      windowId: 'com.apple.finder',
      pid: 769,
      title: 'Finder'
    })
  })

  it('returns null for blank, malformed, or non-numeric-pid lines', () => {
    expect(parseForegroundLine('')).toBeNull()
    expect(parseForegroundLine('   ')).toBeNull()
    expect(parseForegroundLine('no-tabs-here')).toBeNull()
    expect(parseForegroundLine('12345\tNaNpid\ttitle')).toBeNull()
    expect(parseForegroundLine('\t5\ttitle')).toBeNull() // empty hwnd
  })
})

describe('winWatcherSpawnSpec — powershell is pinned to System32', () => {
  // Regression: the watcher used to spawn a bare 'powershell.exe'. Windows' CreateProcess searches the
  // current working directory before PATH, so a bare name runs an attacker-planted powershell.exe if the
  // app is ever launched from an attacker-writable cwd (win-security.ts states the invariant).
  it('spawns the absolute %SystemRoot%\\System32 powershell, never a bare name', () => {
    const spec = winWatcherSpawnSpec()
    expect(spec.command).toMatch(ABSOLUTE_SYSTEM32_POWERSHELL)
    expect(spec.command).not.toBe('powershell.exe')
    expect(spec.command).not.toBe('powershell')
  })

  it('still passes the encoded watcher script (the pinning did not change the payload)', () => {
    const spec = winWatcherSpawnSpec()
    expect(spec.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ])
    expect(Buffer.from(spec.args[5], 'base64').toString('utf16le')).toContain('GetForegroundWindow')
  })
})

describe('startForegroundWatcher — platforms without a producer', () => {
  it('linux: inert handle that never fires and never spawns anything', () => {
    let fired = 0
    const w = startForegroundWatcher(() => fired++, { platform: 'linux' })
    expect(w.current()).toBeNull()
    expect(fired).toBe(0)
    expect(() => w.stop()).not.toThrow() // stop is a safe no-op
  })

  it('darwin WITHOUT the bundled helper: inert handle (pre-helper mac behavior)', () => {
    macHelperMock.macWatcherSpawnSpec.mockReturnValue(null)
    let fired = 0
    const w = startForegroundWatcher(() => fired++, { platform: 'darwin' })
    expect(w.current()).toBeNull()
    expect(fired).toBe(0)
    expect(() => w.stop()).not.toThrow()
  })
})

describe('startForegroundWatcher — darwin with the helper present', () => {
  it('consumes the helper spawn spec and emits parsed app-activation events', async () => {
    // Fake the helper with a node one-liner speaking the exact TSV protocol, staying alive afterwards
    // (so the exit-triggered restart path stays quiet during the assertion window).
    macHelperMock.macWatcherSpawnSpec.mockReturnValue({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("com.apple.finder\\t769\\tFinder\\n");setTimeout(()=>{},30000)']
    })
    const events: Array<{ windowId: string; pid: number; title: string }> = []
    const w = startForegroundWatcher((info) => events.push(info), { platform: 'darwin' })
    try {
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5000 })
      expect(events[0]).toEqual({ windowId: 'com.apple.finder', pid: 769, title: 'Finder' })
      expect(w.current()).toEqual(events[0])
    } finally {
      w.stop()
    }
  })
})
