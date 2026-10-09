#!/usr/bin/env node
// Support-only, exact QA-identity bytes on a clean hosted Mac. Never owner isolation, shipping-byte
// qualification or performance evidence. Importing this module starts no process, server or transport.
import { spawn } from 'node:child_process'
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isStrictSemver } from './fresh-onboarding-baseline.mjs'
import { strictLaunchEnvironment } from './lib/app-driver.mjs'
import { normalizeTeardown, stopOwnedChild } from './lib/st-1-termination.mjs'
import { sha256File } from './provenance.mjs'

export const TLS_SCENARIO = 'hosted-startup-tls'
export const TLS_REPORT = 'hosted-startup-tls.json'
export const TLS_ROWS = Object.freeze([
  'candidate-bound',
  'fixture-health',
  'profile-runtime',
  'renderer-ready-survival',
  'loopback-http',
  'public-https',
  'untrusted-certificate',
  'redirect-denied',
  'header-deadline',
  'body-abort',
  'non-200-denied',
  'audit-final-drain',
  'owned-cleanup'
])
export const TLS_RESIDUALS = Object.freeze({
  owner_admission: 'DISABLED_ARCHITECTURAL_HOLD',
  owner_isolation: 'NOT_PROVEN_HARD_ALIAS_BYPASS_OPEN',
  broker_denial: 'NOT_OBSERVED_DEFAULT_HOSTED_LAUNCH',
  personal_device_performance: 'NOT_MEASURED',
  real_cloud_dataless: 'NOT_RUN_ON_HOSTED',
  shipping_dmg_exe_native_runtime: 'NOT_COVERED',
  onboarding_feature_portal: 'NOT_COVERED',
  public_socket_closure: 'NOT_OBSERVED'
})
const ID_KEYS = ['candidate_run', 'producer_commit', 'installer_sha256', 'version', 'harness_commit', 'platform']
const HASH40 = /^[0-9a-f]{40}$/
const HASH64 = /^[0-9a-f]{64}$/
const ELECTRON = '43.6.0'
const TOOL = '/opt/homebrew/opt/openssl@3/bin/openssl'
const TOOL_REAL = '/opt/homebrew/Cellar/openssl@3/3.6.4/bin/openssl'
const IMAGE = '20260907.0351.1'
const TOOL_VERSION = 'OpenSSL 3.6.4 25 Aug 2026 (Library: OpenSSL 3.6.4 25 Aug 2026)\n'
const TOTAL_MS = 210_000
const RESERVE_MS = 10_000
const FAILURES = new Set([
  'none',
  'invalid-context',
  'candidate-rejected',
  'app-rejected',
  'fixture-tool-precondition',
  'fixture-tool-failed',
  'fixture-tool-cleanup-unacknowledged',
  'fixture-failed',
  'profile-rejected',
  'launch-failed',
  'inspector-failed',
  'runtime-rejected',
  'readiness-failed',
  'audit-failed',
  'network-failed',
  'deadline',
  'cleanup-unacknowledged',
  'output-rejected',
  'harness-failed'
])
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) =>
  plain(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
const fail = (code) => {
  throw new Error(FAILURES.has(code) ? code : 'harness-failed')
}
const finiteFailure = (error) => (FAILURES.has(error?.message) ? error.message : 'harness-failed')
const positive = (value) => Number.isSafeInteger(value) && value > 0
const within = (root, path) => {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}
const identityValid = (identity) =>
  exact(identity, ID_KEYS) &&
  positive(identity.candidate_run) &&
  HASH40.test(identity.producer_commit) &&
  HASH64.test(identity.installer_sha256) &&
  typeof identity.version === 'string' &&
  identity.version.length <= 64 &&
  isStrictSemver(identity.version) &&
  HASH40.test(identity.harness_commit) &&
  identity.platform === 'darwin'

export function bindHostedTlsCandidate(provenance, context) {
  if (
    !plain(provenance) ||
    provenance.schema !== 1 ||
    provenance.repository !== 'mysticalsin/AskToto-Mantu' ||
    provenance.run?.id !== context.candidateRun ||
    provenance.commit !== context.producerCommit ||
    !Array.isArray(provenance.builds)
  ) {
    fail('candidate-rejected')
  }
  const builds = provenance.builds.filter((item) => item?.variant === 'mac-qa-identity')
  const build = builds[0]
  const name = `Metis-QA-${provenance.version}.zip`
  const all = provenance.builds.flatMap((item) => (Array.isArray(item?.assets) ? item.assets : []))
  if (
    builds.length !== 1 ||
    build.artifact !== 'candidate-mac-qa-identity' ||
    build.electron !== ELECTRON ||
    !Array.isArray(build.assets) ||
    build.assets.length !== 1 ||
    build.assets[0]?.name !== name ||
    build.assets[0]?.sha256 !== context.sha256 ||
    !positive(build.assets[0]?.size) ||
    basename(context.installer) !== name ||
    all.filter((asset) => asset?.name === name).length !== 1
  ) {
    fail('candidate-rejected')
  }
  const identity = {
    candidate_run: context.candidateRun,
    producer_commit: context.producerCommit,
    installer_sha256: context.sha256,
    version: provenance.version,
    harness_commit: context.harnessCommit,
    platform: 'darwin'
  }
  if (!identityValid(identity)) fail('invalid-context')
  return identity
}

export function createHostedTlsReport(identity) {
  return {
    schema: 'metis.hosted-startup-tls.v1',
    support_only: true,
    identity,
    outcome: 'PRECONDITION',
    failure: 'invalid-context',
    launch: 'direct-owned-inspector-only',
    rows: TLS_ROWS.map((id) => ({ id, status: 'NOT_RUN' })),
    teardown: 'NOT_ATTEMPTED',
    cleanup: 'NOT_CREATED',
    tool: null,
    residuals: { ...TLS_RESIDUALS }
  }
}

export function hostedTlsReportProblems(report) {
  try {
    if (
      !exact(report, [
        'schema',
        'support_only',
        'identity',
        'outcome',
        'failure',
        'launch',
        'rows',
        'teardown',
        'cleanup',
        'tool',
        'residuals'
      ]) ||
      report.schema !== 'metis.hosted-startup-tls.v1' ||
      report.support_only !== true ||
      !identityValid(report.identity) ||
      !['PASS', 'FAIL', 'PRECONDITION'].includes(report.outcome) ||
      !FAILURES.has(report.failure) ||
      report.launch !== 'direct-owned-inspector-only' ||
      !['NOT_ATTEMPTED', 'ACKNOWLEDGED', 'UNACKNOWLEDGED'].includes(report.teardown) ||
      !['NOT_CREATED', 'REMOVED', 'RETAINED'].includes(report.cleanup) ||
      !exact(report.residuals, Object.keys(TLS_RESIDUALS)) ||
      Object.entries(TLS_RESIDUALS).some(([key, value]) => report.residuals[key] !== value) ||
      !Array.isArray(report.rows) ||
      report.rows.length !== TLS_ROWS.length ||
      report.rows.some(
        (row, index) =>
          !exact(row, ['id', 'status']) ||
          row.id !== TLS_ROWS[index] ||
          !['PASS', 'FAIL', 'NOT_RUN'].includes(row.status)
      )
    ) {
      return ['report-schema-invalid']
    }
    if (
      report.tool !== null &&
      (!exact(report.tool, ['sha256', 'version', 'image', 'arch']) ||
        !HASH64.test(report.tool.sha256) ||
        report.tool.version !== '3.6.4' ||
        report.tool.image !== IMAGE ||
        report.tool.arch !== 'arm64')
    ) {
      return ['report-tool-invalid']
    }
    if (
      report.outcome === 'PASS' &&
      (report.failure !== 'none' ||
        report.teardown !== 'ACKNOWLEDGED' ||
        report.cleanup !== 'REMOVED' ||
        report.rows.some((row) => row.status !== 'PASS') ||
        !report.tool)
    ) {
      return ['report-pass-invalid']
    }
    if (report.outcome !== 'PASS' && report.failure === 'none') return ['report-failure-invalid']
    if (
      (report.teardown === 'UNACKNOWLEDGED' && report.cleanup === 'REMOVED') ||
      (report.outcome === 'PRECONDITION' && report.teardown !== 'NOT_ATTEMPTED') ||
      (report.tool !== null && report.cleanup === 'NOT_CREATED') ||
      (report.rows.some((row) => ['audit-final-drain', 'owned-cleanup'].includes(row.id) && row.status === 'PASS') &&
        report.teardown !== 'ACKNOWLEDGED') ||
      (report.rows.find((row) => row.id === 'owned-cleanup').status === 'PASS' && report.cleanup !== 'REMOVED')
    ) {
      return ['report-cleanup-invalid']
    }
    return []
  } catch {
    return ['report-schema-invalid']
  }
}

export function assessHostedTlsReport(report, expected) {
  const problems = hostedTlsReportProblems(report)
  if (problems.length) return problems
  if (!identityValid(expected) || ID_KEYS.some((key) => report.identity[key] !== expected[key])) {
    return ['report-binding-invalid']
  }
  return []
}

/** Complete records only. Snapshots must retain every previously observed byte. */
export function createAuditParser() {
  let previous = Buffer.alloc(0)
  let consumed = 0
  let ready = false
  let broken = false
  const reject = () => {
    broken = true
    fail('audit-failed')
  }
  return {
    get ready() {
      return ready && !broken
    },
    accept(bytes) {
      if (
        broken ||
        !Buffer.isBuffer(bytes) ||
        bytes.length > 1_048_576 ||
        bytes.length < previous.length ||
        !bytes.subarray(0, previous.length).equals(previous)
      ) {
        reject()
      }
      previous = Buffer.from(bytes)
      for (;;) {
        const end = bytes.indexOf(10, consumed)
        if (end < 0) break
        if (end - consumed > 65_536) reject()
        let record
        try {
          record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(consumed, end)))
        } catch {
          reject()
        }
        consumed = end + 1
        if (!plain(record) || typeof record.event !== 'string') reject()
        if (record.event === 'app.crash' || record.event === 'app.unresponsive') reject()
        if (record.event === 'app.renderer.ready') ready = true
      }
      if (bytes.length - consumed > 65_536) reject()
      return ready
    },
    finish() {
      if (broken || consumed !== previous.length) reject()
      return ready
    }
  }
}

