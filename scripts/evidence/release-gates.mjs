import { basename } from 'node:path'
import { VARIANTS, promotableAssets } from '../qa/provenance.mjs'
import { EVIDENCE_LEVELS, latestByLevel, recordProblems } from './record.mjs'
import { drawSample, populationOf } from './sample.mjs'

export const RELEASE_GATES_SCHEMA = 1

const GATE_ROW_KEYS = new Set(['id', 'ticket', 'level', 'bytes', 'hosts', 'accept', 'match', 'sha256'])
const GATE_BYTES = Object.freeze(['promotable', 'qa-identity', 'baseline'])
const GATE_ACCEPT = Object.freeze(['PASS', 'PASS_OR_STATED', 'REPORT'])
const GATE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const TICKET_RE = /^M2-\d{4}$/
const SHA1_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const sameList = (a, b) => Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b)
const isProgramRelPath = (value) =>
  nonEmptyString(value) && !value.startsWith('/') && !value.includes('\\') &&
  value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')

function gateRowProblems(row, where) {
  if (!isPlainObject(row)) return [`${where}: expected an object`]
  const problems = Object.keys(row).filter((key) => !GATE_ROW_KEYS.has(key)).map((key) => `${where}.${key}: unexpected key`)
  if (!TICKET_RE.test(row.ticket ?? '')) problems.push(`${where}.ticket: expected an id like M2-0046`)
  if (!EVIDENCE_LEVELS.includes(row.level)) problems.push(`${where}.level: expected one of ${EVIDENCE_LEVELS.join(', ')}`)
  if (!GATE_BYTES.includes(row.bytes)) problems.push(`${where}.bytes: expected one of ${GATE_BYTES.join(', ')}`)
  if (!GATE_ACCEPT.includes(row.accept)) problems.push(`${where}.accept: expected one of ${GATE_ACCEPT.join(', ')}`)
  if (!Array.isArray(row.hosts) || row.hosts.length === 0 || !row.hosts.every(nonEmptyString) || new Set(row.hosts).size !== row.hosts.length) {
    problems.push(`${where}.hosts: expected a non-empty array of distinct host labels`)
  }
  if ('match' in row && !nonEmptyString(row.match)) problems.push(`${where}.match: expected a non-empty string`)
  if (row.bytes === 'baseline') {
    if (!Array.isArray(row.sha256) || row.sha256.length === 0 || !row.sha256.every((sha) => SHA256_RE.test(sha))) {
      problems.push(`${where}.sha256: a baseline row needs a non-empty list of 64-hex sha256s`)
    }
  } else if ('sha256' in row) {
    problems.push(`${where}.sha256: only a baseline row lists sha256s; candidate rows bind to the provenance`)
  }
  return problems
}

/** Rows sharing ticket, level and a host are told apart only by `match`, so each needs one no sibling's contains. */
function gateAmbiguityProblems(rows) {
  const problems = []
  const byKey = new Map()
  for (const row of rows) {
    for (const host of row.hosts) {
      const key = `${row.ticket} ${row.level} on ${host}`
      byKey.set(key, [...(byKey.get(key) ?? []), row])
    }
  }
  for (const [key, siblings] of byKey) {
    if (siblings.length < 2) continue
    const ambiguous = siblings.some((row) => row.match === undefined) ||
      siblings.some((row, i) => siblings.some((other, j) => i !== j && other.match.includes(row.match)))
    if (ambiguous) {
      problems.push(`gates: rows ${siblings.map((row) => row.id).join(', ')} share ${key}; each needs a match that no sibling's contains`)
    }
  }
  return problems
}

