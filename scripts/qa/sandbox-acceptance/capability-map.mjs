// G88: the machine-readable E2E map (capability -> scenario -> evidence level) and the pure checker the unit test runs.
// Nothing here launches an app. capability-map.json is DATA; `mapProblems` is the single place that decides whether it is honest:
// a row that needs hardware or an owner can never point at a sandbox scenario, and a sandbox row can never claim a level only a
// live, owner-run or measured result can give.

/** The E2E cases of the rebuild spec (R9 section 3): 54 in total. */
export const E2E_CASES = Object.freeze({
  'E2E-01': ['H', 'P', 'F', 'C', 'R', 'O'],
  'E2E-02': ['H', 'P', 'F', 'C', 'R', 'T', 'J'],
  'E2E-03': ['H', 'P', 'F', 'C', 'R', 'teach'],
  'E2E-04': ['H', 'P', 'F', 'C', 'R'],
  'E2E-05': ['H', 'P', 'F', 'C', 'R'],
  'E2E-06': ['H', 'P', 'F', 'C', 'R'],
  'E2E-07': ['H', 'P', 'F', 'C', 'R'],
  'E2E-08': ['H', 'P', 'F', 'C', 'R'],
  'E2E-09': ['H', 'P', 'F', 'C', 'R'],
  'E2E-10': ['H', 'P', 'F', 'C', 'R']
})

export const CAP_IDS = Object.freeze(
  Array.from({ length: 40 }, (_, index) => `CAP-${String(index + 1).padStart(2, '0')}`)
)

export const ROW_KINDS = Object.freeze([
  'sandbox',
  'ci-only',
  'owner-checklist',
  'blocked-external',
  'pending-disposition',
  'not-in-2.12'
])
const SANDBOX_TARGETS = ['LOCALLY_TESTED', 'DESIGNED']
const OWNER_TARGETS = ['LIVE_VERIFIED', 'ACCEPTED', 'MEASURED']
const PENDING_TICKETS = ['G92', 'G94']

const isText = (value) => typeof value === 'string' && value.trim().length > 0

/** Problems with one row; `scenarioSteps` maps scenario id to its step ids. */
export function rowProblems(row, where, scenarioSteps) {
  if (!row || typeof row !== 'object') return [`${where}: row is not an object`]
  const problems = []
  switch (row.kind) {
    case 'sandbox': {
      if (!(row.scenario in scenarioSteps)) {
        problems.push(`${where}: unknown scenario ${JSON.stringify(row.scenario)}`)
        break
      }
      if (!Array.isArray(row.steps) || row.steps.length === 0) problems.push(`${where}: a sandbox row needs steps`)
      else
        for (const step of row.steps)
          if (!scenarioSteps[row.scenario].includes(step))
            problems.push(`${where}: unknown step ${JSON.stringify(step)} of scenario ${row.scenario}`)
      if (!SANDBOX_TARGETS.includes(row.target))
        problems.push(`${where}: a sandbox row cannot claim ${row.target}; it is ${SANDBOX_TARGETS.join(' or ')}`)
      break
    }
    case 'ci-only':
      if (!isText(row.evidence)) problems.push(`${where}: a ci-only row names its test or gate in evidence`)
      if (!SANDBOX_TARGETS.includes(row.target)) problems.push(`${where}: a ci-only row cannot claim ${row.target}`)
      if ('scenario' in row) problems.push(`${where}: a ci-only row never names a scenario`)
      break
    case 'owner-checklist':
      if ('scenario' in row || 'steps' in row)
        problems.push(`${where}: an owner-checklist row never names a sandbox scenario`)
      if (!isText(row.item)) problems.push(`${where}: an owner-checklist row needs an item`)
      if (!OWNER_TARGETS.includes(row.target))
        problems.push(`${where}: an owner-checklist row targets ${OWNER_TARGETS.join(', ')}`)
      break
    case 'blocked-external':
      if ('scenario' in row || 'steps' in row)
        problems.push(`${where}: a blocked-external row never names a sandbox scenario`)
      if (!isText(row.unblock)) problems.push(`${where}: a blocked-external row needs an unblock step`)
      if (!isText(row.decision)) problems.push(`${where}: a blocked-external row needs a decision id`)
      break
    case 'pending-disposition':
      if (!PENDING_TICKETS.includes(row.ticket))
        problems.push(`${where}: pending-disposition names ${PENDING_TICKETS.join(' or ')}`)
      break
    case 'not-in-2.12':
      if (!isText(row.reason)) problems.push(`${where}: not-in-2.12 needs a reason`)
      break
    default:
      problems.push(`${where}: unknown row kind ${JSON.stringify(row.kind)}`)
  }
  return problems
}

/**
 * Every problem in the map: a missing or duplicated CAP or case, a bad row. An empty list means the map is complete and honest.
 * @param {any} map parsed capability-map.json
 * @param {Record<string, readonly string[]>} scenarioSteps SCENARIO_STEPS
 */
export function mapProblems(map, scenarioSteps) {
  const problems = []
  if (map?.schema !== 'metis.capability-map/1') problems.push('schema must be metis.capability-map/1')
  const caps = Array.isArray(map?.capabilities) ? map.capabilities : []
  for (const id of CAP_IDS) {
    const count = caps.filter((cap) => cap.id === id).length
    if (count === 0) problems.push(`${id}: missing`)
    if (count > 1) problems.push(`${id}: listed ${count} times`)
  }
  for (const cap of caps) {
    if (!CAP_IDS.includes(cap.id)) problems.push(`${cap.id}: not a CAP id`)
    if (!isText(cap.title)) problems.push(`${cap.id}: needs a title`)
    if (!Array.isArray(cap.rows) || cap.rows.length === 0) problems.push(`${cap.id}: needs at least one row`)
    else
      cap.rows.forEach((row, index) => problems.push(...rowProblems(row, `${cap.id} row ${index + 1}`, scenarioSteps)))
  }
  const cases = Array.isArray(map?.e2e) ? map.e2e : []
  for (const [id, letters] of Object.entries(E2E_CASES))
    for (const letter of letters) {
      const count = cases.filter((entry) => entry.id === id && entry.case === letter).length
      if (count === 0) problems.push(`${id} ${letter}: missing`)
      if (count > 1) problems.push(`${id} ${letter}: listed ${count} times`)
    }
  for (const entry of cases) {
    const where = `${entry.id} ${entry.case}`
    if (!E2E_CASES[entry.id]?.includes(entry.case)) problems.push(`${where}: not an E2E case`)
    if (!Array.isArray(entry.caps) || entry.caps.some((id) => !CAP_IDS.includes(id)))
      problems.push(`${where}: caps must be CAP ids`)
    if (!Array.isArray(entry.rows) || entry.rows.length === 0) problems.push(`${where}: needs at least one row`)
    else
      entry.rows.forEach((row, index) => problems.push(...rowProblems(row, `${where} row ${index + 1}`, scenarioSteps)))
  }
  return problems
}
