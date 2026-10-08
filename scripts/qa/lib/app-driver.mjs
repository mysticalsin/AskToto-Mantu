/**
 * Shared app driver for the packaged QA harnesses (M2-0410): launch or attach to the Electron app,
 * wait, screenshot, and census/kill only the processes the harness owns. e2e-smoke, e2e-workflows,
 * packaged-smoke and the golden flows import this instead of keeping local copies.
 *
 * Invariants:
 *  - Every wait is bounded; a timeout throws with the caller's message (and the last error seen).
 *  - Process ownership is structural (see ../owned-processes.mjs): nothing is selected or killed by
 *    name, and a kill never touches this process.
 *  - Playwright is imported lazily so unit tests of the timeout and ownership logic never load it.
 */
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listProcesses, ownedProcesses, roleCounts } from '../owned-processes.mjs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const LOOPBACK_HOST = '127.0.0.1'
const TRANSPORT_RELEASE_TIMEOUT_MS = 5_000
const FRESH_PROFILE_KEYS = ['root', 'home', 'userProfile', 'appData', 'localAppData', 'temp', 'userData']

/** @typedef {{ pid?: number, exitCode?: number | null, signalCode?: string | null,
 *   once: (event: string, listener: (...args: unknown[]) => void) => unknown }} DirectLaunchChild */
/** @typedef {(file: string, args: string[], options: { env: Record<string, string>, stdio: 'ignore',
 *   windowsHide: boolean, detached: boolean }) => DirectLaunchChild} DirectSpawn */
/** @typedef {{ send: (method: 'SystemInfo.getProcessInfo') => Promise<unknown> }} CdpBrowserSession */
/** @typedef {{ newBrowserCDPSession: () => Promise<CdpBrowserSession>, close: () => Promise<unknown> | unknown }}
 *   CdpBrowserTransport */
/** @typedef {(endpoint: string, timeoutMs?: number) => Promise<CdpBrowserTransport>} CdpConnector */
/** @typedef {'cdp-attach-failed' | 'cdp-endpoint-deadline' | 'cdp-transport-timeout' |
 *   'cdp-session-or-process-info-invalid' | 'cdp-browser-pid-mismatch'} ClosedCdpFailure */
/** @typedef {{ browser: CdpBrowserTransport | null, transportUncertain: boolean,
 *   lateRelease: ((releaseTimeoutMs: number) => Promise<boolean>) | null, failure: ClosedCdpFailure | null }}
 *   OwnedCdpAttachment */
/** @typedef {{ ok?: boolean, json: () => Promise<unknown> }} InspectorDiscoveryResponse */
/** @typedef {(url: string, init: { signal: AbortSignal }) => Promise<InspectorDiscoveryResponse>} InspectorFetch */
/** @typedef {{ close: () => Promise<unknown> | unknown }} ReleasableTransport */
/**
 * @typedef {{
 *   readyState?: number,
 *   addEventListener: (event: string, listener: (...args: unknown[]) => void, options?: { once?: boolean }) => unknown,
 *   send: (data: string) => unknown,
 *   close: () => unknown
 * }} InspectorSocket
 */
/** @typedef {new (endpoint: string) => InspectorSocket} InspectorSocketConstructor */

const isPositivePort = (value) => Number.isSafeInteger(value) && value > 0 && value <= 65_535

const isAbsoluteForPlatform = (value, platform) =>
  platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value) : isAbsolute(value)

const isPlainRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const snapshotExactRecord = (value, keys) => {
  if (!isPlainRecord(value)) return null
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const snapshot = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
    snapshot[key] = descriptor.value
  }
  return snapshot
}

const hasFreshProfilePaths = (value) => {
  const paths = snapshotExactRecord(value, FRESH_PROFILE_KEYS)
  return Boolean(paths && FRESH_PROFILE_KEYS.every((key) => typeof paths[key] === 'string' && paths[key]))
}

/** Reject with `message` if `operation` has not settled within `timeoutMs`. The timer never outlives it. */
export function withTimeout(operation, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}

