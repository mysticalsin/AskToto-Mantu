// Ledger + PR evidence checker (ADR-017, M2-0002).
//
// Two independent checks, one CLI. `--ledger` computes closure: whether every ticket's status is
// supported by its dependency graph and its latest evidence records (rules L1-L15). `--pr-event` proves
// the one fact only public CI can prove: that a record pasted into a pull request names a real, green
// Build & Test run on that PR's own head commit, and that a fix's red-before run really precedes it
// (rules P1-P6). Under D-28 (no repository script runs on a Mac), both modes run only in GitHub Actions;
// `--ledger` runs from a private-repo workflow that checks out this file, `--pr-event` runs from the
// public repo's own `.github/workflows/evidence.yml`.
//
// `--release <version>` (M2-0511) proves that every pre-registered release gate row ran on the
// candidate's bytes: `depends_on` is satisfied by ENGINEERING_COMPLETE, and promotion checks only one
// PASS per promotable asset, so neither proves the LIVE_VERIFIED runs happened. It runs from
// program-audit.yml's release-check mode, never on a Mac (D-28), and takes
//   --gates <gates.json> --provenance <provenance.json> --ledger <tickets.json> --notes <<version>.md>
// Gate file, schema 1 (a JSON object):
//   { "schema": 1, "version": "<version>",
//     "rows": [{ "id", "ticket", "level", "bytes": "promotable" | "qa-identity" | "baseline",
//                "hosts": ["macos-latest", ...], "accept": "PASS" | "PASS_OR_STATED" | "REPORT",
//                "match"?: "<substring of the record's output.path or command>",
//                "sha256"?: ["<64-hex>", ...] }],
//     "sample": { "id", "population_of": "M2-####", "fraction": 0.1, "path": "<program-relative sample JSON>" },
//     "accepted": { "id" } }
// - A row is checked once per host. The latest record for (ticket, level, host, match) governs (INV-2).
//   `match` is required, distinct and not a substring of a sibling's on rows sharing ticket, level and host.
// - Candidate-bound rows (promotable, qa-identity) need that record's build_run_id to equal provenance
//   run.id and its artifact_sha256 to be one of that bytes class's provenance assets, at every level,
//   MEASURED included. Baseline rows carry `sha256`, the earlier release's bytes, and need
//   artifact_sha256 among them. A hosted-runner record must carry ci_run_id.
// - PASS needs that record to be a PASS. PASS_OR_STATED accepts a bound PASS or FAIL, or a line in the
//   release file containing the marker `gate:<id>`. REPORT rows are printed and never fail.
// - The sample row recomputes sample.mjs --population-of from the ledger at the sample JSON's
//   ledger_commit (git history of the ledger's own repository), seeded with provenance.commit, and needs
//   a PASS re-execution record (R-REEX) for every sampled ticket.
// - The release ticket is the one ledger ticket whose scope_paths include the release file's path
//   relative to the program root; the accepted row needs its latest ACCEPTED record to be a PASS whose
//   owner_statement names the candidate run and every promotable sha256.
// - The release file names the candidate run, the commit and every promotable sha256, and has the
//   headings "Residual risks" and "Deferred".
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { EXCERPT_FILES, STALL_BUNDLE_NAMES_FILE, STALL_BUNDLE_NAME, excerptOf } from '../qa/freeze-repro/attribution-bundle.mjs'
import { VARIANTS, promotableAssets } from '../qa/provenance.mjs'
import { EVIDENCE_LEVELS, latestByLevel, readRecordStore, recordsInPrBody, recordProblems, sha256Hex } from './record.mjs'
// sample.mjs imports this module back; the cycle is safe because neither module calls the other at top level.
import { drawSample, populationOf } from './sample.mjs'

export const TICKET_STATUSES = Object.freeze([
  'TODO', 'IN_PROGRESS', 'ENGINEERING_COMPLETE', 'BLOCKED_EXTERNAL', 'DEFERRED', 'DONE', 'CANCELLED'
])
export const DECISION_STATES = Object.freeze(['OPEN', 'ANSWERED_AS_DEFAULT', 'ANSWERED_CHANGED'])
export const TEST_WORKFLOW = '.github/workflows/build.yml'
export const M2_0008_DEFAULT_BUNDLE = 'out/m2-0008-freeze-repro'
export const M2_0194_DEFAULT_BUNDLE = 'out/m2-0194-freeze-repro'

