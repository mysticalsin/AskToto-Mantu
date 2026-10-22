import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock } = vi.hoisted(() => ({ execFileMock: vi.fn(), spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }))

import { EventEmitter } from 'node:events'
import { runDesktopExec, spawnDesktopGui } from './desktop-exec'

const SENTINEL = 'synthetic-exec-sentinel'

beforeEach(() => {
  execFileMock.mockReset()
  spawnMock.mockReset()
})

describe('runDesktopExec', () => {
  it('runs execFile with an argv array, no shell, a timeout and a bounded buffer', async () => {
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, 'out', ''))
    const result = await runDesktopExec('/usr/bin/open', ['-b', 'com.apple.Notes'], { timeoutMs: 1234 })
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-b', 'com.apple.Notes'],
      expect.objectContaining({ shell: false, timeout: 1234, windowsHide: true, maxBuffer: 1024 * 1024 }),
      expect.any(Function)
    )
    expect(result).toEqual({ ok: true, stdout: 'out', stderr: '', timedOut: false })
  })

  it('copies the argv so a caller cannot change it after the call', async () => {
    const argv = ['a']
    execFileMock.mockImplementation((_f, args, _o, cb) => {
      argv.push('mutated')
      expect(args).toEqual(['a'])
      cb(null, '', '')
    })
    await runDesktopExec('/bin/x', argv)
  })

  it('a failure is ok:false with only a boolean timeout and bounded stderr, never the thrown value', async () => {
    execFileMock.mockImplementation((_f, _a, _o, cb) =>
      cb(Object.assign(new Error(SENTINEL), { killed: true, code: 'ETIMEDOUT' }), SENTINEL, 'e'.repeat(5000))
    )
    const result = await runDesktopExec('/bin/x', [])
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.stderr.length).toBe(2_000)
    expect(JSON.stringify(result)).not.toContain('ETIMEDOUT')
  })

  it('survives an error whose properties throw, and a synchronous throw from execFile', async () => {
    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, 'killed', {
      get: () => {
        throw new Error(SENTINEL)
      }
    })
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => cb(hostile, undefined, undefined))
    expect(await runDesktopExec('/bin/x', [])).toEqual({ ok: false, stdout: '', stderr: '', timedOut: false })
    execFileMock.mockImplementationOnce(() => {
      throw new Error(SENTINEL)
    })
    expect(await runDesktopExec('/bin/x', [])).toEqual({ ok: false, stdout: '', stderr: '', timedOut: false })
  })
})

describe('spawnDesktopGui', () => {
  it('spawns detached-free with no shell and resolves once the process exists', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    spawnMock.mockReturnValue(child)
    const pending = spawnDesktopGui('C:\\Windows\\notepad.exe', ['C:\\n.txt'])
    child.emit('spawn')
    expect(await pending).toEqual({ ok: true })
    expect(spawnMock).toHaveBeenCalledWith('C:\\Windows\\notepad.exe', ['C:\\n.txt'], {
      detached: false,
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('reports a process that could not be created without its message', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    spawnMock.mockReturnValue(child)
    const pending = spawnDesktopGui('x', [])
    child.emit('error', new Error(SENTINEL))
    expect(await pending).toEqual({ ok: false })
    spawnMock.mockImplementation(() => {
      throw new Error(SENTINEL)
    })
    expect(await spawnDesktopGui('x', [])).toEqual({ ok: false })
  })
})
