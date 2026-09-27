import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

/**
 * cahe-removal.contract.test.ts — M2-0214. 2026-09-26: the Cahê pilot edition —
 * edition code, its embedded-key build path, its electron-builder config, its GitHub Actions
 * workflow, its packaging gate and its docs — is removed entirely. This file's job is to pin that no
 * build path can ever embed an edition key again, by proving no trace of the edition itself remains.
 *
 * A single case-insensitive git-grep over the whole tracked tree covers this. The matches are file
 * contents, not path names: every deleted Cahê file matched the same pattern in its contents 3 to 18
 * times (electron-builder.cahe.win.yml matched 6 times via strings like build/cahe-kimi.local.json and
 * Metis-Windows-Cahe-Setup, even though its own filename contains cahe. rather than cahe-/cahe_). The
 * removed CAHE_KIMI_JSON secret and METIS_CAHE_EMBED_KEY flag both contain CAHE_. That is why restoring
 * any deleted file, or reintroducing either removed identifier anywhere in the tree, fails this scan
 * without needing separate deleted-path existsSync checks or separate literal searches for the two
 * identifiers to catch that class of regression.
 *
 * Historical audit records are deliberately exempt from the tracked-tree scan below, the same carve-out
 * the ticket's own acceptance criterion states ("outside CHANGELOG/removal notes"): docs/qa/BUG-LEDGER.md
 * is a permanent, append-only registry of past defects (rewriting its historical "### MQA-###" write-ups
 * would falsify the record of what was actually found and fixed at the time), and
 * docs/qa/audit-2026-08-10.md / docs/security/AUDIT-10.md / docs/security/AUDIT-20.md are dated,
 * point-in-time verdicts already superseded by later work.
 */

// Historical records this file's own scan must not flag (see the file header), PLUS this file itself:
// both the regex pattern literal below and this header's own prose self-match the scan.
const EXCLUDE_PATHS = [
  ':!docs/qa/BUG-LEDGER.md',
  ':!docs/qa/audit-2026-08-10.md',
  ':!docs/security/AUDIT-10.md',
  ':!docs/security/AUDIT-20.md',
  ':!scripts/cahe-removal.contract.test.ts'
]

describe('M2-0214 — the Cahê edition is removed entirely', () => {
  it('leaves no cahe-/CAHE_ identifier in the tracked tree, outside historical audit records', () => {
    const result = spawnSync(
      'git',
      ['grep', '-iE', 'cahe-|cahe_|CAHE_|edition.*cah', '--', '.', ...EXCLUDE_PATHS],
      { cwd: root, encoding: 'utf8' }
    )
    // `git grep` exits 1 for "no matches" — that is the PASSING case here, not an error. Exit 0 means it
    // found a live trace of the edition; anything else (128, a null status from a missing git binary, …)
    // means the invocation itself is broken, and must not be reported as an empty "no trace found" match.
    expect(
      result.status,
      `git grep did not cleanly report "no matches" (status=${result.status}, error=${result.error}, ` +
        `stderr=${result.stderr}):\n${result.stdout}`
    ).toBe(1)
  })
})
