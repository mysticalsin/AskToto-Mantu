#!/usr/bin/env node
/**
 * lint-ratchet.mjs — M2-0052. The repository had no lint or format tooling, and a mass reformat would bury every
 * real change. This gate checks only the files a branch changes against its merge base with main:
 *
 *   lint    the correctness rules in biome.json. Each changed file may not have MORE diagnostics than the same
 *           file has at the merge base, so violations that already exist are baselined by construction (a file
 *           that was already dirty may stay dirty, never get dirtier) and a new or clean file must stay clean.
 *   format  `biome format` on the changed files. Report-only (exit 0) before FORMAT_BLOCKING_FROM, blocking on
 *           and after it, so the switch needs no workflow edit.
 *
 * Biome is fetched by exact version through npx rather than added as a dependency, so it touches neither
 * package-lock.json nor `npm ci`. Bump BIOME_VERSION here to upgrade it.
 *
 * Run: `node scripts/ci/lint-ratchet.mjs [lint|format] [--base <ref>]` (wired as `npm run lint:changed` and
 * `npm run format:changed`). Exit 0 = pass; 1 = regression or (once blocking) unformatted file, listed on stderr.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const BIOME_VERSION = '2.3.10'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// First day an unformatted changed file fails the format check (one week after the gate landed).
export const FORMAT_BLOCKING_FROM = '2026-10-06'
// The roots in biome.json's files.includes. A path outside them is ignored by Biome, and Biome fails a run in which
// every path it is given is ignored, so such paths are never passed.
const ROOTS = ['src/', 'operator/', 'cloudflare-proxy/', 'license-server/', 'scripts/']
const LINTABLE = /\.(?:[cm]?[jt]s|[jt]sx)$/
// Same exclusions as biome.json's files.includes: generated output is never hand-edited.
const GENERATED = /(?:^|\/)[^/]*\.generated\.[cm]?[jt]s$/

/** The changed paths Biome should look at. */
export function lintablePaths(paths) {
  return paths.filter((p) => ROOTS.some((root) => p.startsWith(root)) && LINTABLE.test(p) && !GENERATED.test(p))
}

/** Whether an unformatted file fails the format check on `now` (a Date; UTC calendar day). */
export function formatIsBlocking(now) {
  return now.toISOString().slice(0, 10) >= FORMAT_BLOCKING_FROM
}

/** Diagnostic count per file from a `biome lint --reporter=json` document. */
export function countByFile(reportJson) {
  const counts = {}
  for (const diagnostic of JSON.parse(reportJson).diagnostics ?? []) {
    const file = diagnostic.location?.path?.file
    if (typeof file !== 'string') continue
    const key = file.replace(/\\/g, '/').replace(/^\.\//, '')
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** Files whose diagnostic count rose above the base count (a file absent from `base` had none). */
export function regressions(base, head) {
  return Object.entries(head)
    .filter(([file, count]) => count > (base[file] ?? 0))
    .map(([file, count]) => ({ file, base: base[file] ?? 0, head: count }))
}

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function biome(args, cwd) {
  return spawnSync('npx', ['--yes', `@biomejs/biome@${BIOME_VERSION}`, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
}

function lintCounts(cwd, files) {
  if (files.length === 0) return {}
  // Biome exits non-zero when it reports errors; the report on stdout is what is wanted.
  const run = biome(['lint', '--reporter=json', '--max-diagnostics=none', ...files], cwd)
  if (run.error || !run.stdout) throw new Error(`biome lint produced no report: ${run.error ?? run.stderr}`)
  return countByFile(run.stdout)
}

/** The base revision of each file, laid out under a scratch directory beside a config that ignores git. */
function materialiseBase(mergeBase, files) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-base-'))
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8'))
  config.vcs = { enabled: false }
  writeFileSync(join(dir, 'biome.json'), JSON.stringify(config))
  const present = []
  for (const file of files) {
    const show = spawnSync('git', ['show', `${mergeBase}:${file}`], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    if (show.status !== 0) continue // added on this branch
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), show.stdout)
    present.push(file)
  }
  return { dir, present }
}

function changedFiles(mergeBase) {
  const out = git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase, 'HEAD'])
  return lintablePaths(out.split('\n').filter(Boolean)).filter((f) => existsSync(join(REPO_ROOT, f)))
}

function main(argv) {
  const mode = argv[0] === 'format' ? 'format' : 'lint'
  const baseFlag = argv.indexOf('--base')
  const baseRef = baseFlag === -1 ? 'origin/main' : argv[baseFlag + 1]
  const mergeBase = git(['merge-base', baseRef, 'HEAD'])
  const files = changedFiles(mergeBase)
  if (files.length === 0) {
    console.log(`No changed lintable files against ${baseRef}.`)
    return 0
  }

  if (mode === 'format') {
    const run = biome(['format', ...files], REPO_ROOT)
    process.stdout.write(run.stdout ?? '')
    process.stderr.write(run.stderr ?? '')
    if (run.status === 0) return 0
    if (formatIsBlocking(new Date())) return 1
    console.error(`Format check is report-only until ${FORMAT_BLOCKING_FROM}; it blocks from that day.`)
    return 0
  }

  const head = lintCounts(REPO_ROOT, files)
  const { dir, present } = materialiseBase(mergeBase, files)
  let base
  try {
    base = lintCounts(dir, present)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const worse = regressions(base, head)
  if (worse.length === 0) {
    console.log(`Lint ratchet holds for ${files.length} changed file(s) against ${baseRef}.`)
    return 0
  }
  for (const { file, base: before, head: after } of worse) {
    console.error(`${file}: ${after} lint diagnostic(s), was ${before} at the merge base`)
  }
  console.error('Run `npx @biomejs/biome@' + BIOME_VERSION + ' lint <file>` to see them.')
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)))
}
