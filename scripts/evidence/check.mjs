// Ledger + PR evidence checker (ADR-017, M2-0002).
//
// Two independent checks, one CLI. `--ledger` computes closure: whether every ticket's status is
// supported by its dependency graph and its latest evidence records (rules L1-L15). `--pr-event` proves
// the one fact only public CI can prove: that a record pasted into a pull request names a real, green
// Build & Test run on that PR's own head commit, and that a fix's red-before run really precedes it
// (rules P1-P6). Under D-28 (no repository script runs on a Mac), both modes run only in GitHub Actions;
// `--ledger` runs from a private-repo workflow that checks out this file, `--pr-event` runs from the
// public repo's own `.github/workflows/evidence.yml`.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { EVIDENCE_LEVELS, latestByLevel, readRecordStore, recordsInPrBody, recordProblems, sha256Hex } from './record.mjs'

export const TICKET_STATUSES = Object.freeze([
  'TODO', 'IN_PROGRESS', 'ENGINEERING_COMPLETE', 'BLOCKED_EXTERNAL', 'DEFERRED', 'DONE', 'CANCELLED'
])
export const DECISION_STATES = Object.freeze(['OPEN', 'ANSWERED_AS_DEFAULT', 'ANSWERED_CHANGED'])
export const TEST_WORKFLOW = '.github/workflows/build.yml'
export const M2_0008_DEFAULT_BUNDLE = 'out/m2-0008-freeze-repro'

const READY_DEP = new Set(['ENGINEERING_COMPLETE', 'DONE', 'DEFERRED', 'BLOCKED_EXTERNAL'])
const IN_HOUSE = new Set(['DESIGNED', 'LOCALLY_TESTED'])
export const CLOSED = new Set(['DONE', 'ENGINEERING_COMPLETE'])
const READY_STATUSES = new Set(['IN_PROGRESS', 'ENGINEERING_COMPLETE', 'DEFERRED', 'DONE'])
const TICKET_RE = /^M2-\d{4}$/
const DECISION_RE = /^D-\d+$/

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function isLatestPass(latest, level) {
  const record = latest.get(level)
  return record != null && record.result === 'PASS'
}

function ticketsById(tickets) {
  const map = new Map()
  for (const ticket of tickets) {
    if (isPlainObject(ticket) && typeof ticket.id === 'string') map.set(ticket.id, ticket)
  }
  return map
}

/**
 * Every transitive `depends_on` ancestor whose status is ENGINEERING_COMPLETE or BLOCKED_EXTERNAL
 * (INV-5). Iterative DFS so a long or cyclic chain cannot blow the stack.
 * @param {string} id
 * @param {Map<string, object>} byId
 * @returns {object[]}
 */
function capsOf(id, byId) {
  const caps = []
  const visited = new Set([id])
  const stack = [...(byId.get(id)?.depends_on ?? [])]
  while (stack.length > 0) {
    const depId = stack.pop()
    if (visited.has(depId)) continue
    visited.add(depId)
    const dep = byId.get(depId)
    if (!dep) continue
    if (dep.status === 'ENGINEERING_COMPLETE' || dep.status === 'BLOCKED_EXTERNAL') caps.push(dep)
    stack.push(...(dep.depends_on ?? []))
  }
  return caps
}

const rootsOf = (caps) => caps.filter((ticket) => ticket.external_blocker != null)

