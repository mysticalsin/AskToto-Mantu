#!/usr/bin/env node
// Content-free, pre-Setup packaged onboarding support probe (M2-0456).  This module is intentionally
// Node-builtins-only at import time: candidate-scenarios imports its schema/validator before it decides
// whether a hosted candidate is eligible. Playwright and the app driver load only after every immutable
// candidate binding and fresh-profile precondition has passed.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FRESH_ONBOARDING_SCHEMA = 'metis.fresh-onboarding-baseline.v1'
export const ASSERTION_IDS = Object.freeze([
  'hermetic-fresh-profile',
  'pre-setup-boundary',
  'opaque-full-display',
  'native-display-bounds',
  'right-edge-visible',
  'right-edge-persisted',
  'bar-absent',
  'placement-to-appearance',
  'teardown-acknowledged'
])

/** These are explicit coverage limits, not free-form diagnostics or a claim that the omitted paths passed. */
export const NOT_COVERED = Object.freeze([
  Object.freeze({ row: 'full-onboarding-completion', reason: 'PRE_SETUP_BOUNDARY' }),
  Object.freeze({ row: 'onboarding-done-persistence', reason: 'PRE_SETUP_BOUNDARY' }),
  Object.freeze({ row: 'replacement-window-replay', reason: 'PRE_SETUP_BOUNDARY' }),
  Object.freeze({ row: 'setup-permissions-capture', reason: 'PRE_SETUP_BOUNDARY' }),
  Object.freeze({ row: 'bar-interaction-min-expand', reason: 'PRE_SETUP_BOUNDARY' }),
  Object.freeze({ row: 'startup-network', reason: 'NOT_OBSERVED' }),
  Object.freeze({ row: 'screenshots-visual-proof', reason: 'NO_CAPTURE_POLICY' }),
  Object.freeze({ row: 'physical-device-proof', reason: 'HOSTED_RUNNER_ONLY' })
])

const REPORT_FILE = 'fresh-onboarding-baseline.json'
const REPORT_KEYS = ['schema', 'outcome', 'identity', 'assertions', 'failure', 'teardown', 'not_covered']
const IDENTITY_KEYS = ['candidate_run', 'producer_commit', 'installer_sha256', 'version', 'harness_commit', 'platform']
const EXPECTED_IDENTITY_KEYS = ['candidateRun', 'commit', 'sha256', 'version', 'harnessCommit', 'platform']
const ASSERTION_KEYS = ['id', 'status']
const NOT_COVERED_KEYS = ['row', 'reason']
const OUTCOMES = new Set(['PASS', 'FAIL', 'PRECONDITION'])
const ASSERTION_STATUSES = new Set(['PASS', 'FAIL', 'NOT_RUN'])
const TEARDOWN_STATES = new Set(['ACKNOWLEDGED', 'UNACKNOWLEDGED', 'NOT_ATTEMPTED'])
const FAILURES = new Set([
  'none',
  'invalid-arguments',
  'provenance-rejected',
  'installer-hash-mismatch',
  'app-identity-rejected',
  'profile-rejected',
  'launch-failed',
  'action-timeout',
  'action-failed',
  'assertion-failed',
  'teardown-unacknowledged',
  'transport-release-failed',
  'profile-cleanup-failed',
  'harness-error'
])
const PRECONDITION_FAILURES = new Set([
  'invalid-arguments',
  'provenance-rejected',
  'installer-hash-mismatch',
  'app-identity-rejected',
  'profile-rejected'
])
const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32'])
const HASH40 = /^[0-9a-f]{40}$/
const HASH64 = /^[0-9a-f]{64}$/
const MAX_VERSION_LENGTH = 64
const NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)'
const NON_NUMERIC_IDENTIFIER = '(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+'
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`
const BUILD_IDENTIFIER = '[0-9A-Za-z-]+'
const SEMVER = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?` +
    `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`
)
const ACTION_TIMEOUT_MS = 15_000
const RELEASE_TIMEOUT_MS = 5_000

/** @typedef {{ isFile: () => boolean, isSymbolicLink: () => boolean, size: number }} PackagedAsarStat */
/** @typedef {{ extractFile: (archive: string, entry: string) => Buffer | Uint8Array | string }} PackagedAsar */
/** @typedef {{ target: { installRoot: string, executable: string }, platform: string,
 *   loadAsar?: () => Promise<PackagedAsar>, lstat?: (path: string) => PackagedAsarStat }} PackagedAsarVersionOptions */
