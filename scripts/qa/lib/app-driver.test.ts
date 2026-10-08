import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  ASK_REVEAL_MIN_HEIGHT_PX,
  BAR_IDLE_HEIGHT_PX,
  WINDOW_RESIZE_HUG_FLOOR_PX
} from '../../../src/shared/overlay-chrome'
import {
  boundedCall,
  childHasExited,
  closeApp,
  attachOwnedCdp,
  attachOwnedMainInspector,
  disposeFreshOnboardingTransports,
  findPage,
  killOwned,
  launchPackagedCdp,
  overlayChromeGeometry,
  ownedCensus,
  packagedLaunchFailed,
  readNumericConstants,
  strictLaunchEnvironment,
  waitFor,
  withTimeout
} from './app-driver.mjs'

const ROOT = '/opt/smoke/Metis.app'

describe('withTimeout', () => {
  it('resolves with the operation result', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1_000, 'late')).resolves.toBe('done')
  })

  it('rejects with the caller message when the operation never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'stuck quitting')).rejects.toThrow('stuck quitting')
  })

  it('propagates the operation error and leaves no pending timer', async () => {
    vi.useFakeTimers()
    try {
      await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'late')).rejects.toThrow('boom')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('boundedCall', () => {
  it('does not invoke work until the bounded call begins', async () => {
    const calls: string[] = []
    const result = await boundedCall(() => {
      calls.push('run')
      return Promise.resolve('done')
    }, 1_000, 'bounded')
    expect(result).toBe('done')
    expect(calls).toEqual(['run'])
  })

  it('rejects an unsettled operation within the caller budget', async () => {
    await expect(boundedCall(() => new Promise(() => {}), 20, 'bounded action timed out')).rejects.toThrow(
      'bounded action timed out'
    )
  })
})

describe('strictLaunchEnvironment', () => {
  const hermetic = {
    home: '/tmp/metis/home',
    userProfile: '/tmp/metis/user',
    appData: '/tmp/metis/appdata',
    localAppData: '/tmp/metis/localappdata',
    temp: '/tmp/metis/temp',
    userData: '/tmp/metis/userdata'
  }

  it('keeps only allowlisted OS values and overrides every profile/temp path', () => {
    const env = strictLaunchEnvironment(
      {
        PATH: '/usr/bin',
        LANG: 'en_CA.UTF-8',
        GITHUB_TOKEN: 'secret',
        GITHUB_OUTPUT: '/runner/output',
        GITHUB_STEP_SUMMARY: '/runner/summary',
        OPENAI_API_KEY: 'secret',
        METIS_QA_HOST_FLOOR_OVERRIDE: '1',
        ASKTOTO_USERDATA: '/owner/profile',
        HOME: '/owner/home'
      },
      hermetic,
      'darwin'
    )
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      LANG: 'en_CA.UTF-8',
      HOME: hermetic.home,
      USERPROFILE: hermetic.userProfile,
      APPDATA: hermetic.appData,
      LOCALAPPDATA: hermetic.localAppData,
      TMPDIR: hermetic.temp,
      TMP: hermetic.temp,
      TEMP: hermetic.temp,
      ASKTOTO_USERDATA: hermetic.userData
    })
    for (const key of [
      'GITHUB_TOKEN',
      'GITHUB_OUTPUT',
      'GITHUB_STEP_SUMMARY',
      'OPENAI_API_KEY',
      'METIS_QA_HOST_FLOOR_OVERRIDE'
    ]) {
      expect(env).not.toHaveProperty(key)
    }
  })

  it('normalizes the Windows PATH spelling without copying both variants', () => {
    const env = strictLaunchEnvironment(
      { Path: 'C:\\Windows\\System32', GITHUB_SHA: 'a'.repeat(40) },
      hermetic,
      'win32'
    )
    expect(env.PATH).toBe('C:\\Windows\\System32')
    expect(env).not.toHaveProperty('Path')
    expect(env).not.toHaveProperty('GITHUB_SHA')
  })
})

