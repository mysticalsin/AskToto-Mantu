// WP14 sandbox acceptance — one launched instance of the QA-identity app, driven over loopback CDP.
//
// The app is started by DIRECT spawn of Contents/MacOS/<exe> with an explicit child environment (the check-packaged-launch
// pattern). There is no `open`, no `launchctl setenv` and no AppleScript: those route through launchd and would leak
// ASKTOTO_USERDATA / TMPDIR into the owner's real Métis session. Every launch passes the sandbox guard first.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  attach,
  findPage,
  freeLoopbackPort,
  killOwned,
  ownedCensus,
  requestOwnedAppQuit,
  sleep,
  waitFor,
  waitForChildExit,
  withTimeout
} from '../lib/app-driver.mjs'
import { parseAuditLog, readAuditLog } from '../golden-flows/smoke-support.mjs'
import { assertCommandAllowed, assertGuards, evaluateGuards } from './guard.mjs'
import { readBundleId } from './bundle.mjs'
import { buildChildEnv, checkSocketBudget, executableForApp, seedSettings } from './lib.mjs'

const READY_POLL_MS = 250

/**
 * Chromium switches the harness adds on top of --remote-debugging-port. The macOS audio service runs sandboxed and cannot
 * open the file behind --use-file-for-fake-audio-capture (the app's file-fed microphone), so the fake device streams
 * silence and no speech ever reaches the recogniser. Turning that one sandbox feature off is confined to this QA-identity,
 * sandbox-profile launch; the shipping build never receives it.
 */
export const HARNESS_CHROMIUM_SWITCHES = Object.freeze(['--disable-features=AudioServiceSandbox'])

/** @param {{ layout: ReturnType<typeof import('./lib.mjs').sandboxLayout>, appPath: string, parentEnv: Record<string, string | undefined>, captureFile?: string | null, platform?: string, bundleId?: string | null, extraEnv?: Record<string, string> }} args */
export function planLaunch({
  layout,
  appPath,
  parentEnv,
  captureFile = null,
  platform = process.platform,
  bundleId = undefined,
  extraEnv = {}
}) {
  const childEnv = buildChildEnv({ parentEnv, layout, captureFile, platform, extraEnv })
  return {
    childEnv,
    guardConfig: {
      sandboxRoot: layout.sandboxRoot,
      appPath,
      bundleId: bundleId === undefined ? readBundleId(appPath) : bundleId,
      childEnv,
      parentEnv,
      meetingsFolder: layout.meetingsFolder
    }
  }
}

/**
 * Every launch guard plus the socket-path budget, as the list --dry-run prints. Reads only the bundle id; launches nothing.
 * @param {{ layout: any, appPath: string, parentEnv: Record<string, string | undefined>, captureFile?: string | null, bundleId?: string | null, platform?: string, extraEnv?: Record<string, string> }} args
 */
export function guardReport({
  layout,
  appPath,
  parentEnv,
  captureFile = null,
  bundleId = undefined,
  platform = process.platform,
  extraEnv = {}
}) {
  const { childEnv, guardConfig } = planLaunch({
    layout,
    appPath,
    parentEnv,
    captureFile,
    bundleId,
    platform,
    extraEnv
  })
  const result = evaluateGuards(guardConfig)
  result.checks.push(checkSocketBudget(layout.tmp))
  return {
    ok: result.checks.every((check) => check.ok),
    checks: result.checks,
    childEnvKeys: Object.keys(childEnv).sort()
  }
}

/**
 * Create the run's directories and, on first launch, the onboarded settings (plus `extraSettings`, for a scenario that needs
 * a specific profile). Idempotent so a relaunch reuses the profile.
 */
export function prepareProfile(layout, extraSettings = {}) {
  for (const dir of [layout.home, layout.tmp, layout.userData, layout.reportsDir, layout.appData, layout.localAppData])
    mkdirSync(dir, { recursive: true })
  const settingsFile = join(layout.userData, 'settings.json')
  if (!existsSync(settingsFile))
    writeFileSync(settingsFile, `${JSON.stringify(seedSettings(Date.now(), extraSettings), null, 2)}\n`, {
      mode: 0o600
    })
}

export const readAudit = (layout) => parseAuditLog(readAuditLog(layout.auditLog))

/**
 * Launch the app and wait for its own `app.renderer.ready` audit record, then (optionally) attach over CDP.
 * Throws on a guard refusal, an early exit, an `app.crash`/`app.unresponsive` record, or the timeout.
 * @param {{ layout: any, appPath: string, parentEnv: Record<string, string | undefined>, captureFile?: string | null,
 *   readyTimeoutMs?: number, connect?: boolean, log?: (line: string) => void, extraEnv?: Record<string, string>,
 *   deps?: { platform?: string, readBundleId?: (appPath: string) => string | null } }} args
 * `deps` is a test seam (a fake bundle whose Info.plist plutil cannot read, and a non-darwin CI host); the CLIs never pass it.
 */
