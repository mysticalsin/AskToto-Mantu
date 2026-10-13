#!/usr/bin/env node

/**
 * Run one isolated Electron development build through Vercel Agent Browser over loopback CDP.
 * This is a QA-only launcher. Remote debugging is never enabled in product startup code.
 *
 * Usage: node scripts/qa/agent-browser-smoke.mjs --port 9222 --agent-browser-package <package-dir>
 *        [--report <path>] [--keep-open]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { attachOwnedCdp, killOwned, strictLaunchEnvironment, waitForChildExit } from './lib/app-driver.mjs'
import { listProcesses, ownedProcesses, survivors } from './owned-processes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const AGENT_BROWSER_VERSION = '0.39.0'
const START_TIMEOUT_MS = 120_000
const CDP_ATTACH_TIMEOUT_MS = 15_000
const COMMAND_TIMEOUT_MS = 25_000
const CHILD_STOP_TIMEOUT_MS = 10_000
const PROCESS_CLEANUP_TIMEOUT_MS = 10_000
const LOOPBACK_HOST = '127.0.0.1'
const STARTUP_OUTPUT_LIMIT = 8_192

function argValue(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? null : args[index + 1] ?? null
}

function parseOptions(args) {
  const port = Number(argValue(args, '--port'))
  const packageDir = argValue(args, '--agent-browser-package') ?? join(ROOT, 'scripts', 'qa', 'agent-browser-package', 'node_modules', 'agent-browser')
  const report = argValue(args, '--report')
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('invalid-port')
  }
  return { port, packageDir: resolve(packageDir), report: report ? resolve(report) : null, keepOpen: args.includes('--keep-open') }
}

function requiredFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label}-missing`)
  return path
}

function packageCli(packageDir) {
  const metadataPath = requiredFile(join(packageDir, 'package.json'), 'agent-browser-package')
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  if (metadata.name !== 'agent-browser' || metadata.version !== AGENT_BROWSER_VERSION) {
    throw new Error('agent-browser-version-mismatch')
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('agent-browser-needs-node-24')
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.['agent-browser']
  if (typeof bin !== 'string') throw new Error('agent-browser-bin-missing')
  const cliPath = resolve(packageDir, bin)
  const rel = relative(packageDir, cliPath)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('agent-browser-bin-outside-package')
  return cliPath
}

function electronExecutable() {
  const dist = join(ROOT, 'node_modules', 'electron', 'dist')
  return process.platform === 'darwin'
    ? requiredFile(join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron'), 'electron-runtime')
    : requiredFile(join(dist, 'electron.exe'), 'electron-runtime')
}

function makeIsolatedProfile() {
  const root = mkdtempSync(join(tmpdir(), 'metis-agent-browser-'))
  const paths = {
    home: join(root, 'home'),
    userProfile: join(root, 'home'),
    appData: join(root, 'appdata'),
    localAppData: join(root, 'localappdata'),
    temp: join(root, 'temp'),
    userData: join(root, 'userdata')
  }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(paths.userData, 'settings.json'),
    `${JSON.stringify({ onboardingDone: true, onboardingDoneAt: Date.now(), overlayLayout: 'bar' }, null, 2)}\n`,
    { mode: 0o600 }
  )
  return { root, paths }
}

function runCli(cliPath, session, args, env, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cliPath, '--session', session, ...args], {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }
    const collect = (target) => (chunk) => {
      if (target === 'stdout') stdout = (stdout + chunk.toString('utf8')).slice(-1_000_000)
      else stderr = (stderr + chunk.toString('utf8')).slice(-1_000_000)
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.once('error', () => finish({ code: null, timedOut: false, stdout, stderr, failedToStart: true }))
    child.once('exit', (code) => finish({ code, timedOut: false, stdout, stderr, failedToStart: false }))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, timedOut: true, stdout, stderr, failedToStart: false })
    }, timeoutMs)
  })
}

function failureClass(result) {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
  if (/no page found|no page target/.test(text)) return 'no-page-target'
  if (/econnrefused|websocket|cdp.*timeout|connection.*refused/.test(text)) return 'cdp-connection'
  if (result.timedOut) return 'command-timeout'
  if (result.failedToStart) return 'command-not-started'
  return 'command-failed'
}

function writeReport(path, report) {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

function waitForInterrupt() {
  return new Promise((resolveSignal) => {
    const done = () => resolveSignal()
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function shellQuote(value, platform) {
  if (platform === 'win32') return `'${String(value).replaceAll("'", "''")}'`
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function printManualSessionInstructions({ cliPath, profilePaths, session }) {
  const paths = {
    HOME: profilePaths.home,
    USERPROFILE: profilePaths.userProfile,
    APPDATA: profilePaths.appData,
    LOCALAPPDATA: profilePaths.localAppData,
    TMPDIR: profilePaths.temp,
    TMP: profilePaths.temp,
    TEMP: profilePaths.temp,
    ...(process.platform === 'darwin'
      ? { CFFIXED_USER_HOME: profilePaths.home, MAC_CHROMIUM_TMPDIR: profilePaths.temp }
      : {})
  }
  const assignments = Object.entries(paths).map(([key, value]) =>
    process.platform === 'win32'
      ? `$env:${key} = ${shellQuote(value, process.platform)}`
      : `export ${key}=${shellQuote(value, process.platform)}`
  )
  const command = process.platform === 'win32'
    ? `& ${shellQuote(process.execPath, process.platform)} ${shellQuote(cliPath, process.platform)}`
    : `${shellQuote(process.execPath, process.platform)} ${shellQuote(cliPath, process.platform)}`
  console.log('[agent-browser-smoke] In a second shell in this worktree, paste the following to share this isolated session:')
  console.log([...assignments, `${command} --session ${session} snapshot -i`].join('\n'))
  console.log(`[agent-browser-smoke] Then use the same command prefix with console, errors, or network requests. Session ${session} is isolated to this worktree and will be deleted when this launcher stops.`)
}

async function waitForCdpEndpoint({ port, child, launchFailed, timeoutMs }) {
  const endpoint = `http://${LOOPBACK_HOST}:${port}/json/version`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (launchFailed() || childHasExited(child)) throw new Error('electron-exited-before-cdp-ready')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_000)
    try {
      const response = await fetch(endpoint, { signal: controller.signal, redirect: 'error' })
      await response.body?.cancel()
      if (response.ok) return
    } catch {
      // The app has not opened its loopback endpoint yet. Recheck the owned child before retrying.
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error('cdp-endpoint-timeout')
}

function mergeOwnedProcesses(target, entries) {
  for (const entry of entries) target.set(`${entry.pid}:${entry.startedMs}`, entry)
}

function captureOwnedProcesses(target, childPid) {
  const table = listOwnedProcessTable()
  const current = ownedProcesses(table, { mainPid: childPid, installRoot: ROOT, platform: process.platform })
  mergeOwnedProcesses(target, current)
  return current
}

function listOwnedProcessTable() {
  // If macOS `ps comm` returns only a basename, resolving it against this cwd could falsely claim
  // that the current worktree owns an unrelated process. Keep the row for PID-tree ownership, but only
  // absolute executable paths can prove root residency.
  return listProcesses(process.platform).map((entry) =>
    entry.exe !== null && !isAbsolute(entry.exe) ? { ...entry, exe: null } : entry
  )
}

function appendBounded(current, chunk) {
  return (current + chunk.toString('utf8')).slice(-STARTUP_OUTPUT_LIMIT)
}

function startupDiagnostic(output) {
  const text = output.toLowerCase()
  if (/eaddrinuse|address already in use|only one usage of each socket address/.test(text)) return 'port-in-use'
  if (/cannot find module|err_module_not_found|module_not_found/.test(text)) return 'module-load-failure'
  if (/not a valid win32 application|bad cpu type|image not found/.test(text)) return 'runtime-load-failure'
  if (/uncaught exception|fatal error|error:/.test(text)) return 'startup-error-output'
  return output ? 'startup-output-present' : 'no-startup-output'
}

async function stopOwnedProcessTree({ child, ownedAtLaunch, report }) {
  if (!child?.pid || child.pid <= 1) {
    report.ownedProcessesCleaned = true
    return
  }

  const owned = new Map(ownedAtLaunch)
  let censusAvailable = owned.size > 0
  try {
    captureOwnedProcesses(owned, child.pid)
  } catch {
    censusAvailable = false
  }

  if (!childHasExited(child)) {
    try {
      child.kill('SIGTERM')
      await waitForChildExit(child, 3_000)
    } catch {
      // The structural census below still provides the only targets considered for hard cleanup.
    }
  }

  const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS
  let remaining = []
  while (Date.now() < deadline) {
    try {
      const table = listOwnedProcessTable()
      remaining = survivors([...owned.values()], table, { installRoot: ROOT, platform: process.platform })
      if (remaining.length === 0) {
        report.ownedProcessesCleaned = censusAvailable
        return
      }
      // The main process got a graceful SIGTERM first; kill only identities in the owned snapshot or
      // processes still resident under this worktree's install root. Never select by process name.
      killOwned(remaining)
    } catch {
      censusAvailable = false
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }

  report.ownedProcessesCleaned = false
  if (!report.failure) report.failure = remaining.length > 0 ? 'owned-process-cleanup-incomplete' : 'process-census-unavailable'
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('unsupported-host')
  const cliPath = packageCli(options.packageDir)
  const executable = electronExecutable()
  const { version: appVersion } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const profile = makeIsolatedProfile()
  const env = strictLaunchEnvironment(process.env, profile.paths)
  const session = `metis-worktree-${options.port}`
  const report = {
    schemaVersion: 1,
    result: 'FAIL',
    appVersion,
    agentBrowserVersion: AGENT_BROWSER_VERSION,
    platform: process.platform,
    cdpHost: LOOPBACK_HOST,
    cdpPort: options.port,
    ownedTargetVerified: false,
    composerVisibleInSnapshot: false,
    diagnosticCommandsSucceeded: { pageErrors: false, console: false, networkRequests: false },
    cleanShutdown: false,
    ownedProcessesCleaned: false,
    preexistingOwnedProcessCount: 0,
    startupDiagnostic: null,
    failure: null
  }

  let appChild = null
  let appOutput = { stdout: '', stderr: '' }
  let ownedBrowser = null
  let connected = false
  let leaveRunning = false
  const ownedAtLaunch = new Map()
  let launchFailed = false
  try {
    const existing = ownedProcesses(listOwnedProcessTable(), { mainPid: null, installRoot: ROOT, platform: process.platform })
    report.preexistingOwnedProcessCount = existing.length
    if (existing.length > 0) throw new Error('worktree-app-already-running')

    appChild = spawn(
      executable,
      ['.', `--remote-debugging-address=${LOOPBACK_HOST}`, `--remote-debugging-port=${options.port}`],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }
    )
    appChild.stdout?.on('data', (chunk) => {
      appOutput.stdout = appendBounded(appOutput.stdout, chunk)
    })
    appChild.stderr?.on('data', (chunk) => {
      appOutput.stderr = appendBounded(appOutput.stderr, chunk)
    })
    appChild.once('error', () => {
      launchFailed = true
    })
    const firstOwnershipSnapshot = captureOwnedProcesses(ownedAtLaunch, appChild.pid)
    if (!firstOwnershipSnapshot.some((entry) => entry.pid === appChild.pid)) {
      throw new Error('electron-process-not-observed')
    }
    await waitForCdpEndpoint({
      port: options.port,
      child: appChild,
      launchFailed: () => launchFailed,
      timeoutMs: START_TIMEOUT_MS
    })
    const attachment = await attachOwnedCdp({
      endpoint: `http://${LOOPBACK_HOST}:${options.port}`,
      childPid: appChild.pid,
      timeoutMs: CDP_ATTACH_TIMEOUT_MS
    })
    if (!attachment.browser) {
      if (attachment.lateRelease && !(await attachment.lateRelease(5_000))) {
        throw new Error('cdp-late-transport-release-unverified')
      }
      throw new Error(`cdp-${attachment.failure ?? 'attach-failed'}`)
    }
    ownedBrowser = attachment.browser
    report.ownedTargetVerified = true

    connected = true
    const connect = await runCli(cliPath, session, ['connect', String(options.port)], env)
    if (connect.code !== 0) throw new Error(`agent-browser-connect-${failureClass(connect)}`)

    let snapshot
    const deadline = Date.now() + START_TIMEOUT_MS
    do {
      snapshot = await runCli(cliPath, session, ['snapshot', '-i'], env)
      if (snapshot.code === 0 && hasComposerTextbox(snapshot.stdout)) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    } while (Date.now() < deadline && appChild.exitCode === null && appChild.signalCode === null)
    if (snapshot?.code !== 0) throw new Error(`agent-browser-snapshot-${failureClass(snapshot)}`)
    report.composerVisibleInSnapshot = hasComposerTextbox(snapshot.stdout)
    if (!report.composerVisibleInSnapshot) throw new Error('composer-not-found-in-dom-snapshot')

    for (const [name, args] of [
      ['pageErrors', ['errors']],
      ['console', ['console']],
      ['networkRequests', ['network', 'requests']]
    ]) {
      const result = await runCli(cliPath, session, args, env)
      if (result.code !== 0) throw new Error(`agent-browser-${name}-${failureClass(result)}`)
      report.diagnosticCommandsSucceeded[name] = true
    }

    report.result = 'PASS'
    if (options.keepOpen) {
      leaveRunning = true
      console.log(`[agent-browser-smoke] isolated Métis session ready at ${LOOPBACK_HOST}:${options.port}; press Ctrl+C here when finished.`)
      printManualSessionInstructions({ cliPath, profilePaths: profile.paths, session })
      await waitForInterrupt()
      leaveRunning = false
    }
  } catch (error) {
    report.failure = error instanceof Error ? error.message.replace(/[^a-z0-9-]/gi, '').slice(0, 80) : 'unknown-failure'
    if (report.failure === 'cdp-endpoint-timeout' || report.failure === 'electron-exited-before-cdp-ready') {
      report.startupDiagnostic = startupDiagnostic(`${appOutput.stdout}\n${appOutput.stderr}`)
    }
  } finally {
    if (appChild?.pid && !leaveRunning) {
      try {
        captureOwnedProcesses(ownedAtLaunch, appChild.pid)
      } catch {
        // stopOwnedProcessTree records an incomplete census if it cannot refresh the ownership snapshot.
      }
    }
    if (ownedBrowser && !leaveRunning) {
      try {
        const pages = ownedBrowser.contexts().flatMap((context) => context.pages())
        const page = pages[0]
        if (page) {
          const quitRequested = await page.evaluate(() => {
            if (!window.toto || typeof window.toto.quit !== 'function') return false
            void window.toto.quit()
            return true
          })
          if (quitRequested) {
            const exited = await waitForChildExit(appChild, CHILD_STOP_TIMEOUT_MS)
            report.cleanShutdown = exited && appChild.exitCode === 0 && appChild.signalCode === null
          }
        }
      } catch {
        // The owned process tree is stopped below if its normal quit path did not complete.
      }
      await ownedBrowser.close().catch(() => {})
    }

    if (connected && !leaveRunning) {
      const close = await runCli(cliPath, session, ['close'], env, 10_000)
      // When the app's own quit path has already closed its CDP endpoint, the CLI's close may report
      // that its target is gone. That is expected cleanup, not a second smoke failure.
      if (close.code !== 0 && report.result === 'PASS' && !report.cleanShutdown) {
        report.result = 'FAIL'
        report.failure = `agent-browser-close-${failureClass(close)}`
      }
    }

    if (appChild && !leaveRunning) {
      await stopOwnedProcessTree({ child: appChild, ownedAtLaunch, report })
    }
    if (!leaveRunning) rmSync(profile.root, { recursive: true, force: true })
    if (report.result === 'PASS' && (!report.cleanShutdown || !report.ownedProcessesCleaned)) {
      report.result = 'FAIL'
      report.failure = report.cleanShutdown ? 'owned-process-cleanup-incomplete' : 'app-clean-quit-not-observed'
    }
    writeReport(options.report, report)
    console.log(`[agent-browser-smoke] ${JSON.stringify(report)}`)
  }

  if (report.result !== 'PASS') process.exitCode = 1
}

function hasComposerTextbox(snapshot) {
  return /\btextbox\b[^\n]*(?:ask métis|ask anything about)/i.test(snapshot)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failure = error instanceof Error ? error.message.replace(/[^a-z0-9-]/gi, '').slice(0, 80) : 'unknown-failure'
    console.error(`[agent-browser-smoke] setup-failed:${failure}`)
    process.exitCode = 1
  })
}
