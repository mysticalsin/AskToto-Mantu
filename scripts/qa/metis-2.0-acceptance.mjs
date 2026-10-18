// Stage A accepts a closed selection envelope and exact, caller-supplied candidate bindings.
// These pure checks do not authenticate GitHub, verify artifact bytes, establish lifecycle PASS, or
// authorize either publisher. Production publishers remain fail-closed and do not call this module.
import { provenanceProblems } from './provenance.mjs'

const REPOSITORY = 'mysticalsin/AskToto-Mantu'
const REPOSITORY_ID = 1282463398
const WORKFLOW_PATH = '.github/workflows/qa-candidate.yml'
const ARTIFACT_NAME = 'candidate-provenance'
const SCHEMA = 'metis.acceptance-selection.v1'
const MAX_SELECTION_BYTES = 32 * 1024
const MAX_REPORTS = 64
const MAX_LOCATOR_LENGTH = 240
const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_SHA = /^[0-9a-f]{40}$/
const CANONICAL_ID = /^[1-9][0-9]*$/
const PRERELEASE_ID = '(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
const VERSION = new RegExp(`^2\\.0\\.(?:0|[1-9][0-9]*)(?:-${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*)?$`)
const LOCATOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$/
const REPORT_KINDS = new Set([
  'freeze',
  'source-quality',
  'installed-lifecycle',
  'upgrade',
  'rollback',
  'live-capture',
  'provider-qualification',
  'release-decision',
  'owner-acceptance'
])

const SELECTION_CODES = Object.freeze({
  shape: 'SELECTION_SHAPE',
  size: 'SELECTION_TOO_LARGE',
  keys: 'SELECTION_KEYS',
  schema: 'SELECTION_SCHEMA',
  version: 'SELECTION_VERSION',
  candidate: 'SELECTION_CANDIDATE',
  reports: 'SELECTION_REPORTS',
  report: 'SELECTION_REPORT',
  duplicate: 'SELECTION_DUPLICATE_REPORT'
})

const BINDING_CODES = Object.freeze({
  observedShape: 'OBSERVED_SHAPE',
  repository: 'OBSERVED_REPOSITORY',
  workflow: 'OBSERVED_WORKFLOW',
  run: 'OBSERVED_RUN',
  artifact: 'OBSERVED_ARTIFACT',
  provenance: 'OBSERVED_PROVENANCE',
  provenanceBytes: 'OBSERVED_PROVENANCE_BYTES',
  payloadManifest: 'OBSERVED_PAYLOAD_MANIFEST'
})

const isRecord = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const fullMatch = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key))
}

const positiveId = (value) => fullMatch(CANONICAL_ID, value) && Number.isSafeInteger(Number(value))
const hash = (value) => fullMatch(SHA256, value)
const observedId = (value) => Number.isSafeInteger(value) && value > 0

function provenanceAssetHashesAreStrict(provenance) {
  return (
    Array.isArray(provenance.builds) &&
    provenance.builds.every(
      (build) =>
        isRecord(build) &&
        Array.isArray(build.assets) &&
        build.assets.every((asset) => isRecord(asset) && fullMatch(SHA256, asset.sha256))
    )
  )
}

function selectionSizeProblems(selection) {
  try {
    const json = JSON.stringify(selection)
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_SELECTION_BYTES) {
      return [SELECTION_CODES.size]
    }
    return []
  } catch {
    return [SELECTION_CODES.shape]
  }
}

/** @param {unknown} selection @returns {string[]} */
export function acceptanceSelectionProblems(selection) {
  const problems = new Set()
  try {
    for (const code of selectionSizeProblems(selection)) problems.add(code)
    if (!isRecord(selection)) return [SELECTION_CODES.shape]
    if (!hasExactKeys(selection, ['schema', 'candidate', 'reports'])) problems.add(SELECTION_CODES.keys)
    if (selection.schema !== SCHEMA) problems.add(SELECTION_CODES.schema)

    const candidateKeys = [
      'version',
      'run_id',
      'attempt',
      'source_sha',
      'provenance_artifact_id',
      'provenance_artifact_name',
      'provenance_archive_sha256',
      'provenance_member_sha256',
      'payload_manifest_sha256'
    ]
    const candidate = selection.candidate
    if (!isRecord(candidate) || !fullMatch(VERSION, candidate.version)) {
      problems.add(SELECTION_CODES.version)
    }
    if (!hasExactKeys(candidate, candidateKeys)) {
      problems.add(SELECTION_CODES.candidate)
    } else if (
      !fullMatch(VERSION, candidate.version) ||
      !positiveId(candidate.run_id) ||
      candidate.attempt !== 1 ||
      !fullMatch(SOURCE_SHA, candidate.source_sha) ||
      !positiveId(candidate.provenance_artifact_id) ||
      candidate.provenance_artifact_name !== ARTIFACT_NAME ||
      !hash(candidate.provenance_archive_sha256) ||
      !hash(candidate.provenance_member_sha256) ||
      !hash(candidate.payload_manifest_sha256)
    ) {
      problems.add(SELECTION_CODES.candidate)
    }

    if (!Array.isArray(selection.reports) || selection.reports.length < 1 || selection.reports.length > MAX_REPORTS) {
      problems.add(SELECTION_CODES.reports)
    } else {
      const reportIds = new Set()
      for (const report of selection.reports) {
        if (
          !hasExactKeys(report, [
            'kind',
            'run_id',
            'attempt',
            'artifact_id',
            'artifact_sha256',
            'report_member',
            'report_sha256'
          ]) ||
          typeof report.kind !== 'string' ||
          !REPORT_KINDS.has(report.kind) ||
          !positiveId(report.run_id) ||
          report.attempt !== 1 ||
          !positiveId(report.artifact_id) ||
          !hash(report.artifact_sha256) ||
          typeof report.report_member !== 'string' ||
          report.report_member.length > MAX_LOCATOR_LENGTH ||
          !fullMatch(LOCATOR, report.report_member) ||
          !report.report_member.endsWith('.json') ||
          !hash(report.report_sha256)
        ) {
          problems.add(SELECTION_CODES.report)
          continue
        }
        const identity = `${report.run_id}/${report.attempt}/${report.artifact_id}/${report.report_member}`
        if (reportIds.has(identity)) problems.add(SELECTION_CODES.duplicate)
        reportIds.add(identity)
      }
    }
  } catch {
    problems.add(SELECTION_CODES.shape)
  }
  return [...problems]
}