function safePath(root, path, kind = 'file', max = Number.MAX_SAFE_INTEGER) {
  const absolute = resolve(path)
  if (!within(root, absolute)) fail('app-rejected')
  let current = absolute
  for (;;) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) fail('app-rejected')
    if (current === absolute) {
      if (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 || stat.size > max : !stat.isDirectory()) {
        fail('app-rejected')
      }
    } else if (!stat.isDirectory()) fail('app-rejected')
    if (current === root) break
    current = dirname(current)
  }
  if (realpathSync(absolute) !== absolute) fail('app-rejected')
  return lstatSync(absolute)
}

export function createAuditMonitor(userData) {
  const root = realpathSync(userData)
  const dir = join(root, 'logs')
  const path = join(dir, 'audit.log')
  const parser = createAuditParser()
  let descriptor = null
  let identity = null
  let appeared = false
  return {
    read(final = false) {
      try {
        let stat
        try {
          stat = lstatSync(path)
        } catch (error) {
          if (!appeared && error?.code === 'ENOENT' && !final) return false
          throw error
        }
        safePath(root, path, 'file', 1_048_576)
        if (readdirSync(dir).some((name) => /^audit-\d+\.log$/.test(name))) fail('audit-failed')
        if (descriptor === null) {
          descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          identity = { dev: stat.dev, ino: stat.ino }
          appeared = true
        }
        const opened = fstatSync(descriptor)
        if (
          stat.dev !== identity.dev ||
          stat.ino !== identity.ino ||
          opened.dev !== identity.dev ||
          opened.ino !== identity.ino ||
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.size > 1_048_576
        ) {
          fail('audit-failed')
        }
        const bytes = Buffer.alloc(opened.size)
        let offset = 0
        while (offset < bytes.length) {
          const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
          if (!count) fail('audit-failed')
          offset += count
        }
        const latest = lstatSync(path)
        if (
          latest.dev !== identity.dev || latest.ino !== identity.ino || latest.nlink !== 1 || latest.size < bytes.length
        ) {
          fail('audit-failed')
        }
        parser.accept(bytes)
        if (final) parser.finish()
        return parser.ready
      } catch {
        fail('audit-failed')
      }
    },
    close() {
      if (descriptor !== null) {
        const owned = descriptor
        descriptor = null
        closeSync(owned)
      }
    }
  }
}