/** Start one asynchronous action inside a finite host budget. A caller that catches this timeout must not retry
 * the action: the owned app is torn down instead. */
export function boundedCall(operation, timeoutMs, message) {
  if (typeof operation !== 'function') return Promise.reject(new TypeError('boundedCall needs an operation function.'))
  return withTimeout(Promise.resolve().then(operation), timeoutMs, message)
}

const POSIX_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE']
const WINDOWS_ENV_KEYS = [
  ['PATH', 'Path'],
  ['SystemRoot', 'SYSTEMROOT'],
  ['windir', 'WINDIR'],
  ['ComSpec', 'COMSPEC'],
  ['PATHEXT'],
  ['ProgramData', 'PROGRAMDATA'],
  ['ProgramFiles', 'PROGRAMFILES'],
  ['ProgramFiles(x86)', 'PROGRAMFILES(X86)'],
  ['PROCESSOR_ARCHITECTURE'],
  ['PROCESSOR_ARCHITEW6432'],
  ['NUMBER_OF_PROCESSORS'],
  ['OS']
]

function requiredEnvironmentPath(paths, key) {
  const value = paths?.[key]
  if (typeof value !== 'string' || !value) throw new Error(`strict environment needs ${key}.`)
  return value
}

/**
 * Return the only environment a fresh packaged probe may pass into Electron. In particular this never copies
 * GitHub/provider credentials, debug switches, inherited Métis overrides or the owner's profile paths.
 * @returns {NodeJS.ProcessEnv}
 */
export function strictLaunchEnvironment(baseEnvironment, paths, platform = process.platform) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('strict environment supports darwin and win32 only.')
  const base = baseEnvironment ?? {}
  const env = {}
  if (platform === 'darwin') {
    for (const key of POSIX_ENV_KEYS) {
      if (typeof base[key] === 'string' && base[key]) env[key] = base[key]
    }
  } else {
    for (const keys of WINDOWS_ENV_KEYS) {
      const value = keys.map((key) => base[key]).find((candidate) => typeof candidate === 'string' && candidate)
      if (typeof value === 'string') env[keys[0]] = value
    }
  }
  const home = requiredEnvironmentPath(paths, 'home')
  const userProfile = requiredEnvironmentPath(paths, 'userProfile')
  const appData = requiredEnvironmentPath(paths, 'appData')
  const localAppData = requiredEnvironmentPath(paths, 'localAppData')
  const temp = requiredEnvironmentPath(paths, 'temp')
  const userData = requiredEnvironmentPath(paths, 'userData')
  return {
    ...env,
    ...(platform === 'darwin' ? { CFFIXED_USER_HOME: home } : {}),
    HOME: home,
    USERPROFILE: userProfile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    ASKTOTO_USERDATA: userData
  }
}

/** Poll `check` until it returns a truthy value. A throwing check is retried; the last error is reported. */
export async function waitFor(check, message, timeoutMs = 8_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let lastError
  for (;;) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) break
    await sleep(intervalMs)
  }
  throw new Error(`${message}${lastError ? ` (${lastError.message || lastError})` : ''}`)
}

export async function waitForText(page, text, timeout = 15_000) {
  await page.getByText(text, { exact: true }).first().waitFor({ timeout })
}

/** Save `<dir>/<prefix><name>.png` and refuse an empty capture. Returns the path. */
export async function screenshot(page, dir, name, prefix = 'e2e-') {
  const path = join(dir, `${prefix}${name}.png`)
  await page.screenshot({ path })
  if (statSync(path).size === 0) throw new Error(`Screenshot ${name} was empty.`)
  return path
}

/** Launch the app under Playwright's Electron driver: the packaged executable, or the project root. */
export async function launch({ executablePath = null, root, env, timeout = 30_000 }) {
  const { _electron: electron } = await import('playwright')
  return electron.launch({
    // Electron's unpackaged app target must be the project root: passing out/main/index.js makes Electron
    // treat out/main as an app root and bypass package.json.
    ...(executablePath ? { executablePath } : { args: [root] }),
    env: { ...process.env, ...env },
    timeout
  })
}

