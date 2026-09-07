#!/usr/bin/env node
/**
 * dev-e2e suite runner: boots one real `metis-operator` Worker (`./boot.mjs`), runs every scenario
 * against it, tears it down, and prints a scenario table plus the exact product defect (file/line/
 * expected vs actual) for every failure. Never claims a pass it did not observe: a scenario that
 * throws is recorded as a failure with the error, not silently skipped.
 *
 * Usage:
 *   node operator/e2e/run.mjs                          run every scenario
 *   node operator/e2e/run.mjs tracking licensing        run only the named scenario(s)
 *
 * Requires: no Cloudflare login (uses `wrangler dev --local` only), and the Bash sandbox disabled
 * for network binding — see operator/e2e/README.md.
 */
import { bootWorker } from './boot.mjs'
import { skipped } from './lib/assert.mjs'
import * as tracking from './scenarios/tracking.mjs'
import * as licensing from './scenarios/licensing.mjs'
import * as authPrivacy from './scenarios/auth-privacy.mjs'
import * as consoleScenario from './scenarios/console.mjs'

const ALL_SCENARIOS = ['tracking', 'licensing', 'auth-privacy', 'console']

function padEnd(s, n) {
  return String(s).padEnd(n)
}

function printTable(results) {
  const header = ['Scenario', 'Status', 'Duration', 'Checks passed', 'Failures']
  const widths = [14, 20, 10, 14, 10]
  console.log(header.map((h, i) => padEnd(h, widths[i])).join(' | '))
  console.log(widths.map((w) => '-'.repeat(w)).join('-|-'))
  for (const r of results) {
    const statusLabel = r.status === 'pass' ? 'pass' : r.status === 'skip' ? `skip (${r.reason})` : 'FAIL'
    console.log(
      [
        padEnd(r.name, widths[0]),
        padEnd(statusLabel, widths[1]),
        padEnd(`${r.durationMs}ms`, widths[2]),
        padEnd(String(r.passedCount ?? 0), widths[3]),
        padEnd(String(r.failures?.length ?? 0), widths[4])
      ].join(' | ')
    )
  }
  console.log('')
  for (const r of results) {
    if (!r.failures?.length) continue
    console.log(`--- ${r.name}: ${r.failures.length} defect(s) ---`)
    r.failures.forEach((f, i) => {
      console.log(`  [${i + 1}] ${f.message}`)
      if (f.file) console.log(`      at ${f.file}${f.line ? `:${f.line}` : ''}`)
      if ('expected' in f) console.log(`      expected: ${JSON.stringify(f.expected)}`)
      if ('actual' in f) console.log(`      actual:   ${JSON.stringify(f.actual)}`)
    })
    console.log('')
  }
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const wanted = requested.length ? requested : ALL_SCENARIOS
  for (const w of wanted) {
    if (!ALL_SCENARIOS.includes(w)) {
      console.error(`Unknown scenario "${w}". Known: ${ALL_SCENARIOS.join(', ')}`)
      process.exit(2)
    }
  }

  console.log('dev-e2e: booting metis-operator Worker (wrangler dev --local, real D1, no Cloudflare login)...\n')
  let ctx
  try {
    ctx = await bootWorker({ log: (l) => console.log(`  ${l}`) })
  } catch (err) {
    console.error('\ndev-e2e: BOOT FAILED — no scenario could run.')
    console.error(err.message || err)
    process.exit(1)
    return
  }
  console.log(`\ndev-e2e: Worker up at ${ctx.baseUrl}\n`)

  const results = []
  try {
    if (wanted.includes('tracking')) {
      results.push(await safeRun('tracking', () => tracking.run(ctx)))
    } else {
      results.push(skipped('tracking', 'not requested'))
    }

    if (wanted.includes('licensing')) {
      results.push(await safeRun('licensing', () => licensing.run(ctx)))
    } else {
      results.push(skipped('licensing', 'not requested'))
    }

    if (wanted.includes('auth-privacy')) {
      results.push(await safeRun('auth-privacy', () => authPrivacy.run(ctx)))
    } else {
      results.push(skipped('auth-privacy', 'not requested'))
    }

    if (wanted.includes('console')) {
      const knownSeatText = [tracking.HOSTNAME, tracking.SSO_EMAIL].filter(Boolean)
      results.push(await safeRun('console', () => consoleScenario.run(ctx, { knownSeatText })))
    } else {
      results.push(skipped('console', 'not requested'))
    }
  } finally {
    await ctx.stop()
  }

  console.log('\n=== dev-e2e report ===\n')
  printTable(results)

  console.log('--- boot log tail ---')
  for (const line of ctx.getBootLog().slice(-40)) console.log(line)

  console.log('\nRe-run: node operator/e2e/run.mjs')

  const anyFail = results.some((r) => r.status === 'fail')
  process.exit(anyFail ? 1 : 0)
}

async function safeRun(name, fn) {
  const startedAt = Date.now()
  try {
    return await fn()
  } catch (err) {
    return {
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      passedCount: 0,
      failures: [{ message: `scenario threw: ${err.message || err}`, actual: err.stack }]
    }
  }
}

main().catch((err) => {
  console.error('dev-e2e: unexpected failure')
  console.error(err)
  process.exit(1)
})