export function createEndpointLatch() {
  let bytes = 0
  let pending = ''
  let endpoint = null
  return {
    get endpoint() {
      return endpoint
    },
    accept(chunk) {
      bytes += chunk.length
      if (bytes > 65_536) fail('inspector-failed')
      pending += Buffer.from(chunk).toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('Debugger listening on ')) continue
        const value = line.slice('Debugger listening on '.length).trim()
        if (
          endpoint ||
          !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) ||
          Number(new URL(value).port) > 65_535
        ) {
          fail('inspector-failed')
        }
        endpoint = value
      }
    }
  }
}

export function fixtureToolArguments(mode) {
  if (mode === 'version') return ['version']
  if (mode !== 'generate') fail('fixture-tool-failed')
  return [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-noenc',
    '-days',
    '1',
    '-batch',
    '-config',
    'fixture.cnf',
    '-extensions',
    'fixture_server',
    '-keyout',
    'fixture-key.pem',
    '-out',
    'fixture-cert.pem'
  ]
}

function ownedChild(file, args, options, spawnImpl = spawn) {
  const state = { child: null, error: false, exited: false, closed: false, requestedStop: false }
  try {
    state.child = spawnImpl(file, args, options)
    state.child.once('error', () => {
      state.error = true
    })
    state.child.once('exit', () => {
      state.exited = true
    })
    state.child.once('close', () => {
      state.closed = true
    })
  } catch {
    state.error = true
  }
  return state
}

async function until(check, deadline, inspect = () => {}) {
  while (performance.now() < deadline) {
    inspect()
    if (check()) return true
    await sleep(Math.min(25, Math.max(1, deadline - performance.now())))
  }
  return false
}

async function stopState(state, deadline, stop = stopOwnedChild) {
  state.requestedStop = true
  let receipt
  try {
    receipt = normalizeTeardown(
      await stop(state.child, {
        platform: 'darwin',
        timeoutMs: Math.min(5_000, Math.max(0, deadline - performance.now()))
      })
    )
  } catch {
    return false
  }
  if (receipt.state !== 'acknowledged') return false
  return until(() => state.exited && state.closed, deadline)
}

/** A fixed tool invocation. Raw version output is returned privately, never as an error or report.
 * @param {'version' | 'generate'} mode
 * @param {{ cwd: string, env: Record<string, string>, deadline: number,
 *   spawn?: (file: string, args: string[], options: any) => any,
 *   stop?: (child: any, options: any) => Promise<any> }} options */