/** Attach to an already-running app over CDP (`http://127.0.0.1:<port>`). */
export async function attach(endpoint, timeout = 30_000) {
  const { chromium } = await import('playwright')
  return chromium.connectOverCDP(endpoint, { timeout })
}

/**
 * Spawn one packaged Electron process with loopback-only CDP and Node-inspector endpoints. This is opt-in for
 * the fresh-onboarding lane: legacy Playwright Electron launchers retain their current behavior.
 *
 * The exact ChildProcess and both failure latches are available synchronously. A caller must capture them before
 * awaiting an endpoint, because a spawn error or early exit can occur while an attachment is pending.
 */
/**
 * @param {{ executablePath: string, env: Record<string, string>, cdpPort: number, inspectPort: number,
 *   platform?: string, spawnProcess?: DirectSpawn }} options
 */
export function launchPackagedCdp({
  executablePath,
  env,
  cdpPort,
  inspectPort,
  platform = process.platform,
  spawnProcess = spawn
}) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('direct packaged launch supports darwin and win32 only.')
  if (typeof executablePath !== 'string' || !isAbsoluteForPlatform(executablePath, platform)) {
    throw new Error('direct packaged launch needs an absolute executable path.')
  }
  if (!isPlainRecord(env)) throw new Error('direct packaged launch needs an explicit environment.')
  if (!isPositivePort(cdpPort) || !isPositivePort(inspectPort) || cdpPort === inspectPort) {
    throw new Error('direct packaged launch needs distinct positive loopback ports.')
  }
  if (typeof spawnProcess !== 'function') throw new Error('direct packaged launch needs a spawn function.')

  const child = spawnProcess(
    executablePath,
    [`--remote-debugging-port=${cdpPort}`, `--inspect=${LOOPBACK_HOST}:${inspectPort}`],
    {
      env: { ...env },
      stdio: 'ignore',
      windowsHide: true,
      detached: platform !== 'win32'
    }
  )
  if (!child || typeof child.once !== 'function') throw new Error('direct packaged launch returned no child receipt.')

  const latches = { spawnError: false, exited: false }
  child.once('error', () => {
    latches.spawnError = true
  })
  child.once('exit', () => {
    latches.exited = true
  })
  return {
    child,
    latches,
    cdpEndpoint: `http://${LOOPBACK_HOST}:${cdpPort}`,
    inspectPort
  }
}

/** True after a direct-launch error or exit, including a child whose public exit fields were set before listeners. */
export function packagedLaunchFailed(child, latches) {
  return Boolean(latches?.spawnError || latches?.exited || childHasExited(child))
}

async function closeTransport(transport, timeoutMs) {
  if (!transport || typeof transport.close !== 'function') return false
  try {
    const result = await boundedCall(
      () => transport.close(),
      timeoutMs,
      'Timed out while releasing the isolated app transport.'
    )
    return result !== false
  } catch {
    return false
  }
}

/**
 * An endpoint attach can settle after its host-side budget. Keep that late value owned by this helper and close it
 * instead of leaking a foreign transport. The caller can wait for that cleanup during the post-stop release phase.
 */
async function attachWithLateCleanup(open, close, timeoutMs, message) {
  let abandoned = false
  const settled = Promise.resolve()
    .then(open)
    .then(
      async (transport) => {
        if (!abandoned) return { kind: 'ready', transport }
        const closed = await boundedCall(
          () => close(transport, Math.min(timeoutMs, TRANSPORT_RELEASE_TIMEOUT_MS)),
          Math.min(timeoutMs, TRANSPORT_RELEASE_TIMEOUT_MS),
          message
        )
          .then((value) => value !== false)
          .catch(() => false)
        return { kind: 'late', closed }
      },
      () => ({ kind: 'failed' })
    )
  try {
    const result = await withTimeout(settled, timeoutMs, message)
    if (result.kind === 'ready') return { transport: result.transport, uncertain: false, lateRelease: null }
    return { transport: null, uncertain: false, lateRelease: null }
  } catch {
    abandoned = true
    return {
      transport: null,
      uncertain: true,
      lateRelease: async (releaseTimeoutMs) => {
        try {
          const result = await boundedCall(() => settled, releaseTimeoutMs, message)
          return result.kind === 'late' && result.closed === true
        } catch {
          return false
        }
      }
    }
  }
}