export async function launchApp({
  layout,
  appPath,
  parentEnv,
  captureFile = null,
  readyTimeoutMs = 120_000,
  connect = true,
  log = () => {},
  extraEnv = {},
  deps = {}
}) {
  const { childEnv, guardConfig } = planLaunch({
    layout,
    appPath,
    parentEnv,
    captureFile,
    extraEnv,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.readBundleId ? { bundleId: deps.readBundleId(appPath) } : {})
  })
  assertGuards(guardConfig)
  const budget = checkSocketBudget(layout.tmp)
  if (!budget.ok) throw new Error(budget.detail)
  prepareProfile(layout)
  const executable = executableForApp(appPath)
  assertCommandAllowed(executable, [])
  const port = await freeLoopbackPort()
  const auditBaseline = readAudit(layout).length
  const installRoot = appPath
  // Loopback-only CDP: Chromium binds --remote-debugging-port to 127.0.0.1 unless an address is requested.
  const child = spawn(executable, [`--remote-debugging-port=${port}`, ...HARNESS_CHROMIUM_SWITCHES], {
    env: childEnv,
    stdio: 'ignore',
    detached: true
  })
  const latches = { error: null, exited: false }
  child.once('error', (error) => {
    latches.error = error
  })
  child.once('exit', () => {
    latches.exited = true
  })
  log(`launched pid ${child.pid} (CDP 127.0.0.1:${port}, userData ${layout.userData})`)

  const session = {
    child,
    pid: child.pid,
    port,
    endpoint: `http://127.0.0.1:${port}`,
    layout,
    installRoot,
    auditBaseline,
    browser: null,
    page: null,
    latches,
    /** Audit records this launch wrote. */
    audit: () => readAudit(layout).slice(auditBaseline),
    async connect(timeoutMs = 30_000) {
      if (session.page && !session.page.isClosed()) return session.page
      session.browser = await waitFor(
        () => attach(session.endpoint, 5_000).catch(() => null),
        'CDP endpoint did not accept a connection',
        timeoutMs,
        500
      )
      session.page = await findPage(
        session.browser,
        (page) => page.evaluate(() => typeof window.toto?.getSettings === 'function'),
        'no page exposes window.toto',
        timeoutMs
      )
      return session.page
    },
    async disconnect() {
      const browser = session.browser
      session.browser = null
      session.page = null
      if (browser)
        await withTimeout(
          browser.close().catch(() => {}),
          5_000,
          'CDP close timed out'
        ).catch(() => {})
    },
    /** Run `fn(page)` against a short-lived CDP connection, so an idle phase is not observed through a standing one. */
    async withPage(fn) {
      const wasConnected = Boolean(session.page)
      const page = await session.connect()
      try {
        return await fn(page)
      } finally {
        if (!wasConnected) await session.disconnect()
      }
    },
    /** Ask the app to quit through its own IPC and wait for the process to exit; never signals unless it refuses. */
    async quit(timeoutMs = 45_000) {
      let page = null
      try {
        page = await session.connect(15_000)
      } catch {
        /* handled below as page-unavailable */
      }
      const result = await requestOwnedAppQuit(
        child,
        async () => {
          if (!page) return 'page-unavailable'
          try {
            await page.evaluate(() => window.toto.quit())
            return 'accepted'
          } catch (error) {
            // The IPC reply can be torn down with the window; the exit observation that follows is what counts.
            const torn = /closed|destroyed|disconnected|crashed|navigat/i.test(String(error?.message ?? error))
            return torn || child.exitCode !== null || child.signalCode !== null ? 'accepted' : 'evaluation-failed'
          }
        },
        timeoutMs
      )
      await session.disconnect()
      const records = session.audit()
      return {
        ...result,
        cleanShutdownRecord: records.some((record) => record.event === 'app.shutdown.clean'),
        leftovers: session.leftovers()
      }
    },
    /** Owned processes still alive (install-root residents or descendants of a live main). */
    leftovers() {
      try {
        return ownedCensus({ mainPid: child.pid, installRoot }).owned.filter((entry) => entry.pid !== process.pid)
      } catch {
        return []
      }
    },
    /** SIGKILL whatever this session still owns. Structural ownership only, never by name. */
    async kill() {
      await session.disconnect()
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* group already gone */
      }
      killOwned(session.leftovers())
      await waitForChildExit(child, 5_000)
    }
  }

  const deadline = Date.now() + readyTimeoutMs
  try {
    for (;;) {
      if (latches.error) throw new Error(`could not launch: ${latches.error.message}`)
      if (latches.exited) throw new Error('the app exited before its renderer became ready')
      const records = session.audit()
      const bad = records.find((record) => record.event === 'app.crash' || record.event === 'app.unresponsive')
      if (bad) throw new Error(`the app reported ${bad.event} while starting`)
      if (records.some((record) => record.event === 'app.renderer.ready')) break
      if (Date.now() >= deadline)
        throw new Error(`no app.renderer.ready audit record within ${Math.round(readyTimeoutMs / 1000)}s`)
      await sleep(READY_POLL_MS)
    }
    if (connect) await session.connect()
  } catch (error) {
    await session.kill()
    throw error
  }
  return session
}
