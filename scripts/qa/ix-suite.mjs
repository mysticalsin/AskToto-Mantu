#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const outArg = process.argv.indexOf('--out')
if (outArg >= 0 && !process.argv[outArg + 1]) {
  console.error('usage: node scripts/qa/ix-suite.mjs [--out <report.json>]')
  process.exit(2)
}
const out = outArg >= 0 ? process.argv[outArg + 1] : join(root, 'out', 'ix-suite', 'ix-suite.json')
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')

mkdirSync(dirname(out), { recursive: true })
const startedAt = new Date().toISOString()
const args = [vitest, 'run', 'src/main/infra/storage/meetings-index.test.ts']
const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const spawnError = result.error ? `\n[spawn-error] ${result.error.message}\n` : ''
const exitCode = result.status ?? 1

const report = {
  suite: 'ix-suite',
  ticket: 'M2-0067.1',
  startedAt,
  finishedAt: new Date().toISOString(),
  command: `${process.execPath} ${args.join(' ')}`,
  exitCode,
  status: exitCode === 0 ? 'PASS' : 'FAIL',
  stdout: result.stdout,
  stderr: `${result.stderr ?? ''}${spawnError}`
}

writeFileSync(out, JSON.stringify(report, null, 2))
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (spawnError) process.stderr.write(spawnError)
process.exit(exitCode)