// Rows and interrupt checks every freeze-repro matrix records, whichever ticket's bundle carries it.
const REQUIRED_MATRIX_ROWS = Object.freeze([
  'row-1-history-open',
  'row-2-brain-status-blocked-brain',
  'row-3-macos-activate',
  'row-4-second-instance-reopen',
  'row-5-dataless-brain-idle',
  'row-9-network-off-flapping'
])
const REQUIRED_INTERRUPTS = Object.freeze(['network-off', 'file-provider-cancel', 'process-signal'])

const READY_DEP = new Set(['ENGINEERING_COMPLETE', 'DONE', 'DEFERRED', 'BLOCKED_EXTERNAL'])
// The evidence levels ENGINEERING_COMPLETE can prove without an external party (§ ENGINEERING_COMPLETE
// gate); backfill.mjs reuses this to know which levels a capped ticket must still show a PASS for.
export const IN_HOUSE = new Set(['DESIGNED', 'LOCALLY_TESTED'])
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

  /**
   * Every merged pull request, oldest first. A hard page cap (not a total-count guess) stops a
   * misbehaving API from looping forever; 50 pages of 100 is far past this repo's merged-PR count.
   * @returns {Promise<{number: number, headSha: string, body: string, mergedAt: string}[]>}
   */
  async function mergedPullRequests() {
    const results = []
    for (let page = 1; page <= 50; page += 1) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=asc&per_page=100&page=${page}`,
        { headers }
      )
      if (!response.ok) throw new Error(`GitHub API returned ${response.status} listing pull requests (page ${page})`)
      const json = await response.json()
      for (const pr of json) {
        if (pr.merged_at) results.push({ number: pr.number, headSha: pr.head.sha, body: pr.body ?? '', mergedAt: pr.merged_at })
      }
      if (json.length < 100) break
    }
    return results
  }

  return { run, isAncestor, mergedPullRequests }
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

function fixtureLabelProblem(row) {
  if (!Object.hasOwn(row, 'fixture')) return null
  if (row.row === 'row-5-dataless-brain-idle' && row.fixture === 'dataless-brain-index') return null
  if (row.row === 'row-9-network-off-flapping' && row.fixture === 'dataless-meeting') return null
  return `matrix.jsonl: ${row.row ?? '(unknown row)'} fixture must be a content-free fixture label`
}

const M2_0008_AUTOMATIC_ROWS = Object.freeze([
  'row-1-history-open',
  'row-2-brain-status-blocked-brain',
  'row-3-macos-activate',
  'row-4-second-instance-reopen'
])
const M2_0008_BLOCKED_ROWS = Object.freeze(['row-5-dataless-brain-idle', 'row-9-network-off-flapping'])
const M2_0008_BLOCKED_INTERRUPTS = Object.freeze(['network-off', 'file-provider-cancel'])
const M2_0008_EXERCISED = new Set(['observed', 'pass', 'fail'])
const HOSTED_RUNNER_HOSTS = new Set(['macos-latest', 'windows-latest'])
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * The extra shape a `run-matrix.sh --hosted-live` bundle must have (M2-0462): the mode and content-free
 * host facts are recorded, every automatic row was driven, judged from its own observation and sampled
 * (main plus renderers chosen by role), the process-signal interrupt ran, and every row or interrupt that
 * needs a cloud-file account is BLOCKED_EXTERNAL with its unblock step. Dry-run and QA-live bundles never
 * reach this function.
 */
function m2_0008HostedLiveProblems(root, { environment, fuse, fifo, blockers, rows, interrupts }) {
  const problems = []
  for (const file of ['hosted-live-summary.json', 'M2-0008.evidence-import.json', 'owner-bug-records.json']) {
    if (!existsSync(join(root, file))) problems.push(`${file}: missing from the hosted-live bundle`)
  }
  if (problems.length > 0) return problems

  const host = environment.host
  if (!isPlainObject(host) || !nonEmptyString(host.os_version) || !nonEmptyString(host.arch) ||
      !(Number.isInteger(host.memory_bytes) && host.memory_bytes > 0)) {
    problems.push('environment.json: hosted-live must record host os_version, arch and memory_bytes')
  }
  if (fuse?.node_options_fuse === 'NOT_EXERCISED') problems.push('node-options-fuse.json: hosted-live must exercise the fuse probe')
  if (Array.isArray(fifo?.fixtures) && !fifo.fixtures.every((fixture) => typeof fixture?.opened_by_1_9_6 === 'boolean')) {
    problems.push('fifo-fixtures.json: hosted-live must record opened_by_1_9_6 as true or false for every FIFO fixture')
  }

  for (const row of M2_0008_AUTOMATIC_ROWS) {
    const result = rows.find((entry) => entry.row === row && Object.hasOwn(entry, 'operator_result'))
    if (!result || result.automatic !== true || !M2_0008_EXERCISED.has(result.operator_result)) {
      problems.push(`matrix.jsonl: ${row} must be an automatic row that was exercised`)
    } else {
      if (!nonEmptyString(result.drive_method)) problems.push(`matrix.jsonl: ${row} must record its drive_method`)
      const observation = result.observation
      const cdp = observation?.cdp
      if (!isPlainObject(cdp) || typeof cdp.main_answered !== 'boolean' || !nonEmptyString(cdp.renderer_round_trip) ||
          !nonEmptyString(cdp.window_visible_observed_by)) {
        problems.push(`matrix.jsonl: ${row} must record its renderer round trip, main answer and window observation`)
      } else if (observation.operator_result !== result.operator_result) {
        problems.push(`matrix.jsonl: ${row} operator_result must be the one derived from its observation`)
      }
    }
    const sample = rows.find((entry) => entry.row === row && Object.hasOwn(entry, 'sampled'))
    if (!sample || sample.sampled !== true || sample.main_sample !== true || !(sample.renderer_samples >= 1) ||
        sample.renderers_selected_by !== '--type=renderer') {
      problems.push(`matrix.jsonl: ${row} must have main and role-selected renderer samples`)
    } else if (!existsSync(join(root, 'samples', `${row}-main.sample.txt`))) {
      problems.push(`samples/${row}-main.sample.txt: missing`)
    }
  }

  const blocked = Array.isArray(blockers?.blockers) ? blockers.blockers : []
  const blockerListing = (key, id) => blocked.some((blocker) => Array.isArray(blocker[key]) && blocker[key].includes(id))
  for (const row of M2_0008_BLOCKED_ROWS) {
    const entry = rows.find((candidate) => candidate.row === row && Object.hasOwn(candidate, 'operator_result'))
    if (entry?.status !== 'BLOCKED_EXTERNAL' || !nonEmptyString(entry.unblock_step) || !blockerListing('rows', row)) {
      problems.push(`matrix.jsonl: ${row} must be BLOCKED_EXTERNAL with an unblock_step listed in external-blockers.json`)
    }
  }
  for (const interrupt of M2_0008_BLOCKED_INTERRUPTS) {
    const entry = interrupts.find((candidate) => candidate.interrupt === interrupt)
    if (entry?.status !== 'BLOCKED_EXTERNAL' || !nonEmptyString(entry.unblock_step) || !blockerListing('interrupts', interrupt)) {
      problems.push(`interrupt-results.jsonl: ${interrupt} must be BLOCKED_EXTERNAL with an unblock_step listed in external-blockers.json`)
    }
  }
  const signal = interrupts.find((candidate) => candidate.interrupt === 'process-signal')
  if (!signal || signal.automatic !== true || !M2_0008_EXERCISED.has(signal.result) || typeof signal.exited_within_10s !== 'boolean') {
    problems.push('interrupt-results.jsonl: process-signal must run automatically and record exited_within_10s')
  }

  const summary = readJsonFile(join(root, 'hosted-live-summary.json'), problems, 'hosted-live-summary.json')
  if (summary) {
    const symptomSeen = rows.some((entry) => M2_0008_AUTOMATIC_ROWS.includes(entry.row) && entry.operator_result === 'observed')
    if (summary.mode !== 'hosted-live' || typeof summary.reproduced !== 'boolean' || !nonEmptyString(summary.conclusion)) {
      problems.push('hosted-live-summary.json: must record mode, reproduced and conclusion')
    } else if (summary.reproduced !== symptomSeen) {
      problems.push('hosted-live-summary.json: reproduced must match the automatic rows that observed a symptom')
    }
  }

  const evidenceImport = readJsonFile(join(root, 'M2-0008.evidence-import.json'), problems, 'M2-0008.evidence-import.json')
  if (evidenceImport) {
    if (evidenceImport.mode !== 'hosted-live') problems.push('M2-0008.evidence-import.json: mode must be hosted-live')
    if (evidenceImport.environment?.kind !== 'hosted-runner' || !HOSTED_RUNNER_HOSTS.has(evidenceImport.environment?.host)) {
      problems.push('M2-0008.evidence-import.json: environment must be the hosted-runner kind on macos-latest or windows-latest')
    }
    if (Object.hasOwn(evidenceImport, 'qa_host_label')) problems.push('M2-0008.evidence-import.json: hosted-live must not carry a QA host label')
    if (evidenceImport.artifact_sha256 !== environment.artifact_sha256) {
      problems.push('M2-0008.evidence-import.json: artifact_sha256 must match environment.json')
    }
    if (!(Number.isInteger(evidenceImport.build_run_id) && evidenceImport.build_run_id > 0)) {
      problems.push('M2-0008.evidence-import.json: build_run_id must be a positive integer')
    }
  }
  return problems
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
        problems.push('fifo-fixtures.json: every fixture must record opened_by_1_9_6')
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
    problems.push('DiagnosticReports collection filter must be restricted to Metis/AskToto process names or sampled process ids')
  }
  if (!Array.isArray(diagnosticReports?.copied)) problems.push('diagnostic-reports.json: copied must be an array')

  const rowIds = new Set(rows.map((row) => row.row))
  for (const row of rows) {
    const problem = fixtureLabelProblem(row)
    if (problem) problems.push(problem)
  }
  for (const row of REQUIRED_MATRIX_ROWS) {
    if (!rowIds.has(row)) problems.push(`matrix.jsonl: missing ${row}`)
  }

  const interruptIds = new Set(interrupts.map((row) => row.interrupt))
  for (const interrupt of REQUIRED_INTERRUPTS) {
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

  if (environment?.mode === 'hosted-live') {
    problems.push(...m2_0008HostedLiveProblems(root, { environment, fuse, fifo, blockers, rows, interrupts }))
  }

  return problems
}

/** M2-0194 attribution bundle: the freeze-repro matrix run against an exact QA candidate, plus content-free
 *  audit excerpts and the names (never the contents) of the stall bundles the sampler wrote. */
export function m2_0194BundleProblems(bundlePath) {
  const root = resolve(bundlePath)
  const problems = []
  const requiredFiles = [
    'README.md',
    'environment.json',
    'external-blockers.json',
    'matrix.jsonl',
    'interrupt-results.jsonl',
    ...Object.values(EXCERPT_FILES),
    STALL_BUNDLE_NAMES_FILE,
    'M2-0194.lead-action.md'
  ]
  for (const file of requiredFiles) {
    if (!existsSync(join(root, file))) problems.push(`${file}: missing from M2-0194 bundle`)
  }
  if (problems.length > 0) return problems

  const environment = readJsonFile(join(root, 'environment.json'), problems, 'environment.json')
  const blockers = readJsonFile(join(root, 'external-blockers.json'), problems, 'external-blockers.json')
  const names = readJsonFile(join(root, STALL_BUNDLE_NAMES_FILE), problems, STALL_BUNDLE_NAMES_FILE)
  const rows = jsonlRows(join(root, 'matrix.jsonl'), problems, 'matrix.jsonl')
  const interrupts = jsonlRows(join(root, 'interrupt-results.jsonl'), problems, 'interrupt-results.jsonl')
  const leadAction = readFileSync(join(root, 'M2-0194.lead-action.md'), 'utf8')

  if (environment?.ticket !== 'M2-0194') problems.push('environment.json: ticket must be M2-0194')
  if (typeof environment?.artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(environment.artifact_sha256)) {
    problems.push('environment.json: artifact_sha256 must be a lowercase sha256')
  }
  if (!/^[1-9]\d*$/.test(String(environment?.candidate_run ?? ''))) {
    problems.push('environment.json: candidate_run must be the qa-candidate run id')
  }
  if (blockers?.ticket !== 'M2-0194') problems.push('external-blockers.json: ticket must be M2-0194')
  if (!Array.isArray(blockers?.blockers)) {
    problems.push('external-blockers.json: blockers array is required')
  } else {
    for (const blocker of blockers.blockers) {
      if (blocker.status !== 'BLOCKED_EXTERNAL') problems.push('external-blockers.json: blockers must be BLOCKED_EXTERNAL')
      if (typeof blocker.unblock_step !== 'string' || blocker.unblock_step.trim() === '') {
        problems.push('external-blockers.json: every blocker needs an unblock_step')
      }
    }
  }

  const rowIds = new Set(rows.map((row) => row.row))
  for (const row of rows) {
    const problem = fixtureLabelProblem(row)
    if (problem) problems.push(problem)
  }
  for (const row of REQUIRED_MATRIX_ROWS) {
    if (!rowIds.has(row)) problems.push(`matrix.jsonl: missing ${row}`)
  }
  const interruptIds = new Set(interrupts.map((row) => row.interrupt))
  for (const interrupt of REQUIRED_INTERRUPTS) {
    if (!interruptIds.has(interrupt)) problems.push(`interrupt-results.jsonl: missing ${interrupt}`)
  }

  for (const [excerpt, file] of Object.entries(EXCERPT_FILES)) {
    for (const row of jsonlRows(join(root, file), problems, file)) {
      if (excerptOf(row.event) !== excerpt) problems.push(`${file}: event ${JSON.stringify(row.event)} does not belong in the ${excerpt} excerpt`)
    }
  }
  if (!Array.isArray(names?.names)) {
    problems.push(`${STALL_BUNDLE_NAMES_FILE}: names array is required`)
  } else if (!names.names.every((name) => typeof name === 'string' && STALL_BUNDLE_NAME.test(name))) {
    problems.push(`${STALL_BUNDLE_NAMES_FILE}: entries must be stall bundle file names only`)
  }

  if (!leadAction.includes('LEAD_ACTION:')) problems.push('M2-0194.lead-action.md: missing LEAD_ACTION handoff')
  const dryRun = environment?.dry_run === 1 || environment?.dry_run === true || environment?.mode === 'dry-run'
  const liveHandoff = leadAction.includes('LIVE_VERIFIED')
  if (!leadAction.includes('M2-0194')) {
    problems.push('M2-0194.lead-action.md: must name M2-0194')
  }
  if (dryRun && liveHandoff) {
    problems.push('M2-0194.lead-action.md: dry-run bundles must not hand off a LIVE_VERIFIED filing')
  } else if (!dryRun && !liveHandoff) {
    problems.push('M2-0194.lead-action.md: must hand off filing the M2-0194 LIVE_VERIFIED record')
  }

  return problems
}

export const RELEASE_GATES_SCHEMA = 1
const GATE_ROW_KEYS = new Set(['id', 'ticket', 'level', 'bytes', 'hosts', 'accept', 'match', 'sha256'])
const GATE_BYTES = Object.freeze(['promotable', 'qa-identity', 'baseline'])
const GATE_ACCEPT = Object.freeze(['PASS', 'PASS_OR_STATED', 'REPORT'])
const GATE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const SHA1_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
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

const sameList = (a, b) => Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b)

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

function releaseMain(values) {
  for (const flag of ['gates', 'provenance', 'ledger', 'notes']) {
    if (typeof values[flag] !== 'string') return usageExit(`check.mjs --release: --${flag} is required`)
  }
  const ledgerPath = resolve(values.ledger)
  let gates, provenance, notesText, program
  try {
    gates = JSON.parse(readFileSync(resolve(values.gates), 'utf8'))
    provenance = JSON.parse(readFileSync(resolve(values.provenance), 'utf8'))
    notesText = readFileSync(resolve(values.notes), 'utf8')
    program = loadProgram(ledgerPath)
  } catch (error) {
    return usageExit(`could not read the release inputs: ${error.message}`)
  }
  // A record the store rejects (record.mjs recordProblems) is malformed input, never skipped: dropping
  // an invalid latest record would let an older PASS meet its row.
  const inputProblems = [...program.problems, ...releaseInputProblems(gates, provenance, program.ledger)]
  if (inputProblems.length > 0) {
    for (const problem of inputProblems) console.error(`- ${problem}`)
    process.exit(2)
  }

  const { problems, reports } = releaseProblems({
    version: values.release,
    gates,
    provenance,
    ledger: program.ledger,
    recordsByTicket: program.recordsByTicket,
    notesPath: relative(program.programRoot, resolve(values.notes)).split(sep).join('/'),
    notesText,
    readSample: (path) => JSON.parse(readFileSync(join(program.programRoot, ...path.split('/')), 'utf8')),
    // The ledger's own repository history; ledger_commit is 40-hex (checked first), never an option.
    ledgerAt: (commit) => JSON.parse(execFileSync('git', ['-C', dirname(ledgerPath), 'show', `${commit}:./${basename(ledgerPath)}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024
    }))
  })
  for (const line of reports) console.log(line)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  console.log(`release ${values.release}: OK, ${gates.rows.length} gate rows, the re-execution sample, the acceptance and the release file are met`)
}

