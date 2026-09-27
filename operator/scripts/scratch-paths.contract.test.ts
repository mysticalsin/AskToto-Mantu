import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findViolations } from './check-no-scratch-paths.mjs'
// Namespace imports (not named imports): a script that does not yet export a resolver fails each
// `it()` below with a clear "not a function" instead of crashing the whole file at module-load
// time on a missing named export.
import * as gates from './gates.mjs'
import * as preview from './preview.mjs'
import * as previewTokens from './preview-tokens.mjs'
import * as previewMotion from './preview-motion.mjs'
import * as seedLocal from './seed-local.mjs'
import * as screenshot from './screenshot.mjs'

const DEFAULT_ROOT = join(tmpdir(), 'metis-operator-preview')

describe('check-no-scratch-paths', () => {
  it('finds no hardcoded /private/tmp/claude- or /Users/ literal in the guarded scripts', () => {
    expect(findViolations()).toEqual([])
  })
})

describe.each([
  ['gates.mjs resolvePreviewDir', gates.resolvePreviewDir, 'METIS_QA_PREVIEW_DIR'],
  ['gates.mjs resolveScratchDir', gates.resolveScratchDir, 'METIS_QA_SCRATCH'],
  ['preview.mjs resolvePreviewDir', preview.resolvePreviewDir, 'METIS_QA_PREVIEW_DIR'],
  ['preview.mjs resolveScratchDir', preview.resolveScratchDir, 'METIS_QA_SCRATCH'],
  ['preview-tokens.mjs resolvePreviewDir', previewTokens.resolvePreviewDir, 'METIS_QA_PREVIEW_DIR'],
  ['preview-motion.mjs resolvePreviewDir', previewMotion.resolvePreviewDir, 'METIS_QA_PREVIEW_DIR'],
  ['seed-local.mjs resolveScratchDir', seedLocal.resolveScratchDir, 'METIS_QA_SCRATCH'],
  ['screenshot.mjs resolvePreviewDir', screenshot.resolvePreviewDir, 'METIS_QA_PREVIEW_DIR'],
  ['screenshot.mjs resolveScratchDir', screenshot.resolveScratchDir, 'METIS_QA_SCRATCH']
])('%s', (_label, resolve, envVar) => {
  it(`is exported as a function`, () => {
    expect(typeof resolve).toBe('function')
  })

  it(`defaults to os.tmpdir()/'metis-operator-preview' when ${envVar} is unset`, () => {
    expect(resolve({})).toBe(DEFAULT_ROOT)
  })

  it(`honors ${envVar} when set`, () => {
    expect(resolve({ [envVar]: '/custom/qa-dir' })).toBe('/custom/qa-dir')
  })

  it('never resolves to a hardcoded /Users/ or /private/tmp/claude- literal', () => {
    expect(resolve({})).not.toMatch(/\/Users\/|\/private\/tmp\/claude-/)
  })
})
