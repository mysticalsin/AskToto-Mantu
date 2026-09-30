#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_SECONDS,
  REQUIRED_TRACE_SCENARIOS,
  STATES,
  collectCensus,
  defaultOutputPath,
  openNdjsonWriter,
  proveLocalTtftEvidenceFromArtifact,
  rendererScenarioProbeSource,
  resolveInstallTarget,
  resolveProductVersion,
  streamCensus,
  validateState,
  validateStatePrecondition,
  windowsWorkingSetEvidenceFromArtifact,
  writeJson
} from './lib.mjs'
import { writeAuditCounts } from './audit-counts.mjs'
import { PARKED_BOUNDS, ParkPreconditionError, createCdpParkChecker, summarizeParkChecks } from './park.mjs'

function usage() {
  return `Usage:
  node scripts/qa/census/run.mjs --state <${STATES.join('|')}> [--seconds 300]

Inputs:
  --app <path>             Installed Metis.app or Metis.exe. Defaults to METIS_CENSUS_APP, then the OS install path.
  --profile <path>         Representative synthetic QA profile from M2-0007. Defaults to METIS_QA_PROFILE.
  --main-pid <pid>         Attach instead of launch. Requires --install-root.
  --install-root <path>    Installed app root when attaching.
  --interval-ms <ms>       Sampling period, scheduled from the previous sample's start. Defaults to 5000.
  --ndjson <path>          Long-run mode: stream a census-stream/1 header, one line per sample (flushed as
                           taken) and a trailer on a normal end. No JSON report is written in this mode.
  --audit-counts <out.json>
                           With --ndjson: per-bucket audit event counts from the profile's audit trail
                           (--profile or METIS_QA_PROFILE), refreshed every checkpoint and at the end.
  --checkpoint-minutes <n> Audit-count refresh period. Defaults to 10.
  --bucket-minutes <n>     Audit-count bucket width. Defaults to 10.
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
    else if (arg === '--ndjson') args.ndjson = next()
    else if (arg === '--audit-counts') args.auditCounts = next()
    else if (arg === '--checkpoint-minutes') args.checkpointMinutes = Number(next())
    else if (arg === '--bucket-minutes') args.bucketMinutes = Number(next())
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
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port')
  return address.port
}

function defaultAppPath(platform) {
  if (platform === 'darwin') return '/Applications/Metis.app'
  if (platform === 'win32') return 'C:\\Program Files\\Metis\\Metis.exe'
  return ''
}

function stripSecretEnv(env) {
  const next = { ...env }
  for (const key of Object.keys(next)) {
    if (/_API_KEY$/i.test(key) || /TOKEN/i.test(key) || /SECRET/i.test(key)) delete next[key]
  }
  delete next.ASKTOTO_SMOKE_REOPEN_PROBE
  delete next.METIS_QA_HOST_FLOOR_OVERRIDE
  return next
}

function readProfileManifest(profile) {
  try {
    return JSON.parse(readFileSync(join(profile, 'resource-census-profile.json'), 'utf8'))
  } catch (error) {
    throw new ParkPreconditionError(`parked-idle requires a readable profile manifest: ${error?.message ?? error}`)
  }
}

export function validateParkedIdleProfile(profile) {
  if (!profile) throw new ParkPreconditionError('parked-idle requires --profile or METIS_QA_PROFILE')
  const manifest = readProfileManifest(profile)
  if (manifest?.layout !== 'hide') {
    throw new ParkPreconditionError(`parked-idle requires profile manifest layout "hide"; observed "${manifest?.layout ?? 'unknown'}"`, {
      layout: manifest?.layout ?? null
    })
  }
  return manifest
}

export function pointerOffTopEdgePosition(_platform) {
  return { x: 32, y: 200 }
}

export function pointerMoveCommand(platform, position) {
  if (platform === 'darwin') {
    return {
      executable: '/usr/bin/swift',
      args: ['-e', `import CoreGraphics\nCGWarpMouseCursorPosition(CGPoint(x: ${position.x}, y: ${position.y}))`],
      method: 'CGWarpMouseCursorPosition'
    }
  }
  if (platform === 'win32') {
    return {
      executable: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -Namespace Census -Name Cursor -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);'; if (-not [Census.Cursor]::SetCursorPos(${position.x}, ${position.y})) { throw 'SetCursorPos failed' }`
      ],
      method: 'user32.SetCursorPos'
    }
  }
  throw new ParkPreconditionError(`parked-idle pointer movement is unsupported on ${platform}`)
}

export function movePointerOffTopEdge(platform, execFile = execFileSync) {
  const position = pointerOffTopEdgePosition(platform)
  const command = pointerMoveCommand(platform, position)
  execFile(command.executable, command.args, { stdio: 'ignore', timeout: 10_000 })
  return { ...position, method: command.method }
}

export function launchOptions({ env, profile, port }) {
  return {
    env: stripSecretEnv({ ...env, ASKTOTO_USERDATA: profile }),
    args: port ? [`--remote-debugging-port=${port}`] : []
  }
}