/**
 * @typedef {{
 *   candidate_run: number | null,
 *   producer_commit: string | null,
 *   installer_sha256: string | null,
 *   version: string | null,
 *   harness_commit: string | null,
 *   platform: 'darwin' | 'win32' | null
 * }} FreshOnboardingIdentity
 */
/**
 * @typedef {{
 *   candidateRun: number,
 *   commit: string,
 *   sha256: string,
 *   version: string,
 *   harnessCommit: string,
 *   platform: 'darwin' | 'win32'
 * }} FreshOnboardingExpectedIdentity
 */
/** @typedef {{ id: string, status: string }} FreshOnboardingAssertion */
/**
 * @typedef {{
 *   outcome?: string,
 *   identity?: FreshOnboardingIdentity,
 *   assertions?: FreshOnboardingAssertion[],
 *   failure?: string,
 *   teardown?: string
 * }} FreshOnboardingReportOptions
 */
/** @typedef {{ requirePass?: boolean }} FreshOnboardingAssessmentOptions */
/** @typedef {{ pid?: number }} FreshOnboardingTeardownChild */
/**
 * @typedef {{
 *   child?: FreshOnboardingTeardownChild | null,
 *   stop?: (child: FreshOnboardingTeardownChild) => Promise<unknown> | unknown,
 *   normalize?: (value: unknown) => unknown,
 *   dispose?: () => Promise<boolean> | boolean
 * }} FreshOnboardingTeardownOptions
 */

const plainRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function snapshotRecord(value, keys) {
  if (!plainRecord(value)) return null
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

const emptyIdentity = () => ({
  candidate_run: null,
  producer_commit: null,
  installer_sha256: null,
  version: null,
  harness_commit: null,
  platform: null
})

const initialAssertions = () => ASSERTION_IDS.map((id) => ({ id, status: 'NOT_RUN' }))

const cloneNotCovered = () => NOT_COVERED.map(({ row, reason }) => ({ row, reason }))

const canonicalPositiveId = (value) => Number.isSafeInteger(value) && value > 0

const canonicalStringOrNull = (value, pattern) => value === null || (typeof value === 'string' && pattern.test(value))

/** Strict SemVer 2.0: no empty dot identifiers and no leading zero in a numeric prerelease identifier. */
export const isStrictSemver = (value) => typeof value === 'string' && SEMVER.test(value)

const canonicalVersion = (value) =>
  typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && isStrictSemver(value)

/** Validate the content-free report identity. Individual null slots are legal for a report that never reached
 * a bound launch; an expected identity passed to assessFreshOnboardingReport is what rejects that as evidence. */
export function identityProblems(identity) {
  try {
    const value = snapshotRecord(identity, IDENTITY_KEYS)
    if (!value) return ['IDENTITY_KEYS_INVALID']
    const problems = []
    if (!(value.candidate_run === null || canonicalPositiveId(value.candidate_run))) {
      problems.push('IDENTITY_CANDIDATE_RUN_INVALID')
    }
    if (!canonicalStringOrNull(value.producer_commit, HASH40)) problems.push('IDENTITY_PRODUCER_COMMIT_INVALID')
    if (!canonicalStringOrNull(value.installer_sha256, HASH64)) problems.push('IDENTITY_INSTALLER_SHA256_INVALID')
    if (!(value.version === null || canonicalVersion(value.version))) problems.push('IDENTITY_VERSION_INVALID')
    if (!canonicalStringOrNull(value.harness_commit, HASH40)) problems.push('IDENTITY_HARNESS_COMMIT_INVALID')
    if (!(value.platform === null || SUPPORTED_PLATFORMS.has(value.platform))) {
      problems.push('IDENTITY_PLATFORM_INVALID')
    }
    return problems
  } catch {
    return ['IDENTITY_KEYS_INVALID']
  }
}

/** A report may contain canonical null slots before launch, but a real candidate must bind every identity field. */
export function identityBindingProblems(identity) {
  const problems = identityProblems(identity)
  if (problems.length) return problems
  const value = snapshotRecord(identity, IDENTITY_KEYS)
  if (!value) return ['IDENTITY_KEYS_INVALID']
  return IDENTITY_KEYS.some((key) => value[key] === null) ? ['IDENTITY_INCOMPLETE'] : []
}

function assertionProblems(assertions) {
  if (!Array.isArray(assertions) || assertions.length !== ASSERTION_IDS.length) return ['ASSERTIONS_INVALID']
  for (const [index, row] of assertions.entries()) {
    const value = snapshotRecord(row, ASSERTION_KEYS)
    if (!value || value.id !== ASSERTION_IDS[index] || !ASSERTION_STATUSES.has(value.status)) {
      return ['ASSERTIONS_INVALID']
    }
  }
  return []
}

function notCoveredProblems(rows) {
  if (!Array.isArray(rows) || rows.length !== NOT_COVERED.length) return ['NOT_COVERED_INVALID']
  for (const [index, row] of rows.entries()) {
    const value = snapshotRecord(row, NOT_COVERED_KEYS)
    const expected = NOT_COVERED[index]
    if (!value || value.row !== expected.row || value.reason !== expected.reason) return ['NOT_COVERED_INVALID']
  }
  return []
}

function reportSemanticProblems(report) {
  const rows = report.assertions
  const statuses = rows.map((row) => row.status)
  const teardownStatus = statuses.at(-1)
  const problems = []
  if (report.outcome === 'PASS') {
    if (
      report.failure !== 'none' ||
      report.teardown !== 'ACKNOWLEDGED' ||
      statuses.some((status) => status !== 'PASS')
    ) {
      problems.push('PASS_SEMANTICS_INVALID')
    }
  }
  if (report.outcome === 'FAIL' && report.failure === 'none') problems.push('FAIL_SEMANTICS_INVALID')
  if (report.outcome === 'PRECONDITION') {
    if (
      !PRECONDITION_FAILURES.has(report.failure) ||
      report.teardown !== 'NOT_ATTEMPTED' ||
      statuses.some((status) => status !== 'NOT_RUN')
    ) {
      problems.push('PRECONDITION_SEMANTICS_INVALID')
    }
  }
  if (
    (report.teardown === 'ACKNOWLEDGED' && teardownStatus !== 'PASS') ||
    (report.teardown === 'UNACKNOWLEDGED' && teardownStatus !== 'FAIL') ||
    (report.teardown === 'NOT_ATTEMPTED' && teardownStatus !== 'NOT_RUN')
  ) {
    problems.push('TEARDOWN_ASSERTION_INVALID')
  }
  return problems
}

/** Reject unknown fields and unsafe shapes before a candidate lane decides whether a report is uploadable. */
export function reportProblems(report) {
  try {
    const value = snapshotRecord(report, REPORT_KEYS)
    if (!value) return ['REPORT_KEYS_INVALID']
    const problems = []
    if (value.schema !== FRESH_ONBOARDING_SCHEMA) problems.push('REPORT_SCHEMA_INVALID')
    if (!OUTCOMES.has(value.outcome)) problems.push('REPORT_OUTCOME_INVALID')
    problems.push(...identityProblems(value.identity))
    problems.push(...assertionProblems(value.assertions))
    if (!FAILURES.has(value.failure)) problems.push('REPORT_FAILURE_INVALID')
    if (!TEARDOWN_STATES.has(value.teardown)) problems.push('REPORT_TEARDOWN_INVALID')
    problems.push(...notCoveredProblems(value.not_covered))
    if (problems.length) return problems
    return reportSemanticProblems(value)
  } catch {
    return ['REPORT_KEYS_INVALID']
  }
}

function expectedIdentityProblems(expected) {
  if (expected === undefined) return []
  const value = snapshotRecord(expected, EXPECTED_IDENTITY_KEYS)
  if (!value) return ['EXPECTED_IDENTITY_INVALID']
  const problems = []
  if (!canonicalPositiveId(value.candidateRun)) problems.push('EXPECTED_CANDIDATE_RUN_INVALID')
  if (!(typeof value.commit === 'string' && HASH40.test(value.commit))) {
    problems.push('EXPECTED_PRODUCER_COMMIT_INVALID')
  }
  if (!(typeof value.sha256 === 'string' && HASH64.test(value.sha256))) {
    problems.push('EXPECTED_INSTALLER_SHA256_INVALID')
  }
  if (!canonicalVersion(value.version)) problems.push('EXPECTED_VERSION_INVALID')
  if (!(typeof value.harnessCommit === 'string' && HASH40.test(value.harnessCommit))) {
    problems.push('EXPECTED_HARNESS_COMMIT_INVALID')
  }
  if (!SUPPORTED_PLATFORMS.has(value.platform)) problems.push('EXPECTED_PLATFORM_INVALID')
  return problems
}

/** Assess a content-free report against the exact expected candidate identity. This accepts valid FAIL and
 * PRECONDITION reports when requirePass is false, so the upload scanner can distinguish schema validity from PASS.
 * @param {unknown} report
 * @param {FreshOnboardingExpectedIdentity | undefined} [expected]
 * @param {FreshOnboardingAssessmentOptions} [options]
 */
export function assessFreshOnboardingReport(report, expected = undefined, { requirePass = true } = {}) {
  const problems = reportProblems(report)
  if (!problems.length) {
    const expectedProblems = expectedIdentityProblems(expected)
    problems.push(...expectedProblems)
    if (!expectedProblems.length && expected !== undefined) {
      const identity = snapshotRecord(report.identity, IDENTITY_KEYS)
      const expectedIdentity = snapshotRecord(expected, EXPECTED_IDENTITY_KEYS)
      const comparisons = [
        ['candidate_run', 'candidateRun', 'IDENTITY_CANDIDATE_RUN_MISMATCH'],
        ['producer_commit', 'commit', 'IDENTITY_PRODUCER_COMMIT_MISMATCH'],
        ['installer_sha256', 'sha256', 'IDENTITY_INSTALLER_SHA256_MISMATCH'],
        ['version', 'version', 'IDENTITY_VERSION_MISMATCH'],
        ['harness_commit', 'harnessCommit', 'IDENTITY_HARNESS_COMMIT_MISMATCH'],
        ['platform', 'platform', 'IDENTITY_PLATFORM_MISMATCH']
      ]
      for (const [actual, required, problem] of comparisons) {
        if (identity[actual] !== expectedIdentity[required]) problems.push(problem)
      }
    }
    if (requirePass && report.outcome !== 'PASS') problems.push('OUTCOME_NOT_PASS')
  }
  const rows = Array.isArray(report?.assertions)
    ? report.assertions.map((row) => {
        const value = snapshotRecord(row, ASSERTION_KEYS)
        return value ? { id: value.id, status: value.status } : { id: null, status: 'NOT_RUN' }
      })
    : []
  return { problems, notCovered: NOT_COVERED, row_verdicts: rows }
}

/** Construct only the closed report shape. Callers cannot add arbitrary diagnostic fields through this helper.
 * @param {FreshOnboardingReportOptions} [options]
 */
export function createFreshOnboardingReport({
  outcome = 'PRECONDITION',
  identity = emptyIdentity(),
  assertions = initialAssertions(),
  failure = 'invalid-arguments',
  teardown = 'NOT_ATTEMPTED'
} = {}) {
  return {
    schema: FRESH_ONBOARDING_SCHEMA,
    outcome,
    identity: Object.fromEntries(IDENTITY_KEYS.map((key) => [key, identity?.[key] ?? null])),
    assertions: Array.isArray(assertions)
      ? assertions.map((row) => ({ id: row?.id ?? null, status: row?.status ?? 'NOT_RUN' }))
      : assertions,
    failure,
    teardown,
    not_covered: cloneNotCovered()
  }
}

/** Mandatory shutdown ordering: acknowledge the owned child before touching Playwright transport.
 * @param {FreshOnboardingTeardownOptions} options
 */
export async function teardownThenDispose({ child, stop, normalize, dispose }) {
  // A launch timeout can still leave an Electron process running after Playwright's promise races its host budget.
  // Without the exact child receipt, neither a signal nor transport close is safe enough to infer ownership.
  if (!child || typeof stop !== 'function' || typeof normalize !== 'function') {
    return { teardown: 'UNACKNOWLEDGED', transportReleased: false }
  }
  let receipt
  try {
    receipt = normalize(await stop(child))
  } catch {
    return { teardown: 'UNACKNOWLEDGED', transportReleased: false }
  }
  if (receipt?.state !== 'acknowledged') return { teardown: 'UNACKNOWLEDGED', transportReleased: false }
  try {
    return { teardown: 'ACKNOWLEDGED', transportReleased: (await dispose()) === true }
  } catch {
    return { teardown: 'ACKNOWLEDGED', transportReleased: false }
  }
}

function finiteError(failure, outcome = 'FAIL') {
  const error = new Error(failure)
  error.failure = failure
  error.outcome = outcome
  return error
}

function parseArguments(argv) {
  const known = new Set([
    'app',
    'installer',
    'sha256',
    'provenance',
    'candidate-run',
    'harness-commit',
    'platform',
    'out'
  ])
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      typeof flag !== 'string' ||
      !flag.startsWith('--') ||
      !known.has(flag.slice(2)) ||
      typeof value !== 'string' ||
      !value ||
      values[flag]
    ) {
      throw finiteError('invalid-arguments', 'PRECONDITION')
    }
    values[flag] = value
  }
  if (Object.keys(values).length !== known.size || argv.length !== known.size * 2) {
    throw finiteError('invalid-arguments', 'PRECONDITION')
  }
  const args = {
    app: values['--app'],
    installer: values['--installer'],
    sha256: values['--sha256'],
    provenance: values['--provenance'],
    candidateRun: Number(values['--candidate-run']),
    harnessCommit: values['--harness-commit'],
    platform: values['--platform'],
    out: values['--out']
  }
  if (
    !canonicalPositiveId(args.candidateRun) ||
    !HASH64.test(args.sha256) ||
    !HASH40.test(args.harnessCommit) ||
    !SUPPORTED_PLATFORMS.has(args.platform) ||
    args.platform !== process.platform ||
    !safeReportPath(args.out)
  ) {
    throw finiteError('invalid-arguments', 'PRECONDITION')
  }
  return args
}