function browserMainOwnership(answer, childPid) {
  const processInfo = answer?.processInfo
  if (!Array.isArray(processInfo)) return 'invalid'
  const browserEntries = processInfo.filter((entry) => isPlainRecord(entry) && entry.type === 'browser')
  if (browserEntries.length !== 1 || !Number.isSafeInteger(browserEntries[0].id)) return 'invalid'
  return browserEntries[0].id === childPid ? 'match' : 'pid-mismatch'
}

/**
 * Attach to the direct-launch CDP endpoint and prove that its browser process is the captured child. A collision,
 * malformed protocol response, or delayed attach is a closed failure. The helper never signals any endpoint PID.
 */
/**
 * @param {{ endpoint: string, childPid: number, timeoutMs: number, connect?: CdpConnector }} options
 * @returns {Promise<OwnedCdpAttachment>}
 */
export async function attachOwnedCdp({ endpoint, childPid, timeoutMs, connect = attach }) {
  if (typeof endpoint !== 'string' || !endpoint || !Number.isSafeInteger(childPid) || childPid <= 1) {
    return { browser: null, transportUncertain: false, lateRelease: null, failure: 'cdp-attach-failed' }
  }
  const deadline = performance.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - performance.now())
  for (;;) {
    const attachRemaining = remaining()
    if (attachRemaining <= 0) {
      return { browser: null, transportUncertain: false, lateRelease: null, failure: 'cdp-endpoint-deadline' }
    }
    const attachment = await attachWithLateCleanup(
      () => connect(endpoint, remaining()),
      (browser, closeTimeoutMs) => closeTransport(browser, closeTimeoutMs),
      attachRemaining,
      'fresh-owned-cdp-attach-timeout'
    )
    if (!attachment.transport) {
      if (attachment.uncertain) {
        return {
          browser: null,
          transportUncertain: true,
          lateRelease: attachment.lateRelease,
          failure: 'cdp-transport-timeout'
        }
      }
      const afterAttach = remaining()
      if (afterAttach <= 0) {
        return { browser: null, transportUncertain: false, lateRelease: null, failure: 'cdp-endpoint-deadline' }
      }
      await sleep(Math.min(100, afterAttach))
      continue
    }
    const browser = attachment.transport
    try {
      const sessionRemaining = remaining()
      if (sessionRemaining <= 0) {
        const released = await closeTransport(browser, 1)
        return {
          browser: null,
          transportUncertain: !released,
          lateRelease: attachment.lateRelease,
          failure: 'cdp-session-or-process-info-invalid'
        }
      }
      const session = await boundedCall(
        () => browser.newBrowserCDPSession(),
        sessionRemaining,
        'fresh-owned-cdp-handshake-timeout'
      )
      const processRemaining = remaining()
      if (processRemaining <= 0) {
        const released = await closeTransport(browser, 1)
        return {
          browser: null,
          transportUncertain: !released,
          lateRelease: attachment.lateRelease,
          failure: 'cdp-session-or-process-info-invalid'
        }
      }
      const answer = await boundedCall(
        () => session.send('SystemInfo.getProcessInfo'),
        processRemaining,
        'fresh-owned-cdp-handshake-timeout'
      )
      const afterProcess = remaining()
      if (afterProcess <= 0) {
        const released = await closeTransport(browser, 1)
        return {
          browser: null,
          transportUncertain: !released,
          lateRelease: attachment.lateRelease,
          failure: 'cdp-session-or-process-info-invalid'
        }
      }
      const ownership = browserMainOwnership(answer, childPid)
      if (ownership !== 'match') {
        const released = await closeTransport(browser, afterProcess)
        return {
          browser: null,
          transportUncertain: !released,
          lateRelease: attachment.lateRelease,
          failure: ownership === 'pid-mismatch' ? 'cdp-browser-pid-mismatch' : 'cdp-session-or-process-info-invalid'
        }
      }
      return { browser, transportUncertain: false, lateRelease: attachment.lateRelease, failure: null }
    } catch {
      const released = await closeTransport(browser, Math.max(1, remaining()))
      return {
        browser: null,
        transportUncertain: !released,
        lateRelease: attachment.lateRelease,
        failure: 'cdp-session-or-process-info-invalid'
      }
    }
  }
}

