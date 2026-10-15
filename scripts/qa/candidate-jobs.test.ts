import { describe, expect, it } from 'vitest'
import { DEFERRED_OWNER_DIAGNOSTICS, candidateJobProblems } from './candidate-jobs.mjs'

function candidateJobs(conclusions: Array<'success' | 'skipped' | 'failure'> = ['success', 'success', 'success']) {
  const names = [...DEFERRED_OWNER_DIAGNOSTICS, 'Build mac']
  return {
    total_count: names.length,
    jobs: names.map((name, index) => ({ name, conclusion: conclusions[index] }))
  }
}

const disclosed = DEFERRED_OWNER_DIAGNOSTICS.map((name) => `- **Not run:** \`${name}\``).join('\n')

describe('candidate job gate', () => {
  it('accepts all-success jobs without a deferral note', () => {
    expect(candidateJobProblems(candidateJobs())).toEqual([])
  })

  it('accepts the two held owner diagnostics when each is disclosed', () => {
    expect(candidateJobProblems(candidateJobs(['skipped', 'skipped', 'success']), disclosed)).toEqual([])
  })

  it('rejects an unrelated skipped job', () => {
    const problems = candidateJobProblems(candidateJobs(['success', 'success', 'skipped']))
    expect(problems.some((problem) => problem.includes('unexpected skipped job: Build mac'))).toBe(true)
  })

  it('rejects a skipped owner diagnostic that the residuals do not name', () => {
    const problems = candidateJobProblems(
      candidateJobs(['skipped', 'success', 'success']),
      'Owner tests were unavailable.'
    )
    expect(problems.some((problem) => problem.includes(`must name ${DEFERRED_OWNER_DIAGNOSTICS[0]}`))).toBe(true)
  })

  it('rejects a disclosure line that is not only the diagnostic name', () => {
    const residuals = `- **Not run:** \`${DEFERRED_OWNER_DIAGNOSTICS[0]}\` — it actually passed`
    const problems = candidateJobProblems(candidateJobs(['skipped', 'success', 'success']), residuals)
    expect(problems.some((problem) => problem.includes(`must name ${DEFERRED_OWNER_DIAGNOSTICS[0]}`))).toBe(true)
  })

  it('does not require disclosure on a dry run', () => {
    expect(
      candidateJobProblems(candidateJobs(['skipped', 'skipped', 'success']), '', { requireDisclosure: false })
    ).toEqual([])
  })

  it('rejects a failed owner diagnostic', () => {
    const problems = candidateJobProblems(candidateJobs(['failure', 'success', 'success']), disclosed)
    expect(
      problems.some((problem) => problem.includes(`job did not succeed: ${DEFERRED_OWNER_DIAGNOSTICS[0]} (failure)`))
    ).toBe(true)
  })

  it('rejects a missing owner diagnostic', () => {
    const jobs = candidateJobs().jobs.slice(1)
    const problems = candidateJobProblems({ total_count: jobs.length, jobs })
    expect(problems.some((problem) => problem.includes('required owner diagnostic is missing'))).toBe(true)
  })
})
