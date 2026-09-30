// Fails when two IN_PROGRESS tickets claim one hot unit (C1) or more than three claim inside
// src/main/ (C2). Only IN_PROGRESS tickets count; a claim is an entry of the ticket's scope_paths.
// Usage: node scripts/program/claims-check.mjs --ledger <repo-relative ledger path>
// Exit codes: 0 no problems, 1 problems, 2 usage or read error.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const HOT_UNITS = Object.freeze({
  index: ['src/main/index.ts'],
  app: ['src/renderer/src/App.tsx'],
  ipc: ['src/shared/ipc.ts'],
  preload: ['src/preload/'],
  deps: ['package.json', 'package-lock.json'],
  'release-wf': ['.github/workflows/release.yml'],
  'build-wf': ['.github/workflows/build.yml'],
  helper: ['native/mac-helper/main.swift']
})

export const MAX_MAIN_PROCESS_CLAIMS = 3

const MAIN_PROCESS_DIR = 'src/main/'

function normalize(path) {
  return path.replaceAll('\\', '/').replace(/^(\.\/)+/, '')
}

function globToRegExpSource(claim) {
  return claim
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
}

/** True when `claim` covers `unitPath` (a file, or a directory when it ends in '/') or lies inside it. */
function claimMatches(claim, unitPath) {
  if (claim === unitPath) return true
  if (unitPath.endsWith('/') && claim.startsWith(unitPath)) return true
  const pattern = new RegExp(`^${globToRegExpSource(claim)}${claim.endsWith('/') ? '' : '$'}`)
  return pattern.test(unitPath)
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Pure: takes the parsed ledger, reads nothing. One line per problem, each starting with ticket ids.
 * @param {object} ledger
 * @param {{ledgerPath?: string}} [options] repo-relative ledger path, guarded as the ninth hot unit
 * @returns {string[]}
 */
export function claimProblems(ledger, { ledgerPath } = {}) {
  if (!Array.isArray(ledger?.tickets)) return ['ledger: tickets must be an array']

  const units = { ...HOT_UNITS }
  if (typeof ledgerPath === 'string' && ledgerPath.length > 0) units.ledger = [normalize(ledgerPath)]

  const problems = []
  const claimants = []
  for (const ticket of ledger.tickets) {
    if (ticket?.status !== 'IN_PROGRESS') continue
    if (!isStringArray(ticket.scope_paths)) {
      problems.push(`${ticket.id}: scope_paths must be an array of strings`)
      continue
    }
    claimants.push({ id: ticket.id, claims: ticket.scope_paths.map(normalize) })
  }

  for (const [unit, paths] of Object.entries(units)) {
    const ids = claimants
      .filter(({ claims }) => claims.some((claim) => paths.some((path) => claimMatches(claim, path))))
      .map(({ id }) => id)
    if (ids.length >= 2) problems.push(`${ids.join(', ')}: claim hot unit ${unit}`)
  }

  const mainIds = claimants
    .filter(({ claims }) => claims.some((claim) => claimMatches(claim, MAIN_PROCESS_DIR)))
    .map(({ id }) => id)
  if (mainIds.length > MAX_MAIN_PROCESS_CLAIMS) {
    problems.push(`${mainIds.join(', ')}: ${mainIds.length} tickets claim ${MAIN_PROCESS_DIR}, at most ${MAX_MAIN_PROCESS_CLAIMS} allowed`)
  }
  return problems
}

function usage(message) {
  console.error(`claims-check: ${message}`)
  console.error('usage: node scripts/program/claims-check.mjs --ledger <path>')
  return 2
}

export function runCli(argv = process.argv.slice(2)) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { ledger: { type: 'string' } } }))
  } catch (error) {
    return usage(error.message)
  }
  if (typeof values.ledger !== 'string') return usage('--ledger is required')

  let ledger
  try {
    ledger = JSON.parse(readFileSync(values.ledger, 'utf8'))
  } catch (error) {
    return usage(`cannot read ledger ${values.ledger}: ${error.message}`)
  }

  const problems = claimProblems(ledger, { ledgerPath: values.ledger })
  for (const problem of problems) console.error(`- ${problem}`)
  if (problems.length === 0) console.log('claims-check: no conflicting claims')
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli()
}