export async function runFixtureTool(mode, { cwd, env, deadline, spawn: spawnImpl = spawn, stop = stopOwnedChild }) {
  if (deadline - performance.now() <= RESERVE_MS) return { ok: false, cleanup: true, output: '' }
  const state = ownedChild(
    TOOL,
    fixtureToolArguments(mode),
    {
      shell: false,
      detached: true,
      cwd,
      env,
      stdio: mode === 'version' ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'ignore', 'ignore']
    },
    spawnImpl
  )
  const chunks = []
  let size = 0
  let overflow = false
  if (mode === 'version' && state.child?.stdout) {
    state.child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 4096) overflow = true
      else chunks.push(Buffer.from(chunk))
    })
    state.child.stdout.once('error', () => {
      state.error = true
    })
  }
  const operatingDeadline = Math.min(deadline - RESERVE_MS, performance.now() + 10_000)
  const settled = await until(() => state.error || overflow || (state.exited && state.closed), operatingDeadline)
  const ok = settled && !state.error && !overflow && state.child?.exitCode === 0 && state.child?.signalCode == null
  const cleanup = await stopState(state, Math.min(deadline, performance.now() + RESERVE_MS), stop)
  return {
    ok: ok && cleanup,
    cleanup,
    output: ok && cleanup && mode === 'version' ? Buffer.concat(chunks).toString('utf8') : ''
  }
}

const CONFIG =
  '[req]\nprompt = no\ndistinguished_name = fixture_subject\nx509_extensions = fixture_server\n' +
  '[fixture_subject]\nCN = Metis hosted TLS fixture\n[fixture_server]\nbasicConstraints = critical,CA:FALSE\n' +
  'keyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = IP:127.0.0.1\n'

async function certificate(paths, deadline, report, state) {
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    process.env.METIS_TLS_IMAGE_VERSION !== IMAGE ||
    realpathSync(TOOL) !== TOOL_REAL
  ) {
    fail('fixture-tool-precondition')
  }
  const stat = lstatSync(TOOL_REAL)
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) fail('fixture-tool-precondition')
  writeFileSync(join(paths.fixture, 'fixture.cnf'), CONFIG, { flag: 'wx', mode: 0o600 })
  const env = {
    HOME: paths.home,
    TMPDIR: paths.temp,
    TMP: paths.temp,
    TEMP: paths.temp,
    LANG: 'C',
    LC_ALL: 'C',
    OPENSSL_CONF: join(paths.fixture, 'fixture.cnf')
  }
  for (const mode of ['version', 'generate']) {
    const result = await runFixtureTool(mode, { cwd: paths.fixture, env, deadline })
    if (!result.cleanup) {
      state.safe = false
      fail('fixture-tool-cleanup-unacknowledged')
    }
    if (!result.ok) fail('fixture-tool-failed')
    if (mode === 'version' && result.output !== TOOL_VERSION) {
      fail('fixture-tool-precondition')
    }
  }
  report.tool = { sha256: await sha256File(TOOL_REAL), version: '3.6.4', image: IMAGE, arch: 'arm64' }
  const keyPath = join(paths.fixture, 'fixture-key.pem')
  const certPath = join(paths.fixture, 'fixture-cert.pem')
  if ((safePath(paths.root, keyPath, 'file', 65_536).mode & 0o777) !== 0o600) fail('fixture-failed')
  safePath(paths.root, certPath, 'file', 65_536)
  const key = readFileSync(keyPath)
  const cert = readFileSync(certPath)
  const x509 = new X509Certificate(cert)
  const privateKey = createPrivateKey(key)
  const publicKey = createPublicKey(privateKey)
  if (
    !x509.checkPrivateKey(privateKey) ||
    !x509.verify(x509.publicKey) ||
    x509.checkIP('127.0.0.1') !== '127.0.0.1' ||
    x509.ca ||
    publicKey.asymmetricKeyType !== 'rsa' ||
    publicKey.asymmetricKeyDetails?.modulusLength !== 2048 ||
    Date.parse(x509.validFrom) > Date.now() ||
    Date.parse(x509.validTo) <= Date.now()
  ) {
    fail('fixture-failed')
  }
  return { key, cert }
}

