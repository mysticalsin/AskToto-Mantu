import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')

import { npmInstallWithDiagnosis } from './cli'

/**
 * MQA-250 — the install-failure advice must not be the cause of the failure.
 *
 * Reported from a real install:
 *
 *     npm error code EEXIST
 *     npm error Invalid response body while trying to fetch …/eventsource-parser:
 *       EACCES: permission denied, mkdir '/Users/<user>/.npm/_cacache/content-v2/sha512/79/da'
 *     ✗ Install failed (often a permissions issue with global npm).
 *       Try:  sudo npm i -g @dust-tt/dust-cli   then run this again.
 *
 * The unwritable path is under the user's OWN $HOME/.npm. It is root-owned because an earlier
 * `sudo npm …` created part of it as root — so the advice we printed was the thing that caused the
 * problem, and following it roots a few more files every time. npm's own docs say not to sudo global
 * installs for exactly this reason.
 *
 * These tests execute the generated script against a stub `npm` rather than reading it, because the bug
 * was in what the user actually saw, not in what the source looked like.
 */
describe('MQA-250 — npm install failure advice', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metis-npm-advice-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Run the generated block with `npm` stubbed to fail and print `output`. Returns what the user sees. */
  function runWith(output: string): string {
    // A bash FUNCTION rather than a file on PATH: on Windows/Git Bash a plain `npm` file loses to
    // npm.cmd and the REAL npm runs — which is how the first version of this test silently exercised
    // nothing at all. A function cannot be shadowed that way, on any platform.
    const script = join(dir, 'run.sh')
    writeFileSync(
      script,
      [
        '#!/bin/bash',
        'npm() {',
        "  cat <<'NPMEOF' >&2",
        output,
        'NPMEOF',
        '  return 1',
        '}',
        'read() { :; }',
        ...npmInstallWithDiagnosis('@anthropic-ai/claude-code', 'Step 1/2  Installing…')
      ].join('\n') + '\n',
      { mode: 0o755 }
    )
    try {
      return execFileSync('bash', [script], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      return `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
  }

  it('is valid bash — a script that does not parse advises nobody', () => {
    const script = ['#!/bin/bash', ...npmInstallWithDiagnosis('@openai/codex', 'Step 1/2  Installing…')].join('\n')
    const path = join(dir, 'syntax.sh')
    writeFileSync(path, script + '\n')
    expect(() => execFileSync('bash', ['-n', path], { stdio: 'pipe' })).not.toThrow()
  })

  it('NEVER tells the user to sudo npm install — that is what breaks the cache', () => {
    for (const pkg of ['@anthropic-ai/claude-code', '@openai/codex']) {
      const joined = npmInstallWithDiagnosis(pkg, 'x').join('\n')
      expect(joined).not.toMatch(/sudo npm (i|install)/)
    }
  })

  it('diagnoses a root-owned CACHE from the real reported output, and says not to sudo', () => {
    const out = runWith(
      [
        'npm error code EEXIST',
        'npm error syscall mkdir',
        "npm error path /Users/kennys/.npm/_cacache/content-v2/sha512/79/da",
        'npm error errno EEXIST',
        "npm error Invalid response body while trying to fetch https://registry.npmjs.org/eventsource-parser: EACCES: permission denied, mkdir '/Users/kennys/.npm/_cacache/content-v2/sha512/79/da'"
      ].join('\n')
    )
    expect(out).toMatch(/npm cache is owned by root/i)
    expect(out).toMatch(/chown -R/)
    expect(out).toMatch(/\.npm/)
    // The load-bearing negative: the old advice, and the thing that deepens the hole.
    expect(out).not.toMatch(/sudo npm (i|install)/)
    expect(out).toMatch(/WITHOUT sudo/i)
  })

  it('diagnoses an unwritable global PREFIX differently — opposite fix', () => {
    const out = runWith(
      [
        'npm error code EACCES',
        'npm error syscall mkdir',
        "npm error path /usr/local/lib/node_modules/@openai",
        "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@openai'"
      ].join('\n')
    )
    expect(out).toMatch(/could not write to its global folder/i)
    expect(out).toMatch(/npm config set prefix/)
    expect(out).not.toMatch(/sudo npm (i|install)/)
    // A prefix problem is not a cache problem; conflating them sends the user to the wrong fix.
    expect(out).not.toMatch(/cache is owned by root/i)
  })

  it('uses pipefail, or every failure would read as success', () => {
    // The install is piped to tee so the log can be inspected. Without pipefail the `if` reads tee's
    // exit status — which is 0 — and the whole diagnosis block becomes unreachable.
    const lines = npmInstallWithDiagnosis('@openai/codex', 'x')
    expect(lines[0]).toBe('set -o pipefail')
    expect(lines.join('\n')).toMatch(/\| tee "\$NPM_LOG"/)
  })
})