function ticketShapeProblems(ledger) {
  const problems = []
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : null
  if (!tickets) {
    problems.push('ledger: tickets must be an array')
    return { problems, tickets: [] }
  }

  const seenIds = new Set()
  const referencedDecisions = new Set()
  let closesProgramCount = 0
  const decisions = isPlainObject(ledger.decisions) ? ledger.decisions : null

  for (const ticket of tickets) {
    const id = ticket?.id
    if (typeof id !== 'string' || !TICKET_RE.test(id)) {
      problems.push(`${id ?? '(missing id)'}: id must match M2-####`)
      continue
    }
    if (seenIds.has(id)) problems.push(`${id}: duplicate ticket id`)
    seenIds.add(id)

    if (!TICKET_STATUSES.includes(ticket.status)) problems.push(`${id}: status "${ticket.status}" is not a known status`)
    if (!Array.isArray(ticket.depends_on)) problems.push(`${id}: depends_on must be an array`)
    if (!Array.isArray(ticket.needs_decision)) problems.push(`${id}: needs_decision must be an array`)
    if (!Array.isArray(ticket.kit_refs)) problems.push(`${id}: kit_refs must be an array`)
    if (!Array.isArray(ticket.finding_refs)) problems.push(`${id}: finding_refs must be an array`)
    if (!Array.isArray(ticket.slices)) problems.push(`${id}: slices must be an array`)
    if (typeof ticket.estimate_hours !== 'number') problems.push(`${id}: estimate_hours must be a number`)
    if (!('external_blocker' in ticket)) problems.push(`${id}: external_blocker must be present (may be null)`)
    if (!('flag' in ticket)) problems.push(`${id}: flag must be present (may be null)`)

    const required = Array.isArray(ticket.required_evidence) ? ticket.required_evidence : null
    if (!required || required.length === 0) {
      problems.push(`${id}: required_evidence must be a non-empty array`)
    } else {
      if (new Set(required).size !== required.length) problems.push(`${id}: required_evidence must not repeat a level`)
      for (const level of required) {
        if (!EVIDENCE_LEVELS.includes(level)) problems.push(`${id}: required_evidence has an unknown level "${level}"`)
      }
    }

    for (const decisionId of Array.isArray(ticket.needs_decision) ? ticket.needs_decision : []) {
      if (typeof decisionId !== 'string' || !DECISION_RE.test(decisionId)) {
        problems.push(`${id}: needs_decision has a malformed id "${decisionId}"`)
      } else {
        referencedDecisions.add(decisionId)
      }
    }

    if (ticket.closes_program === true) closesProgramCount += 1
  }

  if (closesProgramCount > 1) problems.push('ledger: at most one ticket may have closes_program: true')

  if (referencedDecisions.size > 0 && !decisions) {
    problems.push('ledger: a top-level decisions register is required when a ticket has needs_decision')
  } else {
    for (const decisionId of referencedDecisions) {
      if (!DECISION_STATES.includes(decisions[decisionId])) {
        problems.push(`ledger: decisions.${decisionId} must be one of ${DECISION_STATES.join(', ')}`)
      }
    }
  }

  return { problems, tickets: tickets.filter((t) => typeof t?.id === 'string' && TICKET_RE.test(t.id)) }
}

function cycleProblems(tickets, byId) {
  const problems = []
  const reported = new Set()
  const color = new Map(tickets.map((t) => [t.id, 0])) // 0 unvisited, 1 in progress, 2 done

  function visit(id, path) {
    color.set(id, 1)
    path.push(id)
    for (const depId of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(depId)) continue
      if (color.get(depId) === 1) {
        const cycle = path.slice(path.indexOf(depId)).concat(depId)
        const key = [...new Set(cycle)].sort().join(',')
        if (!reported.has(key)) {
          reported.add(key)
          problems.push(`${cycle.join(' → ')}: dependency cycle`)
        }
      } else if (color.get(depId) === 0) {
        visit(depId, path)
      }
    }
    path.pop()
    color.set(id, 2)
  }

  for (const ticket of tickets) {
    if (color.get(ticket.id) === 0) visit(ticket.id, [])
  }
  return problems
}

/**
 * L1's "depends_on ids must exist" applies to every ticket regardless of status; L3's "every direct
 * dependency must be ready" applies only to the statuses that act on their dependency graph.
 */
function dependencyProblems(ticket, byId) {
  const problems = []
  const checkReady = READY_STATUSES.has(ticket.status)
  for (const depId of ticket.depends_on ?? []) {
    const dep = byId.get(depId)
    if (!dep) {
      problems.push(`${ticket.id}: depends_on references unknown ticket ${depId}`)
    } else if (checkReady && !READY_DEP.has(dep.status)) {
      problems.push(`${ticket.id}: depends on ${depId} which is not ready (${dep.status})`)
    }
  }
  return problems
}

