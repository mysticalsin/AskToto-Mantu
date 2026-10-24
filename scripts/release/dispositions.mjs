import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const STATUSES = ['shipped', 'preview', 'deferred', 'owner-blocked', 'pending']

export const AVAILABILITY = {
  shipped: 'Available',
  preview: 'Preview (off)',
  deferred: 'Not in 2.12',
  'owner-blocked': 'Not in 2.12',
  pending: 'Pending qualification'
}

const pad = (n) => String(n).padStart(2, '0')
export const REQUIRED_IDS = [
  ...Array.from({ length: 40 }, (_, i) => `CAP-${pad(i + 1)}`),
  ...Array.from({ length: 8 }, (_, i) => `NB-${pad(i + 1)}`)
]

const BEGIN = '<!-- availability:begin -->'
const END = '<!-- availability:end -->'
const SHA = /^[0-9a-f]{7,40}$/
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0

function evidenceError(item, exists) {
  if (typeof item !== 'string') return 'is not a string'
  if (SHA.test(item)) return null
  if (item.startsWith('/') || item.includes('..') || /\s/.test(item))
    return 'is neither a commit SHA nor a repository path'
  return exists(item) ? null : 'is neither a commit SHA nor an existing repository path'
}

/**
 * @param {{ entries?: any[] }} ledger
 * @param {{ exists?: (path: string) => boolean }} [options]
 * @returns {string[]}
 */
export function validateLedger(ledger, options) {
  const exists = options?.exists ?? (() => false)
  const errors = []
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : []
  if (!Array.isArray(ledger?.entries)) errors.push('ledger.entries must be an array')
  const required = new Set(REQUIRED_IDS)
  const seen = new Set()
  for (const entry of entries) {
    const id = entry?.id
    if (!required.has(id)) {
      errors.push(`unknown id: ${id}`)
      continue
    }
    if (seen.has(id)) {
      errors.push(`duplicate id: ${id}`)
      continue
    }
    seen.add(id)
    if (!nonEmpty(entry.title)) errors.push(`${id}: title is required`)
    if (!STATUSES.includes(entry.status)) {
      errors.push(`${id}: unknown status "${entry.status}"`)
      continue
    }
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : []
    if ((entry.status === 'shipped' || entry.status === 'preview') && evidence.length === 0) {
      errors.push(`${id}: ${entry.status} needs at least one evidence entry`)
    }
    for (const item of evidence) {
      const problem = evidenceError(item, exists)
      if (problem) errors.push(`${id}: evidence "${item}" ${problem}`)
    }
    if ((entry.status === 'deferred' || entry.status === 'owner-blocked') && !nonEmpty(entry.reason)) {
      errors.push(`${id}: ${entry.status} needs a reason`)
    }
    if (entry.status === 'owner-blocked' && !nonEmpty(entry.unblock)) {
      errors.push(`${id}: owner-blocked needs an unblock step`)
    }
    if (entry.notRun !== undefined && !(Array.isArray(entry.notRun) && entry.notRun.every(nonEmpty))) {
      errors.push(`${id}: notRun must be a list of non-empty strings`)
    }
  }
  for (const id of REQUIRED_IDS) {
    if (!seen.has(id)) errors.push(`missing id: ${id}`)
  }
  return errors
}

const cell = (text) =>
  String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')

function notesFor(entry) {
  const parts = []
  if (nonEmpty(entry.reason)) parts.push(entry.reason.trim())
  if (entry.status === 'owner-blocked' && nonEmpty(entry.unblock)) parts.push(`Unblock: ${entry.unblock.trim()}`)
  return parts.join(' ')
}

function byId(a, b) {
  return REQUIRED_IDS.indexOf(a.id) - REQUIRED_IDS.indexOf(b.id)
}

export function renderAvailabilityTable(ledger) {
  const entries = [...ledger.entries].sort(byId)
  const lines = ['| Capability | Availability | Notes |', '| --- | --- | --- |']
  for (const entry of entries) {
    lines.push(`| ${cell(`${entry.id} ${entry.title}`)} | ${AVAILABILITY[entry.status]} | ${cell(notesFor(entry))} |`)
  }
  const notRun = entries.flatMap((entry) => (entry.notRun ?? []).map((text) => `- Not run: ${entry.id} ${cell(text)}`))
  return notRun.length > 0 ? `${lines.join('\n')}\n\n${notRun.join('\n')}\n` : `${lines.join('\n')}\n`
}

export function extractAvailabilitySection(markdown) {
  const start = markdown.indexOf(BEGIN)
  const end = markdown.indexOf(END)
  if (start < 0 || end < start) return null
  return markdown.slice(start + BEGIN.length, end).trim()
}

export function releaseBlockers(ledger) {
  return ledger.entries
    .filter((entry) => entry.status === 'pending')
    .map((entry) => entry.id)
    .sort((a, b) => REQUIRED_IDS.indexOf(a) - REQUIRED_IDS.indexOf(b))
}

const PRIVACY_PATTERNS = [
  ['relay path', /_relay/],
  ['absolute home path', /\/Users\//],
  ['home shorthand', /~\//],
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/],
  ['ticket id', /\b[GVOQC]\d{2}[a-z]?\b/],
  ['decision id', /\bD-\d+\b/],
  ['program id', /M212-|C212-|GATE-|E2E-|JEV|NEEDS_TONY|MASTER-PLAN/],
  ['personal name', /\bTony\b/],
  ['private tool name', /Hindsight|Perssua/],
  ['owner timestamp', /\bowner \d{1,2}:\d{2}/i]
]

export function privacyViolations(text) {
  return PRIVACY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LEDGER_PATH = join(REPO, 'docs', 'release-2.12', 'dispositions.json')
const NOTES_PATH = join(REPO, 'docs', 'RELEASE-NOTES-2.12.md')

function main(argv) {
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
  const notes = readFileSync(NOTES_PATH, 'utf8')
  const errors = validateLedger(ledger, { exists: (p) => existsSync(join(REPO, p)) })
  const rendered = renderAvailabilityTable(ledger).trim()
  if (argv.includes('--write')) {
    const start = notes.indexOf(BEGIN)
    const end = notes.indexOf(END)
    if (start < 0 || end < start) {
      console.error('release notes lack the availability markers')
      return 1
    }
    writeFileSync(NOTES_PATH, `${notes.slice(0, start + BEGIN.length)}\n${rendered}\n${notes.slice(end)}`)
    return errors.length > 0 ? 1 : 0
  }
  if (extractAvailabilitySection(notes) !== rendered) errors.push('release notes availability section is out of date')
  for (const [label, text] of [
    ['ledger', JSON.stringify(ledger)],
    ['release notes', notes]
  ]) {
    for (const violation of privacyViolations(text)) errors.push(`${label}: privacy violation (${violation})`)
  }
  for (const error of errors) console.error(error)
  return errors.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