function safeReportPath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || basename(path) !== REPORT_FILE) return false
  const root = resolve(process.cwd())
  const absolute = resolve(root, path)
  const contained = relative(root, absolute)
  return (
    contained !== '' &&
    contained !== '..' &&
    !contained.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(contained)
  )
}

function outputFromArguments(argv) {
  const positions = argv.reduce((found, value, index) => (value === '--out' ? [...found, index] : found), [])
  if (positions.length !== 1) return null
  const candidate = argv[positions[0] + 1]
  return safeReportPath(candidate) ? candidate : null
}

function identityFor(args, provenance = undefined) {
  const record = plainRecord(provenance) ? provenance : {}
  const run = plainRecord(record.run) ? record.run : {}
  return {
    candidate_run: canonicalPositiveId(args?.candidateRun) ? args.candidateRun : null,
    producer_commit: typeof record.commit === 'string' && HASH40.test(record.commit) ? record.commit : null,
    installer_sha256: typeof args?.sha256 === 'string' && HASH64.test(args.sha256) ? args.sha256 : null,
    version: canonicalVersion(record.version) ? record.version : null,
    harness_commit:
      typeof args?.harnessCommit === 'string' && HASH40.test(args.harnessCommit) ? args.harnessCommit : null,
    platform: SUPPORTED_PLATFORMS.has(args?.platform) ? args.platform : null,
    provenance_run: canonicalPositiveId(run.id) ? run.id : null
  }
}

