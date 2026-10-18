import { EventEmitter } from 'node:events'
import { posix } from 'node:path'
import { runInNewContext } from 'node:vm'
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
  freshProfileObservation,
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

const FRESH_PROFILE_PATHS = {
  root: '/tmp/profile',
  home: '/tmp/profile/home',
  userProfile: '/tmp/profile/userprofile',
  appData: '/tmp/profile/appdata',
  localAppData: '/tmp/profile/localappdata',
  temp: '/tmp/profile/tmp',
  userData: '/tmp/profile/userdata'
} as const

const FRESH_PROFILE_CASES = [
  { label: 'all match', matches: [true, true, true, true], profileMask: 0 },
  { label: 'userData differs', matches: [false, true, true, true], profileMask: 1 },
  { label: 'home differs', matches: [true, false, true, true], profileMask: 2 },
  { label: 'userData and home differ', matches: [false, false, true, true], profileMask: 3 },
  { label: 'appData differs', matches: [true, true, false, true], profileMask: 4 },
  { label: 'userData and appData differ', matches: [false, true, false, true], profileMask: 5 },
  { label: 'home and appData differ', matches: [true, false, false, true], profileMask: 6 },
  { label: 'userData home and appData differ', matches: [false, false, false, true], profileMask: 7 },
  { label: 'temp differs', matches: [true, true, true, false], profileMask: 8 },
  { label: 'userData and temp differ', matches: [false, true, true, false], profileMask: 9 },
  { label: 'home and temp differ', matches: [true, false, true, false], profileMask: 10 },
  { label: 'userData home and temp differ', matches: [false, false, true, false], profileMask: 11 },
  { label: 'appData and temp differ', matches: [true, true, false, false], profileMask: 12 },
  { label: 'userData appData and temp differ', matches: [false, true, false, false], profileMask: 13 },
  { label: 'home appData and temp differ', matches: [true, false, false, false], profileMask: 14 },
  { label: 'all differ', matches: [false, false, false, false], profileMask: 15 }
] as const

const FRESH_PROFILE_KEYS = ['userData', 'home', 'appData', 'temp'] as const

type FreshProfileKey = (typeof FRESH_PROFILE_KEYS)[number]

function observedFreshProfile([userData, home, appData, temp]: readonly boolean[]) {
  const matches = { userData, home, appData, temp }
  return Object.fromEntries(
    FRESH_PROFILE_KEYS.map((key) => [key, matches[key] ? FRESH_PROFILE_PATHS[key] : `/tmp/outside/${key}`])
  ) as Record<FreshProfileKey, string>
}

