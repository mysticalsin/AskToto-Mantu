// Evidence record schema and parsing (ADR-017, M2-0002).
//
// A record is one immutable, checkable fact about one ticket's evidence: a commit, a CI run id, a file
// hash, a named session — never prose standing in for one of those. This module is the schema as code
// (record.mjs is the single source of truth; the program evidence schema prose lives outside this public
// repository). It validates one record in isolation (recordProblems) and reads the
// append-only, one-file-per-ticket JSONL store (readRecordStore). It never judges whether a ticket may
// close — that is scripts/evidence/check.mjs, which needs the ledger too.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const EVIDENCE_LEVELS = Object.freeze([
  'DESIGNED', 'LOCALLY_TESTED', 'HOST_CONFIGURED', 'LIVE_VERIFIED', 'ACCEPTED', 'MEASURED'
])
export const KIT_STATUSES = Object.freeze(['MET', 'PARTIAL', 'BLOCKED', 'NOT_MET'])
export const RECORD_SCHEMA = 1

const TICKET_RE = /^M2-\d{4}$/
const SHA1_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SESSION_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const HOST_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/
const ENVIRONMENT_KINDS = Object.freeze(['ci', 'qa-mac', 'windows-laptop', 'windows-runner', 'owner-mac'])
const CAPABILITY_RE = /^[a-z0-9][a-z0-9._-]*$/
const DECISION_RE = /^D-\d+$/
const TEST_PATH_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
const TEST_ONLY_SEGMENT_RE = /(?:^|\/)(?:__mocks__|fixtures|test)\//
const FILE_NAME_RE = /^M2-\d{4}\.jsonl$/
// A user home path or an email address must never appear in a record (INV-7): records are published
// verbatim into public pull request bodies.
const USER_PATH_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\]+/i
const EMAIL_RE = /[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}/

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const present = (value) => value !== undefined && value !== null
const isRelPath = (value) => {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.startsWith('/') || value.includes('\\')) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}
const isTestOnlyPath = (value) => TEST_PATH_RE.test(value) || TEST_ONLY_SEGMENT_RE.test(value)

