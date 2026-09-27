import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

/**
 * cahe-removal.contract.test.ts — M2-0214. Owner decision D-30 (2026-09-26): the Cahê pilot edition —
 * edition code, the embedded Kimi-key build path, its electron-builder config, its GitHub Actions
 * workflow, its packaging gate and its docs — is removed entirely. The Kimi key it used to embed was
 * already revoked at the vendor before this ticket; this file's job is to pin that no build path can
 * ever embed an edition key again, by proving no trace of the edition itself remains.
 *
 * Historical audit records are deliberately exempt from the tracked-tree scan below, the same carve-out
 * the ticket's own acceptance criterion states ("outside CHANGELOG/removal notes"): docs/qa/BUG-LEDGER.md
 * is a permanent, append-only registry of past defects (rewriting its historical "### MQA-###" write-ups
 * would falsify the record of what was actually found and fixed at the time), and
 * docs/qa/audit-2026-08-10.md / docs/security/AUDIT-10.md / docs/security/AUDIT-20.md are dated,
 * point-in-time verdicts already superseded by later work.
 */
describe('M2-0214 — the Cahê edition is removed entirely', () => {
  it('leaves no cahe-/CAHE_ identifier in the tracked tree, outside historical audit records', () => {
    const result = spawnSync(
      'git',
      [
        'grep',
        '-iE',
        'cahe-|cahe_|CAHE_|edition.*cah',
        '--',
        '.',
        ':!docs/qa/BUG-LEDGER.md',
        ':!docs/qa/audit-2026-08-10.md',
        ':!docs/security/AUDIT-10.md',
        ':!docs/security/AUDIT-20.md'
      ],
      { cwd: root, encoding: 'utf8' }
    )
    // `git grep` exits 1 for "no matches" — that is the PASSING case here, not an error. Exit 0 means it
    // found a live trace of the edition; anything else (128, …) means the invocation itself is broken.
    expect(result.status, `git grep found a live Cahê trace:\n${result.stdout}`).toBe(1)
  })

  it('deletes the edition source, its packaging gate, its workflow and its docs', () => {
    for (const path of [
      'src/main/cahe-edition.ts',
      'src/main/cahe-edition.test.ts',
      'src/main/cahe-embedded-key.ts',
      'src/main/cahe-embedded-key.test.ts',
      'src/main/cahe-disclosure.contract.test.ts',
      'scripts/check-cahe-package.mjs',
      'scripts/check-cahe-package.test.ts',
      'scripts/cahe-package.contract.test.ts',
      'scripts/build-cahe-windows.mjs',
      'electron-builder.cahe.win.yml',
      '.github/workflows/cahe-windows.yml',
      'docs/cahe-windows-edition.md'
    ]) {
      expect(existsSync(join(root, path)), `${path} must not exist`).toBe(false)
    }
  })

  it('carries no reference to the revoked CAHE_KIMI_JSON secret or the METIS_CAHE_EMBED_KEY flag', () => {
    const result = spawnSync(
      'git',
      [
        'grep',
        '-F',
        '-e',
        'CAHE_KIMI_JSON',
        '-e',
        'METIS_CAHE_EMBED_KEY',
        '--',
        '.',
        ':!docs/qa/BUG-LEDGER.md',
        ':!docs/qa/audit-2026-08-10.md',
        ':!docs/security/AUDIT-10.md',
        ':!docs/security/AUDIT-20.md'
      ],
      { cwd: root, encoding: 'utf8' }
    )
    expect(result.status, `git grep found:\n${result.stdout}`).toBe(1)
  })
})