async function main() {
  const usage = 'usage: check.mjs --ledger <path>  |  check.mjs --pr-event <path>  |  check.mjs --ticket M2-0008|M2-0194 [--bundle <path>]  |  ' +
    'check.mjs --release <version> --gates <gates.json> --provenance <provenance.json> --ledger <tickets.json> --notes <release notes .md>'
  let values
  try {
    values = parseArgs({
      options: {
        ledger: { type: 'string' },
        'pr-event': { type: 'string' },
        ticket: { type: 'string' },
        bundle: { type: 'string' },
        release: { type: 'string' },
        gates: { type: 'string' },
        provenance: { type: 'string' },
        notes: { type: 'string' }
      }
    }).values
  } catch (error) {
    return usageExit(`${error.message}\n${usage}`)
  }
  const hasRelease = typeof values.release === 'string'
  // With --release, --ledger is one of its inputs rather than a mode of its own.
  const hasLedger = typeof values.ledger === 'string' && !hasRelease
  const hasPrEvent = typeof values['pr-event'] === 'string'
  const hasTicket = typeof values.ticket === 'string'
  const hasReleaseInput = ['gates', 'provenance', 'notes'].some((flag) => values[flag] !== undefined)
  if ([hasLedger, hasPrEvent, hasTicket, hasRelease].filter(Boolean).length !== 1 || (hasReleaseInput && !hasRelease) ||
      values.release === '') {
    return usageExit(usage)
  }

  if (hasRelease) return releaseMain(values)

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
    const checker = {
      'M2-0008': { check: m2_0008BundleProblems, defaultBundle: M2_0008_DEFAULT_BUNDLE },
      'M2-0194': { check: m2_0194BundleProblems, defaultBundle: M2_0194_DEFAULT_BUNDLE }
    }[values.ticket]
    if (!checker) return usageExit('only --ticket M2-0008 and --ticket M2-0194 are supported in this public-repo checker')
    const bundle = values.bundle ?? checker.defaultBundle
    const problems = checker.check(resolve(bundle))
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`)
      process.exit(1)
    }
    console.log(`${values.ticket} bundle: OK (${bundle})`)
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
