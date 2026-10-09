#!/usr/bin/env node
// One hosted readback of an already failed, scan-validated Windows candidate artifact.
// This never runs an installer or app and never turns the original FAIL into a PASS.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scanFreshOnboardingOutput } from './candidate-scenarios.mjs'
import {
  ASSERTION_IDS,
  NOT_COVERED,
  assessFreshOnboardingReport,
  reportProblems
} from './fresh-onboarding-baseline.mjs'
import {
  closedFailure,
  decodeJson,
  getBytes,
  manifestNames,
  nativeCanary,
  runUnzip,
  selectedSizes,
  verifyArchiveBytes
} from './retained-profile-analysis.mjs'

const REPOSITORY = 'mysticalsin/AskToto-Mantu'
const REPOSITORY_ID = 1282463398
const REPORT = 'fresh-onboarding-baseline.json'
const LANE = 'lane.json'
const MEMBERS = Object.freeze({ [REPORT]: 65_536, [LANE]: 65_536 })
const LIMIT_MS = 120_000

/** The sole allowed source; no CLI arguments, workflow inputs or environment overrides. */
export const PIN = Object.freeze({
  run: 37957295344,
  job: 113911075050,
  head: '1c2be0b542e89ab7667160237980425a4ef57a88',
  candidateRun: 37771807736,
  producerCommit: '2d4ebe7b6698f78abcb74dc426867d95d96e4268',
  installerSha: 'a5459e1f5137710b3f249a21ae372c13395f083a45319a0bd3f8fce7a44d6ff1',
  artifact: Object.freeze({
    id: 11629006377,
    name: 'candidate-scenario-fresh-onboarding-baseline-win',
    size: 1618,
    sha: 'f153d9376575a077e41b8ae1bafe365e9618edb5d4d1692dc2bfb1fe78590e32'
  })
})

const CODES = new Set([
  'owner-state-rejected',
  'metadata-rejected',
  'archive-rejected',
  'report-rejected',
  'readback-rejected'
])
class ReadbackError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}
const requireValue = (valid, code) => {
  if (!valid) throw new ReadbackError(code)
}
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const decodeText = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
export const closedReadbackFailure = (error) =>
  error instanceof ReadbackError && CODES.has(error.code) ? error.code : 'readback-rejected'

export function verifyRun(value) {
  requireValue(
    value?.id === PIN.run &&
      value.path === '.github/workflows/candidate-scenarios.yml' &&
      value.event === 'workflow_dispatch' &&
      value.head_branch === 'main' &&
      value.head_sha === PIN.head &&
      value.run_attempt === 1 &&
      value.status === 'completed' &&
      value.conclusion === 'failure' &&
      [value.repository, value.head_repository].every(
        (repo) => repo?.id === REPOSITORY_ID && repo.full_name === REPOSITORY
      ),
    'metadata-rejected'
  )
}

export function verifyJob(value) {
  const expectedSteps = [
    ['Install the Setup silently into a fresh directory', 'success'],
    ['Run the scenario', 'success'],
    ['Content-free gate', 'success'],
    ['Upload only validated fresh-onboarding JSON', 'success'],
    ['Fail unless the scenario passed and every file was content-free', 'failure']
  ]
  requireValue(
    value?.id === PIN.job &&
      value.name === 'fresh-onboarding-baseline (Windows)' &&
      value.run_id === PIN.run &&
      value.head_sha === PIN.head &&
      value.status === 'completed' &&
      value.conclusion === 'failure' &&
      Array.isArray(value.steps) &&
      value.steps.length <= 64,
    'metadata-rejected'
  )
  let previous = -1
  for (const [name, conclusion] of expectedSteps) {
    const matching = value.steps.flatMap((step, index) => (step?.name === name ? [index] : []))
    requireValue(matching.length === 1 && matching[0] > previous, 'metadata-rejected')
    requireValue(value.steps[matching[0]].conclusion === conclusion, 'metadata-rejected')
    previous = matching[0]
  }
}

export function verifyArtifact(value) {
  const source = value?.workflow_run
  requireValue(
    value?.id === PIN.artifact.id &&
      value.name === PIN.artifact.name &&
      value.size_in_bytes === PIN.artifact.size &&
      value.digest === `sha256:${PIN.artifact.sha}` &&
      value.expired === false &&
      source?.id === PIN.run &&
      source.repository_id === REPOSITORY_ID &&
      source.head_repository_id === REPOSITORY_ID &&
      source.head_sha === PIN.head,
    'metadata-rejected'
  )
}

const IDENTITY = Object.freeze({
  candidate_run: PIN.candidateRun,
  producer_commit: PIN.producerCommit,
  installer_sha256: PIN.installerSha,
  version: '1.9.7',
  harness_commit: PIN.head,
  platform: 'win32'
})
const EXPECTED = Object.freeze({
  candidateRun: PIN.candidateRun,
  commit: PIN.producerCommit,
  sha256: PIN.installerSha,
  version: '1.9.7',
  harnessCommit: PIN.head,
  platform: 'win32'
})

