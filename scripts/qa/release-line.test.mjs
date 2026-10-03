// scripts/qa/release-line.test.mjs — behaviour tests for the ref and version rule of the QA candidate lane (M2-0499).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { candidateBranchProblems, versionForRefProblems, MAIN_REF, HOTFIX_REF } from './release-line.mjs'

const MODULE_PATH = fileURLToPath(new URL('./release-line.mjs', import.meta.url))

// The feed as it stands before the cut: v1.9.6 promoted, and the retired v1.9.8 only a draft (no tag).
const BEFORE = { feedTags: ['v1.9.5', 'v1.9.6'], publishedReleases: ['v1.9.5', 'v1.9.6'] }
const AFTER = { feedTags: ['v1.9.6', 'v1.9.7'], publishedReleases: ['v1.9.6', 'v1.9.7'] }

test('main accepts 1.9.7 while the retired v1.9.8 draft exists', () => {
  const problems = versionForRefProblems({ ref: MAIN_REF, version: '1.9.7', ...BEFORE, publishedReleases: [...BEFORE.publishedReleases] })
  assert.deepEqual(problems, [])
  assert.deepEqual(versionForRefProblems({ ref: MAIN_REF, version: '1.9.7', feedTags: [...BEFORE.feedTags, 'v1.9.8'], publishedReleases: BEFORE.publishedReleases }), [])
})

test('main accepts the PD-08 beta and rc sequence', () => {
  for (const version of ['1.9.9', '2.0.0-beta.1', '2.0.0-rc.12']) {
    assert.deepEqual(versionForRefProblems({ ref: MAIN_REF, version, ...AFTER }), [], version)
  }
})

test('main refuses other prerelease shapes', () => {
  for (const version of ['2.0.0-alpha.1', '2.0.0-beta', '1.9.7-hotfix.1', '1.9', '01.9.7']) {
    assert.notDeepEqual(versionForRefProblems({ ref: MAIN_REF, version, ...AFTER }), [], version)
  }
})

test('1.9.8 is refused on every ref', () => {
  for (const ref of [MAIN_REF, HOTFIX_REF]) {
    const problems = versionForRefProblems({ ref, version: '1.9.8', ...AFTER })
    assert.ok(problems.some((p) => p.includes('retired')), `${ref}: ${problems.join('|')}`)
  }
})

test('release/1.9.x accepts 1.9.7-hotfix.1 once v1.9.7 is published', () => {
  assert.deepEqual(versionForRefProblems({ ref: HOTFIX_REF, version: '1.9.7-hotfix.1', ...AFTER }), [])
  assert.deepEqual(versionForRefProblems({ ref: HOTFIX_REF, version: '1.9.7-hotfix.10', ...AFTER }), [])
})

test('release/1.9.x refuses 1.9.7 as already promoted', () => {
  const problems = versionForRefProblems({ ref: HOTFIX_REF, version: '1.9.7', ...AFTER })
  assert.ok(problems.some((p) => p.includes('already promoted')), problems.join('|'))
})

test('release/1.9.x refuses versions outside the hotfix scheme', () => {
  for (const version of ['1.9.9', '1.9.7-hotfix.0', '1.9.7-hotfix', '1.9.7-rc.1', '1.9.7.1']) {
    assert.notDeepEqual(versionForRefProblems({ ref: HOTFIX_REF, version, ...AFTER }), [], version)
  }
})

test('a hotfix before v1.9.7 is published is refused, and a draft v1.9.7 does not count', () => {
  const problems = versionForRefProblems({ ref: HOTFIX_REF, version: '1.9.7-hotfix.1', ...BEFORE })
  assert.ok(problems.some((p) => p.includes('v1.9.7 is not a published feed release')), problems.join('|'))
})

test('an existing tag is never reused, on either ref', () => {
  const tags = { feedTags: [...AFTER.feedTags, 'v1.9.7-hotfix.1', 'v2.0.0-beta.1'], publishedReleases: [...AFTER.publishedReleases] }
  assert.ok(versionForRefProblems({ ref: HOTFIX_REF, version: '1.9.7-hotfix.1', ...tags }).some((p) => p.includes('never reused')))
  assert.ok(versionForRefProblems({ ref: MAIN_REF, version: '2.0.0-beta.1', ...tags }).some((p) => p.includes('never reused')))
  assert.ok(versionForRefProblems({ ref: MAIN_REF, version: '1.9.6', ...tags }).some((p) => p.includes('never reused')))
})

test('a release without a tag entry still blocks reuse of its version', () => {
  const problems = versionForRefProblems({ ref: MAIN_REF, version: '1.9.6', feedTags: [], publishedReleases: ['v1.9.6'] })
  assert.ok(problems.some((p) => p.includes('never reused')))
})