function slicingProblems(ticket) {
  if (ticket.status !== 'IN_PROGRESS' || !((ticket.estimate_hours ?? 0) > 12)) return []
  const slices = Array.isArray(ticket.slices) ? ticket.slices : []
  if (slices.length === 0) return [`${ticket.id}: estimate_hours > 12 requires slices of at most 10h`]
  return slices
    .filter((slice) => !(typeof slice?.estimate_hours === 'number' && slice.estimate_hours <= 10))
    .map((slice) => `${ticket.id}: slice ${slice?.id ?? '?'} exceeds 10h`)
}

function blockedExternalProblems(ticket) {
  const blocker = ticket.external_blocker
  if (!isPlainObject(blocker) || !blocker.owner || !blocker.unblock_step || !blocker.needed_by || !blocker.raised_on) {
    return [`${ticket.id}: BLOCKED_EXTERNAL requires external_blocker.{owner,unblock_step,needed_by,raised_on}`]
  }
  return []
}

function cancelledProblems(ticket) {
  return ticket.reason ? [] : [`${ticket.id}: CANCELLED requires a non-empty reason`]
}

function deferredProblems(ticket, latest) {
  const problems = []
  if (ticket.flag == null) problems.push(`${ticket.id}: DEFERRED requires a non-null flag`)
  if (!isLatestPass(latest, 'ACCEPTED')) problems.push(`${ticket.id}: DEFERRED requires an ACCEPTED PASS record (owner approval, D-14)`)
  return problems
}

function engineeringCompleteProblems(ticket, latest, caps) {
  const problems = []
  if (!(ticket.external_blocker != null || caps.length > 0)) {
    problems.push(`${ticket.id}: ENGINEERING_COMPLETE requires its own or an inherited external blocker`)
  }
  // INV-2: the *latest* record per level governs, so a withdrawn PASS (a later FAIL) must not count.
  if (![...latest.values()].some((record) => record.result === 'PASS')) {
    problems.push(`${ticket.id}: ENGINEERING_COMPLETE requires at least one PASS record`)
  }
  for (const level of (ticket.required_evidence ?? []).filter((l) => IN_HOUSE.has(l))) {
    if (!isLatestPass(latest, level)) problems.push(`${ticket.id}: ENGINEERING_COMPLETE requires a PASS ${level} record`)
  }
  return problems
}

function doneProblems(ticket, latest, caps, closesProgram) {
  const problems = []
  for (const level of ticket.required_evidence ?? []) {
    if (!isLatestPass(latest, level)) problems.push(`${ticket.id}: DONE requires a PASS ${level} record`)
  }
  if (caps.length > 0 && !closesProgram) {
    problems.push(`${ticket.id}: DONE is blocked by a dependency ancestor that is ENGINEERING_COMPLETE or BLOCKED_EXTERNAL; it can close only as ENGINEERING_COMPLETE`)
  }
  return problems
}

// Rules come from this table, not branching: each status dispatches to one small rule function. The
// not-yet-started and in-progress statuses have no row here; neither has a closure rule beyond the
// depends_on and slicing checks already run above.
const STATUS_RULES = Object.freeze({
  BLOCKED_EXTERNAL: blockedExternalProblems,
  CANCELLED: cancelledProblems,
  DEFERRED: deferredProblems,
  ENGINEERING_COMPLETE: engineeringCompleteProblems,
  DONE: doneProblems
})

