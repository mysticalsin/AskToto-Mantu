/**
 * design-docs-status.contract.test.ts
 *
 * Invariant: every file under `docs/design/*.md` carries a `Status:` line, so a reader can tell
 * whether a design contract is active, draft, or historical without opening every linked file.
 * A design doc that ships with no `Status:` line — or a rewrite that drops one — fails a named test
 * instead of silently going undated.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

describe('every docs/design/*.md file carries a Status: line', () => {
  const dir = join(REPO, 'docs/design')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()

  it('found the design doc set (fails loudly if the directory moves or empties)', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  for (const file of files) {
    it(`docs/design/${file} contains a Status: line`, () => {
      expect(read(`docs/design/${file}`)).toMatch(/Status:/)
    })
  }
})
