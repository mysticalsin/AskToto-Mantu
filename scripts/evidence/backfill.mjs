// Evidence back-fill (M2-0238, ADR-017, M2-0002).
//
// The program ledger and its evidence/records/ store live in the private program repository
// (AGENTS.md #1); this public repository only holds the pull requests whose bodies carried the
// original ```json evidence``` blocks. This tool re-verifies those blocks the same way
// scripts/evidence/check.mjs verifies a PR at merge time (a green Build & Test run on the PR's own
// head SHA, a red-before ancestor run for fixes, wired paths that exist), then, for every DONE or
// ENGINEERING_COMPLETE ticket, copies the latest verified PASS record per required level into a
// records/<id>.jsonl file. A ticket that still has no verified record for a required level after
// this pass is reported as a gap: it cannot be closed on this evidence and its status needs review.
//
// This script never edits a ledger or writes a file inside a program repository (AGENTS.md #4: only
// the Opus orchestrator edits ticket status). It writes public-safe output to --out (a git-ignored
// path by default) for the lead to file into the private evidence store.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { CLOSED, IN_HOUSE, githubApi, prProblems } from './check.mjs'
import { latestByLevel, recordsInPrBody } from './record.mjs'

export const DEFAULT_OUT = 'out/evidence-backfill'

/** DONE requires every required level; a capped ENGINEERING_COMPLETE requires only the in-house ones. */
export function requiredLevelsFor(ticket) {
  const required = Array.isArray(ticket?.required_evidence) ? ticket.required_evidence : []
  if (ticket?.status === 'ENGINEERING_COMPLETE') return required.filter((level) => IN_HOUSE.has(level))
  if (ticket?.status === 'DONE') return required
  return []
}

/**
 * Re-verifies every merged PR's evidence blocks and groups the ones that pass verification by
 * ticket, oldest PR first, so `latestByLevel` picks the same "last line governs" record a live
 * `records/<id>.jsonl` file would (INV-2). A PR with any unverifiable block contributes nothing: a
 * partially-true PR body is not evidence.
 * @param {{number: number, headSha: string, body: string, mergedAt: string}[]} prs
 * @param {{github: ReturnType<typeof githubApi>, fileExists: (path: string) => boolean}} deps
 * @returns {Promise<{recordsByTicket: Map<string, object[]>, prProblems: Map<number, string[]>}>}
 */
export async function verifiedRecordsByTicket(prs, { github, fileExists }) {
  const recordsByTicket = new Map()
  const problemsByPr = new Map()
  const ordered = [...prs].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))

  for (const pr of ordered) {
    const { records } = recordsInPrBody(pr.body)
    if (records.length === 0) continue
    const problems = await prProblems({ body: pr.body, headSha: pr.headSha, prNumber: pr.number, github, fileExists })
    problemsByPr.set(pr.number, problems)
    if (problems.length > 0) continue
    for (const record of records) {
      if (!recordsByTicket.has(record.ticket)) recordsByTicket.set(record.ticket, [])
      recordsByTicket.get(record.ticket).push(record)
    }
  }

  return { recordsByTicket, prProblems: problemsByPr }
}

/**
 * The back-fill result: the latest verified record per level for every closed ticket that has one,
 * and a gap entry for every required level that still has none.
 * @param {object} ledger
 * @param {Map<string, object[]>} recordsByTicket
 * @returns {{ backfilled: Map<string, object[]>, gaps: {ticket: string, status: string, level: string, reason: string}[] }}
 */
export function resolveBackfill(ledger, recordsByTicket) {
  const tickets = (Array.isArray(ledger?.tickets) ? ledger.tickets : []).filter((t) => CLOSED.has(t?.status))
  const backfilled = new Map()
  const gaps = []

  for (const ticket of tickets) {
    const records = recordsByTicket.get(ticket.id) ?? []
    const latest = latestByLevel(records)
    if (latest.size > 0) backfilled.set(ticket.id, [...latest.values()])

    for (const level of requiredLevelsFor(ticket)) {
      const record = latest.get(level)
      if (!record || record.result !== 'PASS') {
        gaps.push({
          ticket: ticket.id,
          status: ticket.status,
          level,
          reason: record ? 'latest verified record is not PASS' : 'no verified PR evidence found for this level'
        })
      }
    }
  }

  return { backfilled, gaps }
}

function jsonlLine(record) {
  return `${JSON.stringify(record)}\n`
}