function provenanceShapeProblems(provenance) {
  if (!isPlainObject(provenance)) return ['provenance: expected an object']
  const problems = []
  if (!SHA1_RE.test(provenance.commit ?? '')) problems.push('provenance.commit: expected 40 lowercase hex characters')
  if (!nonEmptyString(provenance.version)) problems.push('provenance.version: expected a non-empty string')
  if (!(Number.isInteger(provenance.run?.id) && provenance.run.id > 0)) problems.push('provenance.run.id: expected a positive integer')
  const builds = Array.isArray(provenance.builds) ? provenance.builds : null
  if (!builds || !builds.every((build) => isPlainObject(build) && nonEmptyString(build.variant) && Array.isArray(build.assets) &&
      build.assets.every((asset) => isPlainObject(asset) && nonEmptyString(asset.name) && SHA256_RE.test(asset.sha256 ?? '')))) {
    problems.push('provenance.builds: expected [{ variant, assets: [{ name, sha256 }] }]')
  }
  return problems
}

/**
 * Malformed release inputs (the CLI exits 2 on any): the gate file's schema-1 shape, the provenance's
 * shape and the ledger's ticket array. Whether the gates are met is releaseProblems' job.
 * @returns {string[]}
 */
export function releaseInputProblems(gates, provenance, ledger) {
  const problems = []
  if (!isPlainObject(gates)) {
    problems.push('gates: expected an object')
  } else {
    if (gates.schema !== RELEASE_GATES_SCHEMA) problems.push(`gates.schema: expected the number ${RELEASE_GATES_SCHEMA}`)
    if (!nonEmptyString(gates.version)) problems.push('gates.version: expected a non-empty string')
    const rows = Array.isArray(gates.rows) ? gates.rows : []
    if (rows.length === 0) problems.push('gates.rows: expected a non-empty array')
    const rowProblems = rows.flatMap((row, index) => gateRowProblems(row, `gates.rows[${index}]`))
    problems.push(...rowProblems)

    const sample = gates.sample
    if (!isPlainObject(sample) || !TICKET_RE.test(sample.population_of ?? '') || !isProgramRelPath(sample.path) ||
        !(typeof sample.fraction === 'number' && sample.fraction > 0 && sample.fraction <= 1)) {
      problems.push('gates.sample: expected { id, population_of: M2-####, fraction in (0, 1], path: program-relative }')
    }
    if (!isPlainObject(gates.accepted)) problems.push('gates.accepted: expected { id }')

    const ids = [...rows.map((row) => row?.id), sample?.id, gates.accepted?.id]
    for (const id of ids) {
      if (typeof id !== 'string' || !GATE_ID_RE.test(id)) problems.push(`gates: row id ${JSON.stringify(id)} must be a lowercase label`)
    }
    for (const id of new Set(ids.filter((id, i) => typeof id === 'string' && ids.indexOf(id) !== i))) {
      problems.push(`gates: duplicate row id ${id}`)
    }
    if (rowProblems.length === 0) problems.push(...gateAmbiguityProblems(rows))
  }
  problems.push(...provenanceShapeProblems(provenance))
  if (!Array.isArray(ledger?.tickets)) problems.push('ledger: tickets must be an array')
  return problems
}

/** True when `text` contains `token` not directly inside a longer alphanumeric run (run 12 never matches 123). */
function mentions(text, token) {
  return new RegExp(`(?<![0-9A-Za-z])${token}(?![0-9A-Za-z])`).test(text)
}

/** True when a line carries the marker `gate:<id>` for exactly this row id (gate:hk-w never matches gate:hk-w-2). */
function statesGate(text, id) {
  return new RegExp(`(?<![\\w.-])gate:${id.replace(/\./g, '\\.')}(?![\\w-]|\\.\\w)`).test(text)
}

function selectsRecord(row, host, record) {
  if (record.evidence_level !== row.level || record.environment?.host !== host) return false
  return row.match === undefined || [record.output?.path, record.command].some((value) => typeof value === 'string' && value.includes(row.match))
}