function observedShapeProblems(observed) {
  const problems = new Set()
  try {
    if (
      !hasExactKeys(observed, [
        'repository',
        'workflow',
        'run',
        'artifact',
        'provenance',
        'provenance_member_sha256',
        'payload_manifest_sha256'
      ])
    )
      return [BINDING_CODES.observedShape]
    if (!hasExactKeys(observed.repository, ['full_name', 'id'])) problems.add(BINDING_CODES.observedShape)
    if (!hasExactKeys(observed.workflow, ['path'])) problems.add(BINDING_CODES.observedShape)
    if (
      !hasExactKeys(observed.run, ['id', 'event', 'head_branch', 'status', 'conclusion', 'run_attempt', 'head_sha'])
    ) {
      problems.add(BINDING_CODES.observedShape)
    }
    if (!hasExactKeys(observed.artifact, ['id', 'name', 'expired', 'digest', 'workflow_run'])) {
      problems.add(BINDING_CODES.observedShape)
    } else if (!hasExactKeys(observed.artifact.workflow_run, ['id', 'head_sha'])) {
      problems.add(BINDING_CODES.observedShape)
    }
    if (!isRecord(observed.provenance)) problems.add(BINDING_CODES.observedShape)
  } catch {
    problems.add(BINDING_CODES.observedShape)
  }
  return [...problems]
}

/** @param {unknown} selection @param {unknown} observed @returns {string[]} */
export function candidateBindingProblems(selection, observed) {
  const problems = new Set(acceptanceSelectionProblems(selection))
  for (const code of observedShapeProblems(observed)) problems.add(code)
  try {
    if (!isRecord(selection) || !isRecord(selection.candidate) || !isRecord(observed)) return [...problems]
    const candidate = selection.candidate
    const run = observed.run
    const artifact = observed.artifact
    const provenance = observed.provenance
    if (!isRecord(run) || !isRecord(artifact) || !isRecord(artifact.workflow_run) || !isRecord(provenance)) {
      return [...problems]
    }

    if (
      !isRecord(observed.repository) ||
      observed.repository.full_name !== REPOSITORY ||
      observed.repository.id !== REPOSITORY_ID
    )
      problems.add(BINDING_CODES.repository)
    if (!isRecord(observed.workflow) || observed.workflow.path !== WORKFLOW_PATH) problems.add(BINDING_CODES.workflow)
    if (
      !observedId(run.id) ||
      String(run.id) !== candidate.run_id ||
      run.event !== 'workflow_dispatch' ||
      run.head_branch !== 'main' ||
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      run.run_attempt !== 1 ||
      run.run_attempt !== candidate.attempt ||
      run.head_sha !== candidate.source_sha
    )
      problems.add(BINDING_CODES.run)
    if (
      !observedId(artifact.id) ||
      String(artifact.id) !== candidate.provenance_artifact_id ||
      artifact.name !== ARTIFACT_NAME ||
      artifact.expired !== false ||
      artifact.digest !== `sha256:${candidate.provenance_archive_sha256}` ||
      !observedId(artifact.workflow_run.id) ||
      String(artifact.workflow_run.id) !== candidate.run_id ||
      artifact.workflow_run.head_sha !== candidate.source_sha
    )
      problems.add(BINDING_CODES.artifact)

    // provenance.json uses JSON-number run ids. Selection IDs stay canonical strings; compare only
    // after proving the observed provenance number is a safe positive integer.
    const provenanceRunId =
      Number.isSafeInteger(provenance.run?.id) && provenance.run.id > 0 ? String(provenance.run.id) : null
    if (
      provenanceProblems(provenance).length > 0 ||
      !provenanceAssetHashesAreStrict(provenance) ||
      provenance.repository !== REPOSITORY ||
      provenance.version !== candidate.version ||
      provenance.commit !== candidate.source_sha ||
      provenanceRunId !== candidate.run_id ||
      provenance.run?.attempt !== candidate.attempt
    )
      problems.add(BINDING_CODES.provenance)
    if (
      !hash(observed.provenance_member_sha256) ||
      observed.provenance_member_sha256 !== candidate.provenance_member_sha256
    ) {
      problems.add(BINDING_CODES.provenanceBytes)
    }
    if (
      !hash(observed.payload_manifest_sha256) ||
      observed.payload_manifest_sha256 !== candidate.payload_manifest_sha256
    ) {
      problems.add(BINDING_CODES.payloadManifest)
    }
  } catch {
    problems.add(BINDING_CODES.observedShape)
  }
  return [...problems]
}