function leadActionReadme({ backfilled, gaps }) {
  const lines = [
    '# M2-0238 evidence back-fill',
    '',
    'Generated output, not a program document. File it into the private evidence store; do not commit it here.',
    '',
    `Back-filled tickets: ${backfilled.size}. Gaps: ${gaps.length}.`,
    ''
  ]

  if (backfilled.size > 0) {
    lines.push('## LEAD_ACTION: file these records')
    lines.push('For each ticket below, append its records/<id>.jsonl lines to the private evidence store\'s matching file.')
    for (const id of [...backfilled.keys()].sort()) lines.push(`- ${id}: records/${id}.jsonl`)
    lines.push('')
  }

  if (gaps.length > 0) {
    lines.push('## LEAD_ACTION: revert tickets with no verified evidence for a required level')
    lines.push('Acceptance requires reverting these to IN_PROGRESS (or ENGINEERING_COMPLETE, if still capped) in ledger/tickets.json.')
    const byTicket = new Map()
    for (const gap of gaps) {
      if (!byTicket.has(gap.ticket)) byTicket.set(gap.ticket, [])
      byTicket.get(gap.ticket).push(gap)
    }
    for (const id of [...byTicket.keys()].sort()) {
      const levels = byTicket.get(id).map((g) => `${g.level} (${g.reason})`).join(', ')
      lines.push(`- ${id} [${byTicket.get(id)[0].status}]: ${levels}`)
    }
    lines.push('')
  }

  lines.push('## LEAD_ACTION: re-verify M2-0047 and M2-0144 against their own acceptance')
  lines.push(
    'These two are known already-visible false closures. Check gaps.jsonl for M2-0047 and M2-0144 ' +
    'above; whether or not they appear there, re-read each against its own acceptance criteria and ' +
    'record any unmet line as NOT_MET with the ticket that now owns it.'
  )
  lines.push('')

  lines.push('## LEAD_ACTION: draw and record the re-execution sample')
  lines.push(
    'Run `node scripts/evidence/sample.mjs --ledger <private ledger path> --since <previous gate date> ' +
    '--seed <gate commit sha>` against the filed records above and record the result.'
  )
  lines.push('')

  return `${lines.join('\n')}`
}

/**
 * @param {{ledger: object, prs: {number: number, headSha: string, body: string, mergedAt: string}[], github: ReturnType<typeof githubApi>, fileExists: (path: string) => boolean}} args
 */
export async function buildBackfill({ ledger, prs, github, fileExists }) {
  const { recordsByTicket } = await verifiedRecordsByTicket(prs, { github, fileExists })
  return resolveBackfill(ledger, recordsByTicket)
}

export function writeBackfill(outDir, { backfilled, gaps }) {
  const recordsDir = join(outDir, 'records')
  mkdirSync(recordsDir, { recursive: true })

  for (const [ticketId, records] of backfilled) {
    const sorted = [...records].sort((a, b) => a.evidence_level.localeCompare(b.evidence_level))
    writeFileSync(join(recordsDir, `${ticketId}.jsonl`), sorted.map(jsonlLine).join(''))
  }

  writeFileSync(join(outDir, 'gaps.jsonl'), gaps.map(jsonlLine).join(''))
  writeFileSync(join(outDir, 'README.md'), leadActionReadme({ backfilled, gaps }))
}

function usageExit(message) {
  console.error(message)
  process.exit(2)
}

async function main() {
  const { values } = parseArgs({
    options: {
      ledger: { type: 'string' },
      repo: { type: 'string' },
      out: { type: 'string' },
      token: { type: 'string' }
    }
  })
  if (!values.ledger) return usageExit('usage: backfill.mjs --ledger <path> --repo <owner/name> [--out <dir>] [--token <token>]')
  if (!values.repo) return usageExit('backfill.mjs: --repo is required, e.g. --repo mysticalsin/AskToto-Mantu')

  let ledger
  try {
    ledger = JSON.parse(readFileSync(resolve(values.ledger), 'utf8'))
  } catch (error) {
    return usageExit(`could not read the ledger: ${error.message}`)
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const fileExists = (path) => existsSync(join(repoRoot, ...path.split('/')))
  const token = values.token ?? process.env.GITHUB_TOKEN
  const github = githubApi(values.repo, token)

  let prs
  try {
    prs = await github.mergedPullRequests()
  } catch (error) {
    return usageExit(`could not list merged pull requests: ${error.message}`)
  }

  const result = await buildBackfill({ ledger, prs, github, fileExists })
  const outDir = resolve(values.out ?? DEFAULT_OUT)
  writeBackfill(outDir, result)

  console.log(`evidence backfill: ${result.backfilled.size} ticket(s) backfilled, ${result.gaps.length} gap(s) -> ${outDir}`)
  if (result.gaps.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
