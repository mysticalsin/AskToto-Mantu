import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Owner-Mac diagnostics that qa-candidate.yml holds with `if: false` until owner-account isolation
 * is proven. They appear on every candidate as skipped. A skip of any other job is still a refusal.
 */
export const DEFERRED_OWNER_DIAGNOSTICS = Object.freeze([
  'ST-1 control (no fixtures)',
  'ST-1 fifo stall row (macOS)'
])

/**
 * Validate the complete jobs response from a qa-candidate run.
 * Every job must succeed, except the two held owner-Mac diagnostics, which may be skipped.
 * Publishing requires each skipped diagnostic to be named on its own `Not run:` line in the residuals.
 */
export function candidateJobProblems(result, residuals = '', { requireDisclosure = true } = {}) {
  const problems = []
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return ['jobs response is not an object']
  }

  const { total_count: totalCount, jobs } = result
  if (!Number.isSafeInteger(totalCount) || totalCount <= 0) {
    problems.push('jobs response has no positive total_count')
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return [...problems, 'jobs response contains no jobs']
  }
  if (Number.isSafeInteger(totalCount) && totalCount !== jobs.length) {
    problems.push(`jobs response is incomplete: total_count=${totalCount}, received=${jobs.length}`)
  }

  const counts = new Map()
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || typeof job.name !== 'string' || job.name.trim() === '') {
      problems.push('jobs response contains an unnamed job')
      continue
    }
    counts.set(job.name, (counts.get(job.name) ?? 0) + 1)
  }
  for (const [name, count] of counts) {
    if (count !== 1) problems.push(`job name is duplicated: ${name}`)
  }

  for (const name of DEFERRED_OWNER_DIAGNOSTICS) {
    if (counts.get(name) !== 1) problems.push(`required owner diagnostic is missing or duplicated: ${name}`)
  }

  const allowed = new Set(DEFERRED_OWNER_DIAGNOSTICS)
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || typeof job.name !== 'string') continue
    if (job.conclusion === 'success') continue
    if (job.conclusion !== 'skipped') {
      problems.push(`job did not succeed: ${job.name} (${String(job.conclusion)})`)
      continue
    }
    if (!allowed.has(job.name)) {
      problems.push(`unexpected skipped job: ${job.name}`)
      continue
    }
    const disclosed = residuals.split(/\r?\n/).some((line) => {
      const disclosure = /^\s*(?:[-*]\s*)?(?:\*\*not run:\*\*|not run:)\s+`([^`]+)`\s*$/i.exec(line)
      return disclosure?.[1] === job.name
    })
    if (requireDisclosure && !disclosed) {
      problems.push(`release residuals must name ${job.name} and say it was not run`)
    }
  }

  return problems
}

async function main(args) {
  const [jobsPath, residualsPath, publishFlag] = args
  if (
    !jobsPath ||
    !residualsPath ||
    args.length > 3 ||
    (publishFlag && publishFlag !== '--require-disclosure')
  ) {
    console.error(
      'Usage: node scripts/qa/candidate-jobs.mjs <jobs.json> <residuals.md> [--require-disclosure]'
    )
    process.exitCode = 2
    return
  }

  let result
  try {
    result = JSON.parse(readFileSync(jobsPath, 'utf8'))
  } catch (error) {
    console.error(`Could not parse candidate jobs JSON: ${error.message}`)
    process.exitCode = 2
    return
  }

  const residuals = readFileSync(residualsPath, 'utf8')
  const problems = candidateJobProblems(result, residuals, {
    requireDisclosure: publishFlag === '--require-disclosure'
  })
  if (problems.length > 0) {
    console.error(`Candidate job gate rejected: ${JSON.stringify(problems)}`)
    process.exitCode = 1
    return
  }

  const deferred = result.jobs.filter((job) => job.conclusion === 'skipped')
  if (deferred.length > 0) {
    for (const job of deferred) console.log(`Deferred owner diagnostic: ${JSON.stringify(job.name)}`)
  }
  console.log(`Accepted ${result.jobs.length} candidate jobs; all non-deferred jobs succeeded.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