function reportIdentity(identity) {
  return Object.fromEntries(IDENTITY_KEYS.map((key) => [key, identity[key] ?? null]))
}

function assetFromProvenance(provenance, installer) {
  if (!plainRecord(provenance) || !Array.isArray(provenance.builds)) return null
  const name = basename(installer)
  const assets = provenance.builds.flatMap((build) =>
    plainRecord(build) && Array.isArray(build.assets) ? build.assets : []
  )
  const matches = assets.filter(
    (asset) => plainRecord(asset) && asset.name === name && typeof asset.sha256 === 'string'
  )
  return matches.length === 1 && HASH64.test(matches[0].sha256) ? matches[0] : null
}

export function packagedAsarPath(target, platform) {
  if (!plainRecord(target) || typeof target.installRoot !== 'string' || typeof target.executable !== 'string') {
    throw new Error('packaged target is invalid')
  }
  if (platform === 'darwin') return posix.join(target.installRoot, 'Contents', 'Resources', 'app.asar')
  if (platform === 'win32') return win32.join(win32.dirname(target.executable), 'resources', 'app.asar')
  throw new Error('packaged target platform is unsupported')
}

/**
 * Read only root package.json from the installed archive before launch. PE ProductVersion is intentionally unused.
 * @param {PackagedAsarVersionOptions} options
 */
export async function readPackagedAsarVersion({
  target,
  platform,
  loadAsar = () => import('@electron/asar'),
  lstat = lstatSync
}) {
  const archive = packagedAsarPath(target, platform)
  let stat
  try {
    stat = lstat(archive)
  } catch {
    throw new Error('packaged app archive is missing')
  }
  if (!stat?.isFile?.() || stat.isSymbolicLink?.() || !(stat.size > 0)) {
    throw new Error('packaged app archive is not a regular non-empty file')
  }
  let bytes
  try {
    const asar = await loadAsar()
    if (typeof asar?.extractFile !== 'function') throw new Error('missing extractFile')
    bytes = asar.extractFile(archive, 'package.json')
  } catch {
    throw new Error('packaged app archive could not be read')
  }
  let packageJson
  try {
    packageJson = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new Error('packaged package.json is invalid')
  }
  if (!plainRecord(packageJson) || !canonicalVersion(packageJson.version)) {
    throw new Error('packaged package.json version is invalid')
  }
  return packageJson.version
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')))
      .on('error', reject)
  })
}