function freshProfileApp(values: Record<FreshProfileKey, unknown>, reads: string[], throwOn?: FreshProfileKey) {
  return {
    getPath(key: string) {
      reads.push(key)
      if (key === throwOn) throw new Error('synthetic getter failure')
      return values[key as FreshProfileKey]
    }
  }
}

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
    const result = await boundedCall(
      () => {
        calls.push('run')
        return Promise.resolve('done')
      },
      1_000,
      'bounded'
    )
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

  it.each([undefined, '/inherited/native-home'])('isolates the Darwin native home override %s', (inherited) => {
    const base = { HOME: '/inherited/home', CFFIXED_USER_HOME: inherited }
    const snapshot = { ...base }
    const env = strictLaunchEnvironment(base, hermetic, 'darwin')
    expect(env.CFFIXED_USER_HOME).toBe(hermetic.home)
    expect(env.HOME).toBe(hermetic.home)
    expect(base).toEqual(snapshot)
  })

  it('does not pass a native Mac home override to Windows', () => {
    const base = { CFFIXED_USER_HOME: '/inherited/native-home' }
    const env = strictLaunchEnvironment(base, hermetic, 'win32')
    expect(env).not.toHaveProperty('CFFIXED_USER_HOME')
    expect(base).toEqual({ CFFIXED_USER_HOME: '/inherited/native-home' })
  })

  it.each([undefined, '/inherited/native-temp'])('isolates the Darwin native temp override %s', (inherited) => {
    const base = inherited === undefined ? {} : { MAC_CHROMIUM_TMPDIR: inherited }
    const snapshot = { ...base }
    const paths = { ...hermetic }
    const env = strictLaunchEnvironment(base, paths, 'darwin')
    expect(env.MAC_CHROMIUM_TMPDIR).toBe(hermetic.temp)
    expect(env.CFFIXED_USER_HOME).toBe(hermetic.home)
    expect(base).toEqual(snapshot)
    expect(paths).toEqual(hermetic)
  })

  it('does not pass a native Mac temp override to Windows', () => {
    const base = { MAC_CHROMIUM_TMPDIR: '/inherited/native-temp' }
    const env = strictLaunchEnvironment(base, hermetic, 'win32')
    expect(env).not.toHaveProperty('MAC_CHROMIUM_TMPDIR')
    expect(base).toEqual({ MAC_CHROMIUM_TMPDIR: '/inherited/native-temp' })
  })

  it.each(Object.keys(hermetic))('still rejects the missing owned path %s on both platforms', (key) => {
    for (const platform of ['darwin', 'win32'] as const) {
      for (const value of [undefined, '']) {
        expect(() => strictLaunchEnvironment({}, { ...hermetic, [key]: value }, platform)).toThrow(
          `strict environment needs ${key}.`
        )
      }
    }
  })

  it('still rejects unsupported platforms', () => {
    expect(() => strictLaunchEnvironment({}, hermetic, 'linux')).toThrow(
      'strict environment supports darwin and win32 only.'
    )
  })
})

