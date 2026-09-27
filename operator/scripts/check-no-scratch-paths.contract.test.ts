import { describe, expect, it } from 'vitest'
import { findViolations, GUARDED_FILES } from './check-no-scratch-paths.mjs'

// A pure source-text scan (readFileSync + regex, no module import), safe to run against gates.mjs,
// preview.mjs, preview-tokens.mjs, preview-motion.mjs, seed-local.mjs and screenshot.mjs whether or
// not they carry the M2-0055 fix yet — unlike importing those scripts directly (see
// scratch-paths.contract.test.ts), reading their text never risks running their unguarded main().
describe('check-no-scratch-paths', () => {
  it('guards exactly the six scripts named in finding P5-F4', () => {
    expect(GUARDED_FILES).toEqual(['gates.mjs', 'preview.mjs', 'preview-tokens.mjs', 'preview-motion.mjs', 'seed-local.mjs', 'screenshot.mjs'])
  })

  it('finds no hardcoded /private/tmp/claude- or /Users/ literal in the guarded scripts', () => {
    expect(findViolations()).toEqual([])
  })
})
