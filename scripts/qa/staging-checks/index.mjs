#!/usr/bin/env node
// Operator staging checks (M2-0566, .github/workflows/operator-staging.yml). CHECKS is the only list of checks
// the workflow runs: its guard refuses any other name, so a check that needs no new secret is added here and
// never edits the workflow. A check declares the staging secrets it needs from CHECK_SECRETS, the fixed list
// the workflow maps into the check step; the launcher runs it in a child process whose environment holds only
// those. The deploy token (DEPLOY_SECRET) reaches the deploy step alone and no check may declare it.
//
// Every file the workflow uploads is content-free (scanUploads): the deploy receipt, the check report and
// lane.json name no request body, token, account id or workers.dev account subdomain. lane.json uses the
// evidence-record field names, environment {kind: deployed-service, host: operator-staging} (M2-0565), and
// names the deploy run and bundle sha256 that produced the version /health serves, or deployment 'unknown'.
//
//   node scripts/qa/staging-checks/index.mjs guard --check <name>
//   node scripts/qa/staging-checks/index.mjs receipt --bundle-dir <dir> --version <short sha> --out <dir>
//   node scripts/qa/staging-checks/index.mjs version                       (STAGING_URL in the environment)
//   node scripts/qa/staging-checks/index.mjs deploy-runs <runs.json> --version <version>
//   node scripts/qa/staging-checks/index.mjs run --check <name> --expected-version <short sha> --out <dir> \
//     [--deployed-version <version>] [--deploy-run <id> --deploy-receipt <receipt.json>]
//   node scripts/qa/staging-checks/index.mjs scan <dir> --account <runner account>
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDeployTarget } from '../../../operator/scripts/deploy.mjs'
import { contentProblems } from '../candidate-scenarios.mjs'
import { GATEWAY_TOKEN, gatewayPrivacyCheck } from './gateway-privacy.mjs'
import { healthCheck } from './health.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const LANE_SCHEMA = 1
export const ENVIRONMENT = Object.freeze({ kind: 'deployed-service', host: 'operator-staging' })
export const STAGING_WORKER = 'metis-operator-staging'
export const DEPLOY_ARTIFACT = 'operator-staging-deploy'
export const RECEIPT_FILE = 'receipt.json'
export const REPORT_FILE = 'report.json'
export const DEPLOY_SECRET = 'OPERATOR_STAGING_CLOUDFLARE_TOKEN'
export const CHECK_SECRETS = Object.freeze([GATEWAY_TOKEN, 'OPERATOR_STAGING_TEST_DEVICE_CREDENTIAL'])
// Names a check child never inherits unless its entry declares them; wrangler reads the deploy token as CLOUDFLARE_API_TOKEN.
const WITHHELD = Object.freeze([DEPLOY_SECRET, 'CLOUDFLARE_API_TOKEN', ...CHECK_SECRETS])
const VERSION_RE = /^[a-z\d][a-z\d._-]{0,127}$/i
const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/

export const CHECKS = Object.freeze({
  health: Object.freeze({ ticket: 'M2-0103', secrets: Object.freeze([]), run: healthCheck }),
  'gateway-privacy': Object.freeze({ ticket: 'M2-0104', secrets: Object.freeze([GATEWAY_TOKEN]), run: gatewayPrivacyCheck })
})

export function checkEntry(name) {
  if (!Object.hasOwn(CHECKS, name)) {
    throw new Error(`${JSON.stringify(String(name))} is not a registered staging check (${Object.keys(CHECKS).join(', ')}).`)
  }
  const entry = CHECKS[name]
  const undeclared = entry.secrets.filter((secret) => !CHECK_SECRETS.includes(secret))
  if (undeclared.length) throw new Error(`${name} declares ${undeclared.join(', ')}, which the workflow does not map (CHECK_SECRETS).`)
  return entry
}

/** The environment a check's child process gets: `env` without any staging secret, plus the ones `name` declares. */
export function checkEnv(name, env) {
  const { secrets } = checkEntry(name)
  const result = { ...env }
  for (const secret of WITHHELD) delete result[secret]
  for (const secret of secrets) if (env[secret] !== undefined) result[secret] = env[secret]
  return result
}