function inheritedBlockProblems(ticket, latest, roots, closesProgram) {
  const problems = []
  const capsClosure = ticket.status === 'ENGINEERING_COMPLETE' || (ticket.status === 'DONE' && closesProgram)
  if (capsClosure && roots.length > 0) {
    for (const [level, record] of latest) {
      const listed = new Set((record.inherited_block ?? []).map((entry) => entry.ticket))
      for (const root of roots) {
        if (!listed.has(root.id)) problems.push(`${ticket.id}: ${level} record must list inherited_block for ${root.id}`)
      }
    }
  } else if (ticket.status === 'DONE') {
    for (const level of ticket.required_evidence ?? []) {
      const record = latest.get(level)
      if (record && (record.inherited_block ?? []).length > 0) {
        problems.push(`${ticket.id}: DONE ${level} record still carries inherited_block; re-run after the upstream is DONE`)
      }
    }
  }
  return problems
}

function redBeforeProblems(ticket, latest) {
  if (!(CLOSED.has(ticket.status) && ticket.type === 'fix' && (ticket.required_evidence ?? []).includes('LOCALLY_TESTED'))) {
    return []
  }
  const record = latest.get('LOCALLY_TESTED')
  return record && !record.repro ? [`${ticket.id}: fix ticket requires repro (red-before) on its LOCALLY_TESTED record`] : []
}

function statusRuleProblems(ticket, latest, caps, roots) {
  const closesProgram = ticket.closes_program === true
  const rule = STATUS_RULES[ticket.status]
  return [
    ...(rule ? rule(ticket, latest, caps, closesProgram) : []),
    ...inheritedBlockProblems(ticket, latest, roots, closesProgram),
    ...redBeforeProblems(ticket, latest)
  ]
}

function recordContextProblems(ticket, records, decisions) {
  const problems = []
  const kitRefs = new Set(ticket.kit_refs ?? [])
  const findingRefs = new Set(ticket.finding_refs ?? [])
  const needsDecision = new Set(ticket.needs_decision ?? [])

  for (const record of records) {
    const recordKitRefs = new Set(Object.keys(record.kit_refs ?? {}))
    if (recordKitRefs.size !== kitRefs.size || [...recordKitRefs].some((ref) => !kitRefs.has(ref))) {
      problems.push(`${ticket.id}: record kit_refs must equal the ticket's kit_refs exactly`)
    }
    for (const findingRef of record.finding_refs ?? []) {
      if (!findingRefs.has(findingRef)) problems.push(`${ticket.id}: finding_ref ${findingRef} is not one of the ticket's finding_refs`)
    }
    for (const decisionId of record.assumed_decisions ?? []) {
      if (!needsDecision.has(decisionId)) {
        problems.push(`${ticket.id}: assumed_decisions has ${decisionId}, which is not one of the ticket's needs_decision`)
      }
    }
    for (const decisionId of needsDecision) {
      if (decisions?.[decisionId] === 'OPEN' && !(record.assumed_decisions ?? []).includes(decisionId)) {
        problems.push(`${ticket.id}: unlabelled assumption ${decisionId} (an OPEN decision must appear in assumed_decisions)`)
      }
    }
  }

  return problems
}

function revalidationProblems(ticket, latest, decisions) {
  if (!CLOSED.has(ticket.status)) return []
  const problems = []
  const seen = new Set()
  for (const [, record] of latest) {
    for (const decisionId of record.assumed_decisions ?? []) {
      if (decisions?.[decisionId] === 'ANSWERED_CHANGED' && !seen.has(decisionId)) {
        seen.add(decisionId)
        problems.push(`${ticket.id}: re-validate: ${decisionId} was answered differently from the default this evidence assumed`)
      }
    }
  }
  return problems
}

/**
 * Ledger rules L1-L13 plus L14's "record file for a ticket not in the ledger" (pure: takes the parsed
 * ledger and the already-validated record store, reads no files). L15 (output hashes) is separate,
 * because it reads files.
 * @param {object} ledger
 * @param {Map<string, object[]>} recordsByTicket
 * @returns {string[]}
 */
