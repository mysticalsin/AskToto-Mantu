#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refactorClassification } from './check-pr-classification.mjs'
import { findMovedFiles, parseNameStatus } from './verify-move.mjs'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DEFAULT_OUTPUT_DIR = 'out/refactor/pr-kind'
const DEFAULT_MOVE_THRESHOLD = 200
const DEFAULT_SOURCE_MAP = 'docs/PLATFORM-MAP.md'

// A PR must declare exactly one kind. A behaviour-change PR may not carry a relocated block of at least
// `threshold` tokens (verify-move's own move detection, so it cannot be dodged by relabelling), and any PR that
// moves non-test files must update the source map so readers can still find the code.
export function checkPrKind({ body, entries, readAtRevision, threshold = DEFAULT_MOVE_THRESHOLD, sourceMap = DEFAULT_SOURCE_MAP }) {
  const classification = refactorClassification(body)
  const problems = [...classification.problems]
  const moves = findMovedFiles({ entries, readAtRevision })
  const movedTokens = moves.reduce((total, move) => total + move.tokens, 0)

  if (classification.type === 'behaviour-change' && movedTokens >= threshold) {
    problems.push(
      `A behaviour-change PR relocates ${movedTokens} tokens (threshold ${threshold}): ${moves.map((m) => `${m.oldPath} -> ${m.newPath}`).join(', ')}. Send the pure move as its own PR.`
    )
  }

  const touched = new Set(entries.flatMap((entry) => [entry.path, entry.oldPath, entry.newPath]).filter(Boolean))
  const sourceFileMoves = moves.filter((move) => !/\.test\.[cm]?[jt]sx?$/.test(move.newPath))
  if (sourceFileMoves.length > 0 && !touched.has(sourceMap)) {
    problems.push(`${sourceFileMoves.length} file(s) moved but the source map (${sourceMap}) was not updated.`)
  }

  return { ok: problems.length === 0, type: classification.type, moved_tokens: movedTokens, moves, problems }
}

function usageError(message) {
  console.error(`check-pr-kind: ${message}`)
  console.error('usage: node scripts/refactor/check-pr-kind.mjs --pr-event <event.json> --base <rev> --head <rev> [--threshold <tokens>] [--source-map <path>] [--output-dir <dir>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { outputDir: DEFAULT_OUTPUT_DIR, threshold: DEFAULT_MOVE_THRESHOLD, sourceMap: DEFAULT_SOURCE_MAP }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--pr-event') args.prEvent = argv[++index]
    else if (arg === '--base') args.base = argv[++index]
    else if (arg === '--head') args.head = argv[++index]
    else if (arg === '--threshold') args.threshold = Number(argv[++index])
    else if (arg === '--source-map') args.sourceMap = argv[++index]
    else if (arg === '--output-dir') args.outputDir = argv[++index]
    else usageError(`unknown argument ${arg}`)
  }
  if (!args.prEvent) usageError('--pr-event is required')
  if (!args.base) usageError('--base is required')
  if (!args.head) usageError('--head is required')
  if (!Number.isFinite(args.threshold)) usageError('--threshold must be a number')
  return args
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const event = JSON.parse(readFileSync(args.prEvent, 'utf8'))
  const body = event.pull_request?.body
  if (typeof body !== 'string') usageError('event is missing pull_request.body')

  const entries = parseNameStatus(git(['diff', '--name-status', '--find-renames=50%', '-z', args.base, args.head]))
  const result = checkPrKind({
    body,
    entries,
    threshold: args.threshold,
    sourceMap: args.sourceMap,
    readAtRevision: (side, path) => git(['show', `${side === 'base' ? args.base : args.head}:${path}`])
  })

  const outputDir = resolve(repoRoot, args.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const reportPath = join(outputDir, 'pr-kind.json')
  writeFileSync(reportPath, `${JSON.stringify({ schema: 1, ...result }, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `classification=${result.type ?? 'invalid'}\n`)

  const displayPath = relative(repoRoot, reportPath)
  if (!result.ok) {
    console.error(`PR kind check failed; report written to ${displayPath}`)
    for (const problem of result.problems) console.error(problem)
    process.exit(1)
  }
  console.log(`PR kind is ${result.type}; report written to ${displayPath}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
