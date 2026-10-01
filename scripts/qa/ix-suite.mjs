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

mkdirSync(dirname(out), { recursive: true })
const startedAt = new Date().toISOString()
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'src/main/infra/storage/meetings-index.test.ts'],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
)

const report = {
  suite: 'ix-suite',
  ticket: 'M2-0067.1',
  startedAt,
  finishedAt: new Date().toISOString(),
  command: 'npx vitest run src/main/infra/storage/meetings-index.test.ts',
  exitCode: result.status ?? 1,
  status: result.status === 0 ? 'PASS' : 'FAIL',
  stdout: result.stdout,
  stderr: result.stderr
}

writeFileSync(out, JSON.stringify(report, null, 2))
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exit(report.exitCode)