/** Embedded unchanged; only closed literals leave the candidate. No response content or raw exception. */
export async function candidateOperation(expected, operation, ports, budgetMs) {
  if (process.pid !== expected.pid) return { code: 'owner-mismatch' }
  const load = process.mainModule?.require?.bind(process.mainModule)
  if (typeof load !== 'function') return { code: 'loader-unavailable' }
  try {
    const { app, net } = load('electron')
    const path = load('node:path')
    if (!app.isReady()) return { code: 'not-ready' }
    if (process.versions.electron !== '43.6.0' || app.getVersion() !== expected.version) {
      return { code: 'runtime-mismatch' }
    }
    const inside = (value) => {
      const part = path.relative(expected.root, value)
      return part === '' || (part !== '..' && !part.startsWith('..' + path.sep) && !path.isAbsolute(part))
    }
    if (
      app.getPath('userData') !== expected.userData ||
      !['home', 'appData', 'temp'].every((name) => inside(app.getPath(name)))
    ) {
      return { code: 'profile-mismatch' }
    }
    if (operation === 'identity') return { code: 'identity-ok' }
    const routes = {
      'loopback-http': '/ok',
      'untrusted-certificate': '/ok',
      'redirect-denied': '/redirect',
      'header-deadline': '/headers',
      'body-abort': '/body',
      'non-200-denied': '/status'
    }
    if (operation !== 'public-https' && !Object.hasOwn(routes, operation)) return { code: 'operation-invalid' }
    if (
      !Number.isInteger(ports.http) ||
      !Number.isInteger(ports.https) ||
      ports.http < 1 ||
      ports.https < 1 ||
      ports.http > 65535 ||
      ports.https > 65535 ||
      !(budgetMs > 0 && budgetMs <= 10_000)
    ) {
      return { code: 'operation-invalid' }
    }
    const secure = operation === 'untrusted-certificate'
    const url =
      operation === 'public-https'
        ? 'https://api.github.com/'
        : `${secure ? 'https' : 'http'}://127.0.0.1:${secure ? ports.https : ports.http}${routes[operation]}`
    const controller = new AbortController()
    const deadlineReason = Object.freeze({ kind: 'private-deadline' })
    const completeReason = Object.freeze({ kind: 'private-complete' })
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      controller.abort(deadlineReason)
    }, budgetMs)
    try {
      const response = await net.fetch(url, {
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        bypassCustomProtocolHandlers: true,
        signal: controller.signal,
        headers: { 'User-Agent': 'Metis-Hosted-TLS-Probe', Accept: 'application/json' }
      })
      const status = response.status
      controller.abort(completeReason)
      if (operation === 'untrusted-certificate' || operation === 'redirect-denied' || operation === 'header-deadline') {
        return { code: 'unexpected-headers' }
      }
      if (operation === 'non-200-denied') return { code: status === 503 ? 'status-rejected' : 'status-unexpected' }
      return { code: status === 200 && controller.signal.aborted ? 'headers-200-abort-requested' : 'status-unexpected' }
    } catch (error) {
      if (operation === 'untrusted-certificate' && error?.message === 'net::ERR_CERT_AUTHORITY_INVALID') {
        return { code: 'authority-rejected' }
      }
      if (
        operation === 'redirect-denied' &&
        error?.message === "Attempted to redirect, but redirect policy was 'error'"
      ) {
        return { code: 'redirect-rejected' }
      }
      if (operation === 'header-deadline' && expired && controller.signal.aborted && error === deadlineReason) {
        return { code: 'deadline-rejected' }
      }
      return { code: 'network-error' }
    } finally {
      clearTimeout(timer)
      if (!controller.signal.aborted) controller.abort(completeReason)
    }
  } catch {
    return { code: 'candidate-error' }
  }
}

/** Fixed capability only: callers can request identity or one of the seven source-owned network operations.
 * @param {string} endpoint
 * @param {new (endpoint: string) => any} WebSocketClass */
export function createFixedInspector(endpoint, WebSocketClass = WebSocket) {
  const socket = new WebSocketClass(endpoint)
  let opened = false
  let closed = false
  let failed = false
  let nextId = 0
  let pending = null
  const rejectPending = () => {
    failed = true
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('inspector-failed'))
      pending = null
    }
  }
  socket.addEventListener('open', () => {
    opened = true
    if (failed) socket.close()
  })
  socket.addEventListener('error', rejectPending)
  socket.addEventListener('close', () => {
    closed = true
    rejectPending()
  })
  socket.addEventListener('message', (event) => {
    if (failed) return
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 16_384) return rejectPending()
    let response
    try {
      response = JSON.parse(event.data)
    } catch {
      return rejectPending()
    }
    if (
      !pending ||
      response.id !== pending.id ||
      response.error ||
      response.result?.exceptionDetails ||
      !exact(response.result?.result?.value, ['code'])
    ) {
      return rejectPending()
    }
    const owned = pending
    pending = null
    clearTimeout(owned.timer)
    owned.resolve(response.result.result.value)
  })
  return {
    async ready(deadline, inspect) {
      if (!(await until(() => opened || failed || closed, deadline, inspect)) || failed || closed) {
        fail('inspector-failed')
      }
    },
    observe(expected, operation, ports, timeoutMs) {
      if (
        !opened ||
        closed ||
        failed ||
        pending ||
        ![
          'identity',
          'loopback-http',
          'public-https',
          'untrusted-certificate',
          'redirect-denied',
          'header-deadline',
          'body-abort',
          'non-200-denied'
        ].includes(operation) ||
        !(timeoutMs > 0)
      ) {
        return Promise.reject(new Error('inspector-failed'))
      }
      return new Promise((resolveValue, reject) => {
        const id = ++nextId
        const timer = setTimeout(rejectPending, timeoutMs)
        pending = { id, timer, resolve: resolveValue, reject }
        const requestBudget = Math.min(operation === 'header-deadline' ? 2_000 : 10_000, Math.max(1, timeoutMs - 500))
        const args = JSON.stringify([expected, operation, ports, requestBudget])
        const expression = `(${candidateOperation.toString()})(...${args})`
        try {
          socket.send(
            JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: { expression, returnByValue: true, awaitPromise: true }
            })
          )
        } catch {
          rejectPending()
        }
      })
    },
    async close(deadline) {
      rejectPending()
      try {
        if (!closed) socket.close()
      } catch {
        return false
      }
      return until(() => closed, deadline)
    }
  }
}

