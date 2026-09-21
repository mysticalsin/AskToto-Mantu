import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }))

import { executeDesktopAction } from './desktop-adapters'

type SpawnedGui = EventEmitter & { unref: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }

function persistentGui(): SpawnedGui {
  const child = new EventEmitter() as SpawnedGui
  child.unref = vi.fn()
  child.kill = vi.fn()
  return child
}

describe('desktop adapters fixed-demo request guard', () => {
  it.each([
    ['darwin' as const, { id: 'desktop.create_note' as const, args: { title: '"; do shell script "bad"' } }],
    ['win32' as const, { id: 'desktop.google_search' as const, args: { q: 'https://attacker.invalid/?x=1' } }]
  ])('rejects an unsupported request before any %s process call', async (platform, request) => {
    const result = await executeDesktopAction(request, platform)

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('unsupported')
    expect(execFileMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('acknowledges a fixed Notepad launch after process creation without waiting for exit', async () => {
    const child = persistentGui()
    spawnMock.mockReturnValueOnce(child)

    const resultPromise = executeDesktopAction(
      { id: 'desktop.create_note', args: { title: 'hello' } },
      'win32'
    )
    await Promise.resolve()

    expect(spawnMock).toHaveBeenCalledWith('C:\\Windows\\notepad.exe', [], {
      detached: false,
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('spawn')

    await expect(resultPromise).resolves.toMatchObject({
      id: 'desktop.create_note',
      ok: true,
      outcome: 'unknown'
    })
    expect(child.unref).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('returns a visible failure when fixed Notepad process creation fails', async () => {
    const child = persistentGui()
    spawnMock.mockReturnValueOnce(child)

    const resultPromise = executeDesktopAction(
      { id: 'desktop.create_note', args: { title: 'hello' } },
      'win32'
    )
    child.emit('error', new Error('access denied'))

    await expect(resultPromise).resolves.toMatchObject({
      id: 'desktop.create_note',
      ok: false,
      outcome: 'failed',
      detail: 'access denied'
    })
    expect(child.kill).not.toHaveBeenCalled()
  })
})
