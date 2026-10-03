#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DEFAULT_OUTPUT_DIR = 'out/refactor/guard-test-inventory'
const REMOVALS_HEADING = 'Removed guards and tests'

const GUARD_NAMES = ['assertMainWindow', 'denyIfLimited', 'assertBrainReader', 'requireAuth', 'registerHandler']
const GUARD_CALL = new RegExp(`(?<![\\w$.])(?<!function\\s+)(?:${GUARD_NAMES.join('|')})\\s*\\(`, 'g')
const TEST_CASE = /(?<![\w$.])(?:it|test)(?:\.(?:only|skip|concurrent|each))?\s*\(/g
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/
const GUARD_FILE = /^(?:src|operator|license-server)\/.*\.[cm]?[jt]sx?$/

export function countTestCases(source) {
  return source.match(TEST_CASE)?.length ?? 0
}

// Call sites only: a definition (`function assertMainWindow(`) is not a guard applied to a handler.
export function countGuardCalls(source) {
  return source.match(GUARD_CALL)?.length ?? 0
}

// Removals are declared as `- <what was removed> => <its replacement>` lines under the removals heading.
export function parseRemovals(body) {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && line.replace(/^#+\s+/, '').trim() === REMOVALS_HEADING)
  if (start < 0) return []
  const removals = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break
    const match = /^-\s+(.+?)\s+=>\s+(.+?)\s*$/.exec(line)
    if (match) removals.push({ removed: match[1], replacement: match[2] })
  }
  return removals
}

export function compareInventories({ base, head, body }) {
  const removals = parseRemovals(body)
  const testDrop = Math.max(0, base.tests - head.tests)
  const guardDrop = Math.max(0, base.guards - head.guards)
  const problems = []
  if (testDrop + guardDrop > removals.length) {
    problems.push(
      `Test cases dropped by ${testDrop} and guard call sites by ${guardDrop}, but ${removals.length} removal(s) are listed under "${REMOVALS_HEADING}" as "- <removed> => <replacement>".`
    )
  }
  return { ok: problems.length === 0, base, head, test_drop: testDrop, guard_drop: guardDrop, removals, problems }
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function inventoryAt(rev) {
  const files = git(['ls-tree', '-r', '--name-only', rev]).split('\n').filter(Boolean)
  const inventory = { tests: 0, guards: 0 }
  for (const path of files) {
    const isTest = TEST_FILE.test(path)
    if (!isTest && !GUARD_FILE.test(path)) continue
    const source = git(['show', `${rev}:${path}`])
    if (isTest) inventory.tests += countTestCases(source)
    else inventory.guards += countGuardCalls(source)
  }
  return inventory
}

function usageError(message) {
  console.error(`guard-test-inventory: ${message}`)
  console.error('usage: node scripts/refactor/guard-test-inventory.mjs --pr-event <event.json> --base <rev> --head <rev> [--output-dir <dir>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { outputDir: DEFAULT_OUTPUT_DIR }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--pr-event') args.prEvent = argv[++index]
    else if (arg === '--base') args.base = argv[++index]
    else if (arg === '--head') args.head = argv[++index]
    else if (arg === '--output-dir') args.outputDir = argv[++index]
    else usageError(`unknown argument ${arg}`)
  }
  if (!args.prEvent) usageError('--pr-event is required')
  if (!args.base) usageError('--base is required')
  if (!args.head) usageError('--head is required')
  return args
}

function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const body = JSON.parse(readFileSync(args.prEvent, 'utf8')).pull_request?.body
  if (typeof body !== 'string') usageError('event is missing pull_request.body')

  const result = compareInventories({ base: inventoryAt(args.base), head: inventoryAt(args.head), body })
  const outputDir = resolve(repoRoot, args.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const reportPath = join(outputDir, 'inventory.json')
  writeFileSync(reportPath, `${JSON.stringify({ schema: 1, ...result }, null, 2)}\n`)

  const displayPath = relative(repoRoot, reportPath)
  if (!result.ok) {
    console.error(`Guard and test inventory failed; report written to ${displayPath}`)
    for (const problem of result.problems) console.error(problem)
    process.exit(1)
  }
  console.log(`Guard and test inventory holds (tests ${result.base.tests} -> ${result.head.tests}, guards ${result.base.guards} -> ${result.head.guards}); report written to ${displayPath}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