describe('launchPackagedCdp', () => {
  const environment = { PATH: '/usr/bin', HOME: '/tmp/metis' }

  function child(pid = 42) {
    return Object.assign(new EventEmitter(), {
      pid,
      exitCode: null as number | null,
      signalCode: null as string | null
    })
  }

  it('captures the exact child and error/exit latches before any endpoint await', () => {
    const spawned = child()
    let spawnArguments: unknown[] | null = null
    const spawnProcess = (...arguments_: unknown[]) => {
      spawnArguments = arguments_
      return spawned
    }
    const launch = launchPackagedCdp({
      executablePath: '/Applications/Metis.app/Contents/MacOS/Metis',
      env: environment,
      cdpPort: 9222,
      inspectPort: 9223,
      platform: 'darwin',
      spawnProcess
    })

    expect(launch.child).toBe(spawned)
    expect(launch.cdpEndpoint).toBe('http://127.0.0.1:9222')
    expect(spawnArguments).toEqual([
      '/Applications/Metis.app/Contents/MacOS/Metis',
      ['--remote-debugging-port=9222', '--inspect=127.0.0.1:9223'],
      expect.objectContaining({ detached: true, windowsHide: true, stdio: 'ignore', env: environment })
    ])
    expect(packagedLaunchFailed(spawned, launch.latches)).toBe(false)
    spawned.emit('error', new Error('synthetic'))
    expect(packagedLaunchFailed(spawned, launch.latches)).toBe(true)
  })

  it('retains an early child exit even when no spawn error arrives', () => {
    const spawned = child()
    const launch = launchPackagedCdp({
      executablePath: '/Applications/Metis.app/Contents/MacOS/Metis',
      env: environment,
      cdpPort: 9222,
      inspectPort: 9223,
      platform: 'darwin',
      spawnProcess: () => spawned
    })
    spawned.exitCode = 1
    spawned.emit('exit', 1, null)
    expect(launch.latches).toEqual({ spawnError: false, exited: true })
    expect(packagedLaunchFailed(spawned, launch.latches)).toBe(true)
  })

  it('uses a non-detached Windows child and rejects colliding ports before spawn', () => {
    const spawned = child()
    const spawnCalls: unknown[][] = []
    const spawnProcess = (...arguments_: unknown[]) => {
      spawnCalls.push(arguments_)
      return spawned
    }
    launchPackagedCdp({
      executablePath: 'C:\\Program Files\\Metis\\Metis.exe',
      env: environment,
      cdpPort: 9222,
      inspectPort: 9223,
      platform: 'win32',
      spawnProcess
    })
    expect(spawnCalls[0][2]).toMatchObject({ detached: false })
    expect(() =>
      launchPackagedCdp({
        executablePath: '/Applications/Metis.app/Contents/MacOS/Metis',
        env: environment,
        cdpPort: 9222,
        inspectPort: 9222,
        platform: 'darwin',
        spawnProcess
      })
    ).toThrow('distinct positive loopback ports')
    expect(spawnCalls).toHaveLength(1)
  })
})