function createProfile() {
  const root = mkdtempSync(join(tmpdir(), 'metis-fresh-onboarding-'))
  const paths = {
    root,
    home: join(root, 'home'),
    userProfile: join(root, 'userprofile'),
    appData: join(root, 'appdata'),
    localAppData: join(root, 'localappdata'),
    temp: join(root, 'tmp'),
    userData: join(root, 'userdata')
  }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 })
  if (readdirSync(paths.userData).length !== 0) throw finiteError('profile-rejected', 'PRECONDITION')
  return paths
}

export async function waitForProbe(probe, timeoutMs, now = () => performance.now()) {
  const deadline = now() + timeoutMs
  for (;;) {
    const remaining = deadline - now()
    if (remaining <= 0) return false
    const value = await probe(remaining)
    const afterProbe = deadline - now()
    if (afterProbe <= 0) return false
    if (value) return true
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(100, Math.max(1, afterProbe))))
  }
}

/** Latch the first bounded action error. A timeout must tear down the owned app, not permit a later UI action. */
export function createLatchedActionCall(boundedCall, timeoutMs, message = 'fresh-action-timeout') {
  let failure = null
  return async (operation, actionTimeoutMs = timeoutMs) => {
    if (failure) throw finiteError(failure)
    const budget = Math.min(timeoutMs, actionTimeoutMs)
    if (!(budget > 0)) {
      failure = 'action-timeout'
      throw finiteError(failure)
    }
    try {
      return await boundedCall(operation, budget, message)
    } catch (error) {
      failure =
        error?.failure && FAILURES.has(error.failure)
          ? error.failure
          : error?.message === message
            ? 'action-timeout'
            : 'action-failed'
      throw finiteError(failure)
    }
  }
}

/** Find the actual fresh onboarding renderer under one monotonic deadline, never accepting an arbitrary first page. */
export async function findFreshOnboardingPage({ browser, call, timeoutMs, verifyLaunch }) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    verifyLaunch()
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue
        const remaining = Math.max(0, deadline - performance.now())
        if (remaining <= 0) throw finiteError('action-timeout')
        const ready = await call(
          () =>
            page.evaluate(
              () => Boolean(document.querySelector('.onboard-stage')) && typeof window.toto?.getSettings === 'function'
            ),
          remaining
        )
        verifyLaunch()
        if (ready) return page
      }
    }
    const remaining = Math.max(0, deadline - performance.now())
    if (remaining <= 0) throw finiteError('action-timeout')
    await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(100, remaining)))
  }
}

function mapFlowFailure(error) {
  if (error?.failure && FAILURES.has(error.failure)) return error.failure
  if (error?.code === 'ASSERTION_FAILED') return 'assertion-failed'
  if (error?.code === 'ACTION_TIMEOUT') return 'action-timeout'
  if (error?.code === 'ACTION_FAILED') return 'action-failed'
  return 'harness-error'
}

function markAssertion(assertions, id, status) {
  const index = ASSERTION_IDS.indexOf(id)
  if (index < 0 || !ASSERTION_STATUSES.has(status)) throw finiteError('harness-error')
  assertions[index] = { id, status }
}

