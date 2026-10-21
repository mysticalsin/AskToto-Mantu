import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'

const { execFileMock, execFileAsyncMock, spawnMock } = vi.hoisted(() => {
  const execFileMock = vi.fn()
  const execFileAsyncMock = vi.fn()
  Object.defineProperty(execFileMock, Symbol.for('nodejs.util.promisify.custom'), {
    value: execFileAsyncMock
  })
  return { execFileMock, execFileAsyncMock, spawnMock: vi.fn() }
})

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }))

import { CommandControl } from './command-control'
import { executeDesktopAction } from './desktop-adapters'

type SpawnedGui = EventEmitter & { unref: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }

function persistentGui(): SpawnedGui {
  const child = new EventEmitter() as SpawnedGui
  child.unref = vi.fn()
  child.kill = vi.fn()
  return child
}

const GOOGLE_URL = 'https://www.google.com/search?q=Norbert%20Wiener'
const X_URL = 'https://x.com'
const ACK_SENTINEL = 'synthetic-ack-message-stdout-stderr-sentinel'

beforeEach(() => {
  execFileMock.mockReset()
  execFileAsyncMock.mockReset()
  execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => {
    throw new Error('Unexpected process spawn in desktop adapter test')
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop adapters fixed-demo request guard', () => {
  it.each([
    ['darwin' as const, { id: 'desktop.create_note' as const, args: { title: '"; do shell script "bad"' } }],
    ['win32' as const, { id: 'desktop.google_search' as const, args: { q: 'https://attacker.invalid/?x=1' } }]
  ])('rejects an unsupported request before any %s process call', async (platform, request) => {
    const result = await executeDesktopAction(request, platform)

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('unsupported')
    expect(execFileAsyncMock).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(['linux' as const, 'other' as const])('keeps desktop actions unsupported on %s', async (platform) => {
    const result = await executeDesktopAction({ id: 'desktop.open_notes', args: {} }, platform)

    expect(result).toMatchObject({ ok: false, outcome: 'unsupported' })
    expect(execFileAsyncMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('preserves the fixed Mac Notes and AppleScript command for a demo note', async () => {
    const result = await executeDesktopAction({ id: 'desktop.create_note', args: { title: 'hello' } }, 'darwin')

    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/open',
      ['-a', 'Notes'],
      expect.objectContaining({ timeout: 15_000 })
    )
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/osascript',
      [
        '-e',
        'tell application "Notes"\nactivate\nmake new note with properties {name:"hello", body:"hello"}\nend tell'
      ],
      expect.objectContaining({ timeout: 15_000 })
    )
    expect(result).toMatchObject({ id: 'desktop.create_note', ok: true, outcome: 'unknown' })
  })

  it('preserves Windows Arc as unsupported without invoking a process', async () => {
    const result = await executeDesktopAction({ id: 'desktop.open_arc', args: {} }, 'win32')

    expect(result).toMatchObject({ id: 'desktop.open_arc', ok: false, outcome: 'unsupported', preferredMissing: true })
    expect(execFileAsyncMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('acknowledges a fixed Notepad launch after process creation without waiting for exit', async () => {
    const child = persistentGui()
    spawnMock.mockReturnValueOnce(child)

    const resultPromise = executeDesktopAction({ id: 'desktop.create_note', args: { title: 'hello' } }, 'win32')
    let spawnAcknowledged = false
    const acknowledgeSpawn = () => {
      if (spawnAcknowledged) return
      spawnAcknowledged = true
      child.emit('spawn')
    }

    try {
      await Promise.resolve()

      expect(spawnMock).toHaveBeenCalledWith('C:\\Windows\\notepad.exe', [], {
        detached: false,
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      })
      expect(child.kill).not.toHaveBeenCalled()

      acknowledgeSpawn()

      await expect(resultPromise).resolves.toMatchObject({
        id: 'desktop.create_note',
        ok: true,
        outcome: 'unknown'
      })
      expect(child.unref).toHaveBeenCalledOnce()
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      acknowledgeSpawn()
      await resultPromise
    }
  })

  it('keeps an observed Notepad process-creation error failed without exposing its message', async () => {
    const child = persistentGui()
    spawnMock.mockReturnValueOnce(child)

    const resultPromise = executeDesktopAction({ id: 'desktop.create_note', args: { title: 'hello' } }, 'win32')
    child.emit('error', new Error(ACK_SENTINEL))

    const result = await resultPromise
    expect(result).toMatchObject({ id: 'desktop.create_note', ok: false, outcome: 'failed' })
    expect(result.detail).not.toContain(ACK_SENTINEL)
    expect(result.preferredMissing).toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
  })
})

describe('desktop adapter uncertain process acknowledgments', () => {
  it.each([
    ['Notes', { id: 'desktop.open_notes' as const, args: {} }],
    ['Arc', { id: 'desktop.open_arc' as const, args: {} }]
  ])('does not infer that %s is missing from an ENOENT launch rejection', async (app, request) => {
    execFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error(ACK_SENTINEL), { code: 'ENOENT' }))

    const result = await executeDesktopAction(request as DesktopActionRequest, 'darwin')

    expect(execFileAsyncMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ id: request.id, ok: false, outcome: 'unknown' })
    expect(result.preferredMissing).toBeUndefined()
    expect(result.detail).not.toContain(ACK_SENTINEL)
  })

  it.each([
    {
      name: 'Google search',
      request: { id: 'desktop.google_search' as const, args: { q: 'Norbert Wiener' } },
      expectedArgs: ['-a', 'Arc', GOOGLE_URL]
    },
    {
      name: 'X navigation',
      request: { id: 'desktop.open_x' as const, args: {} },
      expectedArgs: ['-a', 'Arc', X_URL]
    }
  ])('does not redispatch $name after the preferred-app acknowledgment is uncertain', async ({
    request,
    expectedArgs
  }) => {
    execFileAsyncMock.mockRejectedValueOnce(new Error(ACK_SENTINEL))
    // If production incorrectly makes a second call, make it settle so the test fails on the count.
    execFileAsyncMock.mockResolvedValueOnce({ stdout: ACK_SENTINEL, stderr: ACK_SENTINEL })

    const result = await executeDesktopAction(request as DesktopActionRequest, 'darwin')

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      expectedArgs,
      expect.objectContaining({ timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 })
    )
    expect(result).toMatchObject({ id: request.id, ok: false, outcome: 'unknown' })
    expect(result.preferredMissing).toBeUndefined()
    expect(result.detail).not.toContain(ACK_SENTINEL)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('carries the real adapter uncertainty through CommandControl without another dispatch', async () => {
    const audit = vi.fn()
    const controller = new CommandControl({
      execute: (request) => executeDesktopAction(request, 'darwin'),
      policyAllows: () => true,
      audit
    })
    const request = { id: 'desktop.google_search' as const, args: { q: 'Norbert Wiener' } }
    execFileAsyncMock.mockRejectedValueOnce(new Error(ACK_SENTINEL))
    execFileAsyncMock.mockResolvedValueOnce({ stdout: ACK_SENTINEL, stderr: ACK_SENTINEL })
    const proposal = controller.propose({ webContentsId: 7, revision: 2 }, request)

    const result = await controller.confirm({ ...proposal, webContentsId: 7 })

    expect(result).toEqual({ ok: false, reason: 'outcome_unverified' })
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith('command.confirmed', {
      actionId: 'desktop.google_search',
      outcome: 'unknown'
    })
    expect(JSON.stringify(audit.mock.calls)).not.toContain(ACK_SENTINEL)
  })

  it.each([
    [
      'numeric exit with process output',
      () => Object.assign(new Error(ACK_SENTINEL), { code: 1, stdout: ACK_SENTINEL, stderr: ACK_SENTINEL })
    ],
    [
      'timeout and signal fields',
      () => Object.assign(new Error(ACK_SENTINEL), { killed: true, signal: 'SIGTERM', stdout: ACK_SENTINEL })
    ],
    [
      'max-buffer fields',
      () => Object.assign(new Error(ACK_SENTINEL), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: ACK_SENTINEL })
    ],
    [
      'malformed error properties',
      () => {
        const thrown = Object.create(null) as Record<string, unknown>
        Object.defineProperty(thrown, 'stdout', {
          get: () => {
            throw new Error(ACK_SENTINEL)
          }
        })
        Object.defineProperty(thrown, 'stderr', {
          get: () => {
            throw new Error(ACK_SENTINEL)
          }
        })
        Object.defineProperty(thrown, 'message', {
          get: () => {
            throw new Error(ACK_SENTINEL)
          }
        })
        return thrown
      }
    ]
  ])('keeps %s as unknown without reading or exposing thrown-value data', async (_label, createError) => {
    execFileAsyncMock.mockRejectedValueOnce(createError())
    execFileAsyncMock.mockResolvedValueOnce({ stdout: ACK_SENTINEL, stderr: ACK_SENTINEL })

    const result = await executeDesktopAction({ id: 'desktop.google_search', args: { q: 'Norbert Wiener' } }, 'darwin')

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' })
    expect(result.preferredMissing).toBeUndefined()
    expect(result.detail).not.toContain(ACK_SENTINEL)
  })

  it.each([
    ['Notes', { id: 'desktop.create_note' as const, args: { title: 'hello' } }],
    ['Photo Booth', { id: 'desktop.photo_booth_capture' as const, args: {} }]
  ])('does not issue dependent AppleScript after uncertain %s launch acknowledgment', async (app, request) => {
    execFileAsyncMock.mockRejectedValueOnce(new Error(ACK_SENTINEL))

    const result = await executeDesktopAction(request, 'darwin')

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', app],
      expect.objectContaining({ timeout: 15_000 })
    )
    expect(result).toMatchObject({ id: request.id, ok: false, outcome: 'unknown' })
    expect(result.preferredMissing).toBeUndefined()
    expect(result.detail).not.toContain(ACK_SENTINEL)
  })

  it.each([
    ['note creation', { id: 'desktop.create_note' as const, args: { title: 'hello' } }],
    ['Photo Booth capture', { id: 'desktop.photo_booth_capture' as const, args: {} }]
  ])('keeps a failed post-launch AppleScript acknowledgment for %s unknown', async (_label, request) => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    execFileAsyncMock.mockRejectedValueOnce(new Error(ACK_SENTINEL))

    const result = await executeDesktopAction(request, 'darwin')

    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ id: request.id, ok: false, outcome: 'unknown' })
    expect(result.preferredMissing).toBeUndefined()
    expect(result.detail).not.toContain(ACK_SENTINEL)
  })

  it('does not spawn Notepad after an uncertain Windows Sticky Notes acknowledgment', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error(ACK_SENTINEL))

    const result = await executeDesktopAction({ id: 'desktop.open_notes', args: {} }, 'win32')

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'C:\\Windows\\explorer.exe',
      ['shell:AppsFolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App'],
      expect.objectContaining({ timeout: 15_000 })
    )
    expect(result).toMatchObject({ id: 'desktop.open_notes', ok: false, outcome: 'unknown' })
    expect(result.preferredMissing).toBeUndefined()
    expect(result.detail).not.toContain(ACK_SENTINEL)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('preserves the acknowledged Windows Sticky Notes launch command', async () => {
    const result = await executeDesktopAction({ id: 'desktop.open_notes', args: {} }, 'win32')

    expect(execFileAsyncMock).toHaveBeenCalledOnce()
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'C:\\Windows\\explorer.exe',
      ['shell:AppsFolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App'],
      expect.objectContaining({ timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 })
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ id: 'desktop.open_notes', ok: true, outcome: 'unknown' })
  })

  it.each([
    {
      name: 'Google search',
      request: { id: 'desktop.google_search' as const, args: { q: 'Norbert Wiener' } },
      target: GOOGLE_URL
    },
    {
      name: 'X navigation',
      request: { id: 'desktop.open_x' as const, args: {} },
      target: X_URL
    }
  ])('preserves the direct Windows $name launch arguments', async ({ request, target }) => {
    const result = await executeDesktopAction(request as DesktopActionRequest, 'win32')

    expect(execFileAsyncMock).toHaveBeenCalledOnce()
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'C:\\Windows\\explorer.exe',
      [target],
      expect.objectContaining({ timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 })
    )
    expect(result).toMatchObject({ id: request.id, ok: true, outcome: 'unknown' })
  })

  it.each([
    {
      name: 'Google search',
      request: { id: 'desktop.google_search' as const, args: { q: 'Norbert Wiener' } },
      args: ['-a', 'Arc', GOOGLE_URL]
    },
    {
      name: 'X navigation',
      request: { id: 'desktop.open_x' as const, args: {} },
      args: ['-a', 'Arc', X_URL]
    }
  ])('preserves the acknowledged Mac $name command and arguments', async ({ request, args }) => {
    const result = await executeDesktopAction(request as DesktopActionRequest, 'darwin')

    expect(execFileAsyncMock).toHaveBeenCalledOnce()
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      args,
      expect.objectContaining({ timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 })
    )
    expect(result).toMatchObject({ id: request.id, ok: true, outcome: 'unknown' })
  })
})
