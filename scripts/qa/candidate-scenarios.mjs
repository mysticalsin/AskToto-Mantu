#!/usr/bin/env node
// Candidate scenarios lane (M2-0467, .github/workflows/candidate-scenarios.yml). Installs the exact bytes of
// a qa-candidate.yml run, selected by sha256, on a fresh hosted profile and runs one packaged scenario on
// them. SCENARIOS below is the single source of truth: the workflow's scenario choices equal its keys, and
// the lane reads the platforms, variant, artifact, command and report of a scenario only from here.
//
// Every file the lane uploads is content-free (contentProblems), and lane.json uses the evidence-record
// field names (scripts/evidence/record.mjs), so the lead copies them into a record unchanged.
//
//   node scripts/qa/candidate-scenarios.mjs resolve --scenario <s> [--mac-sha256 <hex>] [--win-sha256 <hex>]
//   node scripts/qa/candidate-scenarios.mjs guard <run.json> <candidate_run>
//   node scripts/qa/candidate-scenarios.mjs profile --scenario <s> --platform <p>
//   node scripts/qa/candidate-scenarios.mjs run --scenario <s> --platform <p> --installer <relative path>
//       --sha256 <hex> --provenance <provenance.json> --candidate-run <id> --out <relative dir> [--app <installed app>]
//   node scripts/qa/candidate-scenarios.mjs scan <dir> --account <runner account>
// Node builtins only, so the guard job needs no npm ci.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'
import { VARIANTS } from './provenance.mjs'

export const LANE_SCHEMA = 1
export const QA_CANDIDATE_WORKFLOW = '.github/workflows/qa-candidate.yml'
export const PLATFORMS = Object.freeze(['mac', 'win'])
/** The GitHub-hosted image each platform runs on; it is also the evidence environment host. */
export const RUNNER_LABELS = Object.freeze({ mac: 'macos-latest', win: 'windows-latest' })

/** userData directory name per installed variant: Electron takes it from the packaged package.json name,
 *  which build/qa-identity.electron-builder.yml sets to asktoto-qa for the QA identity. */
export const PROFILE_DIRS = Object.freeze({ 'mac-qa-identity': 'asktoto-qa' })

/**
 * A scenario runs on each platform it declares. A platform entry names the qa-candidate variant and
 * artifact it installs, the script and arguments it runs (args receives the installer, its sha256, the
 * report path and the installed app), the report file the script writes, and the settings it seeds into the
 * fresh profile. isolatedProfiles marks a script that runs the app only on its own throwaway
 * ASKTOTO_USERDATA profiles, so the default profile is never touched. notCovered lists report rows the
 * platform cannot prove, each with the reason; lane.json carries them as a residual. qaOnlyHook marks a
 * scenario that needs a hook compiled only into QA-identity bytes; every other scenario installs a
 * promotable variant so its records bind to bytes that can ship.
 */