export function ledgerProblems(ledger, recordsByTicket) {
  const { problems: shapeProblems, tickets } = ticketShapeProblems(ledger)
  const problems = [...shapeProblems]
  const byId = ticketsById(tickets)
  const decisions = isPlainObject(ledger?.decisions) ? ledger.decisions : undefined

  problems.push(...cycleProblems(tickets, byId))

  for (const ticket of tickets) {
    const records = recordsByTicket.get(ticket.id) ?? []
    const caps = capsOf(ticket.id, byId)
    const roots = rootsOf(caps)
    const latest = latestByLevel(records)
    problems.push(...dependencyProblems(ticket, byId))
    problems.push(...slicingProblems(ticket))
    problems.push(...statusRuleProblems(ticket, latest, caps, roots))
    problems.push(...recordContextProblems(ticket, records, decisions))
    problems.push(...revalidationProblems(ticket, latest, decisions))
  }

  for (const ticketId of recordsByTicket.keys()) {
    if (!byId.has(ticketId)) problems.push(`records for unknown ticket ${ticketId} (not in the ledger)`)
  }

  return [...new Set(problems)].sort()
}

/**
 * L15: every valid record's `output` must point at a file under the program root whose sha256 matches.
 * @param {Map<string, object[]>} recordsByTicket
 * @param {string} programRoot
 * @returns {string[]}
 */
export function outputProblems(recordsByTicket, programRoot) {
  const problems = []
  for (const [ticketId, records] of recordsByTicket) {
    for (const record of records) {
      if (!record.output) continue
      const filePath = join(programRoot, ...record.output.path.split('/'))
      if (!existsSync(filePath)) {
        problems.push(`${ticketId}: output ${record.output.path} does not exist`)
        continue
      }
      if (sha256Hex(readFileSync(filePath)) !== record.output.sha256) {
        problems.push(`${ticketId}: output ${record.output.path} does not match its recorded sha256`)
      }
    }
  }
  return problems
}

/**
 * @param {string} ledgerPath
 * @returns {{ledger: object, programRoot: string, recordsByTicket: Map<string, object[]>, problems: string[]}}
 */
export function loadProgram(ledgerPath) {
  const programRoot = resolve(dirname(ledgerPath), '..')
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  const { recordsByTicket, problems } = readRecordStore(join(programRoot, 'evidence', 'records'))
  return { ledger, programRoot, recordsByTicket, problems }
}

/**
 * `field` names which record field this run was found by (`ci_run_id` or `repro.ci_run_id`), so a
 * record carrying both never produces an ambiguous "run: not found".
 */
function runProblems(run, sha, conclusion, field) {
  if (!run) return [`${field}: not found`]
  const problems = []
  if (run.path !== TEST_WORKFLOW) problems.push(`${field}: expected workflow ${TEST_WORKFLOW}, got ${run.path}`)
  if (run.head_sha !== sha) problems.push(`${field}: expected head_sha ${sha}, got ${run.head_sha}`)
  if (run.status !== 'completed') problems.push(`${field}: expected status completed, got ${run.status}`)
  if (run.conclusion !== conclusion) problems.push(`${field}: expected conclusion ${conclusion}, got ${run.conclusion}`)
  return problems
}

/**
 * One evidence block's problems, unprefixed (the caller names the block's position and level).
 * @returns {Promise<string[]>}
 */
async function blockProblems(record, { headSha, prNumber, github, fileExists }) {
  const shapeProblems = recordProblems(record)
  if (shapeProblems.length > 0) return shapeProblems

  const problems = []

  if (record.evidence_level === 'LOCALLY_TESTED') {
    if (record.commit !== headSha) problems.push(`commit: expected the PR head SHA ${headSha}`)
    if (record.pr !== prNumber) problems.push(`pr: expected the PR number ${prNumber}`)
    try {
      problems.push(...runProblems(await github.run(record.ci_run_id), record.commit, 'success', 'ci_run_id'))
    } catch (error) {
      problems.push(`ci_run_id: could not verify run ${record.ci_run_id}: ${error.message}`)
    }
  }

  if (record.repro) {
    try {
      const run = await github.run(record.repro.ci_run_id)
      problems.push(...runProblems(run, record.repro.commit, 'failure', 'repro.ci_run_id'))
      if (run) {
        const isAncestor = await github.isAncestor(record.repro.commit, record.commit)
        if (!isAncestor) problems.push('repro.commit: expected to be an ancestor of commit')
      }
    } catch (error) {
      problems.push(`repro.ci_run_id: could not verify run ${record.repro.ci_run_id}: ${error.message}`)
    }
    if (!fileExists(record.repro.test)) problems.push(`repro.test: ${record.repro.test} does not exist in the checkout`)
  }

  if (record.wired) {
    if (!fileExists(record.wired.client)) problems.push(`wired.client: ${record.wired.client} does not exist in the checkout`)
    if (!fileExists(record.wired.contract_fake)) problems.push(`wired.contract_fake: ${record.wired.contract_fake} does not exist in the checkout`)
  }

  return problems
}