function isExpectedInspectorUrl(value, inspectPort) {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'ws:' && parsed.hostname === LOOPBACK_HOST && Number(parsed.port) === inspectPort
  } catch {
    return false
  }
}

async function discoverInspectorUrl(inspectPort, deadline, fetchImpl) {
  const controller = new AbortController()
  try {
    const fetchRemaining = Math.max(0, deadline - performance.now())
    if (fetchRemaining <= 0) return { kind: 'waiting' }
    const response = await boundedCall(
      () => fetchImpl(`http://${LOOPBACK_HOST}:${inspectPort}/json/list`, { signal: controller.signal }),
      fetchRemaining,
      'fresh-main-inspector-discovery-timeout'
    )
    if (!response || response.ok === false) return { kind: 'waiting' }
    const bodyRemaining = Math.max(0, deadline - performance.now())
    if (bodyRemaining <= 0) return { kind: 'waiting' }
    const targets = await boundedCall(() => response.json(), bodyRemaining, 'fresh-main-inspector-discovery-timeout')
    if (!Array.isArray(targets)) return { kind: 'invalid' }
    const endpoints = targets
      .map((target) => (isPlainRecord(target) ? target.webSocketDebuggerUrl : null))
      .filter((url) => typeof url === 'string')
    if (endpoints.length === 0) return { kind: 'waiting' }
    if (endpoints.length !== 1 || !isExpectedInspectorUrl(endpoints[0], inspectPort)) return { kind: 'invalid' }
    return { kind: 'ready', endpoint: endpoints[0] }
  } catch {
    return { kind: 'waiting' }
  } finally {
    controller.abort()
  }
}

function closeInspectorSocket(socket, timeoutMs) {
  if (!socket || socket.readyState === 3) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    try {
      socket.addEventListener('close', () => finish(true), { once: true })
      socket.close()
    } catch {
      finish(false)
    }
  })
}

/** Open one loopback inspector socket with a tracked close receipt on an error or late opening connection. */
async function openInspectorSocket(endpoint, timeoutMs, WebSocketClass) {
  if (typeof WebSocketClass !== 'function') return { socket: null, uncertain: false }
  return new Promise((resolve) => {
    let socket
    let settled = false
    let releasePromise = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const startRelease = () => {
      if (!releasePromise) {
        releasePromise = closeInspectorSocket(socket, Math.min(timeoutMs, TRANSPORT_RELEASE_TIMEOUT_MS))
      }
      return releasePromise
    }
    const lateRelease = async (releaseTimeoutMs) => {
      try {
        return (
          (await boundedCall(() => startRelease(), releaseTimeoutMs, 'fresh-main-inspector-release-timeout')) === true
        )
      } catch {
        return false
      }
    }
    const timer = setTimeout(() => {
      void startRelease()
      finish({ socket: null, uncertain: true, lateRelease })
    }, timeoutMs)
    try {
      socket = new WebSocketClass(endpoint)
      socket.addEventListener('open', () => {
        if (settled) {
          void startRelease()
          return
        }
        finish({ socket, uncertain: false, lateRelease: null })
      })
      socket.addEventListener(
        'error',
        () => {
          void startRelease()
          finish({ socket: null, uncertain: true, lateRelease })
        },
        { once: true }
      )
    } catch {
      finish({ socket: null, uncertain: false })
    }
  })
}

