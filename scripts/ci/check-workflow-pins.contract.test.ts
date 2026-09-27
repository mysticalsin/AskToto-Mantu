import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findUnpinnedUses, workflowFiles, WORKFLOWS_DIR } from './check-workflow-pins.mjs'

/**
 * check-workflow-pins.contract.test.ts — M2-0223. release.yml's macOS/Windows release jobs run with
 * Developer ID / Authenticode signing secrets and a repo-publishing GH_TOKEN (RF-AUDIT-R3-R3,
 * RF-AUDIT-R3-R4); every job in build.yml runs with the default GITHUB_TOKEN. A `uses:` pinned to a
 * mutable tag (`@v4`) trusts whatever commit that tag currently resolves to, with no diff in this
 * repository to review if it ever moves.
 *
 * What is asserted, in two parts. First, that the DETECTOR (findUnpinnedUses, the same function
 * `npm run check:workflow-pins` runs in CI) classifies every reference shape correctly — pinned,
 * unpinned, commented-out, local, Docker. Second, that every workflow file GitHub Actions actually
 * checks out in this repository is clean under that detector, so this suite fails the moment a new
 * `uses: owner/repo@v4` lands anywhere in .github/workflows, not only in the two files this ticket
 * names.
 */

describe('findUnpinnedUses — classifies a single uses: reference', () => {
  const SHA = 'a'.repeat(40)

  it('flags a mutable major-version tag', () => {
    expect(findUnpinnedUses('      - uses: actions/checkout@v4\n')).toEqual([
      { line: 1, ref: 'actions/checkout@v4', reason: 'not pinned to a full 40-character commit SHA' }
    ])
  })

  it('flags a full commit SHA with no version comment', () => {
    expect(findUnpinnedUses(`      - uses: actions/checkout@${SHA}\n`)).toEqual([
      { line: 1, ref: `actions/checkout@${SHA}`, reason: 'missing a trailing "# vX" version comment' }
    ])
  })

  it('accepts a full commit SHA with a trailing major-version comment', () => {
    expect(findUnpinnedUses(`      - uses: actions/checkout@${SHA} # v4\n`)).toEqual([])
  })

  it('accepts a full semantic-version comment too', () => {
    expect(findUnpinnedUses(`      - uses: actions/checkout@${SHA} # v4.2.2\n`)).toEqual([])
  })

  it('rejects a short SHA — it must be the full 40 characters, not an abbreviation', () => {
    const short = SHA.slice(0, 7)
    expect(findUnpinnedUses(`      - uses: actions/checkout@${short} # v4\n`)).toEqual([
      { line: 1, ref: `actions/checkout@${short}`, reason: 'not pinned to a full 40-character commit SHA' }
    ])
  })

  it('does not flag a local composite action — it has no upstream tag to pin', () => {
    expect(findUnpinnedUses('      - uses: ./.github/actions/local\n')).toEqual([])
  })

  it('does not flag a Docker image reference — it has no tag to pin either', () => {
    expect(findUnpinnedUses('      - uses: docker://alpine:3.20\n')).toEqual([])
  })

  it('ignores a uses: mentioned inside a comment line', () => {
    expect(findUnpinnedUses('      # uses: actions/checkout@v4\n')).toEqual([])
  })

  it('reports every violation with its own line number, across multiple lines', () => {
    const yaml = [
      'jobs:',
      '  quality:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@v4'
    ].join('\n')
    expect(findUnpinnedUses(yaml).map((v) => v.line)).toEqual([4, 5])
  })
})

describe('CI workflow pins — every uses: in .github/workflows must be pinned', () => {
  const files = workflowFiles()

  it('found at least one workflow file to check — a stale path would make every test below vacuous', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`M2-0223 — ${file} has no unpinned action reference`, () => {
      const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8')
      expect(findUnpinnedUses(text)).toEqual([])
    })
  }
})