describe('freshProfileObservation', () => {
  it.each(FRESH_PROFILE_CASES)('keeps the exact profile mask when $label', ({ matches, profileMask }) => {
    const reads: string[] = []
    const observation = freshProfileObservation(
      freshProfileApp(observedFreshProfile(matches), reads),
      posix,
      FRESH_PROFILE_PATHS
    )

    expect(observation).toEqual({ profileMatches: profileMask === 0, profileMask })
    expect(reads).toEqual(FRESH_PROFILE_KEYS)
  })

  it('uses raw userData equality without normalizing a lexically different value', () => {
    const reads: string[] = []
    const observation = freshProfileObservation(
      freshProfileApp(
        {
          userData: `${FRESH_PROFILE_PATHS.userData}/`,
          home: FRESH_PROFILE_PATHS.home,
          appData: FRESH_PROFILE_PATHS.appData,
          temp: FRESH_PROFILE_PATHS.temp
        },
        reads
      ),
      posix,
      FRESH_PROFILE_PATHS
    )

    expect(observation).toEqual({ profileMatches: false, profileMask: 1 })
    expect(reads).toEqual(FRESH_PROFILE_KEYS)
  })

  it('keeps lexical aliases outside the generated root without normalizing them', () => {
    const paths = {
      ...FRESH_PROFILE_PATHS,
      root: '/var/fixture',
      home: '/var/fixture/home',
      appData: '/var/fixture/appdata',
      temp: '/var/fixture/tmp',
      userData: '/var/fixture/userdata'
    }
    const reads: string[] = []
    const observation = freshProfileObservation(
      freshProfileApp(
        {
          userData: paths.userData,
          home: '/private/var/fixture/home',
          appData: paths.appData,
          temp: paths.temp
        },
        reads
      ),
      posix,
      paths
    )

    expect(observation).toEqual({ profileMatches: false, profileMask: 2 })
    expect(reads).toEqual(FRESH_PROFILE_KEYS)
  })

  it.each([
    { label: 'empty appData', key: 'appData', value: '' },
    { label: 'non-string temp', key: 'temp', value: null }
  ])('fails closed for $label', ({ key, value }) => {
    const reads: string[] = []
    const values: Record<FreshProfileKey, unknown> = {
      userData: FRESH_PROFILE_PATHS.userData,
      home: FRESH_PROFILE_PATHS.home,
      appData: FRESH_PROFILE_PATHS.appData,
      temp: FRESH_PROFILE_PATHS.temp
    }
    values[key as FreshProfileKey] = value

    expect(freshProfileObservation(freshProfileApp(values, reads), posix, FRESH_PROFILE_PATHS)).toBeNull()
    expect(reads).toEqual(FRESH_PROFILE_KEYS)
  })

  it('fails closed when one captured path getter throws', () => {
    const reads: string[] = []

    expect(
      freshProfileObservation(
        freshProfileApp(
          {
            userData: FRESH_PROFILE_PATHS.userData,
            home: FRESH_PROFILE_PATHS.home,
            appData: FRESH_PROFILE_PATHS.appData,
            temp: FRESH_PROFILE_PATHS.temp
          },
          reads,
          'home'
        ),
        posix,
        FRESH_PROFILE_PATHS
      )
    ).toBeNull()
    expect(reads).toEqual(['userData', 'home'])
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

  it('passes the strict Darwin profile environment to the direct child', () => {
    const spawned = child()
    let childEnvironment: Record<string, string> | null = null
    const environment = strictLaunchEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/owner/home',
        CFFIXED_USER_HOME: '/owner/native-home',
        MAC_CHROMIUM_TMPDIR: '/owner/native-temp',
        ASKTOTO_USERDATA: '/owner/userdata'
      },
      FRESH_PROFILE_PATHS,
      'darwin'
    )

    launchPackagedCdp({
      executablePath: '/Applications/Metis.app/Contents/MacOS/Metis',
      env: environment,
      cdpPort: 9222,
      inspectPort: 9223,
      platform: 'darwin',
      spawnProcess: (...arguments_: unknown[]) => {
        childEnvironment = (arguments_[2] as { env: Record<string, string> }).env
        return spawned
      }
    })

    expect(childEnvironment).toEqual(
      expect.objectContaining({
        CFFIXED_USER_HOME: FRESH_PROFILE_PATHS.home,
        MAC_CHROMIUM_TMPDIR: FRESH_PROFILE_PATHS.temp,
        HOME: FRESH_PROFILE_PATHS.home,
        USERPROFILE: FRESH_PROFILE_PATHS.userProfile,
        APPDATA: FRESH_PROFILE_PATHS.appData,
        LOCALAPPDATA: FRESH_PROFILE_PATHS.localAppData,
        TMPDIR: FRESH_PROFILE_PATHS.temp,
        TMP: FRESH_PROFILE_PATHS.temp,
        TEMP: FRESH_PROFILE_PATHS.temp,
        ASKTOTO_USERDATA: FRESH_PROFILE_PATHS.userData
      })
    )
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
    expect(result).toMatchObject({ browser, transportUncertain: false, failure: null })
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
    expect(result).toMatchObject({ browser, transportUncertain: false, failure: null })
    expect(attempts).toBe(2)
    expect(close).not.toHaveBeenCalled()
  })

  it('keeps invalid CDP attach input on the generic fallback without connecting', async () => {
    const connect = vi.fn(async () => {
      throw new Error('must not connect')
    })
    const result = await attachOwnedCdp({
      endpoint: '',
      childPid: 42,
      timeoutMs: 1_000,
      connect
    })
    expect(result).toMatchObject({
      browser: null,
      transportUncertain: false,
      failure: 'cdp-attach-failed'
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('classifies a rejected CDP endpoint only after its shared deadline', async () => {
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(11)
    try {
      const result = await attachOwnedCdp({
        endpoint: 'http://127.0.0.1:9222',
        childPid: 42,
        timeoutMs: 10,
        connect: async () => {
          throw new Error('synthetic endpoint rejection')
        }
      })
      expect(result).toMatchObject({
        browser: null,
        transportUncertain: false,
        failure: 'cdp-endpoint-deadline'
      })
    } finally {
      now.mockRestore()
    }
  })

  it('does not begin attachment after a shared monotonic deadline has already expired', async () => {
    const connect = vi.fn(async () => {
      throw new Error('must not connect')
    })
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 15_000,
      deadlineMs: performance.now() - 1,
      connect
    })
    expect(result).toMatchObject({ browser: null, failure: 'cdp-endpoint-deadline' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('classifies a late CDP transport while retaining its owned release', async () => {
    const close = vi.fn(async () => true)
    const session = { send: vi.fn(async () => ({ processInfo: [{ type: 'browser', id: 42 }] })) }
    const browser = { newBrowserCDPSession: vi.fn(async () => session), close }
    const deferred: { resolve?: (value: typeof browser) => void } = {}
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 20,
      connect: () =>
        new Promise<typeof browser>((resolve) => {
          deferred.resolve = resolve
        })
    })
    expect(result).toMatchObject({
      browser: null,
      transportUncertain: true,
      failure: 'cdp-transport-timeout'
    })
    const release = result.lateRelease
    const resolveConnect = deferred.resolve
    if (!release || !resolveConnect) throw new Error('expected owned late release')
    resolveConnect(browser)
    await expect(release(1_000)).resolves.toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
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
      expect(result).toMatchObject({
        browser: null,
        transportUncertain: false,
        failure: 'cdp-session-or-process-info-invalid'
      })
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      now.mockRestore()
    }
  })

  it('closes the transport when CDP session creation rejects', async () => {
    const close = vi.fn(async () => true)
    const browser = {
      newBrowserCDPSession: async () => {
        throw new Error('synthetic session rejection')
      },
      close
    }
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 1_000,
      connect: async () => browser
    })
    expect(result).toMatchObject({
      browser: null,
      transportUncertain: false,
      failure: 'cdp-session-or-process-info-invalid'
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the transport when CDP process-info request rejects', async () => {
    const close = vi.fn(async () => true)
    const browser = {
      newBrowserCDPSession: async () => ({
        send: async () => {
          throw new Error('synthetic process-info rejection')
        }
      }),
      close
    }
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 1_000,
      connect: async () => browser
    })
    expect(result).toMatchObject({
      browser: null,
      transportUncertain: false,
      failure: 'cdp-session-or-process-info-invalid'
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['absent process info', {}],
    ['non-array process info', { processInfo: {} }],
    ['empty process info', { processInfo: [] }],
    [
      'multiple browser processes',
      {
        processInfo: [
          { type: 'browser', id: 42 },
          { type: 'browser', id: 42 }
        ]
      }
    ],
    ['non-safe-integer browser id', { processInfo: [{ type: 'browser', id: 42.5 }] }]
  ])('closes a CDP transport with %s without accepting its pages', async (_case, answer) => {
    const close = vi.fn(async () => true)
    const browser = {
      newBrowserCDPSession: async () => ({ send: async () => answer }),
      close
    }
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 1_000,
      connect: async () => browser
    })
    expect(result).toMatchObject({
      browser: null,
      transportUncertain: false,
      failure: 'cdp-session-or-process-info-invalid'
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('retains transport uncertainty when an invalid CDP transport cannot close', async () => {
    const close = vi.fn(async () => false)
    const browser = {
      newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [] }) }),
      close
    }
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 1_000,
      connect: async () => browser
    })
    expect(result).toMatchObject({
      browser: null,
      transportUncertain: true,
      failure: 'cdp-session-or-process-info-invalid'
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes a structurally valid CDP browser whose pid differs from the owned child', async () => {
    const close = vi.fn(async () => true)
    const browser = {
      newBrowserCDPSession: async () => ({
        send: async () => ({ processInfo: [{ type: 'browser', id: 43 }] })
      }),
      close
    }
    const result = await attachOwnedCdp({
      endpoint: 'http://127.0.0.1:9222',
      childPid: 42,
      timeoutMs: 1_000,
      connect: async () => browser
    })
    expect(result).toMatchObject({
      browser: null,
      transportUncertain: false,
      failure: 'cdp-browser-pid-mismatch'
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps main inspection fixed, synchronous, and bound to the exact child', async () => {
    const messages: unknown[] = []
    const stages: string[] = []
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
                result: {
                  value: { profileMatches: true, profileMask: 0, versionMatches: true, nativeFullDisplay: true }
                }
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
      WebSocketClass: FakeSocket,
      onStage: (stage: string) => stages.push(stage)
    })
    expect(stages).toEqual(['DISCOVERY_READY', 'SOCKET_OPEN', 'OBSERVATION_OWNED'])
    expect(result.observation).toEqual({
      profileMatches: true,
      profileMask: 0,
      versionMatches: true,
      nativeFullDisplay: true
    })
    expect(messages).toEqual([
      expect.objectContaining({
        method: 'Runtime.evaluate',
        params: expect.objectContaining({ returnByValue: true, expression: expect.stringContaining('process.pid') })
      })
    ])
    expect((messages[0] as { params: Record<string, unknown> }).params).not.toHaveProperty('awaitPromise')
    if (!result.inspector) throw new Error('expected attached inspector')
    await expect(result.inspector.close()).resolves.toBe(true)

    const expression = (messages[0] as { params: Record<string, unknown> }).params.expression
    if (typeof expression !== 'string') throw new Error('expected fixed observation expression')
    const readinessCases: Array<{ label: string; readiness?: unknown; expected: object }> = [
      { label: 'false', readiness: () => false, expected: { retry: 'app-not-ready' } },
      { label: 'truthy string', readiness: () => 'true', expected: { retry: 'app-not-ready' } },
      { label: 'truthy number', readiness: () => 1, expected: { retry: 'app-not-ready' } },
      { label: 'null', readiness: () => null, expected: { retry: 'app-not-ready' } },
      { label: 'undefined', readiness: () => undefined, expected: { retry: 'app-not-ready' } },
      { label: 'missing method', expected: { failed: true } },
      { label: 'non-callable method', readiness: true, expected: { failed: true } },
      {
        label: 'throwing method',
        readiness: () => {
          throw new Error('synthetic readiness failure')
        },
        expected: { failed: true }
      },
      {
        label: 'ready',
        readiness: () => true,
        expected: { profileMatches: true, profileMask: 0, versionMatches: true, nativeFullDisplay: true }
      }
    ]
    for (const { label, readiness, expected } of readinessCases) {
      const reads: string[] = []
      const app: Record<string, unknown> = {
        ...freshProfileApp(observedFreshProfile([true, true, true, true]), reads),
        getVersion() {
          reads.push('version')
          return '1.9.7'
        }
      }
      if (label !== 'missing method') app.isReady = readiness
      const bounds = { x: 0, y: 0, width: 1_280, height: 720 }
      const electron = {
        app,
        get BrowserWindow() {
          reads.push('BrowserWindow')
          return {
            getAllWindows: () => [{ id: 1, isDestroyed: () => false, isVisible: () => true, getBounds: () => bounds }]
          }
        },
        get screen() {
          reads.push('screen')
          return { getDisplayMatching: () => ({ bounds }) }
        }
      }
      const load = vi.fn((name: string) => {
        if (name === 'node:path') return posix
        if (name === 'electron') return electron
        throw new Error('unexpected synthetic module')
      })
      const observed = runInNewContext(expression, { process: { pid: 42, mainModule: { require: load } } })
      expect(observed, label).toEqual(expected)
      expect(
        load.mock.calls.map(([name]) => name),
        label
      ).toEqual(['node:path', 'electron'])
      expect(reads, label).toEqual(
        label === 'ready' ? ['BrowserWindow', 'screen', 'userData', 'home', 'appData', 'temp', 'version'] : []
      )
    }
    const unownedLoad = vi.fn(() => {
      throw new Error('unowned loader must not run')
    })
    expect(runInNewContext(expression, { process: { pid: 43, mainModule: { require: unownedLoad } } })).toEqual({
      owner: false
    })
    expect(unownedLoad).not.toHaveBeenCalled()
    expect(runInNewContext(expression, { process: { pid: 42, mainModule: {} } })).toEqual({
      retry: 'loader-unavailable'
    })
  })

  it.each(['loader-unavailable', 'app-not-ready'])('retries exact %s on one socket', async (retry) => {
    const responses = [
      { retry },
      { profileMatches: true, profileMask: 0, versionMatches: true, nativeFullDisplay: false }
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
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ id: request.id, result: { result: { value } } })
          })
        })
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
    expect(result.observation).toEqual({
      profileMatches: true,
      profileMask: 0,
      versionMatches: true,
      nativeFullDisplay: false
    })
    if (!result.inspector) throw new Error('expected attached inspector')
    await expect(result.inspector.close()).resolves.toBe(true)
    expect(sockets).toHaveLength(1)
    expect(responses).toHaveLength(0)
    expect(sockets[0].closed).toBe(true)
  })

  it.each([
    ['has an unknown shape', { extra: true }],
    ['has an unknown retry', { retry: 'unknown' }],
    ['has an app-not-ready retry with extra fields', { retry: 'app-not-ready', extra: true }],
    ['has a loader retry with extra fields', { retry: 'loader-unavailable', extra: true }],
    ['omits the required profile mask', { profileMatches: true, versionMatches: true, nativeFullDisplay: false }],
    [
      'contradicts the all-pass mask',
      { profileMatches: true, profileMask: 1, versionMatches: true, nativeFullDisplay: false }
    ],
    [
      'contradicts the zero mask',
      { profileMatches: false, profileMask: 0, versionMatches: true, nativeFullDisplay: false }
    ],
    [
      'uses an unknown profile mask',
      { profileMatches: false, profileMask: 16, versionMatches: true, nativeFullDisplay: false }
    ]
  ])('fails closed and releases the socket when the fixed observation %s', async (_label, value) => {
    let closed = false
    const stages: string[] = []
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
            data: JSON.stringify({ id: request.id, result: { result: { value } } })
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
      WebSocketClass: InvalidSocket,
      onStage: (stage: string) => stages.push(stage)
    })
    expect(result).toMatchObject({ inspector: null, observation: null, transportUncertain: false })
    expect(stages).toEqual(['DISCOVERY_READY', 'SOCKET_OPEN', 'OBSERVATION_FAILED'])
    expect(closed).toBe(true)
  })

  it.each(['never-ready', 'ready-after-deadline'])('bounds %s to the existing deadline', async (scenario) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let requests = 0
    let closed = false
    class ReadinessSocket extends EventEmitter {
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
        requests += 1
        const lateReady = scenario === 'ready-after-deadline' && requests === 2
        if (lateReady) clock = 1_001
        const value = lateReady
          ? { profileMatches: true, profileMask: 0, versionMatches: true, nativeFullDisplay: true }
          : { retry: 'app-not-ready' }
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({ id: request.id, result: { result: { value } } })
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
      const pending = attachOwnedMainInspector({
        inspectPort: 9223,
        childPid: 42,
        expectedPaths: FRESH_PROFILE_PATHS,
        expectedVersion: '1.9.7',
        timeoutMs: 1_000,
        fetchImpl: async () => ({ ok: true, json: async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/a' }] }),
        WebSocketClass: ReadinessSocket
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(requests).toBe(1)
      if (scenario === 'never-ready') clock = 1_000
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending
      expect(result).toMatchObject({ inspector: null, observation: null, transportUncertain: false })
      expect(requests).toBe(scenario === 'never-ready' ? 1 : 2)
      expect(closed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      now.mockRestore()
      vi.useRealTimers()
    }
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
                result: {
                  value: { profileMatches: true, profileMask: 0, versionMatches: true, nativeFullDisplay: true }
                }
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
    await expect(disposeFreshOnboardingTransports({ inspector: { close: async () => false } }, 1_000)).resolves.toBe(
      false
    )
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
