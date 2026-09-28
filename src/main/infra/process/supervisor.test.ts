import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SpawnOptions } from 'node:child_process'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('../../logger', () => ({ mainLog: { warn: vi.fn() } }))

const fsMock = vi.hoisted(() => ({ existsSync: vi.fn((_path: string) => true) }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: fsMock.existsSync }
})

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock.spawn }))

import {
  macSupervisorHelperPath,
  markSidecarProcessUsable,
  spawnSidecarProcess,
  stopSidecarProcess,
  sidecarSupervisionEnabled
} from './supervisor'

function fakeProc(pid = 1234): import('node:child_process').ChildProcess {
  const proc = new EventEmitter() as import('node:child_process').ChildProcess
  Object.assign(proc, {
    pid,
    killed: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      ;(proc as import('node:child_process').ChildProcess & { killed: boolean }).killed = true
      return true
    })
  })
  return proc
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  fsMock.existsSync.mockReturnValue(true)
})

describe('macSupervisorHelperPath', () => {
  it('prefers the packaged resources helper when present', () => {
    fsMock.existsSync.mockImplementation((path: string) => path === '/app-resources/mac-helper/metis-mac-helper')
    expect(macSupervisorHelperPath('/app-resources')).toBe('/app-resources/mac-helper/metis-mac-helper')
  })
})

describe('sidecar supervision flag', () => {
  it('is opt-in and mac-only', () => {
    expect(sidecarSupervisionEnabled({}, 'darwin')).toBe(false)
    expect(sidecarSupervisionEnabled({ METIS_SIDECAR_SUPERVISION: '1' }, 'darwin')).toBe(true)
    expect(sidecarSupervisionEnabled({ METIS_SIDECAR_SUPERVISION: '1' }, 'win32')).toBe(false)
  })
})