describe('owned direct-launch endpoint handshakes', () => {
  it('accepts only one browser process with the captured child id', async () => {
    const close = vi.fn(async () => undefined)
    const session = { send: vi.fn(async () => ({ processInfo: [{ type: 'browser', id: 42 }] })) }
    const browser = { newBrowserCDPSession: vi.fn(async () => session), close }
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 1_000,
      connect: async () => browser
    })
    expect(result).toMatchObject({ browser, transportUncertain: false })
    expect(session.send).toHaveBeenCalledWith('SystemInfo.getProcessInfo')
    expect(close).not.toHaveBeenCalled()
  })

  it('retries a safely rejected CDP endpoint before its one bounded deadline', async () => {
    const close = vi.fn(async () => undefined)
    const session = { send: vi.fn(async () => ({ processInfo: [{ type: 'browser', id: 42 }] })) }
    const browser = { newBrowserCDPSession: vi.fn(async () => session), close }
    let attempts = 0
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 1_000,
      connect: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('not-ready')
        return browser
      }
    })
    expect(result).toMatchObject({ browser, transportUncertain: false })
    expect(attempts).toBe(2)
    expect(close).not.toHaveBeenCalled()
  })

  it('rejects a CDP ownership response that settles after its monotonic deadline', async () => {
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(11)
    try {
      const close = vi.fn(async () => true)
      const session = { send: vi.fn(async () => ({ processInfo: [{ type: 'browser', id: 42 }] })) }
      const browser = { newBrowserCDPSession: vi.fn(async () => session), close }
      const result = await attachOwnedCdp({
        endpoint: 'http://127.0.0.1:9222',
        childPid: 42,
        timeoutMs: 10,
        connect: async () => browser
      })
      expect(result).toMatchObject({ browser: null, transportUncertain: false })
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      now.mockRestore()
    }
  })

  it('closes a foreign or ambiguous CDP transport instead of accepting its pages', async () => {
    const close = vi.fn(async () => false)
    const browser = {
      newBrowserCDPSession: async () => ({
        processInfo: null,
        send: async () => ({ processInfo: [{ type: 'browser', id: 42 }, { type: 'browser' }] })
      }),
      close
    }
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 1_000,
      connect: async () => browser
    })
    expect(result.browser).toBeNull()
    expect(result.transportUncertain).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps main inspection fixed, synchronous, and bound to the exact child', async () => {
    const messages: unknown[] = []
    class FakeSocket extends EventEmitter {
      readyState = 0
      constructor() {
        super()
        queueMicrotask(() => this.emit('open'))
      }
      addEventListener(name: string, listener: (...args: unknown[]) => void) {
        this.on(name, listener)
      }
      send(raw: string) {
        const request = JSON.parse(raw)
        messages.push(request)
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({
              id: request.id,
              result: {
                result: { value: { profileMatches: true, versionMatches: true, nativeFullDisplay: true } }
              }
            })
          })
        )
      }
      close() {
        this.readyState = 3
        this.emit('close')
      }
    }
    const result = await attachOwnedMainInspector({
      inspectPort: 9223,
      childPid: 42,
      expectedPaths: {
        root: '/tmp/profile',
        home: '/tmp/profile/home',
        userProfile: '/tmp/profile/userprofile',
        appData: '/tmp/profile/appdata',
        localAppData: '/tmp/profile/localappdata',
        temp: '/tmp/profile/tmp',
        userData: '/tmp/profile/userdata'
      },
      expectedVersion: '1.9.7',
      timeoutMs: 1_000,
      fetchImpl: async () => ({ ok: true, json: async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/a' }] }),
      WebSocketClass: FakeSocket
    })
    expect(result.observation).toEqual({ profileMatches: true, versionMatches: true, nativeFullDisplay: true })
    expect(messages).toEqual([
      expect.objectContaining({
        method: 'Runtime.evaluate',
        params: expect.objectContaining({ returnByValue: true, expression: expect.stringContaining('process.pid') })
      })
    ])
    expect((messages[0] as { params: Record<string, unknown> }).params).not.toHaveProperty('awaitPromise')
    if (!result.inspector) throw new Error('expected attached inspector')
    await expect(result.inspector.close()).resolves.toBe(true)
  })

  it('retries only the fixed loader-unavailable response and closes a malformed observation', async () => {
    const responses = [
      { retry: 'loader-unavailable' },
      { profileMatches: true, versionMatches: true, nativeFullDisplay: false }
    ]
    const sockets: Array<{ closed: boolean }> = []
    class RetryingSocket extends EventEmitter {
      readyState = 0
      closed = false
      constructor() {
        super()
        sockets.push(this)
        queueMicrotask(() => this.emit('open'))
      }
      addEventListener(name: string, listener: (...args: unknown[]) => void) {
        this.on(name, listener)
      }
      send(raw: string) {
        const request = JSON.parse(raw)
        const value = responses.shift()
        queueMicrotask(() =>
          this.emit('message', { data: JSON.stringify({ id: request.id, result: { result: { value } } }) })
        )
      }
      close() {
        this.closed = true
        this.readyState = 3
        this.emit('close')
      }
    }
    const result = await attachOwnedMainInspector({
      inspectPort: 9223,
      childPid: 42,
      expectedPaths: {
        root: '/tmp/profile',
        home: '/tmp/profile/home',
        userProfile: '/tmp/profile/userprofile',
        appData: '/tmp/profile/appdata',
        localAppData: '/tmp/profile/localappdata',
        temp: '/tmp/profile/tmp',
        userData: '/tmp/profile/userdata'
      },
      expectedVersion: '1.9.7',
      timeoutMs: 1_000,
      fetchImpl: async () => ({ ok: true, json: async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/a' }] }),
      WebSocketClass: RetryingSocket
    })
    expect(result.observation).toEqual({ profileMatches: true, versionMatches: true, nativeFullDisplay: false })
    if (!result.inspector) throw new Error('expected attached inspector')
    await expect(result.inspector.close()).resolves.toBe(true)
    expect(sockets[0].closed).toBe(true)
  })

  it('fails closed and releases the socket when the fixed observation is not one of its exact shapes', async () => {
    let closed = false
    class InvalidSocket extends EventEmitter {
      readyState = 0
      constructor() {
        super()
        queueMicrotask(() => this.emit('open'))
      }
      addEventListener(name: string, listener: (...args: unknown[]) => void) {
        this.on(name, listener)
      }
      send(raw: string) {
        const request = JSON.parse(raw)
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({ id: request.id, result: { result: { value: { extra: true } } } })
          })
        )
      }
      close() {
        closed = true
        this.readyState = 3
        this.emit('close')
      }
    }
    const result = await attachOwnedMainInspector({
      inspectPort: 9223,
      childPid: 42,
      expectedPaths: {
        root: '/tmp/profile',
        home: '/tmp/profile/home',
        userProfile: '/tmp/profile/userprofile',
        appData: '/tmp/profile/appdata',
        localAppData: '/tmp/profile/localappdata',
        temp: '/tmp/profile/tmp',
        userData: '/tmp/profile/userdata'
      },
      expectedVersion: '1.9.7',
      timeoutMs: 1_000,
      fetchImpl: async () => ({ ok: true, json: async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/a' }] }),
      WebSocketClass: InvalidSocket
    })
    expect(result).toMatchObject({ inspector: null, observation: null, transportUncertain: false })
    expect(closed).toBe(true)
  })

  it('rejects a fixed inspection result that settles after its monotonic deadline', async () => {
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(11)
    let closed = false
    class LateSocket extends EventEmitter {
      readyState = 0
      constructor() {
        super()
        queueMicrotask(() => this.emit('open'))
      }
      addEventListener(name: string, listener: (...args: unknown[]) => void) {
        this.on(name, listener)
      }
      send(raw: string) {
        const request = JSON.parse(raw)
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({
              id: request.id,
              result: {
                result: { value: { profileMatches: true, versionMatches: true, nativeFullDisplay: true } }
              }
            })
          })
        )
      }
      close() {
        closed = true
        this.readyState = 3
        this.emit('close')
      }
    }
    try {
      const result = await attachOwnedMainInspector({
        inspectPort: 9223,
        childPid: 42,
        expectedPaths: {
          root: '/tmp/profile',
          home: '/tmp/profile/home',
          userProfile: '/tmp/profile/userprofile',
          appData: '/tmp/profile/appdata',
          localAppData: '/tmp/profile/localappdata',
          temp: '/tmp/profile/tmp',
          userData: '/tmp/profile/userdata'
        },
        expectedVersion: '1.9.7',
        timeoutMs: 10,
        fetchImpl: async () => ({ ok: true, json: async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/a' }] }),
        WebSocketClass: LateSocket
      })
      expect(result).toMatchObject({ inspector: null, observation: null, transportUncertain: false })
      expect(closed).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  it('keeps an opening inspector socket unacknowledged until its tracked close receipt resolves', async () => {
    let closed = false
    class ErrorSocket extends EventEmitter {
      readyState = 0
      constructor() {
        super()
        queueMicrotask(() => this.emit('error', new Error('synthetic')))
      }
      addEventListener(name: string, listener: (...args: unknown[]) => void) {
        this.on(name, listener)
      }
      send(_raw: string) {}
      close() {
        closed = true
        this.readyState = 3
        this.emit('close')
      }
    }
    const result = await attachOwnedMainInspector({
      inspectPort: 9223,
      childPid: 42,
      expectedPaths: {
        root: '/tmp/profile',
        home: '/tmp/profile/home',
        userProfile: '/tmp/profile/userprofile',
        appData: '/tmp/profile/appdata',
        localAppData: '/tmp/profile/localappdata',
        temp: '/tmp/profile/tmp',
        userData: '/tmp/profile/userdata'
      },
      expectedVersion: '1.9.7',
      timeoutMs: 1_000,
      fetchImpl: async () => ({ ok: true, json: async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/a' }] }),
      WebSocketClass: ErrorSocket
    })
    expect(result).toMatchObject({ inspector: null, observation: null, transportUncertain: true })
    if (!result.lateRelease) throw new Error('expected tracked late release')
    await expect(result.lateRelease(1_000)).resolves.toBe(true)
    expect(closed).toBe(true)
  })
})

describe('disposeFreshOnboardingTransports', () => {
  it('preserves an explicit false close receipt from an owned transport', async () => {
    await expect(
      disposeFreshOnboardingTransports({ inspector: { close: async () => false } }, 1_000)
    ).resolves.toBe(false)
  })
})

describe('waitFor', () => {
  it('returns the first truthy value, retrying falsy results', async () => {
    let calls = 0
    const value = await waitFor(async () => (++calls < 3 ? null : 'ready'), 'never', 1_000, 5)
    expect(value).toBe('ready')
    expect(calls).toBe(3)
  })

  it('retries a throwing check and still succeeds', async () => {
    let calls = 0
    const value = await waitFor(
      () => {
        if (++calls < 2) throw new Error('mid-navigation')
        return 42
      },
      'never',
      1_000,
      5
    )
    expect(value).toBe(42)
  })

  it('times out with the message and the last error seen', async () => {
    await expect(
      waitFor(
        () => {
          throw new Error('page closed')
        },
        'window did not appear',
        30,
        5
      )
    ).rejects.toThrow('window did not appear (page closed)')
  })

  it('times out with the bare message when the check only returns falsy', async () => {
    await expect(waitFor(() => false, 'no bounds', 30, 5)).rejects.toThrow(/^no bounds$/)
  })

  it('checks once even with a zero timeout', async () => {
    await expect(waitFor(() => 'now', 'never', 0)).resolves.toBe('now')
  })
})

describe('findPage', () => {
  const page = (url: string, closed = false) => ({ url: () => url, isClosed: () => closed })
  const browser = (...pages: unknown[]) => ({ contexts: () => [{ pages: () => pages }] })

  it('skips closed pages and pages whose probe throws', async () => {
    const closed = page('a', true)
    const flaky = page('b')
    const good = page('c')
    const found = await findPage(
      browser(closed, flaky, good),
      (p: ReturnType<typeof page>) => {
        if (p === flaky) throw new Error('navigating')
        return p.url() === 'c'
      },
      'no page',
      100,
      5
    )
    expect(found).toBe(good)
  })

  it('reports the caller message when nothing matches in time', async () => {
    await expect(findPage(browser(page('x')), () => false, 'overlay page not found', 30, 5)).rejects.toThrow(
      'overlay page not found'
    )
  })
})

describe('ownedCensus', () => {
  const table = [
    { pid: 10, ppid: 1, startedMs: 100, exe: `${ROOT}/Contents/MacOS/Metis`, role: 'Metis' },
    { pid: 11, ppid: 10, startedMs: 101, exe: '/usr/bin/helper', role: 'helper' },
    { pid: 12, ppid: 1, startedMs: 102, exe: '/usr/bin/Metis', role: 'Metis' },
    { pid: 13, ppid: 1, startedMs: 103, exe: `${ROOT}/Contents/Resources/llama/llama-server`, role: 'llama-server' }
  ]

  it('owns main, its descendants and root residents — never a same-named outsider', () => {
    const { owned, roles } = ownedCensus({
      platform: 'darwin',
      mainPid: 10,
      installRoot: ROOT,
      listTable: () => table
    })
    expect(owned.map((entry) => entry.pid).sort()).toEqual([10, 11, 13])
    expect(roles).toEqual({ Metis: 1, helper: 1, 'llama-server': 1 })
  })

  it('with no main pid owns only what is resident under the root', () => {
    const { owned } = ownedCensus({ platform: 'darwin', mainPid: null, installRoot: ROOT, listTable: () => table })
    expect(owned.map((entry) => entry.pid).sort()).toEqual([10, 13])
  })

  it('asks the process table for the requested platform', () => {
    const listTable = vi.fn(() => [])
    ownedCensus({ platform: 'win32', mainPid: 1, installRoot: 'C:\\Metis', listTable })
    expect(listTable).toHaveBeenCalledWith('win32')
  })
})

describe('killOwned', () => {
  it('kills each owned pid, tolerating one that is already gone, and never this process', () => {
    const killed: number[] = []
    const kill = (pid: number) => {
      if (pid === 2) throw new Error('ESRCH')
      killed.push(pid)
    }
    const entry = (pid: number) => ({ pid, ppid: 1, startedMs: 1, exe: null, role: 'x' })
    killOwned([entry(1), entry(2), entry(process.pid), entry(3)], kill)
    expect(killed).toEqual([1, 3])
  })
})

describe('closeApp', () => {
  function fakeChild({ obeys }: { obeys: 'SIGTERM' | 'SIGKILL' | null }) {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      signals: [] as string[],
      kill(signal: string) {
        child.signals.push(signal)
        if (signal === obeys) {
          child.signalCode = signal
          child.emit('exit')
        }
        return true
      }
    })
    return child
  }
  const fakeApp = (child: ReturnType<typeof fakeChild>) => ({
    process: () => child,
    evaluate: () => Promise.resolve(),
    close: () => Promise.resolve()
  })

  it('does nothing without an app', async () => {
    await expect(closeApp(null)).resolves.toBeUndefined()
  })

  it('does not signal a child that already exited', async () => {
    const child = fakeChild({ obeys: null })
    child.exitCode = 0
    await closeApp(fakeApp(child), { requestTimeoutMs: 20, exitTimeoutMs: 20 })
    expect(child.signals).toEqual([])
  })

  it('escalates SIGTERM to SIGKILL only for a child that ignores SIGTERM', async () => {
    const child = fakeChild({ obeys: 'SIGKILL' })
    await closeApp(fakeApp(child), { requestTimeoutMs: 20, exitTimeoutMs: 20 })
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(childHasExited(child)).toBe(true)
  })

  it('stops at SIGTERM when the child complies', async () => {
    const child = fakeChild({ obeys: 'SIGTERM' })
    await closeApp(fakeApp(child), { requestTimeoutMs: 20, exitTimeoutMs: 20 })
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('bounds a quit request that never answers', async () => {
    const child = fakeChild({ obeys: 'SIGTERM' })
    const app = { ...fakeApp(child), evaluate: () => new Promise(() => {}), close: () => new Promise(() => {}) }
    await closeApp(app, { requestTimeoutMs: 20, exitTimeoutMs: 20 })
    expect(child.signals).toEqual(['SIGTERM'])
  })
})

describe('overlay chrome geometry', () => {
  it('reads the same numbers the app compiles from src/shared/overlay-chrome.ts', () => {
    expect(overlayChromeGeometry()).toEqual({
      barIdleHeightPx: BAR_IDLE_HEIGHT_PX,
      askRevealMinHeightPx: ASK_REVEAL_MIN_HEIGHT_PX,
      hugFloorPx: WINDOW_RESIZE_HUG_FLOOR_PX
    })
  })

  it('refuses a constant that is missing or not a literal rather than guessing', () => {
    expect(() => readNumericConstants('export const A = 1 + 2', ['A'])).toThrow(/not a numeric export/)
    expect(() => readNumericConstants('', ['B'])).toThrow(/not a numeric export/)
    expect(readNumericConstants('export const C = 84', ['C'])).toEqual({ C: 84 })
  })
})