/**
 * PR rules P1-P6: verifies every ` ```json evidence ` block in a pull request body against that PR's
 * own head commit and number, and the named Actions runs. A body with no block makes no claim and
 * returns no problems (P6) — the CLI prints a distinct message for that case. Each block's problems are
 * prefixed with its position and its own `evidence_level`, so a PR body with several blocks never mixes
 * up which one a problem belongs to.
 * @param {{body: string, headSha: string, prNumber: number, github: ReturnType<typeof githubApi>, fileExists: (path: string) => boolean}} args
 * @returns {Promise<string[]>}
 */
export async function prProblems({ body, headSha, prNumber, github, fileExists }) {
  const { records, problems: parseProblems } = recordsInPrBody(body)
  const problems = [...parseProblems]

  for (const [index, record] of records.entries()) {
    const level = typeof record?.evidence_level === 'string' ? record.evidence_level : 'unknown level'
    for (const problem of await blockProblems(record, { headSha, prNumber, github, fileExists })) {
      problems.push(`evidence[${index}] ${level}: ${problem}`)
    }
  }

  return problems
}

/**
 * @param {string} repo "owner/name"
 * @param {string | undefined} token
 * @param {typeof fetch} fetchImpl
 */
export function githubApi(repo, token, fetchImpl = fetch) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }

  async function run(id) {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs/${id}`, { headers })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub API returned ${response.status} for run ${id}`)
    const json = await response.json()
    return { path: json.path, head_sha: json.head_sha, status: json.status, conclusion: json.conclusion }
  }

  async function isAncestor(a, b) {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/compare/${a}...${b}`, { headers })
    if (response.status === 404) return false
    if (!response.ok) throw new Error(`GitHub API returned ${response.status} comparing ${a}...${b}`)
    const json = await response.json()
    return json.status === 'ahead'
  }

  return { run, isAncestor }
}

function usageExit(message) {
  console.error(message)
  process.exit(2)
}

function readJsonFile(path, problems, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    problems.push(`${label}: could not read JSON: ${error.message}`)
    return null
  }
}

function jsonlRows(path, problems, label) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line)
        } catch (error) {
          problems.push(`${label}:${index + 1}: invalid JSON: ${error.message}`)
          return null
        }
      })
      .filter(Boolean)
  } catch (error) {
    problems.push(`${label}: could not read: ${error.message}`)
    return []
  }
}

export function m2_0008BundleProblems(bundlePath) {
  const root = resolve(bundlePath)
  const problems = []
  const requiredFiles = [
    'README.md',
    'environment.json',
    'node-options-fuse.json',
    'dataless-fixtures.json',
    'external-blockers.json',
    'fifo-fixtures.json',
    'diagnostic-reports.json',
    'matrix.jsonl',
    'interrupt-results.jsonl',
    'launch-plan.json',
    'M2-0008.records.README.md',
    'M2-0008.lead-action.md'
  ]

  for (const file of requiredFiles) {
    if (!existsSync(join(root, file))) problems.push(`${file}: missing from M2-0008 bundle`)
  }
  if (problems.length > 0) return problems

  const environment = readJsonFile(join(root, 'environment.json'), problems, 'environment.json')
  const fuse = readJsonFile(join(root, 'node-options-fuse.json'), problems, 'node-options-fuse.json')
  const fifo = readJsonFile(join(root, 'fifo-fixtures.json'), problems, 'fifo-fixtures.json')
  const dataless = readJsonFile(join(root, 'dataless-fixtures.json'), problems, 'dataless-fixtures.json')
  const blockers = readJsonFile(join(root, 'external-blockers.json'), problems, 'external-blockers.json')
  const diagnosticReports = readJsonFile(join(root, 'diagnostic-reports.json'), problems, 'diagnostic-reports.json')
  const rows = jsonlRows(join(root, 'matrix.jsonl'), problems, 'matrix.jsonl')
  const interrupts = jsonlRows(join(root, 'interrupt-results.jsonl'), problems, 'interrupt-results.jsonl')
  const leadAction = readFileSync(join(root, 'M2-0008.lead-action.md'), 'utf8')

  if (environment?.ticket !== 'M2-0008') problems.push('environment.json: ticket must be M2-0008')
  if (typeof environment?.artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(environment.artifact_sha256)) {
    problems.push('environment.json: artifact_sha256 must be a lowercase sha256')
  }
  if (!['ENABLED', 'DISABLED_OR_UNAVAILABLE', 'NOT_EXERCISED'].includes(fuse?.node_options_fuse)) {
    problems.push('node-options-fuse.json: node_options_fuse must be recorded')
  }
  if (fifo?.kind !== 'fifo') problems.push('fifo-fixtures.json: kind must be fifo')
  if (!Number.isInteger(fifo?.count) || fifo.count < 6) problems.push('fifo-fixtures.json: at least six FIFO fixtures are required')
  if (!Array.isArray(fifo?.fixtures) || fifo.fixtures.length < 6) problems.push('fifo-fixtures.json: fixtures array is incomplete')
  if (Array.isArray(fifo?.fixtures)) {
    if (!fifo.fixtures.some((fixture) => String(fixture.path ?? '').endsWith('.brain/index.json'))) {
      problems.push('fifo-fixtures.json: missing blocked .brain/index.json fixture')
    }
    for (const fixture of fifo.fixtures) {
      if (!fixture || typeof fixture !== 'object' || !Object.hasOwn(fixture, 'opened_by_1_9_6')) {
        problems.push('fifo-fixtures.json: every fixture must record whether 1.9.6 opened it')
        break
      }
    }
  }
  if (!Array.isArray(dataless?.fixtures)) problems.push('dataless-fixtures.json: fixtures array is required')
  if (blockers?.ticket !== 'M2-0008') problems.push('external-blockers.json: ticket must be M2-0008')
  if (!Array.isArray(blockers?.blockers)) problems.push('external-blockers.json: blockers array is required')
  if (Array.isArray(blockers?.blockers)) {
    for (const blocker of blockers.blockers) {
      if (blocker.status !== 'BLOCKED_EXTERNAL') problems.push('external-blockers.json: blockers must be BLOCKED_EXTERNAL')
      if (typeof blocker.unblock_step !== 'string' || blocker.unblock_step.trim() === '') {
        problems.push('external-blockers.json: every blocker needs an unblock_step')
      }
    }
  }
  if (typeof diagnosticReports?.consented !== 'boolean') {
    problems.push('diagnostic-reports.json: consented must be recorded')
  }
  if (typeof diagnosticReports?.filter !== 'string' || !/Metis\/AskToto process names or sampled process ids only/.test(diagnosticReports.filter)) {
    problems.push('diagnostic-reports.json: collection filter must be restricted to Metis/AskToto process names or sampled process ids')
  }
  if (!Array.isArray(diagnosticReports?.copied)) problems.push('diagnostic-reports.json: copied must be an array')

  const rowIds = new Set(rows.map((row) => row.row))
  for (const row of [
    'row-1-history-open',
    'row-2-brain-status-blocked-brain',
    'row-3-macos-activate',
    'row-4-second-instance-reopen',
    'row-5-dataless-brain-idle',
    'row-9-network-off-flapping'
  ]) {
    if (!rowIds.has(row)) problems.push(`matrix.jsonl: missing ${row}`)
  }

  const interruptIds = new Set(interrupts.map((row) => row.interrupt))
  for (const interrupt of ['network-off', 'file-provider-cancel', 'process-signal']) {
    if (!interruptIds.has(interrupt)) problems.push(`interrupt-results.jsonl: missing ${interrupt}`)
  }

  if (!leadAction.includes('LEAD_ACTION:')) problems.push('M2-0008.lead-action.md: missing LEAD_ACTION handoff')
  if (!leadAction.includes('two M2-0008 owner-bug evidence records')) {
    problems.push('M2-0008.lead-action.md: must hand off filing the two owner-bug evidence records')
  }
  if (!leadAction.includes('hypothesis ranking')) {
    problems.push('M2-0008.lead-action.md: must hand off hypothesis ranking update')
  }
  if (!leadAction.includes('OBSERVED') || !leadAction.includes('DERIVED')) {
    problems.push('M2-0008.lead-action.md: must require OBSERVED/DERIVED labels')
  }

  return problems
}

async function main() {
  const { values } = parseArgs({
    options: {
      ledger: { type: 'string' },
      'pr-event': { type: 'string' },
      ticket: { type: 'string' },
      bundle: { type: 'string' }
    }
  })
  const hasLedger = typeof values.ledger === 'string'
  const hasPrEvent = typeof values['pr-event'] === 'string'
  const hasTicket = typeof values.ticket === 'string'
  if ([hasLedger, hasPrEvent, hasTicket].filter(Boolean).length !== 1) {
    return usageExit('usage: check.mjs --ledger <path>  |  check.mjs --pr-event <path>  |  check.mjs --ticket M2-0008 [--bundle <path>]')
  }

  if (hasLedger) {
    let program
    try {
      program = loadProgram(resolve(values.ledger))
    } catch (error) {
      return usageExit(`could not read the ledger: ${error.message}`)
    }
    const problems = [
      ...program.problems,
      ...ledgerProblems(program.ledger, program.recordsByTicket),
      ...outputProblems(program.recordsByTicket, program.programRoot)
    ]
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`)
      process.exit(1)
    }
    const recordCount = [...program.recordsByTicket.values()].reduce((n, list) => n + list.length, 0)
    console.log(`evidence: OK, ${program.ledger.tickets.length} tickets, ${recordCount} records`)
    return
  }

  if (hasTicket) {
    if (values.ticket !== 'M2-0008') return usageExit('only --ticket M2-0008 is supported in this public-repo checker')
    const problems = m2_0008BundleProblems(resolve(values.bundle ?? M2_0008_DEFAULT_BUNDLE))
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`)
      process.exit(1)
    }
    console.log(`M2-0008 bundle: OK (${values.bundle ?? M2_0008_DEFAULT_BUNDLE})`)
    return
  }

  let event
  try {
    event = JSON.parse(readFileSync(resolve(values['pr-event']), 'utf8'))
  } catch (error) {
    return usageExit(`could not read the event: ${error.message}`)
  }
  const body = event.pull_request?.body ?? ''
  const headSha = event.pull_request?.head?.sha
  const prNumber = event.pull_request?.number
  const repoFullName = event.repository?.full_name
  if (!headSha || !prNumber || !repoFullName) {
    return usageExit('pr-event: the event is missing pull_request.head.sha, pull_request.number or repository.full_name')
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const fileExists = (path) => existsSync(join(repoRoot, ...path.split('/')))
  const github = githubApi(repoFullName, process.env.GITHUB_TOKEN)
  const { records } = recordsInPrBody(body)
  const problems = await prProblems({ body, headSha, prNumber, github, fileExists })

  if (problems.length > 0) {
    for (const problem of problems) console.error(`- ${problem}`)
    process.exit(1)
  } else if (records.length === 0) {
    console.log('no evidence record in this pull request; nothing to verify')
  } else {
    console.log('evidence: OK')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
