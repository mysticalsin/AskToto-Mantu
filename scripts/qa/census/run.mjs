#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  DEFAULT_SECONDS,
  REQUIRED_TRACE_SCENARIOS,
  STATES,
  SUPPLEMENTARY_STATES,
  collectCensus,
  defaultOutputPath,
  freeLoopbackPort,
  parkedIdleBlockedReport,
  proveLocalTtftEvidenceFromArtifact,
  rendererScenarioProbeSource,
  resolveInstallTarget,
  resolveProductVersion,
  stripSecretEnv,
  validatePointerAwayForState,
  validateProfileForState,
  validateState,
  validateStatePrecondition,
  windowsWorkingSetEvidenceFromArtifact,
  writeJson
} from './lib.mjs'
import { movePointer, parsePoint, stationaryMove } from './pointer.mjs'

function usage() {
  return `Usage:
  node scripts/qa/census/run.mjs --state <${[...STATES, ...SUPPLEMENTARY_STATES].join('|')}> [--seconds 300]

Inputs:
  --app <path>             Installed Metis.app or Metis.exe. Defaults to METIS_CENSUS_APP, then the OS install path.
  --profile <path>         Representative synthetic QA profile from M2-0007. Defaults to METIS_QA_PROFILE.
                           parked-idle needs one built with profile.mjs --overlay-layout hide.
  --pointer-away <x,y>     Required for parked-idle: the pointer is moved here, and read back there, before
                           sampling. A pointer that cannot be moved writes a BLOCKED_EXTERNAL report and fails.
  --main-pid <pid>         Attach instead of launch. Requires --install-root.
  --install-root <path>    Installed app root when attaching.
  --interval-ms <ms>       Sampling interval. Defaults to 5000.
  --settle-ms <ms>         Wait after launch before non-cold-start states. Defaults to 15000.
  --output <path>          JSON output. Defaults under metis-census-output/.
  --cdp-url <url>          Existing Chromium DevTools endpoint for renderer traces.
  --trace-scenario <name>  Repeatable. Expected names: ${REQUIRED_TRACE_SCENARIOS.join(', ')}.
  --ttft-output <path>     Saved stdout/stderr artifact from scripts/prove-local-ttft.mjs.
  --windows-working-set-artifact <path>
                           Windows QA lane census JSON proving positive workingSetBytes samples.
  --product-version <ver>  Product version when it cannot be read from the installed app.
  --precondition-evidence <text>
                           Required with --main-pid for first-inference, active-transcription,
                           post-meeting, and post-recovery.
`
}

function readArgs(argv) {
  const args = {
    traceScenarios: []
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--state') args.state = next()
    else if (arg === '--seconds') args.seconds = Number(next())
    else if (arg === '--interval-ms') args.intervalMs = Number(next())
    else if (arg === '--settle-ms') args.settleMs = Number(next())
    else if (arg === '--app') args.app = next()
    else if (arg === '--profile') args.profile = next()
    else if (arg === '--main-pid') args.mainPid = Number(next())
    else if (arg === '--install-root') args.installRoot = next()
    else if (arg === '--output') args.output = next()
    else if (arg === '--cdp-url') args.cdpUrl = next()
    else if (arg === '--trace-scenario') args.traceScenarios.push(next())
    else if (arg === '--ttft-output') args.ttftOutput = next()
    else if (arg === '--ttft-ms') throw new Error('--ttft-ms is not accepted; pass --ttft-output from scripts/prove-local-ttft.mjs')
    else if (arg === '--windows-working-set-artifact') args.windowsWorkingSetArtifact = next()
    else if (arg === '--product-version') args.productVersion = next()
    else if (arg === '--precondition-evidence') args.preconditionEvidence = next()
    else if (arg === '--pointer-away') args.pointerAway = parsePoint(next())
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function defaultAppPath(platform) {
  if (platform === 'darwin') return '/Applications/Metis.app'
  if (platform === 'win32') return 'C:\\Program Files\\Metis\\Metis.exe'
  return ''
}

async function findOverlayPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      try {
        const hasToto = await page.evaluate(() => typeof window.toto !== 'undefined')
        if (hasToto) return page
      } catch {
        // Page can navigate while the app is booting.
      }
    }
  }
  return null
}

