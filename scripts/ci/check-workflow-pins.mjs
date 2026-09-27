#!/usr/bin/env node
/**
 * check-workflow-pins.mjs — M2-0223. Every third-party GitHub Action referenced from a workflow in
 * this repository must be pinned to a full commit SHA, not a mutable tag such as `@v4`.
 *
 * Why this matters here specifically: release.yml's `release-macos` and `release-windows` jobs run
 * with Developer ID / Authenticode signing secrets and a `GH_TOKEN` that can publish to this repo's
 * public GitHub Releases page (RF-AUDIT-R3-R3, RF-AUDIT-R3-R4). A mutable tag lets whatever commit
 * `actions/checkout@v4` currently resolves to run inside that job with no diff in this repository to
 * review — a compromised or re-tagged upstream action would be trusted the next time CI executes.
 * Pinning to a SHA makes the action's code exactly as reviewable and immutable as any other pinned
 * dependency; the trailing `# vX.Y.Z` comment names the exact release a reviewer or Dependabot can
 * check the SHA against — a moving major tag such as `# v4` cannot be re-verified once that tag moves.
 *
 * What is scanned: every `uses:` step across every file in .github/workflows/, not only build.yml and
 * release.yml — a workflow this ticket didn't name still runs with the repo's default GITHUB_TOKEN, so
 * the same class of risk applies to all of them.
 *
 * What is out of scope: a local composite action (`uses: ./path`) has no upstream tag to pin. A Docker
 * image reference (`uses: docker://image`) is not exempt — it has no GitHub release tag to name in a
 * `# vX.Y.Z` comment, so it is accepted only when pinned by digest (`docker://image@sha256:<64 hex>`).
 *
 * Run: `node scripts/ci/check-workflow-pins.mjs` (wired as `npm run check:workflow-pins`).
 * Exit 0 = every uses: is pinned; 1 = at least one violation, listed on stderr.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows')

// A `uses:` step, as a sequence item (`- uses: ...`) or a bare step-level key, at any indentation.
// A line that merely mentions "uses:" inside a `#` comment does not start with it, so it never matches.
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/
// A local composite action: GitHub resolves one only when the path starts with `./`, never `../`.
const LOCAL_ACTION = /^\.\//
// A Docker image reference. It has a mutable tag by default (`docker://alpine:3.20`), so it is
// pinned only when it carries a sha256 digest instead.
const DOCKER_ACTION = /^docker:\/\//
const DOCKER_PINNED_TO_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-fA-F]{64}$/
// owner/repo[/subpath]@<40-character commit SHA>, with nothing else after the ref itself.
const PINNED_TO_SHA = /^[^@\s]+@[0-9a-fA-F]{40}$/
const VERSION_COMMENT = /#\s*v\d+\.\d+\.\d+\b/

/**
 * Every `uses:` reference in `yamlText` that is not pinned to a full commit SHA with a trailing
 * version comment. Returns `[]` when the text is clean.
 */
export function findUnpinnedUses(yamlText) {
  const violations = []
  yamlText.split(/\r?\n/).forEach((line, i) => {
    const match = USES_LINE.exec(line)
    if (!match) return
    const [, ref, trailing] = match
    if (LOCAL_ACTION.test(ref)) return
    if (DOCKER_ACTION.test(ref)) {
      if (!DOCKER_PINNED_TO_DIGEST.test(ref)) {
        violations.push({
          line: i + 1,
          ref,
          reason: 'docker image ref must be pinned by digest (docker://image@sha256:<64 hex>)'
        })
      }
      return
    }
    if (!PINNED_TO_SHA.test(ref)) {
      violations.push({ line: i + 1, ref, reason: 'not pinned to a full 40-character commit SHA' })
    } else if (!VERSION_COMMENT.test(trailing)) {
      violations.push({ line: i + 1, ref, reason: 'missing a trailing "# vX.Y.Z" version comment' })
    }
  })
  return violations
}

/** Every workflow file this gate covers, in this repository's .github/workflows/ directory. */
export function workflowFiles() {
  return readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name)).sort()
}

function main() {
  const files = workflowFiles()
  if (files.length === 0) {
    console.error(`[check:workflow-pins] FAIL — no workflow files found under ${WORKFLOWS_DIR}`)
    process.exit(1)
  }
  const violations = []
  for (const file of files) {
    const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8')
    for (const v of findUnpinnedUses(text)) violations.push({ file, ...v })
  }
  if (violations.length) {
    console.error(`[check:workflow-pins] FAIL — ${violations.length} unpinned action reference(s):`)
    for (const v of violations) console.error(`  - ${v.file}:${v.line} "${v.ref}" — ${v.reason}`)
    process.exit(1)
  }
  console.log(`[check:workflow-pins] OK — every uses: in ${files.length} workflow file(s) is pinned to a commit SHA`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