export const SCENARIOS = Object.freeze({
  // M2-0026: onFatal "Relaunch Métis", then a census 10 s later with no orphaned owned sidecar. The
  // SIGUSR2 fault hook exists only in QA-identity bytes, so it installs the Metis-QA zip.
  'fault-fatal-relaunch': Object.freeze({
    ticket: 'M2-0026',
    qaOnlyHook: true,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac-qa-identity',
        artifact: 'candidate-mac-qa-identity',
        script: 'scripts/qa/fault-fatal-relaunch.mjs',
        args: ({ installer, sha256, report }) => ['--zip', installer, '--sha256', sha256, '--out', report],
        report: 'fault-fatal-relaunch.json',
        settings: LOCAL_LLM_SETTINGS
      })
    })
  }),
  // M2-0027 acceptance[4] via M2-0468: SIGKILL main with a live sidecar, relaunch, orphan reaped within 5 s of
  // boot. The legacy rule is off in QA-identity bytes, so both platforms install promotable bytes. macOS
  // requires the real llama-server row (a BLOCKED_EXTERNAL there is a PRECONDITION, not a PASS).
  'sidecar-boot-reaper': Object.freeze({
    ticket: 'M2-0027',
    qaOnlyHook: false,
    exits: Object.freeze({ 0: 'PASS', 1: 'FAIL', 2: 'PRECONDITION' }),
    platforms: Object.freeze({
      mac: Object.freeze({
        variant: 'mac',
        artifact: 'candidate-mac',
        script: 'scripts/qa/sidecar-boot-reaper.mjs',
        args: ({ app, report }) => [app, report, '--require-real-llama'],
        report: 'sidecar-boot-reaper.json',
        isolatedProfiles: true
      }),
      win: Object.freeze({
        variant: 'win',
        artifact: 'candidate-win',
        script: 'scripts/qa/sidecar-boot-reaper.mjs',
        args: ({ app, report }) => [app, report],
        report: 'sidecar-boot-reaper.json',
        isolatedProfiles: true,
        notCovered: Object.freeze([
          Object.freeze({ row: 'realLlama', reason: 'The real llama-server proof runs on macOS only; the report marks it BLOCKED_EXTERNAL.' }),
          Object.freeze({ row: 'legacyOrphan', reason: 'The legacy-orphan proof runs on macOS only; the report marks it BLOCKED_EXTERNAL.' })
        ])
      })
    })
  })
})

const SHA256 = /^[0-9a-f]{64}$/

function scenarioEntry(scenario) {
  const entry = Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : undefined
  if (!entry) throw new Error(`Unknown scenario ${JSON.stringify(scenario)}; expected one of ${Object.keys(SCENARIOS).join(', ')}.`)
  return entry
}

function platformEntry(scenario, platform) {
  const entry = scenarioEntry(scenario).platforms[platform]
  if (!entry) throw new Error(`Scenario ${scenario} does not run on ${platform}.`)
  return entry
}

/**
 * Checks the dispatch inputs against the registry: the scenario must exist, every platform it runs on
 * needs a 64-hex sha256, and a sha256 for a platform it does not run on is refused rather than ignored.
 * Returns the normalized plan per platform; throws listing every problem.
 * @returns {Record<string, { variant: string, artifact: string, sha256: string }>}
 */
export function resolveScenario({ scenario, sha256 }) {
  const entry = scenarioEntry(scenario)
  const problems = []
  /** @type {Record<string, { variant: string, artifact: string, sha256: string }>} */
  const plan = {}
  for (const platform of PLATFORMS) {
    const given = String(sha256[platform] ?? '').trim().toLowerCase()
    const target = entry.platforms[platform]
    if (!target) {
      if (given) problems.push(`${platform}_sha256 is set, but ${scenario} does not run on ${platform}; leave it empty.`)
      continue
    }
    if (!SHA256.test(given)) {
      problems.push(`${platform}_sha256 is required for ${scenario} and must be 64 hexadecimal characters.`)
      continue
    }
    plan[platform] = { variant: target.variant, artifact: target.artifact, sha256: given }
  }
  if (problems.length) throw new Error(problems.join('\n'))
  return plan
}