function createFixtures(credentials) {
  const sockets = new Set()
  const hits = new Map()
  const closed = new Map()
  let httpsConnections = 0
  let httpsHits = 0
  let broken = false
  const record = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
  const handler = (secure) => (request, response) => {
    const route = request.url
    if (secure) httpsHits++
    record(hits, route)
    request.socket.once('close', () => record(closed, route))
    response.setHeader('Connection', 'close')
    if (route === '/headers') return
    if (route === '/body') {
      response.writeHead(200)
      response.write('fixture')
      return
    }
    if (route === '/redirect') {
      response.writeHead(302, { Location: '/destination' })
      response.end()
      return
    }
    response.writeHead(route === '/status' ? 503 : 200)
    response.end()
  }
  const http = createHttpServer(handler(false))
  const https = createHttpsServer(credentials, handler(true))
  for (const server of [http, https]) {
    server.on('error', () => {
      broken = true
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      if (server === https) httpsConnections++
      socket.once('error', () => {})
      socket.once('close', () => sockets.delete(socket))
    })
  }
  https.on('tlsClientError', () => {})
  return {
    ports: { http: 0, https: 0 },
    hits: (route) => hits.get(route) ?? 0,
    closed: (route) => closed.get(route) ?? 0,
    get tlsConnections() {
      return httpsConnections
    },
    get tlsRequests() {
      return httpsHits
    },
    check() {
      if (broken) fail('fixture-failed')
    },
    async start(deadline) {
      for (const [kind, server] of [
        ['http', http],
        ['https', https]
      ]) {
        let listening = false
        server.listen(0, '127.0.0.1', () => {
          listening = true
        })
        if (!(await until(() => listening || broken, deadline)) || broken) fail('fixture-failed')
        const address = server.address()
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') fail('fixture-failed')
        this.ports[kind] = address.port
      }
    },
    async close(deadline) {
      let acknowledged = 0
      let closeFailed = false
      for (const server of [http, https]) {
        try {
          server.close((error) => {
            closeFailed ||= Boolean(error)
            acknowledged++
          })
        } catch {
          return false
        }
      }
      for (const socket of sockets) socket.destroy()
      return (await until(() => acknowledged === 2 && sockets.size === 0, deadline)) && !closeFailed
    }
  }
}

async function fixtureHealth(fixtures, cert, deadline) {
  for (const secure of [true, false]) {
    let headers = false
    let failed = false
    let closed = false
    let intentionalClose = false
    const request = (secure ? httpsRequest : httpRequest)(
      {
        hostname: '127.0.0.1',
        port: secure ? fixtures.ports.https : fixtures.ports.http,
        path: secure ? '/ok' : '/destination',
        method: 'GET',
        agent: false,
        ...(secure ? { ca: cert, rejectUnauthorized: true } : {})
      },
      (response) => {
        headers = response.statusCode === 200
        intentionalClose = true
        response.destroy()
        request.destroy()
      }
    )
    request.once('error', () => {
      if (!intentionalClose) failed = true
    })
    request.once('close', () => {
      closed = true
    })
    request.end()
    const settled = await until(() => closed, Math.min(deadline, performance.now() + 5_000))
    if (!settled) {
      request.destroy()
      if (!(await until(() => closed, Math.min(deadline, performance.now() + 1_000)))) fail('cleanup-unacknowledged')
    }
    if (!settled || !headers || failed) fail('fixture-failed')
  }
}

