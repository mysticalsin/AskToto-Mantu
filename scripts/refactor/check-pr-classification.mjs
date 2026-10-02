#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DEFAULT_OUTPUT_DIR = 'out/refactor/pr-classification'

export function refactorClassification(body) {
  const pureMove = isChecked(body, 'Pure move')
  const behaviorChange = isChecked(body, 'Behaviour change')
  const problems = []
  if (pureMove && behaviorChange) problems.push('A refactor PR cannot be both a pure move and a behaviour change.')
  if (!pureMove && !behaviorChange) problems.push('Select exactly one refactor classification.')
  return { ok: problems.length === 0, type: pureMove ? 'pure-move' : behaviorChange ? 'behaviour-change' : null, problems }
}

function isChecked(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^- \\[[xX]\\]\\s+${escaped}\\s*$`, 'm').test(body)
}

function usageError(message) {
  console.error(`check-pr-classification: ${message}`)
  console.error('usage: node scripts/refactor/check-pr-classification.mjs --pr-event <event.json> [--output-dir <dir>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { outputDir: DEFAULT_OUTPUT_DIR }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--pr-event') args.prEvent = argv[++index]
    else if (arg === '--output-dir') args.outputDir = argv[++index]
    else usageError(`unknown argument ${arg}`)
  }
  if (!args.prEvent) usageError('--pr-event is required')
  return args
}

function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const event = JSON.parse(readFileSync(args.prEvent, 'utf8'))
  const body = event.pull_request?.body
  if (typeof body !== 'string') usageError('event is missing pull_request.body')

  const result = refactorClassification(body)
  const outputDir = resolve(repoRoot, args.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const reportPath = join(outputDir, 'classification.json')
  writeFileSync(reportPath, `${JSON.stringify({ schema: 1, ...result }, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `classification=${result.type ?? 'invalid'}\n`)

  const displayPath = relative(repoRoot, reportPath)
  if (!result.ok) {
    console.error(`Refactor classification failed; report written to ${displayPath}`)
    for (const problem of result.problems) console.error(problem)
    process.exit(1)
  }
  console.log(`Refactor classification is ${result.type}; report written to ${displayPath}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli()