function isTicketId(value) {
  return typeof value === 'string' && TICKET_RE.test(value) ? null : 'ticket: expected an id like M2-0002'
}
function isEvidenceLevel(value) {
  return EVIDENCE_LEVELS.includes(value) ? null : `evidence_level: expected one of ${EVIDENCE_LEVELS.join(', ')}`
}
function isInstant(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && !Number.isNaN(Date.parse(value))
    ? null
    : 'recorded_at: expected a UTC instant YYYY-MM-DDTHH:MM:SSZ'
}
function isKitStatusMap(value) {
  if (!isPlainObject(value)) return 'kit_refs: expected an object'
  for (const [ref, status] of Object.entries(value)) {
    if (ref.length === 0) return 'kit_refs: keys must be non-empty strings'
    if (!KIT_STATUSES.includes(status)) return `kit_refs.${ref}: expected one of ${KIT_STATUSES.join(', ')}`
  }
  return null
}
function isFindingRefs(value) {
  if (!Array.isArray(value)) return 'finding_refs: expected an array'
  return value.every((entry) => typeof entry === 'string' && entry.length > 0)
    ? null
    : 'finding_refs: expected non-empty strings'
}
function isSha1(value) {
  return typeof value === 'string' && SHA1_RE.test(value) ? null : 'commit: expected 40 lowercase hex characters'
}
function isResult(value) {
  return value === 'PASS' || value === 'FAIL' ? null : 'result: expected PASS or FAIL'
}
function isSessionField(label) {
  return (value) => {
    if (!isPlainObject(value)) return `${label}: expected an object`
    if (typeof value.model !== 'string' || !SESSION_MODEL_RE.test(value.model)) {
      return `${label}.model: expected a lowercase dotted id (e.g. claude-sonnet-5)`
    }
    if (typeof value.id !== 'string' || !SESSION_ID_RE.test(value.id)) {
      return `${label}.id: expected an opaque session id, never a name or email`
    }
    return null
  }
}
function isPositiveInt(label) {
  return (value) => Number.isInteger(value) && value > 0 ? null : `${label}: expected a positive integer`
}
function isSha256Field(label) {
  return (value) => typeof value === 'string' && SHA256_RE.test(value) ? null : `${label}: expected 64 lowercase hex characters`
}
function isEnvironment(value) {
  if (!isPlainObject(value)) return 'environment: expected an object'
  if (!ENVIRONMENT_KINDS.includes(value.kind)) return `environment.kind: expected one of ${ENVIRONMENT_KINDS.join(', ')}`
  if (typeof value.host !== 'string' || !HOST_RE.test(value.host)) return 'environment.host: expected a registered lowercase label'
  return null
}
function isCommand(value) {
  return typeof value === 'string' && value.length > 0 && !/\r|\n/.test(value)
    ? null
    : 'command: expected a non-empty single-line string'
}
function isExitCode(value) {
  return Number.isInteger(value) ? null : 'exit_code: expected an integer'
}
function isProgramPath(value) {
  return isRelPath(value) ? null : 'output.path: expected a relative path with no leading /, no \\, and no . or .. segment'
}
function isOutput(value) {
  if (!isPlainObject(value)) return 'output: expected an object'
  const pathProblem = isProgramPath(value.path)
  if (pathProblem) return pathProblem
  return isSha256Field('output.sha256')(value.sha256)
}
function isOwnerStatement(value) {
  if (!isPlainObject(value)) return 'owner_statement: expected an object'
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || Number.isNaN(Date.parse(value.date))) {
    return 'owner_statement.date: expected YYYY-MM-DD'
  }
  if (typeof value.text !== 'string' || value.text.length === 0) return 'owner_statement.text: expected a non-empty string'
  return null
}
function isRepro(value) {
  if (!isPlainObject(value)) return 'repro: expected an object'
  if (!isRelPath(value.test) || !TEST_PATH_RE.test(value.test)) return 'repro.test: expected a test path (.test. or .spec.)'
  if (typeof value.commit !== 'string' || !SHA1_RE.test(value.commit)) return 'repro.commit: expected 40 lowercase hex characters'
  if (!Number.isInteger(value.ci_run_id) || value.ci_run_id <= 0) return 'repro.ci_run_id: expected a positive integer'
  return null
}
function isDecisionIds(value) {
  if (!Array.isArray(value)) return 'assumed_decisions: expected an array'
  return value.every((entry) => typeof entry === 'string' && DECISION_RE.test(entry))
    ? null
    : 'assumed_decisions: expected ids like D-13'
}
function isInheritedBlock(value) {
  if (!Array.isArray(value)) return 'inherited_block: expected an array'
  const bad = value.some((entry) => !isPlainObject(entry) ||
    typeof entry.ticket !== 'string' || !TICKET_RE.test(entry.ticket) ||
    typeof entry.unblock_step !== 'string' || entry.unblock_step.length === 0)
  return bad ? 'inherited_block: expected { ticket, unblock_step } entries' : null
}
function isWired(value) {
  if (!isPlainObject(value)) return 'wired: expected an object'
  const { client, contract_fake: contractFake, probe, capability, unblock_step: unblockStep, ...rest } = value
  if (Object.keys(rest).length > 0) return `wired.${Object.keys(rest)[0]}: unexpected key`
  if (!isRelPath(client) || isTestOnlyPath(client)) return 'wired.client: expected a real (non-test-only) repo path'
  if (!isRelPath(contractFake) || !isTestOnlyPath(contractFake)) return 'wired.contract_fake: expected a test-only repo path'
  if (typeof probe !== 'string' || probe.length === 0 || /&&|\|\||;|\|/.test(probe) || /\r|\n/.test(probe)) {
    return 'wired.probe: expected one command with no &&, ||, ; or |'
  }
  if (typeof capability !== 'string' || !CAPABILITY_RE.test(capability)) return 'wired.capability: expected a lowercase capability id'
  if (typeof unblockStep !== 'string' || unblockStep.length === 0) return 'wired.unblock_step: expected a non-empty string'
  return null
}

// Every known field, always valid to check even when the current level does not require it (§3).
const FIELDS = {
  schema: (value) => value === RECORD_SCHEMA ? null : `schema: expected the number ${RECORD_SCHEMA}`,
  ticket: isTicketId,
  evidence_level: isEvidenceLevel,
  recorded_at: isInstant,
  kit_refs: isKitStatusMap,
  finding_refs: isFindingRefs,
  commit: isSha1,
  result: isResult,
  implementer_session: isSessionField('implementer_session'),
  validator_session: isSessionField('validator_session'),
  pr: isPositiveInt('pr'),
  ci_run_id: isPositiveInt('ci_run_id'),
  environment: isEnvironment,
  command: isCommand,
  exit_code: isExitCode,
  output: isOutput,
  artifact_sha256: isSha256Field('artifact_sha256'),
  build_run_id: isPositiveInt('build_run_id'),
  owner_statement: isOwnerStatement,
  repro: isRepro,
  reexecuted_by: isSessionField('reexecuted_by'),
  assumed_decisions: isDecisionIds,
  inherited_block: isInheritedBlock,
  wired: isWired
}

