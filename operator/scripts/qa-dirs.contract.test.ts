import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePreviewDir, resolveScratchDir } from './qa-dirs.mjs'

const DEFAULT_ROOT = join(tmpdir(), 'metis-operator-preview')

describe.each([
  ['resolvePreviewDir', resolvePreviewDir, 'METIS_QA_PREVIEW_DIR'],
  ['resolveScratchDir', resolveScratchDir, 'METIS_QA_SCRATCH']
])('%s', (_label, resolve, envVar) => {
  it(`defaults to os.tmpdir()/'metis-operator-preview' when ${envVar} is unset`, () => {
    expect(resolve({})).toBe(DEFAULT_ROOT)
  })

  it(`honors ${envVar} when set`, () => {
    expect(resolve({ [envVar]: '/custom/qa-dir' })).toBe('/custom/qa-dir')
  })
})
