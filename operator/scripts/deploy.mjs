#!/usr/bin/env node
/**
 * deploy.mjs — versioned, gated deploy for the Métis Operator Worker.
 *
 *   node operator/scripts/deploy.mjs --dry-run [--env staging|production]
 *   node operator/scripts/deploy.mjs --env staging
 *   node operator/scripts/deploy.mjs --env production
 *
 * Order of operations (every step is fatal on failure — no step after a failure runs):
 *   1. Refuse a dirty git tree (`git status --porcelain`), unless --allow-dirty.
 *   2. Local `tsc --noEmit` for operator/tsconfig.json and operator/client/tsconfig.json.
 *   3. Local `vitest run --config operator/vitest.config.ts` (operator's own test suite).
 *   4. Build the client bundle (`build-client.mjs`) and, if it exists yet, the world bundle
 *      (`build-world.mjs` — still landing from another P0.4/P1.3 task at the time this script was
 *      written; skipped with a loud note if the file is absent, never silently).
 *   5. Compute OPERATOR_VERSION (`git rev-parse --short HEAD`) and OPERATOR_BUILT_AT (now, ISO).
 *   6. Run the D1 migration runner (`migrate.mjs --remote [--env staging]`) BEFORE deploying, so a
 *      new schema is in place before the new code that expects it goes live.
 *   7. Lockfile-pinned `wrangler deploy [--env staging] --var OPERATOR_VERSION:<sha> --var OPERATOR_BUILT_AT:<iso>`.
 *      TEAM_DOMAIN and every other `vars` entry in wrangler.jsonc are left alone — `--var` only
 *      overrides the two keys named here for this deploy, per Wrangler's docs (it does not require
 *      restating the whole vars object, and does not persist to the config file).
 *   8. Post-deploy smoke (`smoke.mjs`) against the environment's URL.
 *
 * Run npm ci before deployment. All JS CLIs run through process.execPath using the committed
 * dependencies; no production gate resolves executables through npx. Cloudflare authentication
 * is required for steps 6 onward. Missing authentication fails closed with the CLI error, never
 * a silent skip. --dry-run prints the full plan without executing steps 2-8.
 *
 * Rollback: `cd operator && node ../node_modules/wrangler/bin/wrangler.js rollback [--env staging]`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandFailureDetails, localNodeCommand } from './toolchain.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const REPO_ROOT = join(OPERATOR_ROOT, '..')

export const DEPLOYED_URLS = {
  production: 'https://metis-operator.tony-walteur.workers.dev',
  staging: 'https://metis-operator-staging.tony-walteur.workers.dev'
}

export function parseArgs(argv) {
  const args = { env: 'staging', dryRun: false, allowDirty: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env') args.env = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--allow-dirty') args.allowDirty = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  if (args.env !== 'production' && args.env !== 'staging') {
    throw new Error(`--env must be "production" or "staging", got ${JSON.stringify(args.env)}`)
  }
  return args
}

/** Pure: builds the wrangler deploy argv (no cwd, no execution). */
export function buildDeployArgs({ env, version, builtAt }) {
  const args = ['deploy', '--var', `OPERATOR_VERSION:${version}`, '--var', `OPERATOR_BUILT_AT:${builtAt}`]
  if (env === 'staging') args.push('--env', 'staging')
  return args
}

/** Pure: builds the migration-runner argv, run BEFORE deploy. */
export function buildMigrateArgs({ env }) {
  const args = [posix.join('operator', 'scripts', 'migrate.mjs'), '--remote']
  if (env === 'staging') args.push('--env', 'staging')
  return args
}

/** Pure: builds the post-deploy smoke argv. `url` is the environment's known workers.dev URL,
 *  or (preferred, when available) the URL wrangler's own deploy output printed. */
export function buildSmokeArgs({ url }) {
  return [posix.join('operator', 'scripts', 'smoke.mjs'), '--url', url]
}

/** Pure: pulls the first `https://…workers.dev` URL out of `wrangler deploy`'s stdout, so the
 *  smoke check targets exactly what was just deployed rather than a hard-coded guess. Falls back
 *  to the known per-environment URL (DEPLOYED_URLS) when wrangler's output does not contain one
 *  (e.g. a custom domain route, or output shape changes in a future wrangler). */
export function extractDeployedUrl(stdout, env) {
  const match = /https:\/\/[a-z0-9.-]+\.workers\.dev\S*/i.exec(stdout || '')
  if (match) return match[0].replace(/[).,]+$/, '')
  return DEPLOYED_URLS[env]
}

export function formatBuiltAt(date = new Date()) {
  return date.toISOString()
}

function printHelp() {
  console.log(`Usage: node operator/scripts/deploy.mjs [--env staging|production] [--dry-run] [--allow-dirty]

Default --env is staging. --dry-run prints every command this script would run (including the
resolved version/timestamp) without executing typecheck, tests, builds, migrations, or wrangler.
--allow-dirty skips the "clean git tree" gate (never use this for a production deploy).`)
}

function run(label, cmd, args, { cwd = REPO_ROOT, dryRun, capture = false } = {}) {
  const printable = `(cd ${cwd === REPO_ROOT ? '.' : cwd.replace(`${REPO_ROOT}/`, '')} && ${cmd} ${args.join(' ')})`
  if (dryRun) {
    console.log(`[dry-run] ${label}: ${printable}`)
    return { status: 0, stdout: '' }
  }
  console.log(`\n=== ${label} ===\n${printable}`)
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8'
  })
  if (capture && res.stdout) process.stdout.write(res.stdout)
  if (res.status !== 0 || res.error || res.signal) {
    console.error(commandFailureDetails({ ...res, stdout: '', stderr: '' }))
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? '' }
}