const ALWAYS = Object.freeze([
  'schema', 'ticket', 'evidence_level', 'recorded_at', 'kit_refs', 'finding_refs',
  'commit', 'result', 'implementer_session', 'validator_session'
])

const LEVEL_REQUIRES = Object.freeze({
  DESIGNED: [],
  LOCALLY_TESTED: ['pr', 'ci_run_id', 'environment', 'command', 'exit_code'],
  HOST_CONFIGURED: ['environment', 'command', 'exit_code', 'output'],
  LIVE_VERIFIED: ['artifact_sha256', 'build_run_id', 'environment', 'command', 'exit_code', 'output'],
  MEASURED: ['environment', 'command', 'exit_code', 'output'],
  ACCEPTED: ['owner_statement']
})

function* walkStrings(value, path) {
  if (typeof value === 'string') {
    yield [path, value]
  } else if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) yield* walkStrings(entry, `${path}[${index}]`)
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) yield* walkStrings(entry, path ? `${path}.${key}` : key)
  }
}

function unsafePaths(record) {
  const paths = []
  for (const [path, value] of walkStrings(record, '')) {
    if (USER_PATH_RE.test(value) || EMAIL_RE.test(value)) paths.push(path)
  }
  return paths
}

/**
 * Validates one record in isolation (context-free: no ledger, no ticket). Returns a list of problem
 * strings; an empty list means the record is well-formed. Includes the record-local cross-field rules
 * R-SEP, R-REEX, R-EXIT, R-REPRO, R-WIRED, R-DESIGNED and R-SAFE.
 * @param {unknown} record
 * @returns {string[]}
 */
export function recordProblems(record) {
  if (!isPlainObject(record)) return ['record: expected an object']
  const problems = []
  const has = (key) => present(record[key])

  for (const key of Object.keys(record)) {
    if (!(key in FIELDS)) problems.push(`${key}: unexpected key`)
  }
  for (const key of ALWAYS) {
    if (!has(key)) problems.push(`${key}: required`)
  }
  for (const key of Object.keys(FIELDS)) {
    if (has(key)) {
      const problem = FIELDS[key](record[key])
      if (problem) problems.push(problem)
    }
  }

  const level = record.evidence_level
  if (EVIDENCE_LEVELS.includes(level)) {
    for (const key of LEVEL_REQUIRES[level]) {
      if (!has(key)) problems.push(`${key}: required for ${level}`)
    }
    if (level === 'DESIGNED' && !has('output') && !has('pr')) {
      problems.push('DESIGNED requires output or pr (a design document lives in the program repo or is proven by its own PR)')
    }
    if (has('environment') && isPlainObject(record.environment)) {
      const kind = record.environment.kind
      if (level === 'LOCALLY_TESTED' && kind !== 'ci') {
        problems.push(`environment.kind: expected 'ci' for ${level}`)
      }
      if ((level === 'HOST_CONFIGURED' || level === 'LIVE_VERIFIED') && kind === 'ci') {
        problems.push(`environment.kind: must not be 'ci' for ${level}`)
      }
    }
  }

  if (has('command') !== has('exit_code')) {
    problems.push('exit_code: required exactly when command is present')
  }
  if (has('command') && has('exit_code') && has('result')) {
    const exitIsZero = record.exit_code === 0
    if ((record.result === 'PASS') !== exitIsZero) {
      problems.push('exit_code: result PASS requires exit_code 0, and FAIL requires a non-zero exit_code')
    }
  }

  if (has('implementer_session') && has('validator_session') &&
      isPlainObject(record.implementer_session) && isPlainObject(record.validator_session) &&
      record.implementer_session.id === record.validator_session.id) {
    problems.push('validator_session.id: must differ from implementer_session.id (a reviewer never approves its own work)')
  }

  if (has('reexecuted_by') && isPlainObject(record.reexecuted_by) && isPlainObject(record.implementer_session)) {
    if (record.reexecuted_by.model === record.implementer_session.model) {
      problems.push('reexecuted_by.model: must differ from implementer_session.model (a re-execution uses a different model)')
    }
    const usedIds = [record.implementer_session.id, record.validator_session?.id]
    if (usedIds.includes(record.reexecuted_by.id)) {
      problems.push('reexecuted_by.id: must be a fresh session id, not the implementer\'s or validator\'s')
    }
  }

  if (has('repro') && isPlainObject(record.repro) && has('commit') && record.repro.commit === record.commit) {
    problems.push('repro.commit: must differ from commit (the red run precedes the green one)')
  }

  if (has('kit_refs') && isPlainObject(record.kit_refs)) {
    for (const [ref, status] of Object.entries(record.kit_refs)) {
      if (status === 'BLOCKED' && (!has('wired') || isWired(record.wired))) {
        problems.push(`kit_refs.${ref}: BLOCKED without a complete, valid wired counts as NOT_MET`)
      }
    }
  }

  for (const path of unsafePaths(record)) {
    problems.push(`${path}: must not contain a user home path or an email address`)
  }

  return problems
}