function plistString(bytes, key) {
  const text = bytes.toString('utf8')
  const matches = [...text.matchAll(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`, 'g'))]
  if (matches.length !== 1) fail('app-rejected')
  return matches[0][1]
}

/** Inspect only the unique installed QA bundle. Dependency injection is a unit-test seam, not a CLI input.
 * @param {any} args
 * @param {any} identity
 * @param {any} provenance
 * @param {{ cwd?: string, loadAsar?: () => Promise<{extractFile: (path: string, name: string) => Buffer}>,
 *   modeOf?: (stat: import('node:fs').Stats) => number }} options */
export async function verifyHostedApp(
  args,
  identity,
  provenance,
  { cwd = realpathSync(process.cwd()), loadAsar = () => import('@electron/asar'), modeOf = (stat) => stat.mode } = {}
) {
  const root = join(cwd, 'candidate-install')
  safePath(cwd, root, 'directory')
  const app = resolve(args.app)
  const names = readdirSync(root).filter((name) => name.endsWith('.app'))
  if (names.length !== 1 || app !== join(root, names[0])) fail('app-rejected')
  safePath(root, app, 'directory')
  const infoPath = join(app, 'Contents', 'Info.plist')
  safePath(root, infoPath, 'file', 65_536)
  const info = readFileSync(infoPath)
  if (
    plistString(info, 'CFBundleIdentifier') !== 'com.mantu.asktoto.qa' ||
    plistString(info, 'CFBundleShortVersionString') !== identity.version
  ) {
    fail('app-rejected')
  }
  const executableName = plistString(info, 'CFBundleExecutable')
  if (executableName !== 'Metis QA') fail('app-rejected')
  const executable = join(app, 'Contents', 'MacOS', executableName)
  const executableStat = safePath(root, executable)
  if (!(modeOf(executableStat) & 0o111)) fail('app-rejected')
  const archive = join(app, 'Contents', 'Resources', 'app.asar')
  safePath(root, archive)
  const asar = await loadAsar()
  const bytes = asar.extractFile(archive, 'package.json')
  if (bytes.length > 65_536) fail('app-rejected')
  const pkg = JSON.parse(bytes.toString('utf8'))
  if (pkg.name !== 'asktoto-qa' || pkg.version !== identity.version) fail('app-rejected')
  const installer = resolve(args.installer)
  const stat = safePath(cwd, installer)
  const asset = provenance.builds.find((build) => build.variant === 'mac-qa-identity').assets[0]
  if (stat.size !== asset.size || (await sha256File(installer)) !== identity.installer_sha256) {
    fail('candidate-rejected')
  }
  return executable
}

function makeProfile(temp) {
  const parent = realpathSync(temp)
  if (!lstatSync(parent).isDirectory()) fail('profile-rejected')
  const root = mkdtempSync(join(parent, 'metis-hosted-tls-'))
  const receipt = lstatSync(root)
  const paths = {
    root,
    home: join(root, 'home'),
    userProfile: join(root, 'user-profile'),
    appData: join(root, 'app-data'),
    localAppData: join(root, 'local-app-data'),
    temp: join(root, 'temp'),
    userData: join(root, 'user-data'),
    fixture: join(root, 'fixture')
  }
  for (const path of Object.values(paths)) if (path !== root) mkdirSync(path, { mode: 0o700 })
  return { paths, receipt }
}

function removeProfile(profile) {
  const actual = lstatSync(profile.paths.root)
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.dev !== profile.receipt.dev ||
    actual.ino !== profile.receipt.ino
  ) {
    fail('cleanup-unacknowledged')
  }
  rmSync(profile.paths.root, { recursive: true })
}

export async function runHostedTls(args, provenance) {
  const started = performance.now()
  const deadline = started + TOTAL_MS
  const workDeadline = deadline - RESERVE_MS
  const identity = bindHostedTlsCandidate(provenance, args)
  const report = createHostedTlsReport(identity)
  const row = (id) => {
    report.rows.find((item) => item.id === id).status = 'PASS'
  }
  let profile = null
  let child = null
  let inspector = null
  let audit = null
  let fixtures = null
  let endpointFailure = false
  let monitor = null
  let observationFailure = null
  const toolState = { safe: true }
  const inspect = () => {
    if (observationFailure) fail(observationFailure)
    if (endpointFailure) fail('inspector-failed')
    if (
      child &&
      (child.error ||
        (!child.requestedStop &&
          (child.exited || child.closed || child.child?.exitCode != null || child.child?.signalCode != null)))
    ) {
      fail('launch-failed')
    }
    fixtures?.check()
    audit?.read()
    if (performance.now() >= workDeadline) fail('deadline')
  }
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.env.TMPDIR) fail('invalid-context')
    const executable = await verifyHostedApp(args, identity, provenance)
    if (performance.now() >= workDeadline) fail('deadline')
    row('candidate-bound')
    profile = makeProfile(process.env.TMPDIR)
    report.cleanup = 'RETAINED'
    const credentials = await certificate(profile.paths, deadline, report, toolState)
    fixtures = createFixtures(credentials)
    await fixtures.start(workDeadline)
    await fixtureHealth(fixtures, credentials.cert, workDeadline)
    row('fixture-health')
    if (performance.now() >= workDeadline) fail('deadline')
    const endpoint = createEndpointLatch()
    child = ownedChild(executable, ['--inspect=127.0.0.1:0'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: strictLaunchEnvironment(process.env, profile.paths, 'darwin')
    })
    child.child?.stderr?.on('data', (chunk) => {
      try {
        endpoint.accept(chunk)
      } catch {
        endpointFailure = true
      }
    })
    child.child?.stderr?.once('error', () => {
      endpointFailure = true
    })
    audit = createAuditMonitor(profile.paths.userData)
    monitor = setInterval(() => {
      try {
        inspect()
      } catch (error) {
        observationFailure ??= finiteFailure(error)
      }
    }, 100)
    const startupDeadline = Math.min(workDeadline, started + 150_000)
    if (
      !(await until(() => endpoint.endpoint !== null, Math.min(startupDeadline, performance.now() + 60_000), inspect))
    ) {
      fail('inspector-failed')
    }
    inspector = createFixedInspector(endpoint.endpoint)
    await inspector.ready(Math.min(startupDeadline, performance.now() + 10_000), inspect)
    const expected = {
      pid: child.child.pid,
      version: identity.version,
      root: profile.paths.root,
      userData: profile.paths.userData
    }
    let observed = false
    while (performance.now() < startupDeadline) {
      inspect()
      const runtime = await inspector.observe(
        expected,
        'identity',
        fixtures.ports,
        Math.min(10_000, startupDeadline - performance.now())
      )
      if (runtime.code === 'identity-ok') {
        observed = true
        break
      }
      if (runtime.code !== 'not-ready') fail('runtime-rejected')
      await sleep(25)
    }
    if (!observed) fail('runtime-rejected')
    row('profile-runtime')
    let readyAt = null
    if (
      !(await until(
        () => readyAt !== null && performance.now() - readyAt >= 3_000,
        startupDeadline,
        () => {
          inspect()
          if (audit.read() && readyAt === null) readyAt = performance.now()
        }
      ))
    ) {
      fail('readiness-failed')
    }
    row('renderer-ready-survival')
    for (const operation of [
      'loopback-http',
      'public-https',
      'untrusted-certificate',
      'redirect-denied',
      'header-deadline',
      'body-abort',
      'non-200-denied'
    ]) {
      inspect()
      const before = {
        tls: fixtures.tlsConnections,
        requests: fixtures.tlsRequests,
        destination: fixtures.hits('/destination'),
        redirect: fixtures.hits('/redirect'),
        header: fixtures.hits('/headers'),
        headerClosed: fixtures.closed('/headers'),
        body: fixtures.hits('/body'),
        bodyClosed: fixtures.closed('/body'),
        ok: fixtures.hits('/ok'),
        status: fixtures.hits('/status')
      }
      const attemptDeadline = Math.min(workDeadline, performance.now() + 10_000)
      const answer = await inspector.observe(expected, operation, fixtures.ports, attemptDeadline - performance.now())
      inspect()
      const expectedCode =
        {
          'untrusted-certificate': 'authority-rejected',
          'redirect-denied': 'redirect-rejected',
          'header-deadline': 'deadline-rejected',
          'non-200-denied': 'status-rejected'
        }[operation] ?? 'headers-200-abort-requested'
      if (answer.code !== expectedCode) fail('network-failed')
      if (
        operation === 'untrusted-certificate' &&
        (fixtures.tlsConnections <= before.tls || fixtures.tlsRequests !== before.requests)
      ) {
        fail('network-failed')
      }
      if (
        operation === 'redirect-denied' &&
        (fixtures.hits('/redirect') !== before.redirect + 1 || fixtures.hits('/destination') !== before.destination)
      ) {
        fail('network-failed')
      }
      if (operation === 'loopback-http' && fixtures.hits('/ok') !== before.ok + 1) fail('network-failed')
      if (operation === 'non-200-denied' && fixtures.hits('/status') !== before.status + 1) fail('network-failed')
      if (
        operation === 'header-deadline' &&
        (fixtures.hits('/headers') !== before.header + 1 ||
          !(await until(() => fixtures.closed('/headers') === before.headerClosed + 1, attemptDeadline, inspect)))
      ) {
        fail('network-failed')
      }
      if (
        operation === 'body-abort' &&
        (fixtures.hits('/body') !== before.body + 1 ||
          !(await until(() => fixtures.closed('/body') === before.bodyClosed + 1, attemptDeadline, inspect)))
      ) {
        fail('network-failed')
      }
      row(operation)
    }
    inspect()
    report.outcome = 'PASS'
    report.failure = 'none'
  } catch (error) {
    report.outcome = child ? 'FAIL' : 'PRECONDITION'
    report.failure = finiteFailure(error)
    if (report.failure === 'cleanup-unacknowledged') toolState.safe = false
  } finally {
    if (monitor) clearInterval(monitor)
    const cleanupDeadline = Math.min(deadline, performance.now() + RESERVE_MS)
    let clean = toolState.safe
    if (child) {
      const stopped = await stopState(child, cleanupDeadline)
      report.teardown = stopped ? 'ACKNOWLEDGED' : 'UNACKNOWLEDGED'
      clean = clean && stopped
      if (stopped) {
        try {
          audit.read(true)
          row('audit-final-drain')
        } catch {
          clean = false
          if (report.failure === 'none') report.failure = 'audit-failed'
        }
      }
    }
    try {
      audit?.close()
    } catch {
      clean = false
    }
    if (inspector && !(await inspector.close(cleanupDeadline))) clean = false
    if (fixtures && !(await fixtures.close(cleanupDeadline))) clean = false
    if (endpointFailure) {
      if (report.failure === 'none') report.failure = 'inspector-failed'
      clean = false
    }
    if (observationFailure) {
      report.failure = report.failure === 'none' ? observationFailure : report.failure
      clean = false
    }
    if (clean && profile) {
      try {
        removeProfile(profile)
        report.cleanup = 'REMOVED'
        if (child) row('owned-cleanup')
      } catch {
        clean = false
      }
    }
    if (!clean) {
      report.outcome = 'FAIL'
      if (report.failure === 'none') report.failure = 'cleanup-unacknowledged'
    }
    if (report.failure !== 'none' && report.outcome === 'PASS') report.outcome = 'FAIL'
  }
  return report
}

async function main(argv) {
  const keys = ['app', 'installer', 'sha256', 'provenance', 'candidate-run', 'producer-commit', 'harness-commit', 'out']
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.slice(2)
    if (!argv[index]?.startsWith('--') || !keys.includes(name) || Object.hasOwn(values, name) || !argv[index + 1]) {
      fail('invalid-context')
    }
    values[name] = argv[index + 1]
  }
  if (Object.keys(values).length !== keys.length || values.out !== `candidate-scenario/${TLS_REPORT}`) {
    fail('invalid-context')
  }
  const cwd = realpathSync(process.cwd())
  safePath(cwd, resolve(values.provenance), 'file', 1_048_576)
  safePath(cwd, join(cwd, 'candidate-scenario'), 'directory')
  const args = {
    app: values.app,
    installer: values.installer,
    sha256: values.sha256,
    candidateRun: Number(values['candidate-run']),
    producerCommit: values['producer-commit'],
    harnessCommit: values['harness-commit']
  }
  const report = await runHostedTls(args, JSON.parse(readFileSync(values.provenance, 'utf8')))
  if (hostedTlsReportProblems(report).length) fail('output-rejected')
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { PASS: 0, FAIL: 1, PRECONDITION: 2 }[report.outcome]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    () => {
      console.error('hosted-startup-tls: closed-harness-failure')
      process.exitCode = 1
    }
  )
}