function runLocalTool(label, tool, args, options) {
  const command = localNodeCommand(tool, args)
  return run(label, command.cmd, command.args, options)
}

function fatal(message) {
  console.error(`deploy.mjs: ${message}`)
  process.exit(1)
}

function gitIsDirty() {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return (res.stdout || '').trim().length > 0
}

function gitShortSha() {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (res.status !== 0) throw new Error('git rev-parse --short HEAD failed — is this a git checkout?')
  return res.stdout.trim()
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    fatal(err.message)
  }
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const { env, dryRun, allowDirty } = args
  const receipt = { env, version: null, builtAt: null, url: null, migration: null, smoke: null }

  // 1. Clean tree gate.
  if (!dryRun && !allowDirty && gitIsDirty()) {
    fatal('git tree is dirty. Commit or stash first, or pass --allow-dirty (never for production).')
  }
  if (dryRun && gitIsDirty() && !allowDirty) {
    console.log('[dry-run] NOTE: git tree is currently dirty — a real run would refuse here without --allow-dirty.')
  }

  // Version stamp — computed even in dry-run so the printed plan is the real plan.
  const version = gitShortSha()
  const builtAt = formatBuiltAt()
  receipt.version = version
  receipt.builtAt = builtAt

  // 2. Typecheck.
  let res = runLocalTool('typecheck (operator)', 'typescript', ['--noEmit', '-p', 'operator/tsconfig.json'], { dryRun })
  if (res.status !== 0) fatal('typecheck failed for operator/tsconfig.json')
  res = runLocalTool('typecheck (operator/client)', 'typescript', ['--noEmit', '-p', 'operator/client/tsconfig.json'], {
    dryRun
  })
  if (res.status !== 0) fatal('typecheck failed for operator/client/tsconfig.json')

  // 3. Tests.
  res = runLocalTool('operator tests', 'vitest', ['run', '--config', 'operator/vitest.config.ts'], { dryRun })
  if (res.status !== 0) fatal('operator test suite failed')

  // 4. Builds.
  res = run('build client bundle', process.execPath, ['operator/scripts/build-client.mjs'], { dryRun })
  if (res.status !== 0) fatal('build-client.mjs failed')

  const worldBuildScript = join(OPERATOR_ROOT, 'scripts', 'build-world.mjs')
  if (existsSync(worldBuildScript) || dryRun) {
    res = run('build world bundle', process.execPath, ['operator/scripts/build-world.mjs'], { dryRun })
    if (!dryRun && res.status !== 0) fatal('build-world.mjs failed')
  } else {
    console.log('build world bundle: SKIPPED — operator/scripts/build-world.mjs does not exist yet.')
  }

  // 5. (version/builtAt already computed above)

  // 6. Migrate before deploy.
  const migrateArgs = buildMigrateArgs({ env })
  const migrateScript = join(REPO_ROOT, migrateArgs[0])
  if (!existsSync(migrateScript) && !dryRun) {
    fatal(
      `${migrateArgs[0]} does not exist yet. It must land (another P0.3 task) before a real deploy can run migrations before code.`
    )
  }
  res = run('migrate (before deploy)', process.execPath, migrateArgs, { dryRun })
  if (!dryRun && res.status !== 0) fatal('migration runner failed — deploy aborted, nothing was deployed')
  receipt.migration = dryRun ? '(dry-run, not executed)' : 'applied (see migrate.mjs output above)'

  // 7. Deploy.
  const deployArgs = buildDeployArgs({ env, version, builtAt })
  res = runLocalTool('wrangler deploy', 'wrangler', deployArgs, { cwd: OPERATOR_ROOT, dryRun, capture: true })
  if (!dryRun && res.status !== 0) {
    fatal(
      'wrangler deploy failed. If there is no Cloudflare auth on this machine, run ' +
        '`cd operator && node ../node_modules/wrangler/bin/wrangler.js login` first (see docs/operator/RUNBOOKS.md).'
    )
  }
  const url = dryRun ? DEPLOYED_URLS[env] : extractDeployedUrl(res.stdout, env)
  receipt.url = url

  // 8. Smoke.
  const smokeArgs = buildSmokeArgs({ url })
  res = run('post-deploy smoke', process.execPath, smokeArgs, { dryRun })
  if (!dryRun && res.status !== 0) {
    fatal(
      `post-deploy smoke FAILED against ${url}. The deploy already happened — this is a signal to ` +
        `investigate immediately or roll back: cd operator && node ../node_modules/wrangler/bin/wrangler.js rollback ${env === 'staging' ? '--env staging' : ''}`.trim()
    )
  }
  receipt.smoke = dryRun ? '(dry-run, not executed)' : 'all checks passed'

  printReceipt(receipt)
}

function printReceipt(receipt) {
  console.log('\n=== Métis Operator deploy receipt ===')
  console.log(`  environment:   ${receipt.env}`)
  console.log(`  version:       ${receipt.version}`)
  console.log(`  built at:      ${receipt.builtAt}`)
  console.log(`  url:           ${receipt.url}`)
  console.log(`  migration:     ${receipt.migration}`)
  console.log(`  smoke:         ${receipt.smoke}`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