/**
 * Parses one ticket's record file (JSONL): one compact JSON object per line, 1-based line numbers.
 * Reports a malformed line or a blank interior line as a problem; it does not run recordProblems (that
 * is readRecordStore's job, once we know which file/ticket the line belongs to).
 * @param {string} text
 * @returns {{records: {record: object, line: number}[], problems: string[]}}
 */
export function parseRecordLines(text) {
  const lines = text.split(/\r\n|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop() // a single trailing newline is allowed
  const records = []
  const problems = []
  lines.forEach((line, index) => {
    const lineNo = index + 1
    if (line.trim().length === 0) {
      problems.push(`${lineNo}: blank line`)
      return
    }
    try {
      records.push({ record: JSON.parse(line), line: lineNo })
    } catch (error) {
      problems.push(`${lineNo}: invalid JSON: ${error.message}`)
    }
  })
  return { records, problems }
}

const EVIDENCE_FENCE_OPEN_RE = /^```json evidence[ \t]*$/
const FENCE_CLOSE_RE = /^```[ \t]*$/

/**
 * Extracts every fenced ` ```json evidence ` block from a pull request body. HTML comments are stripped
 * first, so template comments never parse as a record. A plain ` ```json ` block is not a record.
 * @param {string} body
 * @returns {{records: object[], problems: string[]}}
 */
export function recordsInPrBody(body) {
  const stripped = (body ?? '').replace(/<!--[\s\S]*?-->/g, '')
  const lines = stripped.split(/\r\n|\n/)
  const records = []
  const problems = []
  let index = 0
  while (index < lines.length) {
    if (!EVIDENCE_FENCE_OPEN_RE.test(lines[index])) {
      index += 1
      continue
    }
    const start = index + 1
    let end = start
    while (end < lines.length && !FENCE_CLOSE_RE.test(lines[end])) end += 1
    try {
      records.push(JSON.parse(lines.slice(start, end).join('\n')))
    } catch (error) {
      problems.push(`evidence block starting at line ${start}: invalid JSON: ${error.message}`)
    }
    index = end + 1
  }
  return { records, problems }
}

/**
 * The last record of each level, in array order (INV-2: for each level, the last line governs).
 * @param {object[]} records
 * @returns {Map<string, object>}
 */
export function latestByLevel(records) {
  const map = new Map()
  for (const record of records) {
    if (record && EVIDENCE_LEVELS.includes(record.evidence_level)) map.set(record.evidence_level, record)
  }
  return map
}

/**
 * Reads every ticket's record file from a directory. A missing directory is an empty store, not an
 * error (a program with no records yet). Dotfiles (.gitkeep) are ignored; any other unexpected file
 * name, a line whose ticket does not match its file stem, or an invalid record line is reported and
 * excluded from the returned map — only valid, correctly-filed records count as evidence.
 * @param {string} dir
 * @returns {{recordsByTicket: Map<string, object[]>, problems: string[]}}
 */
export function readRecordStore(dir) {
  const recordsByTicket = new Map()
  const problems = []
  if (!existsSync(dir)) return { recordsByTicket, problems }

  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue
    if (!FILE_NAME_RE.test(name)) {
      problems.push(`records/${name}: unexpected file name`)
      continue
    }
    const stem = name.slice(0, -'.jsonl'.length)
    const { records, problems: parseProblems } = parseRecordLines(readFileSync(join(dir, name), 'utf8'))
    for (const problem of parseProblems) problems.push(`records/${name}:${problem}`)

    const valid = []
    for (const { record, line } of records) {
      const recordIssues = recordProblems(record)
      if (recordIssues.length > 0) {
        for (const issue of recordIssues) problems.push(`records/${name}:${line}: ${issue}`)
        continue
      }
      if (record.ticket !== stem) {
        problems.push(`records/${name}:${line}: ticket ${record.ticket} does not match file ${stem}`)
        continue
      }
      valid.push(record)
    }
    if (valid.length > 0) recordsByTicket.set(stem, valid)
  }
  return { recordsByTicket, problems }
}

/**
 * @param {string | Buffer} bytesOrString
 * @returns {string} lowercase hex sha256
 */
export function sha256Hex(bytesOrString) {
  return createHash('sha256').update(bytesOrString).digest('hex')
}