/** The GITHUB_OUTPUT lines the guard job publishes for the platform jobs. */
export function resolveOutputs(plan) {
  const lines = []
  for (const platform of PLATFORMS) {
    lines.push(`${platform}=${Boolean(plan[platform])}`)
    if (plan[platform]) {
      lines.push(`${platform}_variant=${plan[platform].variant}`)
      lines.push(`${platform}_artifact=${plan[platform].artifact}`)
      lines.push(`${platform}_sha256=${plan[platform].sha256}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Decides from the Actions API run JSON (GET repos/{repo}/actions/runs/{id}) whether a run may be measured:
 * only a completed, successful workflow_dispatch run of qa-candidate.yml on main. A pull-request self-test
 * candidate is refused, since its bytes are a PR merge commit and can never be promoted.
 * Returns the problems; empty means the run is a candidate.
 */
export function candidateRunProblems(run, candidateRun) {
  if (typeof run !== 'object' || run === null) return ['The run JSON is not an object.']
  const problems = []
  if (String(run.id) !== String(candidateRun)) problems.push(`The API returned run ${run.id}, not ${candidateRun}.`)
  const path = String(run.path ?? '').replace(/@.*$/, '')
  if (path !== QA_CANDIDATE_WORKFLOW) problems.push(`Run ${candidateRun} is ${path || 'no workflow'}, not ${QA_CANDIDATE_WORKFLOW}.`)
  if (run.event !== 'workflow_dispatch') {
    problems.push(`Run ${candidateRun} was triggered by ${run.event}, not workflow_dispatch; a pull-request self-test is never a candidate.`)
  }
  if (run.head_branch !== 'main') problems.push(`Run ${candidateRun} ran on ${run.head_branch}, not main.`)
  if (run.status !== 'completed') problems.push(`Run ${candidateRun} is ${run.status}, not completed.`)
  if (run.conclusion !== 'success') problems.push(`Run ${candidateRun} concluded ${run.conclusion}, not success.`)
  return problems
}

/**
 * Makes the fresh profile a scenario runs on: the variant's userData directory must not exist yet (any
 * earlier state would make the run measure something other than a first install), and only the settings the
 * scenario declares are written. Returns the settings path. A scenario with isolatedProfiles never opens the
 * default profile, so nothing is written and null is returned.
 */
export function prepareProfile({ scenario, platform, appDataDir }) {
  const target = platformEntry(scenario, platform)
  if (target.isolatedProfiles) return null
  if (!appDataDir) throw new Error(`No fresh-profile location is declared for ${platform}.`)
  const name = PROFILE_DIRS[target.variant]
  if (!name) throw new Error(`No userData directory is declared for variant ${target.variant}.`)
  const profile = join(appDataDir, name)
  if (existsSync(profile)) throw new Error(`The ${name} userData directory already exists; the profile is not fresh.`)
  if (!target.settings) return null
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const settingsPath = join(profile, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify(target.settings, null, 2), { mode: 0o600 })
  return settingsPath
}

/** Maps a scenario script's exit code to its outcome; a code the scenario does not declare, or a kill by
 *  signal (null), is a FAIL. */
export function outcomeForExit(scenario, exitCode) {
  const exits = scenarioEntry(scenario).exits
  return Number.isInteger(exitCode) && Object.hasOwn(exits, exitCode) ? exits[exitCode] : 'FAIL'
}

/** The argv (after `node`) that runs a scenario. Every argument is repository-relative, so the recorded
 *  command never names the runner's home or temp directory.
 *  @param {{ scenario: string, platform: string, installer: string, sha256: string, outDir: string, app?: string }} options */
export function scenarioCommand({ scenario, platform, installer, sha256, outDir, app }) {
  const target = platformEntry(scenario, platform)
  const argv = [target.script, ...target.args({ installer, sha256, report: join(outDir, target.report).replaceAll('\\', '/'), app })]
  if (argv.some((arg) => typeof arg !== 'string' || arg === '')) {
    throw new Error(`The ${scenario} command is missing an argument; pass the installed app with --app.`)
  }
  const absolute = argv.filter((arg) => isAbsolute(arg) || /^[A-Za-z]:[\\/]/.test(arg))
  if (absolute.length) throw new Error(`The scenario command must use repository-relative paths; got ${absolute.length} absolute.`)
  return argv
}

/** The provenance must be the candidate run's own: build_run_id and commit are taken from it. */
export function assertCandidateProvenance(provenance, candidateRun) {
  if (String(provenance?.run?.id) !== String(candidateRun)) {
    throw new Error(`provenance run ${provenance?.run?.id} is not the candidate run ${candidateRun}.`)
  }
}

/**
 * lane.json: what ran, on which bytes and host, and how it ended. Field names match the evidence record
 * (build_run_id, commit, artifact_sha256, ci_run_id, environment, command, exit_code) so the lead copies
 * them into a LIVE_VERIFIED record as they are. A platform that cannot prove some report rows adds
 * not_covered, so a PASS there is never read as covering them.
 */
export function laneRecord({ scenario, platform, env, provenance, candidateRun, installer, sha256, argv, exitCode, detail, reportWritten }) {
  const target = platformEntry(scenario, platform)
  assertCandidateProvenance(provenance, candidateRun)
  const outcome = outcomeForExit(scenario, exitCode)
  const host = RUNNER_LABELS[platform]
  return {
    schema: LANE_SCHEMA,
    scenario,
    ticket: scenarioEntry(scenario).ticket,
    platform,
    runner_image: { label: host, image_os: env.ImageOS ?? null, image_version: env.ImageVersion ?? null },
    build_run_id: provenance.run.id,
    commit: provenance.commit,
    variant: target.variant,
    installer: basename(installer),
    artifact_sha256: sha256,
    ci_run_id: Number(env.GITHUB_RUN_ID),
    environment: { kind: 'hosted-runner', host },
    command: ['node', ...argv].join(' '),
    exit_code: exitCode,
    outcome,
    report: reportWritten ? target.report : null,
    detail: outcome === 'PASS' ? null : detail || null,
    ...(target.notCovered ? { not_covered: target.notCovered.map(({ row, reason }) => ({ row, reason })) } : {})
  }
}

/** The job-summary markdown for a lane record. */
export function laneSummary(lane) {
  const rows = [
    ['outcome', lane.outcome],
    ['scenario', lane.scenario],
    ['platform', lane.platform],
    ['runner', `${lane.runner_image.label} (${lane.runner_image.image_os ?? '?'} ${lane.runner_image.image_version ?? '?'})`],
    ['build_run_id', lane.build_run_id],
    ['commit', lane.commit],
    ['variant', lane.variant],
    ['installer', lane.installer],
    ['artifact_sha256', lane.artifact_sha256],
    ['ci_run_id', lane.ci_run_id],
    ['environment', `${lane.environment.kind} ${lane.environment.host}`],
    ['command', lane.command],
    ['exit_code', lane.exit_code],
    ['report', lane.report ?? 'none']
  ]
  if (lane.detail) rows.push(['detail', lane.detail])
  for (const { row, reason } of lane.not_covered ?? []) rows.push([`not covered: ${row}`, reason])
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('`', "'")
  return [
    `### Candidate scenario ${lane.scenario} (${lane.platform}): ${lane.outcome}`,
    '',
    '| field | value |',
    '|---|---|',
    ...rows.map(([key, value]) => `| ${key} | \`${cell(value)}\` |`),
    ''
  ].join('\n')
}

/** The workflow annotation for an outcome that is not PASS; a PRECONDITION is a warning, never a pass. */
export function laneAnnotation(lane) {
  const text = String(lane.detail ?? 'see the scenario log').replace(/[\r\n]+/g, ' ')
  if (lane.outcome === 'PASS') return null
  if (lane.outcome === 'PRECONDITION') return `::warning title=${lane.scenario} PRECONDITION (not PASS)::${text}`
  return `::error title=${lane.scenario} ${lane.outcome}::${text}`
}

const CONTENT_PATTERNS = Object.freeze([
  ['macOS user home path', /\/Users\/[^\s/\\"'`]+/],
  ['Linux user home path', /\/home\/[^\s/\\"'`]+/],
  ['Windows user home path', /[A-Za-z]:\\+Users\\+[^\s\\"'`]+/i],
  ['email address', /[^\s@<>"'`]+@[^\s@<>"'`]+\.[A-Za-z]{2,}/]
])

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The names of the content rules `text` breaks — never the matched text itself. The runner account name
 * counts where it names an identity: a path segment, a ~account, an account@host, or a string value that
 * is exactly the account. The account as an ordinary word (such as the environment kind hosted-runner)
 * does not.
 */
export function contentProblems(text, { account }) {
  const problems = CONTENT_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  const name = String(account ?? '').trim()
  if (name) {
    const token = escapeRegExp(name)
    const identity = new RegExp(`[/\\\\~]${token}(?![A-Za-z0-9._-])|(?<![A-Za-z0-9._-])${token}[@/\\\\]|["']${token}["']`, 'i')
    if (identity.test(text)) problems.push('runner account name')
  }
  return problems
}

/** Scans every file under `dir` and deletes each one that breaks a content rule, so it is never uploaded.
 *  Returns the problems as `<file>: <rule>` lines. */
export function scanUploadDir(dir, { account }) {
  const problems = []
  if (!existsSync(dir)) return problems
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath ?? entry.path, entry.name)
    const hits = contentProblems(readFileSync(path, 'utf8'), { account })
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

function run(values) {
  const scenario = required(values, 'scenario')
  const platform = required(values, 'platform')
  const installer = required(values, 'installer')
  const sha256 = required(values, 'sha256').trim().toLowerCase()
  const outDir = required(values, 'out')
  const candidateRun = required(values, 'candidate-run')
  const provenance = JSON.parse(readFileSync(required(values, 'provenance'), 'utf8'))
  const target = platformEntry(scenario, platform)
  assertCandidateProvenance(provenance, candidateRun)
  // The installed app sits outside the checkout (under the runner's temp directory); it is recorded relative
  // to the working directory so the command stays free of absolute paths.
  const app = values.app ? relative(process.cwd(), values.app).replaceAll('\\', '/') : undefined

  const argv = scenarioCommand({ scenario, platform, installer, sha256, outDir, app })
  mkdirSync(outDir, { recursive: true })
  const child = spawnSync(process.execPath, argv, { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  process.stderr.write(child.stderr ?? '')
  const detail = child.signal ? `terminated by ${child.signal}` : child.error ? child.error.message : lastLine(child.stderr)

  const lane = laneRecord({
    scenario,
    platform,
    env: process.env,
    provenance,
    candidateRun,
    installer,
    sha256,
    argv,
    exitCode: child.status,
    detail,
    reportWritten: existsSync(join(outDir, target.report))
  })
  writeFileSync(join(outDir, 'lane.json'), `${JSON.stringify(lane, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, laneSummary(lane))
  const annotation = laneAnnotation(lane)
  if (annotation) console.log(annotation)
  console.log(`${scenario} (${platform}): ${lane.outcome}, exit ${lane.exit_code}`)
  return lane.outcome === 'PASS' ? 0 : 1
}

function main(argv) {
  const [command, ...rest] = argv
  const { values, positional } = flags(rest)
  switch (command) {
    case 'resolve': {
      const plan = resolveScenario({
        scenario: required(values, 'scenario'),
        sha256: { mac: values['mac-sha256'], win: values['win-sha256'] }
      })
      process.stdout.write(resolveOutputs(plan))
      return 0
    }
    case 'guard': {
      const [runJson, candidateRun] = positional
      if (!runJson || !candidateRun) throw new Error('usage: guard <run.json> <candidate_run>')
      const problems = candidateRunProblems(JSON.parse(readFileSync(runJson, 'utf8')), candidateRun)
      if (problems.length) throw new Error(problems.join('\n'))
      console.log(`Run ${candidateRun} is a successful ${QA_CANDIDATE_WORKFLOW} dispatch on main.`)
      return 0
    }
    case 'profile': {
      const scenario = required(values, 'scenario')
      const platform = required(values, 'platform')
      const settings = prepareProfile({
        scenario,
        platform,
        appDataDir: platform === 'mac' ? join(homedir(), 'Library', 'Application Support') : null
      })
      if (platformEntry(scenario, platform).isolatedProfiles) console.log('The scenario runs the app only on its own isolated profiles.')
      else console.log(settings ? 'Fresh profile seeded with the scenario settings.' : 'Fresh profile; the scenario seeds no settings.')
      return 0
    }
    case 'run':
      return run(values)
    case 'scan': {
      const [dir] = positional
      if (!dir) throw new Error('usage: scan <dir> --account <runner account>')
      const problems = scanUploadDir(dir, { account: required(values, 'account') })
      for (const problem of problems) console.log(`::error title=Content-free gate::${problem} (file removed from the upload)`)
      return problems.length ? 1 : 0
    }
    default:
      throw new Error('usage: candidate-scenarios.mjs <resolve|guard|profile|run|scan> ...')
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error.message.replaceAll('\n', '%0A')}`)
    process.exitCode = 1
  }
}