/** Return only schema-checked enums. The result is diagnostic, not acceptance evidence. */
export function verifyReport(report, lane) {
  requireValue(reportProblems(report).length === 0, 'report-rejected')
  requireValue(
    assessFreshOnboardingReport(report, EXPECTED, { requirePass: false }).problems.length === 0,
    'report-rejected'
  )
  requireValue(
    exact(lane, [
      'schema',
      'scenario',
      'support_only',
      'identity',
      'ci_run_id',
      'exit_code',
      'outcome',
      'report',
      'detail',
      'not_covered'
    ]) &&
      lane.schema === 'metis.fresh-onboarding-lane.v1' &&
      lane.scenario === 'fresh-onboarding-baseline' &&
      lane.support_only === true &&
      lane.ci_run_id === PIN.run &&
      lane.exit_code === 1 &&
      lane.outcome === 'FAIL' &&
      lane.report === REPORT &&
      lane.detail === 'scenario-failed' &&
      same(lane.identity, IDENTITY) &&
      same(lane.not_covered, NOT_COVERED) &&
      report.outcome === 'FAIL' &&
      same(report.identity, IDENTITY),
    'report-rejected'
  )
  // The scanner enforces the complete lane/not-covered schema and report-lane binding on disk.
  return {
    outcome: 'FAIL',
    failure: report.failure,
    teardown: report.teardown,
    cdp_diagnostic: report.cdp_diagnostic,
    assertions: ASSERTION_IDS.map((id, index) => ({ id, status: report.assertions[index].status }))
  }
}

/** Reads selected members with unzip -p; no archive member path is extracted. */
export async function readArchive(bytes, expectedArchive, dir, deadline) {
  requireValue(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      Number.isSafeInteger(expectedArchive?.size) &&
      expectedArchive.size > 0 &&
      expectedArchive.size <= 256 * 1024,
    'archive-rejected'
  )
  verifyArchiveBytes(bytes, expectedArchive)
  const root = lstatSync(dir)
  requireValue(root.isDirectory() && !root.isSymbolicLink(), 'archive-rejected')
  const archive = join(dir, 'source.zip')
  writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 })
  const owned = () => {
    const stat = lstatSync(archive)
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'archive-rejected')
    verifyArchiveBytes(readFileSync(archive), expectedArchive)
  }
  const unzip = (args, cap) => {
    owned()
    return runUnzip(args, { cwd: dir, cap, deadline })
  }
  const names = Object.keys(MEMBERS)
  const listed = manifestNames(decodeText(await unzip(['-Z', '-1', archive], 4096)), names)
  requireValue(listed.length === names.length && names.every((name) => listed.includes(name)), 'archive-rejected')
  const sizes = selectedSizes(decodeText(await unzip(['-Z', '-l', archive, ...names], 8192)), MEMBERS)
  const selectedDir = join(dir, 'selected')
  mkdirSync(selectedDir, { mode: 0o700 })
  const originals = Object.create(null)
  for (const name of names) {
    const member = await unzip(['-p', archive, name], MEMBERS[name])
    requireValue(member.length === sizes[name], 'archive-rejected')
    originals[name] = member
    writeFileSync(join(selectedDir, name), member, { flag: 'wx', mode: 0o600 })
  }
  requireValue(
    scanFreshOnboardingOutput(selectedDir, { identity: IDENTITY, ciRun: PIN.run, laneWritten: true }).length === 0,
    'report-rejected'
  )
  const reportBytes = readFileSync(join(selectedDir, REPORT))
  const laneBytes = readFileSync(join(selectedDir, LANE))
  requireValue(reportBytes.equals(originals[REPORT]) && laneBytes.equals(originals[LANE]), 'archive-rejected')
  const report = decodeJson(reportBytes, MEMBERS[REPORT])
  const lane = decodeJson(laneBytes, MEMBERS[LANE])
  return verifyReport(report, lane)
}

/** Metadata is checked before any archive request; all paths and caps are fixed. */
export async function loadPinnedEvidence(read) {
  const json = async (route) => decodeJson(await read(route, 65_536), 65_536)
  verifyRun(await json(`runs/${PIN.run}`))
  verifyJob(await json(`jobs/${PIN.job}`))
  verifyArtifact(await json(`artifacts/${PIN.artifact.id}`))
  return read(`artifacts/${PIN.artifact.id}/zip`, PIN.artifact.size)
}

async function main() {
  const env = process.env
  requireValue(
    process.platform === 'linux' &&
      env.CI === 'true' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') &&
      typeof env.GH_TOKEN === 'string' &&
      env.GH_TOKEN.length > 0 &&
      isAbsolute(env.RUNNER_TEMP ?? '') &&
      process.argv.length === 2,
    'owner-state-rejected'
  )
  const deadline = performance.now() + LIMIT_MS
  const read = (route, cap) => getBytes(route, { cap, deadline, token: env.GH_TOKEN })
  const bytes = await loadPinnedEvidence(read)
  const dir = mkdtempSync(join(env.RUNNER_TEMP, 'metis-candidate-readback-'))
  chmodSync(dir, 0o700)
  let clean = true
  let result
  try {
    await nativeCanary(dir, deadline)
    result = await readArchive(bytes, PIN.artifact, dir, deadline)
  } catch (error) {
    clean = closedFailure(error) !== 'native-unacknowledged'
    throw error
  } finally {
    if (clean) rmSync(dir, { recursive: true })
  }
  requireValue(performance.now() < deadline, 'readback-rejected')
  process.stdout.write('candidate-report-readback: diagnostic-only; candidate verdict remains FAIL\n')
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`candidate-report-readback: ${closedReadbackFailure(error)}\n`)
    process.exitCode = 1
  })
}