export function parkedIdlePreconditionFailureReport({
  parkedIdle,
  firstCheck,
  productVersion,
  platform,
  state,
  seconds,
  mainPid
}) {
  const failedParkedIdle = {
    ...(parkedIdle ?? {}),
    boundsSignal: 'Browser.getWindowForTarget/getWindowBounds',
    expectedBounds: PARKED_BOUNDS,
    checks: [firstCheck],
    summary: summarizeParkChecks([firstCheck])
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ticket: 'M2-0009',
    evidenceLevel: 'PRECONDITION',
    productVersion,
    platform,
    state,
    seconds,
    mainPid,
    profileKind: 'representative-synthetic',
    statePrecondition: {
      required: true,
      kind: 'parked-idle',
      status: 'PRECONDITION',
      observedBounds: firstCheck.bounds
    },
    parkedIdle: failedParkedIdle
  }
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
  let parkedIdle = null
  let mainPid = args.mainPid ?? null
  let installRoot = args.installRoot ?? null
  let executable = null
  let child = null
  let cdpUrl = args.cdpUrl ?? null
  const attachMode = mainPid !== null
  const checkpointMinutes = args.checkpointMinutes ?? 10
  const bucketMinutes = args.bucketMinutes ?? 10

  if (args.auditCounts && !args.ndjson) throw new Error('--audit-counts requires --ndjson')
  if (args.auditCounts && !profile) throw new Error('--audit-counts requires --profile or METIS_QA_PROFILE')
  if (!(checkpointMinutes > 0)) throw new Error('--checkpoint-minutes must be positive')
  if (state === 'parked-idle' && args.ndjson) {
    throw new Error('parked-idle does not support --ndjson; use JSON output so park checks are recorded')
  }
  if (state === 'parked-idle') validateParkedIdleProfile(profile)

  validateStatePrecondition({
    state,
    attachMode,
    evidence: args.preconditionEvidence
  })

  if (mainPid === null) {
    if (!profile) {
      throw new Error('--profile or METIS_QA_PROFILE is required; a fresh profile is not representative for M2-0009')
    }
    const target = resolveInstallTarget(args.app ?? process.env.METIS_CENSUS_APP ?? defaultAppPath(platform), platform)
    installRoot = target.installRoot
    executable = target.executable
    const traceRequested = args.traceScenarios.length > 0
    const port = traceRequested || state === 'parked-idle' ? await freeLoopbackPort() : null
    if (port) cdpUrl = `http://127.0.0.1:${port}`
    const pointerPosition = state === 'parked-idle' ? movePointerOffTopEdge(platform) : null
    const options = launchOptions({ env: process.env, profile, port })
    child = spawn(target.executable, options.args, { env: options.env, stdio: 'ignore' })
    mainPid = child.pid ?? null
    if (!mainPid) throw new Error('launched app did not expose a pid')
    if (state !== 'cold-start') await sleep(args.settleMs ?? 15_000)
    if (pointerPosition) parkedIdle = { pointerMovedOffTopEdge: pointerPosition }
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
    let checker = null
    if (state === 'parked-idle') {
      checker = await createCdpParkChecker(cdpUrl)
      const firstCheck = await checker.check()
      if (!firstCheck.parked) {
        writeJson(
          output,
          parkedIdlePreconditionFailureReport({ parkedIdle, firstCheck, productVersion, platform, state, seconds, mainPid })
        )
        await checker.close()
        checker = null
        throw new ParkPreconditionError('parked-idle precondition failed: overlay window is not parked', {
          observedBounds: firstCheck.bounds
        })
      }
      parkedIdle = {
        ...(parkedIdle ?? {}),
        boundsSignal: 'Browser.getWindowForTarget/getWindowBounds',
        expectedBounds: PARKED_BOUNDS,
        checks: [firstCheck]
      }
    }
    try {
      if (args.ndjson) {
        const writeCounts = (from) =>
          writeAuditCounts(args.auditCounts, { userData: profile, from: new Date(from).toISOString(), bucketMinutes })
        const countsFrom = Date.now()
        let lastCheckpoint = 0
        const result = await streamCensus({
          state,
          seconds,
          intervalMs: args.intervalMs,
          platform,
          installRoot,
          mainPid,
          productVersion,
          profileKind: 'representative-synthetic',
          writeLine: openNdjsonWriter(args.ndjson),
          afterSample: async () => {
            if (!args.auditCounts) return
            if (Date.now() - lastCheckpoint < checkpointMinutes * 60_000) return
            lastCheckpoint = Date.now()
            writeCounts(countsFrom)
          }
        })
        if (args.auditCounts) writeCounts(countsFrom)
        console.log(`[census] streamed ${result.samples} samples (${result.outcome}) to ${args.ndjson}`)
        return
      }
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
        windowsWorkingSet,
        parkedIdle,
        checkPark: checker ? (sampledAt) => checker.check(sampledAt) : undefined
      })
      writeJson(output, report)
      console.log(`[census] wrote ${output}`)
    } finally {
      await checker?.close()
    }
  } finally {
    if (child && !child.killed) child.kill()
  }
}

export function isMainModule(metaUrl, argv1) {
  return Boolean(argv1) && metaUrl === pathToFileURL(resolve(argv1)).href
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`[census] ${error?.message ?? error}`)
    if (error instanceof ParkPreconditionError) {
      if (error.details && Object.keys(error.details).length > 0) console.error(`[census] ${JSON.stringify(error.details)}`)
      process.exitCode = 2
    } else {
      process.exitCode = 1
    }
  })
}