describe('spawnSidecarProcess', () => {
  it('restores the original direct spawn shape when the flag is off', () => {
    const child = fakeProc()
    spawnMock.spawn.mockReturnValue(child)
    const audit = vi.fn()
    const options: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }

    const result = spawnSidecarProcess('llama-server', '/bin/llama-server', ['--port', '0'], options, audit, {})

    expect(result).toEqual({ child, supervised: false })
    expect(spawnMock.spawn).toHaveBeenCalledWith('/bin/llama-server', ['--port', '0'], options)
    expect(audit).not.toHaveBeenCalled()
  })

  it('wraps mac sidecars with mac-helper supervise when explicitly enabled', () => {
    const child = fakeProc()
    spawnMock.spawn.mockReturnValue(child)
    const audit = vi.fn()
    const options: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] }

    const result = spawnSidecarProcess(
      'fm-serve',
      '/usr/bin/fm',
      ['serve', '--host', '127.0.0.1'],
      options,
      audit,
      { METIS_SIDECAR_SUPERVISION: '1' },
      'darwin'
    )

    expect(result.supervised).toBe(true)
    expect(result.child.pid).toBe(child.pid)
    const [command, args, passedOptions] = spawnMock.spawn.mock.calls[0]
    expect(String(command).endsWith('metis-mac-helper')).toBe(true)
    expect(args).toEqual([
      'supervise',
      '--parent',
      String(process.pid),
      '--',
      '/usr/bin/fm',
      'serve',
      '--host',
      '127.0.0.1'
    ])
    expect(passedOptions).toBe(options)
    expect(audit).not.toHaveBeenCalled()
  })

  it('falls back to direct spawn and audits when the supervised wrapper emits an async spawn error', async () => {
    const wrapper = fakeProc()
    const direct = fakeProc(2468)
    spawnMock.spawn.mockReturnValueOnce(wrapper).mockReturnValueOnce(direct)
    const audit = vi.fn()
    const options: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] }

    const result = spawnSidecarProcess(
      'llama-server',
      '/bin/llama-server',
      ['--port', '0'],
      options,
      audit,
      { METIS_SIDECAR_SUPERVISION: '1' },
      'darwin'
    )

    wrapper.emit('error', new Error('bad helper'))
    await Promise.resolve()

    expect(result.supervised).toBe(true)
    expect(result.child.pid).toBe(2468)
    expect(spawnMock.spawn).toHaveBeenLastCalledWith('/bin/llama-server', ['--port', '0'], options)
    expect(audit).toHaveBeenCalledWith('sidecar.unsupervised', {
      name: 'llama-server',
      reason: 'wrapper-spawn-failed',
      error: 'bad helper'
    })
  })

  it('falls back to direct spawn and audits when the supervised wrapper exits before the sidecar is usable', async () => {
    const wrapper = fakeProc()
    const direct = fakeProc(2468)
    spawnMock.spawn.mockReturnValueOnce(wrapper).mockReturnValueOnce(direct)
    const audit = vi.fn()
    const options: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] }

    const result = spawnSidecarProcess(
      'llama-server',
      '/bin/llama-server',
      ['--port', '0'],
      options,
      audit,
      { METIS_SIDECAR_SUPERVISION: '1' },
      'darwin'
    )

    wrapper.emit('exit', 1, null)
    await Promise.resolve()

    expect(result.supervised).toBe(true)
    expect(result.child.pid).toBe(2468)
    expect(spawnMock.spawn).toHaveBeenLastCalledWith('/bin/llama-server', ['--port', '0'], options)
    expect(audit).toHaveBeenCalledWith('sidecar.unsupervised', {
      name: 'llama-server',
      reason: 'wrapper-exited-before-usable',
      error: 'code=1, signal=null'
    })
  })

  it('propagates supervised wrapper exit after the sidecar is marked usable', async () => {
    const wrapper = fakeProc()
    spawnMock.spawn.mockReturnValue(wrapper)
    const audit = vi.fn()
    const options: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] }

    const result = spawnSidecarProcess(
      'fm-serve',
      '/usr/bin/fm',
      ['serve'],
      options,
      audit,
      { METIS_SIDECAR_SUPERVISION: '1' },
      'darwin'
    )
    const exit = vi.fn()
    result.child.once('exit', exit)

    markSidecarProcessUsable(result.child)
    wrapper.emit('exit', 0, null)
    await Promise.resolve()

    expect(spawnMock.spawn).toHaveBeenCalledTimes(1)
    expect(audit).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0, null)
  })

  it('falls back to direct spawn and audits when the wrapper is missing', () => {
    fsMock.existsSync.mockImplementation((path: string) => !path.endsWith('metis-mac-helper'))
    const child = fakeProc()
    spawnMock.spawn.mockReturnValue(child)
    const audit = vi.fn()

    const result = spawnSidecarProcess(
      'llama-server',
      '/bin/llama-server',
      ['--port', '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] } satisfies SpawnOptions,
      audit,
      { METIS_SIDECAR_SUPERVISION: '1' },
      'darwin'
    )

    expect(result).toEqual({ child, supervised: false })
    expect(spawnMock.spawn).toHaveBeenCalledWith(
      '/bin/llama-server',
      ['--port', '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    expect(audit).toHaveBeenCalledWith('sidecar.unsupervised', {
      name: 'llama-server',
      reason: 'wrapper-missing'
    })
  })

  it('falls back to direct spawn and audits when the wrapper spawn fails', () => {
    const child = fakeProc()
    spawnMock.spawn
      .mockImplementationOnce(() => {
        throw new Error('permission denied')
      })
      .mockReturnValueOnce(child)
    const audit = vi.fn()

    const result = spawnSidecarProcess(
      'fm-serve',
      '/usr/bin/fm',
      ['serve'],
      { stdio: ['ignore', 'pipe', 'pipe'] } satisfies SpawnOptions,
      audit,
      { METIS_SIDECAR_SUPERVISION: '1' },
      'darwin'
    )

    expect(result).toEqual({ child, supervised: false })
    expect(spawnMock.spawn).toHaveBeenLastCalledWith('/usr/bin/fm', ['serve'], { stdio: ['ignore', 'pipe', 'pipe'] })
    expect(audit).toHaveBeenCalledWith('sidecar.unsupervised', {
      name: 'fm-serve',
      reason: 'wrapper-spawn-failed',
      error: 'permission denied'
    })
  })
})

describe('stopSidecarProcess', () => {
  function supervisedFake(pid = 4321): {
    supervised: import('node:child_process').ChildProcess
    wrapper: import('node:child_process').ChildProcess
  } {
    const wrapper = fakeProc(pid)
    spawnMock.spawn.mockReturnValue(wrapper)
    const supervised = spawnSidecarProcess(
      'llama-server',
      '/bin/llama-server',
      [],
      { stdio: ['ignore', 'pipe', 'pipe'] } satisfies SpawnOptions,
      vi.fn(),
      { METIS_SIDECAR_SUPERVISION: '1' },
      'darwin'
    ).child
    return { supervised, wrapper }
  }

  it('kills a supervised wrapper process group first on POSIX, using the negative child pid', () => {
    const { supervised, wrapper } = supervisedFake(4321)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    stopSidecarProcess(supervised)

    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL')
    expect(wrapper.kill).not.toHaveBeenCalled()
  })

  it('falls back to child.kill when the process group is unavailable', () => {
    const { supervised, wrapper } = supervisedFake(4321)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no group')
    })

    stopSidecarProcess(supervised)

    expect(wrapper.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('uses the original direct child kill for unsupervised processes', () => {
    const child = fakeProc(4321)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    stopSidecarProcess(child)

    expect(kill).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
