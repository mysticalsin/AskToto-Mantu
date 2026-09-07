#!/usr/bin/env node
/**
 * backup.mjs — D1 export/restore helper for the Métis Operator database.
 *
 * Export (default mode):
 *   node operator/scripts/backup.mjs                    # production DB, metis-operator
 *   node operator/scripts/backup.mjs --env staging       # staging DB, metis-operator-staging
 *   node operator/scripts/backup.mjs --dry-run           # print the wrangler command, do nothing
 *
 * Writes `operator/backups/<db>-<timestamp>.sql` via `wrangler d1 export --remote`. The
 * directory is gitignored (see .gitignore) — a D1 export is a full data dump (ciphertext Asks,
 * hashed license keys, seat rows) and must never land in git history.
 *
 * Restore (explanation-first, never silent):
 *   node operator/scripts/backup.mjs --restore path/to/backup.sql [--env staging]
 * Without --yes this only PRINTS the exact commands Tony would run and why, and exits 0. Pass
 * --yes to actually execute them. This mirrors D1's own posture (there is no single "restore"
 * verb — see the printed Time Travel note) and keeps a destructive action opt-in every time.
 *
 * No Cloudflare auth exists on this Mac (see docs/operator/RUNBOOKS.md); every wrangler
 * invocation here is meant to be run later by Tony after `npx wrangler@4 login`. The pure
 * command-building functions below are unit-tested in backup.contract.test.ts without touching
 * the network or wrangler at all.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const BACKUPS_DIR = join(OPERATOR_ROOT, 'backups')

export function resolveDbName(env) {
  return env === 'staging' ? 'metis-operator-staging' : 'metis-operator'
}

/** `YYYY-MM-DDTHHmmssZ`, filesystem-safe (no colons), sortable, unique to the second. */
export function formatBackupDate(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '')
}

export function backupFileName(env, date = new Date()) {
  return `${resolveDbName(env)}-${formatBackupDate(date)}.sql`
}

/** Pure: builds the wrangler argv for `wrangler d1 export`. No side effects. */
export function buildExportArgs({ env, outFile }) {
  const args = ['d1', 'export', resolveDbName(env), '--remote', '--output', outFile]
  if (env === 'staging') args.push('--env', 'staging')
  return args
}

/** Pure: the human-readable restore plan. Returns an array of { comment?, command } steps so the
 *  CLI can both print them and, with --yes, execute the `command` steps in order. */
export function buildRestorePlan({ env, file }) {
  const db = resolveDbName(env)
  const envFlag = env === 'staging' ? ['--env', 'staging'] : []
  return [
    {
      comment:
        'D1 Time Travel can restore to any point in the last 30 days WITHOUT this file — ' +
        `\`npx wrangler@4 d1 time-travel restore ${db} --timestamp=<ISO-8601>\` ${envFlag.join(' ')}`.trim() +
        ' — prefer that for an accidental-write rollback. Use the SQL file restore below only for a ' +
        'full re-seed (new environment, or Time Travel\'s 30-day window has already passed).'
    },
    {
      comment: `Executes every statement in ${file} against the LIVE remote database ${db}. This does ` +
        'not truncate existing tables first — CREATE TABLE IF NOT EXISTS statements are no-ops against ' +
        'an existing schema, and INSERT statements can conflict with rows written since the backup. ' +
        'Safe path: restore into a fresh D1 instance, verify, then repoint the Worker binding.',
      command: ['d1', 'execute', db, `--file=${file}`, '--remote', ...envFlag]
    }
  ]
}

export function parseArgs(argv) {
  const args = { env: 'production', dryRun: false, restore: null, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env') args.env = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--restore') args.restore = argv[++i]
    else if (a === '--yes') args.yes = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  if (args.env !== 'production' && args.env !== 'staging') {
    throw new Error(`--env must be "production" or "staging", got ${JSON.stringify(args.env)}`)
  }
  return args
}

function printHelp() {
  console.log(`Usage:
  node operator/scripts/backup.mjs [--env staging|production] [--dry-run]
  node operator/scripts/backup.mjs --restore <file.sql> [--env staging|production] [--yes]

Export defaults to production (metis-operator). --dry-run prints the wrangler command without
running it. --restore prints the exact restore plan; pass --yes to actually execute it.`)
}

function runWrangler(args, { dryRun }) {
  const printable = `npx wrangler@4 ${args.join(' ')}`
  if (dryRun) {
    console.log(`[dry-run] (cd operator && ${printable})`)
    return { status: 0, dryRun: true }
  }
  console.log(`Running: ${printable}`)
  const res = spawnSync('npx', ['wrangler@4', ...args], { cwd: OPERATOR_ROOT, stdio: 'inherit' })
  return { status: res.status ?? 1 }
}

function doExport(args) {
  mkdirSync(BACKUPS_DIR, { recursive: true })
  const fileName = backupFileName(args.env)
  const outFile = join('backups', fileName)
  const wranglerArgs = buildExportArgs({ env: args.env, outFile })
  const { status } = runWrangler(wranglerArgs, { dryRun: args.dryRun })
  if (status !== 0) {
    console.error(`backup.mjs: wrangler d1 export failed (exit ${status}).`)
    process.exit(1)
  }
  if (!args.dryRun) {
    console.log(`Wrote ${resolve(OPERATOR_ROOT, outFile)}`)
  }
}

function doRestore(args) {
  const file = resolve(process.cwd(), args.restore)
  const plan = buildRestorePlan({ env: args.env, file: args.restore })
  console.log(`Restore plan for ${resolveDbName(args.env)} from ${file}:\n`)
  for (const step of plan) {
    if (step.comment) console.log(`  # ${step.comment.replace(/\n/g, '\n  # ')}`)
    if (step.command) console.log(`  npx wrangler@4 ${step.command.join(' ')}`)
    console.log('')
  }
  if (!args.yes) {
    console.log('Dry explanation only (no --yes). Re-run with --yes to execute the restore step(s) above.')
    return
  }
  if (!existsSync(file)) {
    console.error(`backup.mjs: restore file not found: ${file}`)
    process.exit(1)
  }
  for (const step of plan) {
    if (!step.command) continue
    const { status } = runWrangler(step.command, { dryRun: false })
    if (status !== 0) {
      console.error(`backup.mjs: restore step failed (exit ${status}): npx wrangler@4 ${step.command.join(' ')}`)
      process.exit(1)
    }
  }
  console.log('Restore complete.')
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`backup.mjs: ${err.message}`)
    process.exit(1)
  }
  if (args.help) {
    printHelp()
    process.exit(0)
  }
  if (args.restore) doRestore(args)
  else doExport(args)
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) main()
