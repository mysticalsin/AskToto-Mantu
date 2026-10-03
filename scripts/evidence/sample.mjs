// Re-execution sampler (ADR-017, M2-0002, §4 S1-S3).
//
// Draws a reproducible 10% sample of tickets closed since the previous gate, for cross-model
// re-execution. The draw is a pure function of the population and a seed (the gate commit SHA): no
// Math.random, no wall-clock time, so anyone can re-derive the same sample and the lead cannot steer it.
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { CLOSED, loadProgram } from './check.mjs'

/**
 * S1: closed tickets whose newest record's `recorded_at` is at or after `since`.
 * @param {object} ledger
 * @param {Map<string, object[]>} recordsByTicket
 * @param {string} since Date.parse-able instant or YYYY-MM-DD
 * @returns {string[]} ticket ids
 */
export function closedSince(ledger, recordsByTicket, since) {
  const sinceMs = Date.parse(since)
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : []
  return tickets
    .filter((ticket) => CLOSED.has(ticket?.status))
    .filter((ticket) => {
      const records = recordsByTicket.get(ticket.id) ?? []
      const timestamps = records.map((r) => Date.parse(r.recorded_at)).filter((n) => !Number.isNaN(n))
      if (timestamps.length === 0) return false
      return Math.max(...timestamps) >= sinceMs
    })
    .map((ticket) => ticket.id)
}

/**
 * S1 by dependency: the closed tickets a ticket depends on, whatever their records' timestamps say.
 * @param {object} ledger
 * @param {string} ticketId
 * @returns {string[] | null} ticket ids, or null when `ticketId` is not in the ledger
 */
export function populationOf(ledger, ticketId) {
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : []
  const target = tickets.find((ticket) => ticket?.id === ticketId)
  if (!target) return null
  const dependencies = new Set(Array.isArray(target.depends_on) ? target.depends_on : [])
  return tickets.filter((ticket) => dependencies.has(ticket?.id) && CLOSED.has(ticket?.status)).map((ticket) => ticket.id)
}

/**
 * S2 (size) + S3 (selection): the ⌈fraction × n⌉ ids (at least 1 when n > 0) whose
 * sha256("<seed>:<id>") hex is smallest, printed sorted by id.
 * @param {string[]} ids
 * @param {string} seed
 * @param {number} fraction
 * @returns {string[]}
 */
export function drawSample(ids, seed, fraction = 0.1) {
  if (ids.length === 0) return []
  const size = Math.max(1, Math.ceil(fraction * ids.length))
  return ids
    .map((id) => ({ id, hash: createHash('sha256').update(`${seed}:${id}`).digest('hex') }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    .slice(0, size)
    .map((entry) => entry.id)
    .sort()
}

function usageExit(message) {
  console.error(message)
  process.exit(2)
}

function main() {
  const { values } = parseArgs({ options: { ledger: { type: 'string' }, since: { type: 'string' }, 'population-of': { type: 'string' }, seed: { type: 'string' } } })
  const of = values['population-of']
  if (!values.ledger) return usageExit('usage: sample.mjs --ledger <path> (--since <YYYY-MM-DD|instant> | --population-of <ticket>) --seed <string>')
  if (!values.seed) return usageExit('sample.mjs: --seed is required and must be non-empty')
  if ((of === undefined) === (values.since === undefined)) return usageExit('sample.mjs: give exactly one of --since or --population-of')
  if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) return usageExit('sample.mjs: --since must be a parseable date or instant')

  let program
  try {
    program = loadProgram(resolve(values.ledger))
  } catch (error) {
    return usageExit(`could not read the ledger: ${error.message}`)
  }
  const population = of === undefined ? closedSince(program.ledger, program.recordsByTicket, values.since) : populationOf(program.ledger, of)
  if (population === null) return usageExit(`sample.mjs: unknown ticket ${of}`)
  const sample = drawSample(population, values.seed)
  const populationRule = of === undefined ? 'closed-since' : 'depends-on-closed'
  console.log(JSON.stringify({ since: values.since ?? null, populationRule, of: of ?? null, seed: values.seed, population, sample }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