async function captureRendererTrace({ cdpUrl, scenarios, outputDir }) {
  if (!cdpUrl || scenarios.length === 0) return { captured: false, scenarios: [] }
  const { chromium } = await import('playwright')
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 30_000 })
  const captured = []
  try {
    let page = null
    const deadline = Date.now() + 30_000
    while (!page && Date.now() < deadline) {
      page = await findOverlayPage(browser)
      if (!page) await sleep(500)
    }
    if (!page) throw new Error('no overlay renderer exposing window.toto')

    for (const scenario of scenarios) {
      if (!REQUIRED_TRACE_SCENARIOS.includes(scenario)) throw new Error(`unknown trace scenario: ${scenario}`)
      const proof = await page.evaluate(rendererScenarioProbeSource(scenario))
      if (!proof?.ok) throw new Error(`renderer trace scenario is not established: ${scenario}`)
      const proofPath = join(outputDir, `${scenario}.proof.json`)
      writeJson(proofPath, {
        scenario,
        observedAt: new Date().toISOString(),
        proof
      })
      const session = await page.context().newCDPSession(page)
      await session.send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,gpu',
        transferMode: 'ReturnAsStream'
      })
      await sleep(10_000)
      const complete = new Promise((resolve) => {
        session.once('Tracing.tracingComplete', resolve)
      })
      await session.send('Tracing.end')
      const event = await complete
      let trace = ''
      let eof = false
      while (!eof) {
        const chunk = await session.send('IO.read', { handle: event.stream })
        trace += chunk.data ?? ''
        eof = Boolean(chunk.eof)
      }
      await session.send('IO.close', { handle: event.stream }).catch(() => {})
      const path = join(outputDir, `${scenario}.trace.json`)
      mkdirSync(dirname(path), { recursive: true })
      writeJson(path, JSON.parse(trace))
      captured.push({ scenario, path, proofPath })
    }
  } finally {
    await browser.close().catch(() => {})
  }
  return { captured: captured.length > 0, scenarios: captured }
}

async function main() {
  const args = readArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  const platform = process.platform
  const state = validateState(args.state)
  const seconds = args.seconds ?? DEFAULT_SECONDS
  const output = args.output ?? defaultOutputPath({ state, platform })
  const outputDir = dirname(output)
  const profile = args.profile ?? process.env.METIS_QA_PROFILE
  let mainPid = args.mainPid ?? null
  let installRoot = args.installRoot ?? null
  let executable = null
  let child = null
  let cdpUrl = args.cdpUrl ?? null
  const attachMode = mainPid !== null

  validateStatePrecondition({
    state,
    attachMode,
    evidence: args.preconditionEvidence
  })
  validatePointerAwayForState(state, args.pointerAway)
  if (args.pointerAway) {
    try {
      await movePointer(stationaryMove(args.pointerAway), { platform })
    } catch (error) {
      writeJson(output, parkedIdleBlockedReport({ platform, reason: error?.message ?? String(error) }))
      throw new Error(`the pointer could not be moved away, so ${output} records BLOCKED_EXTERNAL, not a census`)
    }
  }

  if (mainPid === null) {
    if (!profile) {
      throw new Error('--profile or METIS_QA_PROFILE is required; a fresh profile is not representative for M2-0009')
    }
    validateProfileForState(state, JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')))
    const target = resolveInstallTarget(args.app ?? process.env.METIS_CENSUS_APP ?? defaultAppPath(platform), platform)
    installRoot = target.installRoot
    executable = target.executable
    const traceRequested = args.traceScenarios.length > 0
    const port = traceRequested ? await freeLoopbackPort() : null
    if (port) cdpUrl = `http://127.0.0.1:${port}`
    const env = stripSecretEnv({ ...process.env, ASKTOTO_USERDATA: profile })
    const launchArgs = port ? [`--remote-debugging-port=${port}`] : []
    child = spawn(target.executable, launchArgs, { env, stdio: 'ignore' })
    mainPid = child.pid ?? null
    if (!mainPid) throw new Error('launched app did not expose a pid')
    if (state !== 'cold-start') await sleep(args.settleMs ?? 15_000)
  }

  if (!installRoot) throw new Error('--install-root is required when --main-pid is used')
  const productVersion = resolveProductVersion({
    explicit: args.productVersion,
    installRoot,
    executable,
    platform
  })

  try {
    const proveLocalTtft = args.ttftOutput
      ? proveLocalTtftEvidenceFromArtifact(args.ttftOutput)
      : { recorded: false, command: 'node scripts/prove-local-ttft.mjs' }
    const windowsWorkingSet = args.windowsWorkingSetArtifact
      ? windowsWorkingSetEvidenceFromArtifact(args.windowsWorkingSetArtifact)
      : undefined
    const rendererTrace = await captureRendererTrace({
      cdpUrl,
      scenarios: args.traceScenarios,
      outputDir
    })
    const report = await collectCensus({
      state,
      seconds,
      intervalMs: args.intervalMs,
      platform,
      installRoot,
      mainPid,
      attachMode,
      productVersion,
      preconditionEvidence: args.preconditionEvidence,
      profileKind: 'representative-synthetic',
      rendererTrace,
      proveLocalTtft,
      windowsWorkingSet
    })
    writeJson(output, report)
    console.log(`[census] wrote ${output}`)
  } finally {
    if (child && !child.killed) child.kill()
  }
}

main().catch((error) => {
  console.error(`[census] ${error?.message ?? error}`)
  process.exitCode = 1
})
