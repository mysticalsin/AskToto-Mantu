#!/usr/bin/env node
// Disposable, hosted-only readback of one fixed-enum Windows diagnostic. Remove within 48 hours.
// Producer run 37771807736 succeeded; the separate 15-second acceptance run 37957295344 failed.
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { probeReportProblems } from './windows-cdp-probe.mjs'
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
const REPORT = 'cdp-probe.json'
const MEMBERS = Object.freeze({ [REPORT]: 2_048 })
const DEADLINE_MS = 120_000

/** There are no CLI inputs, workflow inputs, or environment overrides for this source. */
export const PIN = Object.freeze({
  run: 37977003212,
  job: 113977846046,
  head: '554ffa2eac1b16537ef40082df755352ce9e576a',
  artifact: Object.freeze({
    id: 11638794052,
    name: 'windows-cdp-diagnostic-spike',
    size: 502,
    sha: '5b15cea39fa3458f09643785ad9c913dddbb3729c35c2ae7426aa52a76e9a655'
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
const requireValue = (value, code) => {
  if (!value) throw new ReadbackError(code)
}
export const closedReadbackFailure = (error) =>
  error instanceof ReadbackError && CODES.has(error.code) ? error.code : 'readback-rejected'
const decodeText = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

export function verifyRun(value) {
  requireValue(
    value?.id === PIN.run &&
      value.path === '.github/workflows/windows-cdp-diagnostic-spike.yml' &&
      value.event === 'workflow_dispatch' &&
      value.head_branch === 'main' &&
      value.head_sha === PIN.head &&
      value.run_attempt === 1 &&
      value.status === 'completed' &&
      value.conclusion === 'success' &&
      [value.repository, value.head_repository].every(
        (repo) => repo?.id === REPOSITORY_ID && repo.full_name === REPOSITORY
      ),
    'metadata-rejected'
  )
}

export function verifyJob(value) {
  const requiredSteps = [
    ['Install the pinned Setup into a fresh directory', 'success'],
    ['Observe exact owned process with unchanged 15-second boundary', 'success'],
    ['Validate the only uploadable fixed-enum report', 'success'],
    ['Upload validated diagnostic only', 'success'],
    ['Fail unless observation and content-free gate completed', 'skipped']
  ]
  requireValue(
    value?.id === PIN.job &&
      value.name === 'probe' &&
      value.run_id === PIN.run &&
      value.head_sha === PIN.head &&
      value.status === 'completed' &&
      value.conclusion === 'success' &&
      Array.isArray(value.steps) &&
      value.steps.length <= 64,
    'metadata-rejected'
  )
  let previous = -1
  for (const [name, conclusion] of requiredSteps) {
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

/** Construct a new object from closed fields only; never echo report, identity, paths or URLs. */
export function verifyReport(report) {
  requireValue(
    probeReportProblems(report).length === 0 && report.identity.harness_commit === PIN.head,
    'report-rejected'
  )
  return {
    diagnostic_only: true,
    acceptance_15s: report.acceptance_15s,
    cdp_45s: report.cdp_45s,
    inspector_45s: report.inspector_45s,
    process_at_end: report.process_at_end,
    teardown: report.teardown,
    transport_release: report.transport_release
  }
}

/** Metadata is proven before any archive request; every route and transfer cap is fixed. */
export async function loadPinnedEvidence(read) {
  const json = async (route) => decodeJson(await read(route, 65_536), 65_536)
  verifyRun(await json(`runs/${PIN.run}`))
  verifyJob(await json(`jobs/${PIN.job}`))
  verifyArtifact(await json(`artifacts/${PIN.artifact.id}`))
  return read(`artifacts/${PIN.artifact.id}/zip`, PIN.artifact.size)
}

/** Inspect the one regular member with unzip -p; never extract an archive path. */
export async function readArchive(bytes, expectedArchive, dir, deadline) {
  requireValue(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      Number.isSafeInteger(expectedArchive?.size) &&
      expectedArchive.size > 0 &&
      expectedArchive.size <= 8_192,
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
  const names = manifestNames(decodeText(await unzip(['-Z', '-1', archive], 4_096)), [REPORT])
  requireValue(names.length === 1 && names[0] === REPORT, 'archive-rejected')
  const sizes = selectedSizes(decodeText(await unzip(['-Z', '-l', archive, REPORT], 4_096)), MEMBERS)
  const member = await unzip(['-p', archive, REPORT], MEMBERS[REPORT])
  requireValue(member.length === sizes[REPORT], 'archive-rejected')
  const text = decodeText(member)
  const report = JSON.parse(text)
  requireValue(text === `${JSON.stringify(report)}\n`, 'report-rejected')
  return verifyReport(report)
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
      process.argv.length === 2 &&
      Date.now() < Date.parse('2026-10-11T18:00:00Z'),
    'owner-state-rejected'
  )
  const deadline = performance.now() + DEADLINE_MS
  const read = (route, cap) => getBytes(route, { cap, deadline, token: env.GH_TOKEN })
  const bytes = await loadPinnedEvidence(read)
  const dir = mkdtempSync(join(env.RUNNER_TEMP, 'metis-cdp-readback-'))
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
  process.stdout.write('windows-cdp-readback: diagnostic only; no product acceptance established\n')
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`windows-cdp-readback: ${closedReadbackFailure(error)}\n`)
    process.exitCode = 1
  })
}