/** Why `record` does not bind to the bytes `row` requires, or null when it does. */
function bindingProblem(record, row, candidate) {
  if (record.environment?.kind === 'hosted-runner' && record.ci_run_id == null) return 'is a hosted-runner record with no ci_run_id'
  if (row.bytes === 'baseline') {
    if (record.artifact_sha256 == null) return 'has no artifact_sha256'
    return row.sha256.includes(record.artifact_sha256) ? null : `names sha256 ${record.artifact_sha256}, not one of the baseline sha256s`
  }
  if (record.build_run_id == null) return 'has no build_run_id (required on a candidate-bound row at every level)'
  if (record.build_run_id !== candidate.runId) return `is bound to run ${record.build_run_id}, not the candidate (run ${candidate.runId})`
  if (record.artifact_sha256 == null) return 'has no artifact_sha256 (required on a candidate-bound row at every level)'
  if (candidate.bytes[row.bytes].has(record.artifact_sha256)) return null
  const other = GATE_BYTES.find((bytes) => bytes !== row.bytes && candidate.bytes[bytes]?.has(record.artifact_sha256))
  return other
    ? `names ${other} bytes (${record.artifact_sha256}) where ${row.bytes} bytes are required`
    : `names sha256 ${record.artifact_sha256}, not one of the candidate's ${row.bytes} assets`
}

/** One gate row on one host: the governing record and why the row is unmet (null when met). */
function gateRowOnHost(row, host, records, candidate) {
  const record = records.filter((entry) => selectsRecord(row, host, entry)).at(-1)
  if (!record) return { record, problem: `no ${row.level} record${row.match === undefined ? '' : ` matching "${row.match}"`}` }
  const binding = bindingProblem(record, row, candidate)
  if (binding) return { record, problem: `the latest ${row.level} record ${binding}` }
  if (row.accept === 'PASS' && record.result !== 'PASS') return { record, problem: `the latest ${row.level} record is ${record.result}, not PASS` }
  return { record, problem: null }
}

function reexecutedPass(records) {
  const record = records.filter((entry) => entry.reexecuted_by != null).at(-1)
  return record?.result === 'PASS' && !recordProblems(record).some((problem) => problem.startsWith('reexecuted_by'))
}

function sampleProblem(spec, { provenance, recordsByTicket, readSample, ledgerAt }) {
  let sample
  try {
    sample = readSample(spec.path)
  } catch (error) {
    return `cannot read the sample ${spec.path}: ${error.message}`
  }
  if (!isPlainObject(sample)) return `the sample ${spec.path} is not a JSON object`
  if (sample.seed !== provenance.commit) return `seed ${sample.seed} is not the candidate commit ${provenance.commit}`
  if (sample.of !== spec.population_of) return `the sample is drawn over ${sample.of}, not ${spec.population_of}`
  if (!SHA1_RE.test(sample.ledger_commit ?? '')) return 'ledger_commit: expected 40 lowercase hex characters'
  let pastLedger
  try {
    pastLedger = ledgerAt(sample.ledger_commit)
  } catch (error) {
    return `cannot read the ledger at ${sample.ledger_commit}: ${error.message}`
  }
  const population = populationOf(pastLedger, spec.population_of)
  if (population === null) return `${spec.population_of} is not in the ledger at ${sample.ledger_commit}`
  const expected = drawSample(population, sample.seed, spec.fraction)
  if (!sameList(sample.population, population) || !sameList(sample.sample, expected)) {
    return `population and sample differ from sample.mjs --population-of ${spec.population_of} recomputed at ledger_commit ${sample.ledger_commit} (sample ${expected.join(', ') || 'empty'})`
  }
  const missing = expected.filter((id) => !reexecutedPass(recordsByTicket.get(id) ?? []))
  return missing.length > 0 ? `no PASS re-execution record (reexecuted_by, R-REEX) for ${missing.join(', ')}` : null
}

/**
 * The --release check (pure: every file read is injected). `notesPath` is the release file's path
 * relative to the program root; `readSample(path)` returns the parsed sample JSON at a program-relative
 * path; `ledgerAt(commit)` returns the parsed ledger at that commit. Inputs must already pass
 * releaseInputProblems. Returns one problem line per unmet row (per host for gate rows) plus one per
 * missing release-file item, and one report line per REPORT row and host.
 * @returns {{problems: string[], reports: string[]}}
 */