function freshMainObservationExpression({ childPid, expectedPaths, expectedVersion }) {
  const expected = JSON.stringify({ childPid, paths: expectedPaths, version: expectedVersion })
  return `(() => {
    const expected = ${expected}
    if (process.pid !== expected.childPid) return { owner: false }
    const load = process.mainModule?.require
    if (typeof load !== 'function') return { retry: 'loader-unavailable' }
    try {
      const path = load('node:path')
      const { app, BrowserWindow, screen } = load('electron')
      const within = (value) => {
        if (typeof value !== 'string' || !value) return false
        const relative = path.relative(expected.paths.root, value)
        return (
          relative === '' ||
          (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
        )
      }
      const visible = BrowserWindow.getAllWindows()
        .filter((candidate) => !candidate.isDestroyed() && candidate.isVisible())
        .sort((left, right) => right.id - left.id)[0]
      let nativeFullDisplay = false
      if (visible) {
        const bounds = visible.getBounds()
        const display = screen.getDisplayMatching(bounds).bounds
        nativeFullDisplay =
          bounds.x === display.x &&
          bounds.y === display.y &&
          bounds.width === display.width &&
          bounds.height === display.height
      }
      return {
        profileMatches:
          app.getPath('userData') === expected.paths.userData &&
          within(app.getPath('home')) &&
          within(app.getPath('appData')) &&
          within(app.getPath('temp')),
        versionMatches: app.getVersion() === expected.version,
        nativeFullDisplay
      }
    } catch {
      return { failed: true }
    }
  })()`
}

function exactObservation(value) {
  const retry = snapshotExactRecord(value, ['retry'])
  if (retry?.retry === 'loader-unavailable') return { kind: 'retry' }
  const owner = snapshotExactRecord(value, ['owner'])
  if (owner && owner.owner === false) return { kind: 'failed' }
  const observation = snapshotExactRecord(value, ['profileMatches', 'versionMatches', 'nativeFullDisplay'])
  if (
    observation &&
    typeof observation.profileMatches === 'boolean' &&
    typeof observation.versionMatches === 'boolean' &&
    typeof observation.nativeFullDisplay === 'boolean'
  ) {
    return { kind: 'ready', observation }
  }
  return { kind: 'failed' }
}

function createFixedMainInspector(socket) {
  const pending = new Map()
  let nextId = 1
  let closed = false
  const rejectPending = () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new Error('fresh-main-inspector-closed'))
    }
    pending.clear()
  }
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const entry = pending.get(message?.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message)
  })
  socket.addEventListener(
    'error',
    () => {
      rejectPending()
    },
    { once: true }
  )
  socket.addEventListener(
    'close',
    () => {
      closed = true
      rejectPending()
    },
    { once: true }
  )

  const sendObservation = (expression, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('fresh-main-inspector-closed'))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('fresh-main-inspector-evaluate-timeout'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
      } catch {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error('fresh-main-inspector-send-failed'))
      }
    })

  return {
    async observe(expected, timeoutMs) {
      try {
        const answer = await sendObservation(freshMainObservationExpression(expected), timeoutMs)
        if (answer?.error || answer?.result?.exceptionDetails) return { kind: 'failed' }
        return exactObservation(answer?.result?.result?.value)
      } catch {
        return { kind: 'failed' }
      }
    },
    async close(timeoutMs = TRANSPORT_RELEASE_TIMEOUT_MS) {
      rejectPending()
      return closeInspectorSocket(socket, timeoutMs)
    }
  }
}

/**
 * Attach to the captured main process's loopback inspector and make only the fixed fresh-onboarding observation.
 * It never exposes a general evaluator or records endpoint, process, path, or main-process content.
 */
/**
 * @param {{ inspectPort: number, childPid: number, expectedPaths: Record<string, string>, expectedVersion: string,
 *   timeoutMs: number, fetchImpl?: InspectorFetch, WebSocketClass?: InspectorSocketConstructor }} options
 */
