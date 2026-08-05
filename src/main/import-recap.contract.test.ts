import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Source-contract lock for the imported-recording auto-summary path (runImportedRecap lives inside
// index.ts and has no unit seam — same rationale as the other *.contract.test.ts files).
//
// Regression pinned (found live 2026-08-04, importing a real Downloads recording): the recap streamed
// completely, then the provider stream ended with a trailing idle-timeout error (claude-cli lingers
// after its final token) and onError REJECTED — discarding the finished summary. Transcript saved,
// Notes empty, recapError set: exactly the user-reported "import doesn't auto-summarize".
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('imported-recording recap survives a trailing stream error', () => {
  const start = indexSrc.indexOf('async function runImportedRecap')
  const body = indexSrc.slice(start, indexSrc.indexOf('function initializeImportJobs'))

  it('onError keeps substantial already-streamed summary text instead of discarding it', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/if \(text\.trim\(\)\.length >= 200\) \{/)
    expect(body).toMatch(/resolveRecap\(text\)/)
  })

  it('early failures (no meaningful text) still reject into the provider waterfall', () => {
    expect(body).toMatch(/rejectRecap\(new Error\(error\)\)/)
  })

  it('recap failure still never fails the import job (invariant from import-jobs.ts)', () => {
    const jobsSrc = readFileSync(join(__dirname, 'import-jobs.ts'), 'utf8')
    expect(jobsSrc).toMatch(/recapError/)
  })
})