/** The staging URL from the STAGING_URL repository variable: https only, with no path. */
export function stagingUrl(env) {
  const raw = String(env.STAGING_URL ?? '').trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('STAGING_URL (repository variable OPERATOR_STAGING_URL) is not set to a URL.')
  }
  if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '')) throw new Error('STAGING_URL must be an https origin.')
  return url.origin
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** sha256 of the bundle wrangler wrote with --outdir: the digest of a sha256sum-style manifest of every file, sorted by path. */
export function bundleDigest(dir) {
  const files = existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)).replaceAll('\\', '/'))
        .sort()
        .map((path) => ({ path, sha256: sha256(readFileSync(join(dir, path))) }))
    : []
  if (!files.length) throw new Error('wrangler wrote no bundle to --outdir, so its sha256 cannot be recorded.')
  return { sha256: sha256(files.map((file) => `${file.sha256}  ${file.path}\n`).join('')), files }
}

/** receipt.json: which commit and version a successful staging deploy uploaded, and the bundle's sha256. */
export function deployReceipt({ env, version, bundle, target }) {
  if (target.worker !== STAGING_WORKER || target.database !== STAGING_WORKER) {
    throw new Error(`The deploy target is ${target.worker} / ${target.database}, not ${STAGING_WORKER}.`)
  }
  if (!SHORT_SHA_RE.test(version) || !String(env.GITHUB_SHA ?? '').startsWith(version)) {
    throw new Error(`version ${version} is not the short sha of commit ${env.GITHUB_SHA}.`)
  }
  return {
    schema: LANE_SCHEMA,
    environment: 'staging',
    worker: target.worker,
    database: target.database,
    commit: env.GITHUB_SHA,
    version,
    deploy_run_id: Number(env.GITHUB_RUN_ID),
    bundle_sha256: bundle.sha256,
    bundle_files: bundle.files
  }
}