function preserveFirstFailure(state, fallback) {
  state.outcome = 'FAIL'
  if (state.failure === 'none') state.failure = fallback
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

async function execute(argv) {
  const state = {
    outcome: 'FAIL',
    failure: 'none',
    identity: emptyIdentity(),
    assertions: initialAssertions(),
    teardown: 'NOT_ATTEMPTED',
    output: outputFromArguments(argv),
    profile: null,
    browser: null,
    inspector: null,
    child: null,
    latches: null,
    launchAttempted: false,
    ownershipCaptured: false,
    transportReleased: false,
    transportUncertain: false,
    lateReleases: [],
    stopOwnedChild: null,
    normalizeTeardown: null,
    disposeFreshOnboardingTransports: null
  }
  try {
    const args = parseArguments(argv)
    state.output = args.out
    let provenance
    try {
      provenance = JSON.parse(readFileSync(args.provenance, 'utf8'))
    } catch {
      throw finiteError('provenance-rejected', 'PRECONDITION')
    }
    const bound = identityFor(args, provenance)
    state.identity = reportIdentity(bound)
    if (bound.provenance_run !== args.candidateRun || identityBindingProblems(state.identity).length) {
      throw finiteError('provenance-rejected', 'PRECONDITION')
    }
    const asset = assetFromProvenance(provenance, args.installer)
    if (!asset || asset.sha256 !== args.sha256) throw finiteError('installer-hash-mismatch', 'PRECONDITION')
    try {
      if ((await sha256File(args.installer)) !== args.sha256) throw new Error('mismatch')
    } catch {
      throw finiteError('installer-hash-mismatch', 'PRECONDITION')
    }

    const { resolveInstallTarget } = await import('./census/lib.mjs')
    let target
    try {
      target = resolveInstallTarget(args.app, args.platform)
      if ((await readPackagedAsarVersion({ target, platform: args.platform })) !== bound.version) {
        throw new Error('version')
      }
    } catch {
      throw finiteError('app-identity-rejected', 'PRECONDITION')
    }

    try {
      state.profile = createProfile()
    } catch (error) {
      if (error?.failure === 'profile-rejected') throw error
      throw finiteError('profile-rejected', 'PRECONDITION')
    }

    const [appDriver, onboardingFlow, termination] = await Promise.all([
      import('./lib/app-driver.mjs'),
      import('./golden-flows/onboarding-flows.mjs'),
      import('./lib/st-1-termination.mjs')
    ])
    const {
      attachOwnedCdp,
      attachOwnedMainInspector,
      boundedCall,
      disposeFreshOnboardingTransports,
      freeLoopbackPort,
      launchPackagedCdp,
      packagedLaunchFailed,
      strictLaunchEnvironment
    } = appDriver
    const { runFreshOnboardingBaselineFlow } = onboardingFlow
    const { normalizeTeardown, stopOwnedChild } = termination
    state.disposeFreshOnboardingTransports = disposeFreshOnboardingTransports
    state.normalizeTeardown = normalizeTeardown
    state.stopOwnedChild = stopOwnedChild
    const environment = strictLaunchEnvironment(process.env, state.profile, args.platform)
    let launch
    try {
      const cdpPort = await boundedCall(() => freeLoopbackPort(), ACTION_TIMEOUT_MS, 'fresh-action-timeout')
      const inspectPort = await boundedCall(() => freeLoopbackPort(), ACTION_TIMEOUT_MS, 'fresh-action-timeout')
      if (cdpPort === inspectPort) throw new Error('loopback-port-collision')
      state.launchAttempted = true
      launch = launchPackagedCdp({
        executablePath: target.executable,
        env: environment,
        cdpPort,
        inspectPort,
        platform: args.platform
      })
      state.child = launch.child
      state.latches = launch.latches
      state.ownershipCaptured =
        Number.isSafeInteger(state.child?.pid) && state.child.pid > 1 && state.child.pid !== process.pid
      if (!state.ownershipCaptured || packagedLaunchFailed(state.child, state.latches)) {
        throw new Error('missing-owned-child-receipt')
      }
    } catch {
      throw finiteError('launch-failed')
    }

    const bounded = createLatchedActionCall(boundedCall, ACTION_TIMEOUT_MS)
    const verifyLaunch = () => {
      if (packagedLaunchFailed(state.child, state.latches)) throw finiteError('launch-failed')
    }
    const call = async (operation, timeoutMs = ACTION_TIMEOUT_MS) => {
      verifyLaunch()
      const value = await bounded(async () => {
        verifyLaunch()
        const result = await operation()
        verifyLaunch()
        return result
      }, timeoutMs)
      verifyLaunch()
      return value
    }

    const attachedCdp = await attachOwnedCdp({
      endpoint: launch.cdpEndpoint,
      childPid: state.child.pid,
      timeoutMs: ACTION_TIMEOUT_MS
    })
    state.transportUncertain ||= attachedCdp.transportUncertain
    if (attachedCdp.lateRelease) state.lateReleases.push(attachedCdp.lateRelease)
    state.browser = attachedCdp.browser
    verifyLaunch()
    if (!attachedCdp.browser) throw finiteError('action-failed')

    const attachedInspector = await attachOwnedMainInspector({
      inspectPort: launch.inspectPort,
      childPid: state.child.pid,
      expectedPaths: state.profile,
      expectedVersion: bound.version,
      timeoutMs: ACTION_TIMEOUT_MS
    })
    state.transportUncertain ||= attachedInspector.transportUncertain
    if (attachedInspector.lateRelease) state.lateReleases.push(attachedInspector.lateRelease)
    state.inspector = attachedInspector.inspector
    verifyLaunch()
    if (!attachedInspector.inspector || !attachedInspector.observation) throw finiteError('action-failed')
    if (!attachedInspector.observation.profileMatches || !attachedInspector.observation.versionMatches) {
      throw finiteError('assertion-failed')
    }

    const win = await findFreshOnboardingPage({
      browser: state.browser,
      call,
      timeoutMs: ACTION_TIMEOUT_MS,
      verifyLaunch
    })
    const fresh = await waitForProbe(async (remaining) => {
      const renderer = await call(
        () =>
          win.evaluate(async () => {
            if (!window.toto?.getSettings) return null
            const settings = await window.toto.getSettings()
            return { onboardingDone: settings.onboardingDone === false }
          }),
        remaining
      )
      return renderer?.onboardingDone === true
    }, ACTION_TIMEOUT_MS)
    markAssertion(state.assertions, 'hermetic-fresh-profile', fresh ? 'PASS' : 'FAIL')
    if (!fresh) throw finiteError('assertion-failed')

    await runFreshOnboardingBaselineFlow({
      win,
      timeoutMs: ACTION_TIMEOUT_MS,
      call,
      nativeFullDisplay: async (timeoutMs = ACTION_TIMEOUT_MS) => {
        const observation = await state.inspector.observe(
          { childPid: state.child.pid, expectedPaths: state.profile, expectedVersion: bound.version },
          timeoutMs
        )
        if (observation.kind !== 'ready') throw finiteError('action-failed')
        return observation.observation.nativeFullDisplay
      },
      mark: (id, status) => markAssertion(state.assertions, id, status)
    })
    state.outcome = 'PASS'
    state.failure = 'none'
  } catch (error) {
    if (state.failure === 'none') state.failure = mapFlowFailure(error)
    state.outcome = error?.outcome === 'PRECONDITION' ? 'PRECONDITION' : 'FAIL'
  } finally {
    if (state.launchAttempted) {
      const result = await teardownThenDispose({
        child: state.ownershipCaptured ? state.child : null,
        stop: state.stopOwnedChild,
        normalize: state.normalizeTeardown,
        dispose: () =>
          state.disposeFreshOnboardingTransports(
            {
              inspector: state.inspector,
              browser: state.browser,
              transportUncertain: state.transportUncertain,
              lateReleases: state.lateReleases
            },
            RELEASE_TIMEOUT_MS
          )
      })
      state.teardown = result.teardown
      state.transportReleased = result.transportReleased
      markAssertion(state.assertions, 'teardown-acknowledged', result.teardown === 'ACKNOWLEDGED' ? 'PASS' : 'FAIL')
      if (result.teardown !== 'ACKNOWLEDGED') {
        preserveFirstFailure(state, 'teardown-unacknowledged')
      } else if (!result.transportReleased) {
        preserveFirstFailure(state, 'transport-release-failed')
      } else if (state.profile) {
        try {
          rmSync(state.profile.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
        } catch {
          preserveFirstFailure(state, 'profile-cleanup-failed')
        }
      }
    }
  }
  return state
}

async function main(argv) {
  const state = await execute(argv)
  const report = createFreshOnboardingReport({
    outcome: state.outcome,
    identity: state.identity,
    assertions: state.assertions,
    failure: state.failure,
    teardown: state.teardown
  })
  if (!state.output) return { exitCode: 1, outcome: 'FAIL', failure: 'report-write-failed' }
  try {
    writeReport(state.output, report)
  } catch {
    return { exitCode: 1, outcome: 'FAIL', failure: 'report-write-failed' }
  }
  return {
    exitCode: report.outcome === 'PASS' ? 0 : report.outcome === 'PRECONDITION' ? 2 : 1,
    outcome: report.outcome,
    failure: report.failure
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then(({ exitCode, outcome, failure }) => {
      process.stdout.write(`fresh-onboarding-baseline ${outcome} ${failure}\n`)
      process.exitCode = exitCode
    })
    .catch(() => {
      process.stdout.write('fresh-onboarding-baseline FAIL harness-error\n')
      process.exitCode = 1
    })
}
