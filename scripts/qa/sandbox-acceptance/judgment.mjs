// G88: the shared shape of a pure judge. A judge looks at observations and says PASS, FAIL (with problems) or NOT_SUPPORTED
// (with the reason the build or host cannot show this). `stepFromJudgment` turns that into the result `runStep` records, so a
// scenario step has no way to PASS while a problem stands and no way to report NOT_SUPPORTED without a reason.

/** @typedef {{ outcome: 'PASS' | 'FAIL' | 'NOT_SUPPORTED', reason?: string, problems: string[] }} Judgment */

/** @returns {Judgment} */
export const pass = () => ({ outcome: 'PASS', problems: [] })
/** @param {string[]} problems @returns {Judgment} */
export const fail = (problems) => ({ outcome: 'FAIL', problems })
/** @param {string} reason @returns {Judgment} */
export const notSupported = (reason) => ({ outcome: 'NOT_SUPPORTED', reason, problems: [] })

/**
 * @param {{ outcome: 'PASS' | 'FAIL' | 'NOT_SUPPORTED', reason?: string, problems: string[] }} judgment
 * @param {Record<string, unknown>} evidence counts, ids, hashes and booleans only
 */
export function stepFromJudgment(judgment, evidence) {
  if (judgment.outcome === 'FAIL')
    throw new Error(`${judgment.problems.join('; ')} (observed ${JSON.stringify(evidence)})`)
  if (judgment.outcome === 'NOT_SUPPORTED') return { status: 'NOT_SUPPORTED', reason: judgment.reason, evidence }
  return { evidence }
}
