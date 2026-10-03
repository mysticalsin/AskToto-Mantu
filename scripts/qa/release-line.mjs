#!/usr/bin/env node
// scripts/qa/release-line.mjs — which version a candidate may carry on which branch (M2-0499). Node builtins only.
//
// main builds the PD-08 sequence (X.Y.Z, X.Y.Z-beta.N, X.Y.Z-rc.N). release/1.9.x builds hotfixes of the
// promoted 1.9.7 as 1.9.7-hotfix.N: electron-builder names artifacts from that version, it is unique per
// hotfix, and it never contains the retired 1.9.8. A hotfix is only legal once v1.9.7 is a published feed
// release, and a version is never reused.
//
// versionForRefProblems reports what it found as string[]; empty means OK. Nothing here reads the network:
// the CLI takes the feed's tags and published releases as files, so the workflow owns the API calls.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MAIN_REF = 'refs/heads/main'
export const HOTFIX_REF = 'refs/heads/release/1.9.x'
export const ALLOWED_REFS = Object.freeze([MAIN_REF, HOTFIX_REF])

/** The version 1.9.x hotfixes are based on, and the one version number no candidate may ever carry. */
export const PROMOTED_BASE = '1.9.7'
export const RETIRED_VERSION = '1.9.8'

const NUMBER = '(?:0|[1-9]\\d*)'
const MAIN_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(?:beta|rc)\\.${NUMBER})?$`)
const HOTFIX_VERSION = new RegExp(`^${PROMOTED_BASE.replace(/\./g, '\\.')}-hotfix\\.[1-9]\\d*$`)

/**
 * @param {{ref: string, version: string, feedTags: string[], publishedReleases: string[]}} input
 *   feedTags: every git tag on the feed; publishedReleases: tag names of its non-draft releases.
 */
export function versionForRefProblems({ ref, version, feedTags, publishedReleases }) {
  if (!ALLOWED_REFS.includes(ref)) {
    return [`ref ${ref} may not build a candidate: only ${MAIN_REF} and ${HOTFIX_REF} may.`]
  }
  const problems = []
  if (version === RETIRED_VERSION) {
    problems.push(`version ${RETIRED_VERSION} is retired and is never built.`)
  }
  if (ref === MAIN_REF) {
    if (!MAIN_VERSION.test(version)) {
      problems.push(`version ${version} on main must be X.Y.Z, X.Y.Z-beta.N or X.Y.Z-rc.N.`)
    }
  } else {
    if (version === PROMOTED_BASE) {
      problems.push(`version ${PROMOTED_BASE} is already promoted: ${HOTFIX_REF} builds hotfixes as ${PROMOTED_BASE}-hotfix.N.`)
    } else if (!HOTFIX_VERSION.test(version)) {
      problems.push(`version ${version} on ${HOTFIX_REF} must be ${PROMOTED_BASE}-hotfix.N with N >= 1.`)
    }
    if (!publishedReleases.includes(`v${PROMOTED_BASE}`)) {
      problems.push(`v${PROMOTED_BASE} is not a published feed release, so ${HOTFIX_REF} has nothing to hotfix yet.`)
    }
  }
  if (feedTags.includes(`v${version}`) || publishedReleases.includes(`v${version}`)) {
    problems.push(`v${version} already exists on the feed. Versions are never reused.`)
  }
  return problems
}

/**
 * Promotion (M2-0500): which qa-candidate run branches may be published. A main candidate is unchanged; a
 * release/1.9.x candidate must carry a version versionForRefProblems accepts for that ref; any other branch is refused.
 * @param {{branch: string, version: string, feedTags: string[], publishedReleases: string[]}} input  branch: the run's head_branch.
 */
export function candidateBranchProblems({ branch, version, feedTags, publishedReleases }) {
  const ref = `refs/heads/${branch}`
  if (ref === MAIN_REF) return []
  if (ref !== HOTFIX_REF) return [`candidate branch ${branch} may not be promoted: only main and ${HOTFIX_REF.slice('refs/heads/'.length)} may.`]
  return versionForRefProblems({ ref, version, feedTags, publishedReleases })
}

function lines(path) {
  return readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
}

function flagValue(args, name) {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

function usage() {
  console.error(
    'usage: release-line.mjs check --ref <ref> --package <package.json> --tags <file> --releases <file> [--report-only]\n' +
      '       release-line.mjs candidate --branch <head_branch> --package <provenance.json> --tags <file> --releases <file>\n' +
      '  --tags and --releases hold one feed tag name per line; --report-only prints a ::warning:: and exits 0.'
  )
  process.exitCode = 2
}

function main(argv) {
  const [command, ...rest] = argv
  if (command !== 'check' && command !== 'candidate') return usage()
  const ref = flagValue(rest, command === 'check' ? '--ref' : '--branch')
  const packagePath = flagValue(rest, '--package')
  const tagsPath = flagValue(rest, '--tags')
  const releasesPath = flagValue(rest, '--releases')
  if (!ref || !packagePath || !tagsPath || !releasesPath) return usage()
  const reportOnly = rest.includes('--report-only')
  let problems
  try {
    const { version } = JSON.parse(readFileSync(packagePath, 'utf8'))
    const input = { version, feedTags: lines(tagsPath), publishedReleases: lines(releasesPath) }
    problems = command === 'check' ? versionForRefProblems({ ref, ...input }) : candidateBranchProblems({ branch: ref, ...input })
  } catch (error) {
    problems = [`could not read the check's inputs: ${error.message}`]
  }
  for (const problem of problems) console.log(`::${reportOnly ? 'warning' : 'error'}::${problem}`)
  if (problems.length && !reportOnly) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
