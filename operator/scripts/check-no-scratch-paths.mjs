#!/usr/bin/env node
/**
 * check-no-scratch-paths.mjs — regression lock for M2-0055 / P5-F4.
 *
 * gates.mjs, preview.mjs, preview-tokens.mjs, preview-motion.mjs, seed-local.mjs and
 * screenshot.mjs used to default their scratch/preview directories to one past Claude Code agent
 * session's absolute sandbox path — session UUID and Tony's OneDrive folder layout baked in
 * verbatim (macOS-only, wrong the moment a different session, a teammate's Mac or a Linux CI
 * runner ran the same script). Every default now resolves through resolvePreviewDir()/
 * resolveScratchDir() (os.tmpdir()-based, overridable via METIS_QA_PREVIEW_DIR/METIS_QA_SCRATCH);
 * this check fails the build if a literal absolute scratch or per-user path creeps back into any
 * of those six files, in code or in a comment.
 *
 * Scoped to exactly these six files (the ones P5-F4 named), not all of operator/scripts/: a
 * repo-wide or directory-wide scan would also trip on pre-existing, unrelated absolute-path
 * literals elsewhere (e.g. operator/scripts/build-css.mjs's --reference fallback) that this
 * ticket does not fix.
 *
 * Run: `node operator/scripts/check-no-scratch-paths.mjs`
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

export const GUARDED_FILES = ['gates.mjs', 'preview.mjs', 'preview-tokens.mjs', 'preview-motion.mjs', 'seed-local.mjs', 'screenshot.mjs']

const FORBIDDEN = [
  { pattern: /\/private\/tmp\/claude-/, label: 'a past agent-session sandbox path (/private/tmp/claude-...)' },
  { pattern: /\/Users\/[A-Za-z]/, label: 'an absolute per-user path (/Users/<name>/...)' }
]

/** Returns one `"<file>:<line>: <label>"` string per forbidden literal found across GUARDED_FILES. */
export function findViolations(dir = SCRIPTS_DIR) {
  const violations = []
  for (const name of GUARDED_FILES) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(line)) violations.push(`${name}:${i + 1}: ${label}`)
      }
    })
  }
  return violations
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const violations = findViolations()
  if (violations.length) {
    console.error('✗ Hardcoded scratch/user path literal(s) found:\n')
    for (const v of violations) console.error('  ' + v)
    console.error('\nUse resolvePreviewDir()/resolveScratchDir() (os.tmpdir()-based) instead.')
    process.exit(1)
  }
  console.log(`✓ No hardcoded scratch/user path literals in ${GUARDED_FILES.join(', ')}.`)
}