export async function attachOwnedMainInspector({
  inspectPort,
  childPid,
  expectedPaths,
  expectedVersion,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  WebSocketClass = globalThis.WebSocket
}) {
  if (
    !isPositivePort(inspectPort) ||
    !Number.isSafeInteger(childPid) ||
    childPid <= 1 ||
    !hasFreshProfilePaths(expectedPaths) ||
    typeof expectedVersion !== 'string' ||
    typeof fetchImpl !== 'function'
  ) {
    return { inspector: null, observation: null, transportUncertain: false, lateRelease: null }
  }
  const deadline = performance.now() + timeoutMs
  let inspector = null
  for (;;) {
    const remaining = Math.max(0, deadline - performance.now())
    if (remaining <= 0) return { inspector: null, observation: null, transportUncertain: false, lateRelease: null }
    const discovery = await discoverInspectorUrl(inspectPort, deadline, fetchImpl)
    if (discovery.kind === 'invalid') {
      return { inspector: null, observation: null, transportUncertain: false, lateRelease: null }
    }
    const afterDiscovery = Math.max(0, deadline - performance.now())
    if (afterDiscovery <= 0) return { inspector: null, observation: null, transportUncertain: false, lateRelease: null }
    if (discovery.kind === 'waiting') {
      await sleep(Math.min(100, afterDiscovery))
      continue
    }
    const opened = await openInspectorSocket(discovery.endpoint, afterDiscovery, WebSocketClass)
    if (!opened.socket) {
      return {
        inspector: null,
        observation: null,
        transportUncertain: opened.uncertain,
        lateRelease: opened.lateRelease ?? null
      }
    }
    inspector = createFixedMainInspector(opened.socket)
    for (;;) {
      const observationRemaining = Math.max(0, deadline - performance.now())
      if (observationRemaining <= 0) {
        const released = await inspector.close(Math.max(1, observationRemaining))
        return { inspector: null, observation: null, transportUncertain: !released, lateRelease: null }
      }
      const result = await inspector.observe({ childPid, expectedPaths, expectedVersion }, observationRemaining)
      const afterObservation = Math.max(0, deadline - performance.now())
      if (afterObservation <= 0) {
        const released = await inspector.close(1)
        return { inspector: null, observation: null, transportUncertain: !released, lateRelease: null }
      }
      if (result.kind === 'ready') {
        return { inspector, observation: result.observation, transportUncertain: false, lateRelease: null }
      }
      if (result.kind !== 'retry') {
        const released = await inspector.close(afterObservation)
        return { inspector: null, observation: null, transportUncertain: !released, lateRelease: null }
      }
      const afterProbe = Math.max(0, deadline - performance.now())
      if (afterProbe <= 0) {
        const released = await inspector.close(1)
        return { inspector: null, observation: null, transportUncertain: !released, lateRelease: null }
      }
      await sleep(Math.min(100, afterProbe))
    }
  }
}

/**
 * Release only direct-launch transports after an acknowledged owned-child stop.
 * @param {{ inspector?: ReleasableTransport | null, browser?: ReleasableTransport | null,
 *   transportUncertain?: boolean, lateReleases?: unknown[] }} options
 * @param {number} [timeoutMs]
 */
export async function disposeFreshOnboardingTransports(
  { inspector = null, browser = null, transportUncertain = false, lateReleases = [] } = {},
  timeoutMs = TRANSPORT_RELEASE_TIMEOUT_MS
) {
  const deadline = performance.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - performance.now())
  let released = !transportUncertain
  for (const transport of [inspector, browser]) {
    if (!transport) continue
    released = (await closeTransport(transport, Math.max(1, remaining()))) && released
  }
  for (const release of lateReleases) {
    if (typeof release !== 'function') {
      released = false
      continue
    }
    try {
      released = (await release(Math.max(1, remaining()))) && released
    } catch {
      released = false
    }
  }
  return released
}

/** First open page of the attached browser for which `accept(page)` resolves truthy, within `timeoutMs`. */
export async function findPage(browser, accept, message, timeoutMs = 15_000, intervalMs = 100) {
  return waitFor(
    async () => {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (page.isClosed()) continue
          try {
            if (await accept(page)) return page
          } catch {
            // Mid-navigation pages throw on evaluate; the next poll sees the settled page.
          }
        }
      }
      return null
    },
    message,
    timeoutMs,
    intervalMs
  )
}