/** The version the staging Worker's /health reports, or '' when it reports none. */
export async function readDeployedVersion(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${url}/health`, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(10_000)
    })
    const body = await response.json()
    return response.status === 200 && typeof body?.version === 'string' && VERSION_RE.test(body.version) ? body.version : ''
  } catch {
    return ''
  }
}

/**
 * Runs of this workflow that may have deployed `version`, newest first: completed workflow_dispatch runs on
 * main whose commit has that short sha. The first whose deploy artifact exists is the latest successful
 * deploy, because the deploy job uploads its receipt only after deploy.mjs (and its smoke) passed.
 */
export function deployRunCandidates(runs, version) {
  if (!SHORT_SHA_RE.test(version ?? '')) return []
  return (runs?.workflow_runs ?? [])
    .filter((run) => run.status === 'completed' && run.event === 'workflow_dispatch' && run.head_branch === 'main')
    .filter((run) => typeof run.head_sha === 'string' && run.head_sha.startsWith(version))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((run) => run.id)
}

/** The deploy that produced what staging serves, or 'unknown' with the reason. */
export function deploymentFor({ deployedVersion, deployRunId, receipt }) {
  if (!deployedVersion) return { deployment: 'unknown', deployment_detail: 'the staging /health reported no version' }
  if (!receipt || !deployRunId) {
    return { deployment: 'unknown', deployment_detail: `no deploy run of operator-staging.yml produced version ${deployedVersion}` }
  }
  if (receipt.version !== deployedVersion || String(receipt.deploy_run_id) !== String(deployRunId)) {
    return {
      deployment: 'unknown',
      deployment_detail: `deploy run ${deployRunId} produced version ${receipt.version}, staging serves ${deployedVersion}`
    }
  }
  return {
    deployment: { run_id: Number(deployRunId), commit: receipt.commit, version: receipt.version, bundle_sha256: receipt.bundle_sha256 }
  }
}

/**
 * lane.json. Field names match the evidence record (commit, ci_run_id, environment, command, exit_code,
 * output sha256), so the lead copies them as they are. With deployment 'unknown' no deploy run is bound to
 * what was checked, and the lane is not evidence of a LIVE_VERIFIED deployment.
 */
export function laneRecord({ check, env, argv, exitCode, reportSha256, deployedVersion, deployRunId, receipt, detail }) {
  const entry = checkEntry(check)
  const deployment = deploymentFor({ deployedVersion, deployRunId, receipt })
  const outcome = exitCode === 0 && reportSha256 ? 'PASS' : 'FAIL'
  return {
    schema: LANE_SCHEMA,
    check,
    ticket: entry.ticket,
    commit: env.GITHUB_SHA,
    ci_run_id: Number(env.GITHUB_RUN_ID),
    environment: { ...ENVIRONMENT },
    command: ['node', ...argv].join(' '),
    exit_code: exitCode,
    outcome,
    report: reportSha256 ? { path: REPORT_FILE, sha256: reportSha256 } : null,
    deployed_version: deployedVersion || null,
    ...deployment,
    live_verified_eligible: outcome === 'PASS' && deployment.deployment !== 'unknown',
    detail: outcome === 'PASS' ? null : detail || null
  }
}

/** The job-summary markdown for a lane record. */
export function laneSummary(lane) {
  const deployment = lane.deployment === 'unknown'
    ? [['deployment', `unknown (${lane.deployment_detail}); not evidence of a LIVE_VERIFIED deployment`]]
    : [['deploy run', lane.deployment.run_id], ['bundle_sha256', lane.deployment.bundle_sha256]]
  const rows = [
    ['outcome', lane.outcome],
    ['check', lane.check],
    ['commit', lane.commit],
    ['ci_run_id', lane.ci_run_id],
    ['environment', `${lane.environment.kind} ${lane.environment.host}`],
    ['command', lane.command],
    ['exit_code', lane.exit_code],
    ['report sha256', lane.report?.sha256 ?? 'none'],
    ['deployed version', lane.deployed_version ?? 'none'],
    ...deployment
  ]
  if (lane.detail) rows.push(['detail', lane.detail])
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('`', "'")
  return [`### Staging check ${lane.check}: ${lane.outcome}`, '', '| field | value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | \`${cell(v)}\` |`), ''].join('\n')
}

// A Cloudflare account id is 32 hex digits; sha256 (64) and commit (40) runs are longer and never match.
const ACCOUNT_ID_RE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i

/** The content rules `text` breaks (names only), adding the staging host, whose subdomain names the account. */
export function stagingContentProblems(text, { account, host }) {
  const problems = contentProblems(text, { account })
  if (ACCOUNT_ID_RE.test(text)) problems.push('account id')
  if (host && text.toLowerCase().includes(host.toLowerCase())) problems.push('staging host')
  if (/\.workers\.dev\b/i.test(text)) problems.push('workers.dev host')
  if (/\bbearer\s+\S/i.test(text)) problems.push('authorization header')
  return problems
}

/** Deletes every file under `dir` that breaks a content rule, so it is never uploaded; returns `<file>: <rule>` lines. */
export function scanUploads(dir, { account, host }) {
  const problems = []
  if (!existsSync(dir)) return problems
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath ?? entry.path, entry.name)
    const hits = stagingContentProblems(readFileSync(path, 'utf8'), { account, host })
    if (!hits.length) continue
    rmSync(path, { force: true })
    for (const hit of hits) problems.push(`${basename(path)}: ${hit}`)
  }
  return problems
}

// --- CLI ----------------------------------------------------------------------------------------------

function flags(argv) {
  const values = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) values[argv[i].slice(2)] = argv[++i] ?? ''
    else positional.push(argv[i])
  }
  return { values, positional }
}

function required(values, name) {
  const value = values[name]
  if (value === undefined || value === '') throw new Error(`--${name} is required.`)
  return value
}

function lastLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? ''
}

