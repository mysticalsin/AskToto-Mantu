#!/usr/bin/env node
/**
 * Behaviour proof for `metis-mac-helper supervise` (M2-0028): argument and setup failures, exit-status and
 * stdout pass-through, signal forwarding, and the parent-death path (including a group member that ignores
 * TERM). Runs on the macOS hosted runner against the helper inside the packaged app.
 *
 * Usage:
 *   node scripts/qa/mac-helper-supervise.mjs <metis-mac-helper> <report.json>
 *
 * The report is content-free: case names, pass/fail and timings only.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SETUP_FAILURE_STATUS = 125
const REAP_BOUND_MS = 5_000
const POLL_MS = 100

function usage() {
  console.error('usage: node scripts/qa/mac-helper-supervise.mjs <metis-mac-helper> <report.json>')
  process.exit(2)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function groupMembers(pgid) {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => Number.isInteger(pid) && group === pgid)
    .map(([pid]) => pid)
}

function runHelper(helper, args, { parent = process.pid } = {}) {
  return spawnSync(helper, ['supervise', '--parent', String(parent), '--', ...args], { encoding: 'utf8', timeout: 20_000 })
}

async function untilGone(pgid) {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= REAP_BOUND_MS) {
    if (groupMembers(pgid).length === 0) return Date.now() - startedAt
    await sleep(POLL_MS)
  }
  return null
}

const CASES = [
  {
    name: 'missing-arguments-is-setup-failure',
    run: async (helper) => {
      const result = spawnSync(helper, ['supervise'], { encoding: 'utf8', timeout: 10_000 })
      return result.status === SETUP_FAILURE_STATUS ? null : `exit ${result.status}`
    }
  },
  {
    name: 'wrong-parent-is-setup-failure',
    run: async (helper) => {
      const result = runHelper(helper, ['/usr/bin/true'], { parent: 1 })
      return result.status === SETUP_FAILURE_STATUS ? null : `exit ${result.status}`
    }
  },
  {
    name: 'missing-command-is-setup-failure',
    run: async (helper) => {
      const result = runHelper(helper, ['/nonexistent/metis-hk-command'])
      return result.status === SETUP_FAILURE_STATUS ? null : `exit ${result.status}`
    }
  },
  {
    name: 'child-exit-status-propagates',
    run: async (helper) => {
      const result = runHelper(helper, ['/bin/sh', '-c', 'exit 7'])
      return result.status === 7 ? null : `exit ${result.status}`
    }
  },
  {
    name: 'stdout-and-stderr-are-inherited',
    run: async (helper) => {
      const result = runHelper(helper, ['/bin/sh', '-c', 'echo out-marker; echo err-marker 1>&2'])
      if (result.status !== 0) return `exit ${result.status}`
      return result.stdout.includes('out-marker') && result.stderr.includes('err-marker') ? null : 'stdio not inherited'
    }
  },
  {
    name: 'term-is-forwarded-to-the-child',
    run: async (helper) => {
      const proc = spawn(helper, ['supervise', '--parent', String(process.pid), '--', '/bin/sleep', '60'], { stdio: 'ignore' })
      const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })))
      await sleep(500)
      proc.kill('SIGTERM')
      const outcome = await Promise.race([exited, sleep(REAP_BOUND_MS).then(() => null)])
      if (!outcome) {
        proc.kill('SIGKILL')
        return 'helper did not exit after TERM'
      }
      return outcome.signal === 'SIGTERM' || outcome.code === 143 ? null : `exit ${outcome.code}/${outcome.signal}`
    }
  },
  {
    name: 'parent-death-kills-the-whole-group-including-term-ignorers',
    run: async (helper) => {
      const intermediateSource = `
        const { spawn } = require('node:child_process')
        const helper = spawn(${JSON.stringify(helper)}, ['supervise', '--parent', String(process.pid), '--',
          '/bin/sh', '-c', 'trap "" TERM; sleep 120 & wait'], { stdio: 'ignore' })
        console.log(helper.pid)
        setInterval(() => {}, 1000)
      `
      const intermediate = spawn(process.execPath, ['-e', intermediateSource], { stdio: ['ignore', 'pipe', 'ignore'] })
      const helperPid = await new Promise((resolve, reject) => {
        intermediate.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())))
        intermediate.once('error', reject)
      })
      if (!Number.isInteger(helperPid)) return 'no helper pid'
      await sleep(1_000)
      if (groupMembers(helperPid).length < 2) return 'group never formed'
      intermediate.kill('SIGKILL')
      const goneMs = await untilGone(helperPid)
      if (goneMs === null) {
        for (const pid of groupMembers(helperPid)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
        return `group survived ${REAP_BOUND_MS} ms`
      }
      return alive(helperPid) ? 'helper still alive' : null
    }
  }
]

async function main() {
  const [helper, reportPath] = process.argv.slice(2)
  if (!helper || !reportPath) usage()
  if (process.platform !== 'darwin') {
    console.error('mac-helper supervise proof runs on macOS only')
    process.exit(2)
  }
  const rows = []
  for (const testCase of CASES) {
    const startedAt = Date.now()
    let failure
    try {
      failure = await testCase.run(helper)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    rows.push({ name: testCase.name, status: failure ? 'FAIL' : 'PASS', ...(failure ? { failure } : {}), ms: Date.now() - startedAt })
  }
  const result = rows.every((row) => row.status === 'PASS') ? 'pass' : 'fail'
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify({ schema: 1, ticket: 'M2-0028', result, rows }, null, 2)}\n`)
  if (result !== 'pass') process.exit(1)
}

main().catch((error) => {
  console.error(`[mac-helper-supervise] ${error?.message ?? error}`)
  process.exit(2)
})