test('any other ref is refused with an error naming both allowed refs', () => {
  const problems = versionForRefProblems({ ref: 'refs/heads/feature/x', version: '1.9.7', ...AFTER })
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes(MAIN_REF) && problems[0].includes(HOTFIX_REF) && problems[0].includes('refs/heads/feature/x'))
})

function runCli({ ref, version, tags, releases, extra = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'release-line-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
    writeFileSync(join(dir, 'tags.txt'), tags.join('\n'))
    writeFileSync(join(dir, 'releases.txt'), releases.join('\n'))
    return spawnSync(
      process.execPath,
      [MODULE_PATH, 'check', '--ref', ref, '--package', join(dir, 'package.json'), '--tags', join(dir, 'tags.txt'), '--releases', join(dir, 'releases.txt'), ...extra],
      { encoding: 'utf8' }
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the CLI passes a legal version and fails an illegal one with an ::error::', () => {
  const ok = runCli({ ref: HOTFIX_REF, version: '1.9.7-hotfix.1', tags: AFTER.feedTags, releases: AFTER.publishedReleases })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const refused = runCli({ ref: HOTFIX_REF, version: '1.9.7', tags: AFTER.feedTags, releases: AFTER.publishedReleases })
  assert.equal(refused.status, 1)
  assert.match(refused.stdout, /^::error::.*already promoted/m)
})

test('--report-only turns every problem into a ::warning:: and never fails', () => {
  const result = runCli({ ref: MAIN_REF, version: '1.9.8', tags: [], releases: [], extra: ['--report-only'] })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^::warning::.*retired/m)
  assert.doesNotMatch(result.stdout, /::error::/)
})

test('promotion accepts a main candidate, and release/1.9.x only with a version legal for that ref', () => {
  assert.deepEqual(candidateBranchProblems({ branch: 'main', version: '1.9.7', ...BEFORE }), [])
  assert.deepEqual(candidateBranchProblems({ branch: 'release/1.9.x', version: '1.9.7-hotfix.1', ...AFTER }), [])
  const promoted = candidateBranchProblems({ branch: 'release/1.9.x', version: '1.9.7', ...AFTER })
  assert.ok(promoted.some((p) => p.includes('already promoted')), promoted.join('|'))
  assert.notDeepEqual(candidateBranchProblems({ branch: 'release/1.9.x', version: '1.9.7-hotfix.1', ...BEFORE }), [])
})

test('promotion refuses every other candidate branch, naming the allowed ones', () => {
  for (const branch of ['feature/x', 'release/1.8.x', 'main2', 'refs/heads/main', '']) {
    const problems = candidateBranchProblems({ branch, version: '1.9.7-hotfix.1', ...AFTER })
    assert.equal(problems.length, 1, branch)
    assert.ok(problems[0].includes('main') && problems[0].includes('release/1.9.x'), problems[0])
  }
})

function runCandidateCli({ branch, version }) {
  const dir = mkdtempSync(join(tmpdir(), 'release-line-'))
  try {
    writeFileSync(join(dir, 'provenance.json'), JSON.stringify({ version }))
    writeFileSync(join(dir, 'tags.txt'), AFTER.feedTags.join('\n'))
    writeFileSync(join(dir, 'releases.txt'), AFTER.publishedReleases.join('\n'))
    return spawnSync(
      process.execPath,
      [MODULE_PATH, 'candidate', '--branch', branch, '--package', join(dir, 'provenance.json'), '--tags', join(dir, 'tags.txt'), '--releases', join(dir, 'releases.txt')],
      { encoding: 'utf8' }
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the candidate CLI passes a legal hotfix and fails 1.9.7 on release/1.9.x and any other branch', () => {
  assert.equal(runCandidateCli({ branch: 'release/1.9.x', version: '1.9.7-hotfix.1' }).status, 0)
  assert.equal(runCandidateCli({ branch: 'main', version: '2.0.0-beta.1' }).status, 0)
  const promoted = runCandidateCli({ branch: 'release/1.9.x', version: '1.9.7' })
  assert.equal(promoted.status, 1)
  assert.match(promoted.stdout, /^::error::.*already promoted/m)
  assert.equal(runCandidateCli({ branch: 'feature/x', version: '1.9.7-hotfix.1' }).status, 1)
})

test('the CLI fails on unreadable inputs unless report-only, and rejects a bad command', () => {
  const missing = spawnSync(process.execPath, [MODULE_PATH, 'check', '--ref', MAIN_REF, '--package', '/nonexistent/package.json', '--tags', '/nonexistent/t', '--releases', '/nonexistent/r'], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.equal(spawnSync(process.execPath, [MODULE_PATH, 'bogus'], { encoding: 'utf8' }).status, 2)
})