function receipt(values) {
  const outDir = required(values, 'out')
  const target = resolveDeployTarget(readFileSync(join(REPO_ROOT, 'operator', 'wrangler.jsonc'), 'utf8'), 'staging')
  const record = deployReceipt({ env: process.env, version: required(values, 'version'), bundle: bundleDigest(required(values, 'bundle-dir')), target })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, RECEIPT_FILE), `${JSON.stringify(record, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `bundle_sha256=${record.bundle_sha256}\nversion=${record.version}\n`)
  console.log(`Deployed ${record.worker} version ${record.version}, bundle sha256 ${record.bundle_sha256}.`)
  return 0
}

function run(values) {
  const check = required(values, 'check')
  checkEntry(check)
  const outDir = required(values, 'out')
  const expectedVersion = required(values, 'expected-version')
  const deployedVersion = values['deployed-version'] ?? ''
  const deployRunId = values['deploy-run'] ?? ''
  const receiptPath = values['deploy-receipt']
  const receiptData = receiptPath && existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null
  stagingUrl(process.env)

  mkdirSync(outDir, { recursive: true })
  const script = relative(process.cwd(), fileURLToPath(import.meta.url)).replaceAll('\\', '/')
  const argv = [script, 'exec', '--check', check, '--expected-version', expectedVersion, '--out', outDir]
  const child = spawnSync(process.execPath, argv, { env: checkEnv(check, process.env), stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' })
  process.stderr.write(child.stderr ?? '')
  const reportPath = join(outDir, REPORT_FILE)
  const lane = laneRecord({
    check,
    env: process.env,
    argv,
    exitCode: child.status,
    reportSha256: existsSync(reportPath) ? sha256(readFileSync(reportPath)) : null,
    deployedVersion,
    deployRunId,
    receipt: receiptData,
    detail: child.signal ? `terminated by ${child.signal}` : child.error ? child.error.message : lastLine(child.stderr)
  })
  writeFileSync(join(outDir, 'lane.json'), `${JSON.stringify(lane, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, laneSummary(lane))
  if (lane.outcome !== 'PASS') console.log(`::error title=${check} ${lane.outcome}::${String(lane.detail ?? 'see the check log').replace(/[\r\n]+/g, ' ')}`)
  if (lane.deployment === 'unknown') console.log(`::warning title=${check} deployment unknown::${lane.deployment_detail}`)
  console.log(`${check}: ${lane.outcome}, exit ${lane.exit_code}`)
  return lane.outcome === 'PASS' ? 0 : 1
}

/** The child side of run: only the declared secrets are in this process's environment. */
async function exec(values) {
  const check = required(values, 'check')
  const entry = checkEntry(check)
  const outDir = required(values, 'out')
  const secrets = Object.fromEntries(entry.secrets.map((secret) => [secret, process.env[secret] ?? '']))
  const { ok, report } = await entry.run({ url: stagingUrl(process.env), expectedVersion: required(values, 'expected-version'), secrets })
  writeFileSync(join(outDir, REPORT_FILE), `${JSON.stringify({ check, ok, ...report }, null, 2)}\n`)
  return ok ? 0 : 1
}

async function main(argv) {
  const [command, ...rest] = argv
  const { values, positional } = flags(rest)
  switch (command) {
    case 'guard':
      checkEntry(required(values, 'check'))
      console.log(`${values.check} is a registered staging check.`)
      return 0
    case 'receipt':
      return receipt(values)
    case 'version': {
      const version = await readDeployedVersion(stagingUrl(process.env))
      process.stdout.write(`version=${version}\n`)
      return 0
    }
    case 'deploy-runs': {
      const [runsJson] = positional
      if (!runsJson) throw new Error('usage: deploy-runs <runs.json> --version <version>')
      process.stdout.write(deployRunCandidates(JSON.parse(readFileSync(runsJson, 'utf8')), values.version ?? '').join('\n'))
      return 0
    }
    case 'run':
      return run(values)
    case 'exec':
      return exec(values)
    case 'scan': {
      const [dir] = positional
      if (!dir) throw new Error('usage: scan <dir> --account <runner account>')
      const host = process.env.STAGING_URL ? new URL(stagingUrl(process.env)).hostname : ''
      const problems = scanUploads(dir, { account: required(values, 'account'), host })
      for (const problem of problems) console.log(`::error title=Content-free gate::${problem} (file removed from the upload)`)
      return problems.length ? 1 : 0
    }
    default:
      throw new Error('usage: index.mjs <guard|receipt|version|deploy-runs|run|exec|scan> ...')
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    // exit, not exitCode: a check's open keep-alive sockets must not hold the step open.
    process.exit(await main(process.argv.slice(2)))
  } catch (error) {
    console.error(`::error::${String(error.message).replaceAll('\n', '%0A')}`)
    process.exit(1)
  }
}