export function childHasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null
}

export function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(childHasExited(child)), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Close only the app this driver launched: ask it to quit, close the Playwright handle, then signal that
 * specific child (SIGTERM, then SIGKILL) if it did not comply. Métis stays alive after its last window
 * for background reconciliation, so a bare close is not enough.
 */
export async function closeApp(app, { requestTimeoutMs = 5_000, exitTimeoutMs = 3_000 } = {}) {
  if (!app) return
  const child = app.process()
  await withTimeout(
    app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {}),
    requestTimeoutMs,
    'Timed out while requesting the isolated test app to quit.'
  ).catch(() => {})
  await withTimeout(
    app.close().catch(() => {}),
    requestTimeoutMs,
    'Timed out while closing the isolated test app.'
  ).catch(() => {})
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (childHasExited(child)) return
    child.kill(signal)
    await waitForChildExit(child, exitTimeoutMs)
  }
}

/**
 * Processes the harness owns: main, its descendants and everything resident under the install root.
 * `listTable` is injectable so ownership is testable without a real process table.
 */
export function ownedCensus({ platform = process.platform, mainPid, installRoot, listTable = listProcesses }) {
  const owned = ownedProcesses(listTable(platform), { mainPid, installRoot, platform })
  return { owned, roles: roleCounts(owned) }
}

/**
 * SIGKILL the given owned entries. Never this process, never by name; an already-gone pid is fine.
 * @param {{ pid: number }[]} entries
 * @param {(pid: number) => void} [kill]
 */
export function killOwned(entries, kill = (pid) => void process.kill(pid, 'SIGKILL')) {
  for (const entry of entries) {
    if (entry.pid === process.pid) continue
    try {
      kill(entry.pid)
    } catch {
      // Already gone.
    }
  }
}

/** Run a helper process to completion or `timeoutMs`; never rejects. */
export function runProcess(file, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(file, args, { stdio: 'ignore', detached: false, ...options })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish({ code: null, signal: 'timeout', error: false })
    }, timeoutMs)
    child.once('error', () => finish({ code: null, signal: null, error: true }))
    child.once('exit', (code, signal) => finish({ code, signal, error: false }))
  })
}

export function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Bounds and work area of the newest visible overlay window, read from the Electron main process. */
export async function overlayGeometry(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const overlay = BrowserWindow.getAllWindows()
      .filter((candidate) => !candidate.isDestroyed() && candidate.isVisible())
      .sort((a, b) => b.id - a.id)[0]
    if (!overlay) return null
    const bounds = overlay.getBounds()
    const display = screen.getDisplayMatching(bounds)
    return { bounds, displayBounds: display.bounds, workArea: display.workArea, displayId: display.id }
  })
}

const OVERLAY_CHROME_SOURCE = fileURLToPath(new URL('../../../src/shared/overlay-chrome.ts', import.meta.url))

/** Numeric `export const NAME = <literal>` values of a TypeScript source, so scripts share one truth. */
export function readNumericConstants(source, names) {
  const values = {}
  for (const name of names) {
    const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)(?=\\s*(?:\\r?\\n|$|//))`).exec(source)
    if (!match) throw new Error(`${name} is not a numeric export of the overlay chrome source`)
    values[name] = Number(match[1])
  }
  return values
}

/** Overlay heights the harnesses assert against, read from src/shared/overlay-chrome.ts. */
export function overlayChromeGeometry(source = readFileSync(OVERLAY_CHROME_SOURCE, 'utf8')) {
  const v = readNumericConstants(source, [
    'BAR_IDLE_HEIGHT_PX',
    'ASK_REVEAL_MIN_HEIGHT_PX',
    'WINDOW_RESIZE_HUG_FLOOR_PX'
  ])
  return {
    barIdleHeightPx: v.BAR_IDLE_HEIGHT_PX,
    askRevealMinHeightPx: v.ASK_REVEAL_MIN_HEIGHT_PX,
    hugFloorPx: v.WINDOW_RESIZE_HUG_FLOOR_PX
  }
}
