#!/usr/bin/env node

/**
 * Run one isolated Electron development build through Vercel Agent Browser over loopback CDP.
 * This is a QA-only launcher. Remote debugging is never enabled in product startup code.
 *
 * Usage: node scripts/qa/agent-browser-smoke.mjs --port 9222 --agent-browser-package <package-dir>
 *        [--report <path>] [--keep-open]
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  return index < 0 ? null : (args[index + 1] ?? null)
}

function parseOptions(args) {
  const port = Number(argValue(args, '--port'))
  const packageDir =
    argValue(args, '--agent-browser-package') ??
    join(ROOT, 'scripts', 'qa', 'agent-browser-package', 'node_modules', 'agent-browser')
  const report = argValue(args, '--report')
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('invalid-port')
  }
  return {
    port,
    packageDir: resolve(packageDir),
    report: report ? resolve(report) : null,
    keepOpen: args.includes('--keep-open')
  }
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
  const binaryPath = resolve(dirname(cliPath), agentBrowserBinaryName(process.platform, process.arch))
  const binaryRel = relative(packageDir, binaryPath)
  if (!binaryRel || binaryRel === '..' || binaryRel.startsWith(`..${sep}`)) {
    throw new Error('agent-browser-binary-outside-package')
  }
  const binary = lstatSync(requiredFile(binaryPath, 'agent-browser-native-binary'))
  if (!binary.isFile() || binary.isSymbolicLink()) throw new Error('agent-browser-binary-not-regular-file')
  return binaryPath
}

export function agentBrowserBinaryName(platform, arch) {
  const binaries = {
    'darwin-arm64': 'agent-browser-darwin-arm64',
    'darwin-x64': 'agent-browser-darwin-x64',
    'win32-x64': 'agent-browser-win32-x64.exe'
  }
  const name = binaries[`${platform}-${arch}`]
  if (!name) throw new Error('agent-browser-platform-not-pinned')
  return name
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
    userData: join(root, 'userdata'),
    agentBrowserSocketDir: join(root, 'ab')
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
    const child = spawn(cliPath, ['--session', session, ...args], {
      cwd: ROOT,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
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
    child.once('close', (code) => {
      if (!timedOut) finish({ code, timedOut: false, stdout, stderr, failedToStart: false, cleanupComplete: true })
    })
    const timer = setTimeout(() => {
      timedOut = true
      void stopCliProcessTree(child).then((cleanupComplete) =>
        finish({ code: null, timedOut: true, stdout, stderr, failedToStart: false, cleanupComplete })
      )
    }, timeoutMs)
  })
}

export function failureClass(result) {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
  if (/no page found|no page target/.test(text)) return 'no-page-target'
  if (
    /daemon process exited during startup|daemon failed to start|failed to start daemon|failed to connect:/.test(text)
  ) {
    return 'session-daemon-failure'
  }
  const isCdpFailure = /econnrefused|failed to connect via cdp|websocket|cdp.*timeout|connection.*refused/.test(text)
  if (isCdpFailure) return 'cdp-connection'
  if (/unknown command|unexpected argument|invalid argument|usage:/.test(text)) return 'cli-usage-error'
  const isNativeBinaryFailure =
    /no binary found|unsupported platform|error executing binary|cannot make binary executable/.test(text)
  if (isNativeBinaryFailure) return 'native-binary-start-failure'
  if (/browser (?:has been |is )?closed|target closed/.test(text)) return 'browser-target-closed'
  if (/failed to launch|browser launch failed|could not launch/.test(text)) return 'browser-launch-failure'
  if (result.cleanupComplete === false) return 'process-cleanup-incomplete'
  if (result.timedOut) return 'command-timeout'
  if (result.failedToStart) return 'command-not-started'
  return 'command-failed'
}

function safeDiagnosticCodes(output) {
  const text = typeof output === 'string' ? output : ''
  const patterns = [
    /\bERR_[A-Z0-9_]+\b/gi,
    /\bE(?:ACCES|BADF|BUSY|EXIST|INVAL|ISDIR|MFILE|NOENT|NOMEM|NOTDIR|NOTEMPTY|NOTSUP|PERM|PIPE|ROFS|XDEV)\b/g,
    /\bE(?:ADDRINUSE|ADDRNOTAVAIL|CONNREFUSED|CONNRESET|NETUNREACH|TIMEDOUT)\b/g,
    /\b(?:Type|Reference|Syntax|Range|Aggregate|URI)Error\b/g,
    /\b(?:os|win32) error \d+\b/gi
  ]
  const codes = new Set()
  for (const pattern of patterns) {
    for (const [code] of text.matchAll(pattern)) {
      codes.add(code.toUpperCase())
      if (codes.size === 8) return [...codes]
    }
  }
  return [...codes]
}

function safeDiagnosticHints(output) {
  const text = typeof output === 'string' ? output.toLowerCase() : ''
  const hints = [
    ['daemon', /\bdaemon\b/],
    ['cdp', /\bcdp\b/],
    ['websocket', /web\s?socket/],
    ['connection', /connect(?:ion)?/],
    ['socket', /\bsocket\b/],
    ['browser', /\bbrowser\b/],
    ['page-target', /\b(?:page|target|tab)\b/],
    ['timeout', /\b(?:timeout|timed out)\b/],
    ['permission', /\b(?:permission|denied)\b/],
    ['module', /\b(?:module|package|import)\b/],
    ['configuration', /\b(?:config|configuration|option)\b/],
    ['protocol', /\bprotocol\b/],
    ['not-found', /\b(?:not found|missing|does not exist)\b/],
    ['closed', /\b(?:closed|exited)\b/],
    ['invalid-input', /\b(?:parse|invalid|malformed)\b/],
    ['panic', /\bpanic\b/]
  ]
  return hints.filter(([, pattern]) => pattern.test(text)).map(([hint]) => hint)
}

function safeStartupTerms(output) {
  const allowlist = new Set([
    'a',
    'absolute',
    'access',
    'after',
    'an',
    'and',
    'app',
    'application',
    'asar',
    'at',
    'binary',
    'be',
    'because',
    'cannot',
    'check',
    'could',
    'create',
    'crash',
    'determine',
    'did',
    'directory',
    'does',
    'during',
    'exists',
    'electron',
    'error',
    'exception',
    'failed',
    'fatal',
    'file',
    'find',
    'found',
    'from',
    'function',
    'get',
    'has',
    'in',
    'import',
    'is',
    'initialize',
    'invalid',
    'load',
    'loaded',
    'loading',
    'main',
    'missing',
    'module',
    'native',
    'node',
    'null',
    'not',
    'normalize',
    'of',
    'open',
    'package',
    'path',
    'preload',
    'properties',
    'property',
    'process',
    'read',
    'reference',
    'resolve',
    'renderer',
    'require',
    'script',
    'set',
    'the',
    'temporary',
    'this',
    'to',
    'threw',
    'specified',
    'syntax',
    'type',
    'unable',
    'startup',
    'undefined',
    'validate',
    'was',
    'while',
    'with',
    'write'
  ])
  const prelude = []
  for (const line of (typeof output === 'string' ? output : '').split(/\r?\n/)) {
    if (/^\s*at\s/.test(line) || prelude.length >= 6) break
    prelude.push(line)
  }
  const terms = []
  for (const match of prelude
    .join('\n')
    .toLowerCase()
    .matchAll(/[a-z]+/g)) {
    if (allowlist.has(match[0])) terms.push(match[0])
    if (terms.length === 32) break
  }
  return terms
}

function safeStartupModuleNames(output, knownModules) {
  const specifier = safeMissingModuleSpecifier(output)
  if (!specifier) return []
  return knownModules
    .filter((name) => typeof name === 'string' && name && (specifier === name || specifier.startsWith(`${name}/`)))
    .slice(0, 8)
}

function safeStartupModuleKind(output, knownModules) {
  const specifier = safeMissingModuleSpecifier(output)
  if (!specifier) return 'other-startup-error'
  if (safeStartupModuleNames(output, knownModules).length > 0) return 'declared-dependency'
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(specifier)) return 'absolute-app-path'
  if (specifier.startsWith('.')) return 'relative-app-module'
  if (specifier.startsWith('node:')) return 'node-builtin'
  return 'undeclared-package'
}

function safeStartupErrorKind(output) {
  const text = typeof output === 'string' ? output.toLowerCase() : ''
  if (/cacheddatarejected|invalid or incompatible cached data/.test(text)) return 'incompatible-bytecode'
  if (/err_dlopen_failed|failed to load.*\.node|could not load.*dll|module could not be found/.test(text)) {
    return 'native-runtime-load-failure'
  }
  if (/cannot find module|cannot find package|err_module_not_found|module_not_found/.test(text)) {
    return 'module-resolution-failure'
  }
  if (/app threw an error during load/.test(text)) return 'main-process-exception'
  if (/\bsyntaxerror\b/.test(text)) return 'javascript-syntax-error'
  if (/\breferenceerror\b/.test(text)) return 'javascript-reference-error'
  if (/\btypeerror\b/.test(text)) return 'javascript-type-error'
  return 'other-startup-error'
}

function safeStartupSourceFrames(output, knownModules, projectRoot = ROOT) {
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const rootPrefix = `${root.toLowerCase()}/`
  const known = new Set(knownModules)
  const frames = []
  for (const line of (typeof output === 'string' ? output : '').split(/\r?\n/)) {
    const file = line.match(/\((.+):\d+:\d+\)\s*$/)?.[1]
    if (!file) continue
    const normalized = file.replace(/\\/g, '/')
    if (!normalized.toLowerCase().startsWith(rootPrefix)) continue
    const relativePath = normalized.slice(rootPrefix.length)
    if (/^(?:out|src)\/main\/.+\.(?:c?js|mjs|jsc|ts)$/i.test(relativePath)) frames.push(relativePath)
    const packageName = relativePath.match(/^node_modules\/(?:(@[^/]+\/[^/]+)|([^/]+))\//)
    const moduleName = packageName?.[1] ?? packageName?.[2]
    if (moduleName && known.has(moduleName)) frames.push(moduleName)
    if (frames.length >= 5) break
  }
  return [...new Set(frames)]
}

function safeMissingModuleSpecifier(output) {
  const prelude = []
  for (const line of (typeof output === 'string' ? output : '').split(/\r?\n/)) {
    if (/^\s*at\s/.test(line) || prelude.length >= 6) break
    prelude.push(line)
  }
  return prelude.join('\n').match(/Cannot find (?:module|package)\s+['"]([^'"]+)['"]/i)?.[1] ?? null
}

export function safeCommandEvidence(result, args) {
  const operation = ['snapshot', 'errors', 'console', 'network', 'close'].includes(args[0]) ? args[0] : 'other'
  return {
    operation,
    exitCode: Number.isInteger(result.code) ? result.code : null,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
    stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    diagnosticCodes: safeDiagnosticCodes(result.stderr ?? ''),
    diagnosticHints: safeDiagnosticHints(result.stderr ?? ''),
    timedOut: Boolean(result.timedOut),
    cleanupComplete: result.cleanupComplete !== false
  }
}

export function safeStartupEvidence(output, child, knownModules = [], projectRoot = ROOT) {
  return {
    exitCode: Number.isInteger(child?.exitCode) ? child.exitCode : null,
    signal: typeof child?.signalCode === 'string' ? child.signalCode : null,
    stdoutBytes: Buffer.byteLength(output.stdout ?? ''),
    stderrBytes: Buffer.byteLength(output.stderr ?? ''),
    diagnosticCodes: safeDiagnosticCodes(output.stderr ?? ''),
    diagnosticHints: safeDiagnosticHints(output.stderr ?? ''),
    diagnosticTerms: safeStartupTerms(output.stderr ?? ''),
    diagnosticModules: safeStartupModuleNames(output.stderr ?? '', knownModules),
    diagnosticModuleKind: safeStartupModuleKind(output.stderr ?? '', knownModules),
    diagnosticErrorKind: safeStartupErrorKind(output.stderr ?? ''),
    diagnosticSourceFrames: safeStartupSourceFrames(output.stderr ?? '', knownModules, projectRoot)
  }
}

async function stopCliProcessTree(child) {
  if (!child?.pid || child.pid <= 1) return childHasExited(child)

  let signalAccepted = false
  if (process.platform === 'win32') {
    const windowsRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
    try {
      execFileSync(join(windowsRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 3_000,
        windowsHide: true
      })
      signalAccepted = true
    } catch {
      // A failed tree kill is not treated as cleanup success, even if the wrapper itself exits.
    }
  } else {
    try {
      // CLI wrapper and native executable share the isolated process group created by detached spawn.
      process.kill(-child.pid, 'SIGKILL')
      signalAccepted = true
    } catch (error) {
      signalAccepted = error?.code === 'ESRCH'
    }
  }

  await waitForChildExit(child, 3_000).catch(() => {})
  if (!signalAccepted || !childHasExited(child)) return false
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 0)
      return false
    } catch (error) {
      return error?.code === 'ESRCH'
    }
  }
  return true
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

function printManualSessionInstructions({ cliPath, profilePaths, session, cdpWebSocketUrl }) {
  const paths = {
    HOME: profilePaths.home,
    USERPROFILE: profilePaths.userProfile,
    APPDATA: profilePaths.appData,
    LOCALAPPDATA: profilePaths.localAppData,
    AGENT_BROWSER_SOCKET_DIR: profilePaths.agentBrowserSocketDir,
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
  const command =
    process.platform === 'win32'
      ? `& ${shellQuote(cliPath, process.platform)}`
      : shellQuote(cliPath, process.platform)
  const commandPrefix = [command, '--session', shellQuote(session, process.platform)].join(' ')
  console.log(
    '[agent-browser-smoke] In a second shell in this worktree, paste the following to share this isolated session:'
  )
  const connectCommand = `${commandPrefix} connect ${shellQuote(cdpWebSocketUrl, process.platform)}`
  console.log([...assignments, connectCommand, `${commandPrefix} snapshot -i`].join('\n'))
  console.log(
    `[agent-browser-smoke] Then use the same command prefix with console, errors, or network requests. ` +
      `Session ${session} is isolated to this worktree and will be deleted when this launcher stops.`
  )
}

export function loopbackDebuggerWebSocket(value, port) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('cdp-websocket-url-invalid')
  }
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== LOOPBACK_HOST ||
    url.port !== String(port) ||
    !/^\/devtools\/browser\/[^/]+$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('cdp-websocket-url-not-loopback')
  }
  return url.href
}

export function electronLaunchArgs(port, appPath) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('invalid-port')
  }
  if (typeof appPath !== 'string' || !appPath) throw new Error('electron-app-path-invalid')
  // Electron treats the first positional argument as the app path. Keep Chromium switches ahead
  // of it so both Windows and macOS parse the debugging options as Electron switches. An absolute
  // target also avoids current-directory interpretation differences across hosted runners.
  return [`--remote-debugging-address=${LOOPBACK_HOST}`, `--remote-debugging-port=${port}`, appPath]
}

async function waitForCdpEndpoint({ port, child, launchFailed, timeoutMs }) {
  const endpoint = `http://${LOOPBACK_HOST}:${port}/json/version`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (launchFailed() || childHasExited(child)) throw new Error('electron-exited-before-cdp-ready')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_000)
    let response = null
    try {
      response = await fetch(endpoint, { signal: controller.signal, redirect: 'error' })
    } catch {
      // The app has not opened its loopback endpoint yet. Recheck the owned child before retrying.
    } finally {
      clearTimeout(timer)
    }
    if (response?.ok) {
      const discovery = await response.json().catch(() => null)
      if (!discovery) throw new Error('cdp-discovery-response-invalid')
      return loopbackDebuggerWebSocket(discovery.webSocketDebuggerUrl, port)
    }
    await response?.body?.cancel()
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
  if (/cannot find module|err_module_not_found|module_not_found/.test(text)) return 'module-resolution-failure'
  if (/not a valid win32 application|bad cpu type|image not found/.test(text)) return 'runtime-load-failure'
  if (/eacces|eperm|access is denied|permission denied/.test(text)) return 'startup-permission-failure'
  if (/eexist|profile.*in use|user data directory.*already in use/.test(text)) return 'profile-initialization-failure'
  if (/err_dlopen_failed|failed to load.*\.node|could not load.*dll|module could not be found/.test(text)) {
    return 'native-module-load-failure'
  }
  if (/uncaught exception|unhandled exception/.test(text)) return 'uncaught-startup-exception'
  if (/failed to load.*(?:electron|app)|cannot load.*(?:electron|app)/.test(text)) return 'app-entry-load-failure'
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
  if (!report.failure)
    report.failure = remaining.length > 0 ? 'owned-process-cleanup-incomplete' : 'process-census-unavailable'
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('unsupported-host')
  const cliPath = packageCli(options.packageDir)
  const executable = electronExecutable()
  const appManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const appVersion = appManifest.version
  const knownModules = [
    ...Object.keys(appManifest.dependencies ?? {}),
    ...Object.keys(appManifest.optionalDependencies ?? {}),
    ...Object.keys(appManifest.devDependencies ?? {})
  ]
  const appMainPath = typeof appManifest.main === 'string' ? resolve(ROOT, appManifest.main) : null
  const appMainRelative = appMainPath ? relative(ROOT, appMainPath) : null
  const appMainInsideWorktree =
    appMainRelative !== null &&
    appMainRelative !== '..' &&
    !appMainRelative.startsWith(`..${sep}`) &&
    !isAbsolute(appMainRelative)
  const appEntry = {
    mainConfigured: typeof appManifest.main === 'string' && appManifest.main.length > 0,
    mainInsideWorktree: appMainInsideWorktree,
    mainEntryExists: appMainInsideWorktree && existsSync(appMainPath)
  }
  const profile = makeIsolatedProfile()
  const env = strictLaunchEnvironment(process.env, profile.paths)
  if (process.env.METIS_QA_STARTUP_SOURCEMAP === '1') env.NODE_OPTIONS = '--enable-source-maps'
  const session = `metis-worktree-${options.port}`
  const report = {
    schemaVersion: 1,
    result: 'FAIL',
    appVersion,
    agentBrowserVersion: AGENT_BROWSER_VERSION,
    platform: process.platform,
    cdpHost: LOOPBACK_HOST,
    cdpPort: options.port,
    appEntry,
    ownedTargetVerified: false,
    composerVisibleInSnapshot: false,
    diagnosticCommandsSucceeded: { pageErrors: false, console: false, networkRequests: false },
    cleanShutdown: false,
    ownedProcessesCleaned: false,
    agentBrowserProcessesCleaned: true,
    preexistingOwnedProcessCount: 0,
    agentBrowserDiagnostic: null,
    agentBrowserCommandEvidence: null,
    agentBrowserCleanupDiagnostic: null,
    agentBrowserCleanupEvidence: null,
    startupDiagnostic: null,
    startupEvidence: null,
    failure: null
  }

  let appChild = null
  let appOutput = { stdout: '', stderr: '' }
  let ownedBrowser = null
  let connected = false
  let leaveRunning = false
  let cdpWebSocketUrl = null
  let agentBrowserCloseFailure = null
  const ownedAtLaunch = new Map()
  let launchFailed = false
  const runAgentBrowser = async (args, timeoutMs = COMMAND_TIMEOUT_MS, recordFailure = true) => {
    const agentBrowserEnv = { ...env, AGENT_BROWSER_SOCKET_DIR: profile.paths.agentBrowserSocketDir }
    const result = await runCli(
      cliPath,
      session,
      ['--debug', ...args],
      agentBrowserEnv,
      timeoutMs
    )
    if (result.cleanupComplete === false) report.agentBrowserProcessesCleaned = false
    if (recordFailure && result.code !== 0) {
      report.agentBrowserDiagnostic = failureClass(result)
      report.agentBrowserCommandEvidence = safeCommandEvidence(result, args)
    }
    return result
  }
  try {
    if (!appEntry.mainEntryExists) throw new Error('electron-main-entry-unavailable')
    const existing = ownedProcesses(listOwnedProcessTable(), {
      mainPid: null,
      installRoot: ROOT,
      platform: process.platform
    })
    report.preexistingOwnedProcessCount = existing.length
    if (existing.length > 0) throw new Error('worktree-app-already-running')

    appChild = spawn(executable, electronLaunchArgs(options.port, ROOT), {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
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
    cdpWebSocketUrl = await waitForCdpEndpoint({
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

    const connection = await runAgentBrowser(['connect', cdpWebSocketUrl])
    if (connection.code !== 0) throw new Error(`agent-browser-connect-${failureClass(connection)}`)
    connected = true

    let snapshot
    const deadline = Date.now() + START_TIMEOUT_MS
    do {
      snapshot = await runAgentBrowser(['snapshot', '-i'])
      if (snapshot.code !== 0) throw new Error(`agent-browser-snapshot-${failureClass(snapshot)}`)
      if (hasComposerTextbox(snapshot.stdout)) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    } while (Date.now() < deadline && appChild.exitCode === null && appChild.signalCode === null)
    report.composerVisibleInSnapshot = hasComposerTextbox(snapshot.stdout)
    if (!report.composerVisibleInSnapshot) throw new Error('composer-not-found-in-dom-snapshot')

    for (const [name, args] of [
      ['pageErrors', ['errors']],
      ['console', ['console']],
      ['networkRequests', ['network', 'requests']]
    ]) {
      const result = await runAgentBrowser(args)
      if (result.code !== 0) throw new Error(`agent-browser-${name}-${failureClass(result)}`)
      report.diagnosticCommandsSucceeded[name] = true
    }

    report.result = 'PASS'
    if (options.keepOpen) {
      leaveRunning = true
      console.log(
        `[agent-browser-smoke] isolated Métis session ready at ${LOOPBACK_HOST}:${options.port}; press Ctrl+C here when finished.`
      )
      printManualSessionInstructions({ cliPath, profilePaths: profile.paths, session, cdpWebSocketUrl })
      await waitForInterrupt()
      leaveRunning = false
    }
  } catch (error) {
    report.failure = error instanceof Error ? error.message.replace(/[^a-z0-9-]/gi, '').slice(0, 80) : 'unknown-failure'
    if (report.failure === 'cdp-endpoint-timeout' || report.failure === 'electron-exited-before-cdp-ready') {
      report.startupDiagnostic = startupDiagnostic(`${appOutput.stdout}\n${appOutput.stderr}`)
      report.startupEvidence = safeStartupEvidence(appOutput, appChild, knownModules)
    }
  } finally {
    if (appChild?.pid && !leaveRunning) {
      try {
        captureOwnedProcesses(ownedAtLaunch, appChild.pid)
      } catch {
        // stopOwnedProcessTree records an incomplete census if it cannot refresh the ownership snapshot.
      }
    }
    if (connected && !leaveRunning) {
      const close = await runAgentBrowser(['close'], 10_000, false)
      if (close.code !== 0) {
        report.agentBrowserProcessesCleaned = false
        agentBrowserCloseFailure = failureClass(close)
        report.agentBrowserCleanupDiagnostic = agentBrowserCloseFailure
        report.agentBrowserCleanupEvidence = safeCommandEvidence(close, ['close'])
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

    if (appChild && !leaveRunning) {
      await stopOwnedProcessTree({ child: appChild, ownedAtLaunch, report })
    }
    if (!leaveRunning) rmSync(profile.root, { recursive: true, force: true })
    if (report.result === 'PASS' && agentBrowserCloseFailure) {
      report.result = 'FAIL'
      report.failure = `agent-browser-close-${agentBrowserCloseFailure}`
    }
    if (
      report.result === 'PASS' &&
      (!report.cleanShutdown || !report.ownedProcessesCleaned || !report.agentBrowserProcessesCleaned)
    ) {
      report.result = 'FAIL'
      report.failure = !report.cleanShutdown
        ? 'app-clean-quit-not-observed'
        : !report.agentBrowserProcessesCleaned
          ? 'agent-browser-process-cleanup-incomplete'
          : 'owned-process-cleanup-incomplete'
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