export function releaseProblems({ version, gates, provenance, ledger, recordsByTicket, notesPath, notesText, readSample, ledgerAt }) {
  const problems = []
  const reports = []
  const runId = provenance.run.id
  const promotable = promotableAssets(provenance)
  const assetsOf = (isPromotable) => provenance.builds
    .filter((build) => VARIANTS[build.variant]?.promotable === isPromotable)
    .flatMap((build) => build.assets.map((asset) => asset.sha256))
  const candidate = { runId, bytes: { promotable: new Set(assetsOf(true)), 'qa-identity': new Set(assetsOf(false)) } }

  if (provenance.version !== version) problems.push(`provenance: version ${provenance.version} is not ${version}`)
  if (gates.version !== version) problems.push(`gates: version ${gates.version} is not ${version}`)

  for (const row of gates.rows) {
    const records = recordsByTicket.get(row.ticket) ?? []
    const stated = row.accept === 'PASS_OR_STATED' && statesGate(notesText, row.id)
    for (const host of row.hosts) {
      const label = `${row.id} [${row.ticket} ${row.level} ${row.bytes} on ${host}]`
      const { record, problem } = gateRowOnHost(row, host, records, candidate)
      if (row.accept === 'REPORT') {
        reports.push(`REPORT ${label}: ${problem ?? `met (${record.result})`}`)
      } else if (problem && !stated) {
        problems.push(`${label}: ${problem}${row.accept === 'PASS_OR_STATED' ? `, and the release file has no gate:${row.id} line` : ''}`)
      }
    }
  }

  const sample = sampleProblem(gates.sample, { provenance, recordsByTicket, readSample, ledgerAt })
  if (sample) problems.push(`${gates.sample.id} [re-execution sample of ${gates.sample.population_of}]: ${sample}`)

  const releaseTickets = ledger.tickets.filter((ticket) => Array.isArray(ticket?.scope_paths) && ticket.scope_paths.includes(notesPath))
  if (basename(notesPath) !== `${version}.md`) problems.push(`release file: ${notesPath} is not named ${version}.md`)
  if (releaseTickets.length !== 1) {
    problems.push(`${gates.accepted.id}: expected exactly one ledger ticket whose scope_paths include ${notesPath}, found ${releaseTickets.length}`)
  } else {
    const releaseTicket = releaseTickets[0].id
    const accepted = latestByLevel(recordsByTicket.get(releaseTicket) ?? []).get('ACCEPTED')
    const label = `${gates.accepted.id} [${releaseTicket} ACCEPTED]`
    if (!accepted) {
      problems.push(`${label}: no ACCEPTED record`)
    } else if (accepted.result !== 'PASS') {
      problems.push(`${label}: the latest ACCEPTED record is ${accepted.result}, not PASS`)
    } else {
      const text = accepted.owner_statement?.text ?? ''
      const unnamed = [
        ...(mentions(text, String(runId)) ? [] : [`run ${runId}`]),
        ...promotable.filter((asset) => !mentions(text, asset.sha256)).map((asset) => `${asset.name} (${asset.sha256})`)
      ]
      if (unnamed.length > 0) problems.push(`${label}: owner_statement does not name ${unnamed.join(', ')}`)
    }
  }

  if (!mentions(notesText, String(runId))) problems.push(`release file: does not name the candidate run ${runId}`)
  if (!mentions(notesText, provenance.commit)) problems.push(`release file: does not name the commit ${provenance.commit}`)
  for (const asset of promotable) {
    if (!mentions(notesText, asset.sha256)) problems.push(`release file: does not name ${asset.name} (${asset.sha256})`)
  }
  for (const heading of ['Residual risks', 'Deferred']) {
    if (!new RegExp(`^#{1,6}[ \\t]+${heading}[ \\t]*#*[ \\t]*$`, 'm').test(notesText)) problems.push(`release file: missing the heading "${heading}"`)
  }

  return { problems, reports }
}
