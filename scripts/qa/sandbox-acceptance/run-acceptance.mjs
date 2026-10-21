#!/usr/bin/env node
// WP14 installed-app acceptance of the QA-identity build, inside _relay/goal-loop/sandbox-home/ only.
//
//   <isolate.sh> node scripts/qa/sandbox-acceptance/run-acceptance.mjs [--app <Metis QA.app>] [--dry-run] ...
//
// Scenario (explicit PASS / FAIL / NOT_SUPPORTED / SKIPPED per step, each backed by something the run observed):
//   launch -> renderer ready -> synthetic meeting live -> transcript segments -> stop and save -> meeting file in the sandbox
//   meetings folder -> review opens it -> clean quit -> relaunch -> saved meeting still listed -> clean quit.
// Exit codes: 0 PASS or PASS_WITH_GAPS, 1 FAIL or INCOMPLETE, 2 PRECONDITION (a guard refused, or a bad argument).
// --dry-run validates arguments and every guard, prints the plan and touches nothing.
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, platform as osPlatform, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBundleId, readBundleVersion, readCodesign, mainExecutableSha256 } from './bundle.mjs'
import { prepareAudio, AUDIO_KINDS } from './audio.mjs'
import { assertWritableInSandbox, deriveSandboxRoot, GuardError } from './guard.mjs'
import {
  CliError,
  EXIT_CODES,
  createReport,
  exitCodeForVerdict,
  finishReport,
  formatSteps,
  newRunId,
  parseCli,
  runStep,
  sandboxLayout
} from './lib.mjs'
import { guardReport, launchApp, prepareProfile } from './session.mjs'
import {
  observeTranscriptDraft,
  reviewSavedMeeting,
  startSyntheticMeeting,
  stopAndSave,
  verifyMeetingPreserved
} from './scenario.mjs'

export const CLI_SPEC = Object.freeze({
  app: { type: 'string' },
  'sandbox-root': { type: 'string' },
  'run-id': { type: 'string' },
  out: { type: 'string' },
  audio: { type: 'string', default: 'speech' },
  wav: { type: 'string' },
  'meeting-seconds': { type: 'number', default: 90, min: 20 },
  'transcript-wait-seconds': { type: 'number', default: 150, min: 10 },
  'save-wait-seconds': { type: 'number', default: 180, min: 10 },
  'ready-timeout-seconds': { type: 'number', default: 120, min: 10 },
  'dry-run': { type: 'boolean', default: false }
})

/** Resolve everything the run needs from arguments and the environment; throws CliError on a bad argument. */
export function resolveConfig(argv, env = process.env) {
  const values = parseCli(argv, CLI_SPEC)
  if (!AUDIO_KINDS.includes(values.audio)) throw new CliError(`--audio must be one of ${AUDIO_KINDS.join(', ')}`)
  if (values.audio === 'file' && !values.wav) throw new CliError('--audio file needs --wav <path>')
  if (values.wav && values.audio !== 'file') throw new CliError('--wav is only valid with --audio file')
  const sandboxRoot =
    values['sandbox-root'] ??
    env.METIS_SANDBOX_ROOT ??
    deriveSandboxRoot(env.HOME) ??
    deriveSandboxRoot(env.ASKTOTO_USERDATA)
  if (!sandboxRoot)
    throw new CliError(
      'cannot derive the sandbox root: run through _relay/goal-loop/isolate.sh or pass --sandbox-root <.../_relay/goal-loop/sandbox-home>'
    )
  const runId = values['run-id'] ?? newRunId()
  if (!/^[A-Za-z0-9-]{1,16}$/.test(runId))
    throw new CliError('--run-id must be 1-16 characters of letters, digits and -')
  const layout = sandboxLayout({ sandboxRoot, runId })
  return { values, layout, appPath: values.app ?? join(layout.appsDir, 'Metis QA.app') }
}

/**
 * The dry-run result: every guard check plus the plan. Reads only the bundle id.
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {Record<string, string | undefined>} [env]
 * @param {{ bundleId?: string | null, platform?: string }} [options] platform defaults to the host (tests pin darwin)
 */
export function dryRunPlan(config, env = process.env, { bundleId = undefined, platform = process.platform } = {}) {
  const { layout, appPath, values } = config
  const guards = guardReport({ layout, appPath, parentEnv: env, captureFile: layout.captureWav, bundleId, platform })
  return {
    ok: guards.ok,
    checks: guards.checks,
    plan: {
      appPath,
      runRoot: layout.runRoot,
      userData: layout.userData,
      meetingsFolder: layout.meetingsFolder,
      audio: values.audio,
      meetingSeconds: values['meeting-seconds'],
      steps: [
        'launch-and-renderer-ready',
        'meeting-live',
        'transcript-observed',
        'stop-and-save',
        'review-opens-meeting',
        'clean-quit',
        'relaunch',
        'meeting-preserved-after-relaunch',
        'final-quit'
      ],
      childEnvKeys: guards.childEnvKeys
    }
  }
}

async function main(argv) {
  let config
  try {
    config = resolveConfig(argv)
  } catch (error) {
    console.error(`[acceptance] ${error.message}`)
    return EXIT_CODES.PRECONDITION
  }
  const dry = dryRunPlan(config)
  for (const check of dry.checks) console.log(`[guard] ${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}`)
  if (!dry.ok) {
    console.error('[acceptance] a guard refused; nothing was launched.')
    return EXIT_CODES.PRECONDITION
  }
  if (config.values['dry-run']) {
    console.log(`[acceptance] dry run only. Plan: ${JSON.stringify(dry.plan, null, 2)}`)
    return EXIT_CODES.PASS
  }

  const { layout, appPath, values } = config
  const outPath = values.out ?? join(layout.reportsDir, `acceptance-${layout.runId}.json`)
  try {
    assertWritableInSandbox(outPath, layout.sandboxRoot)
  } catch (error) {
    console.error(`[acceptance] ${error.message}`)
    return EXIT_CODES.PRECONDITION
  }
  prepareProfile(layout)
  let audio
  try {
    audio = prepareAudio({ kind: values.audio, layout, wavSource: values.wav })
  } catch (error) {
    console.error(`[acceptance] ${error.message}`)
    return EXIT_CODES.PRECONDITION
  }
  const report = createReport({
    tool: 'run-acceptance',
    config: { audio: values.audio, meetingSeconds: values['meeting-seconds'], runId: layout.runId },
    meta: {
      bundleId: readBundleId(appPath),
      appVersion: readBundleVersion(appPath),
      codesign: (({ adhoc, signature, teamIdentifier }) => ({ adhoc, signature, teamIdentifier }))(
        readCodesign(appPath)
      ),
      mainExecutableSha256: mainExecutableSha256(appPath),
      audio,
      host: { platform: osPlatform(), arch: arch(), osRelease: release(), node: process.version }
    }
  })
  const log = (line) => console.log(`[acceptance] ${line}`)
  const launchArgs = {
    layout,
    appPath,
    parentEnv: process.env,
    captureFile: layout.captureWav,
    readyTimeoutMs: values['ready-timeout-seconds'] * 1000,
    log
  }
  let session = null
  let savedFile = null
  const cleanup = async () => {
    if (session) await session.kill().catch(() => {})
  }
  process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)))
  try {
    await runStep(report, 'launch-and-renderer-ready', async () => {
      session = await launchApp(launchArgs)
      const ready = session.audit().find((record) => record.event === 'app.renderer.ready')
      return {
        evidence: {
          pid: session.pid,
          rendererReadyAudit: Boolean(ready),
          cdpConnected: Boolean(session.page),
          captureFileSourceAudit: session.audit().some((record) => record.event === 'qa.capture.file_source')
        }
      }
    })
    await runStep(report, 'meeting-live', () => startSyntheticMeeting(session), {
      requires: ['launch-and-renderer-ready']
    })
    await runStep(
      report,
      'transcript-observed',
      () => observeTranscriptDraft(session, { speech: audio.speech, waitSeconds: values['transcript-wait-seconds'] }),
      { requires: ['meeting-live'] }
    )
    if (report.steps.find((step) => step.id === 'meeting-live')?.status === 'PASS') {
      // Hold the meeting open for the requested length (the transcript step above already consumed part of it).
      const heldMs = Math.max(
        0,
        values['meeting-seconds'] * 1000 - (report.steps.find((step) => step.id === 'transcript-observed')?.ms ?? 0)
      )
      await new Promise((resolve) => setTimeout(resolve, heldMs))
    }
    await runStep(
      report,
      'stop-and-save',
      async () => {
        const result = await stopAndSave(session, { waitSeconds: values['save-wait-seconds'] })
        savedFile = result.file
        return { evidence: result.evidence }
      },
      { requires: ['meeting-live'] }
    )
    await runStep(
      report,
      'review-opens-meeting',
      () => reviewSavedMeeting(session, savedFile, { speech: audio.speech }),
      { requires: ['stop-and-save'] }
    )
    await runStep(
      report,
      'clean-quit',
      async () => {
        const quit = await session.quit()
        if (!quit.cleanShutdown)
          throw new Error(`the app did not exit cleanly (request ${quit.request}, exit ${quit.exit})`)
        if (!quit.cleanShutdownRecord) throw new Error('the app exited but wrote no app.shutdown.clean audit record')
        if (quit.leftovers.length) throw new Error(`${quit.leftovers.length} owned process(es) survived the quit`)
        return { evidence: { exit: quit.exit, appShutdownCleanAudit: true, leftoverProcesses: 0 } }
      },
      { requires: ['launch-and-renderer-ready'] }
    )
    await runStep(
      report,
      'relaunch',
      async () => {
        session = await launchApp(launchArgs)
        return {
          evidence: {
            pid: session.pid,
            rendererReadyAudit: session.audit().some((record) => record.event === 'app.renderer.ready')
          }
        }
      },
      { requires: ['clean-quit'] }
    )
    await runStep(report, 'meeting-preserved-after-relaunch', () => verifyMeetingPreserved(session, savedFile), {
      requires: ['relaunch', 'stop-and-save']
    })
    await runStep(
      report,
      'final-quit',
      async () => {
        const quit = await session.quit()
        if (!quit.cleanShutdown || !quit.cleanShutdownRecord)
          throw new Error(
            `the relaunched app did not shut down cleanly (request ${quit.request}, exit ${quit.exit}, audit ${quit.cleanShutdownRecord})`
          )
        if (quit.leftovers.length) throw new Error(`${quit.leftovers.length} owned process(es) survived the quit`)
        return { evidence: { exit: quit.exit, appShutdownCleanAudit: true, leftoverProcesses: 0 } }
      },
      { requires: ['relaunch'] }
    )
  } finally {
    await cleanup()
  }
  const final = finishReport(report)
  mkdirSync(join(outPath, '..'), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(final, null, 2)}\n`)
  console.log(formatSteps(final.steps))
  console.log(`[acceptance] verdict ${final.verdict}; report ${outPath}`)
  return exitCodeForVerdict(final.verdict)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(
        `[acceptance] ${error instanceof GuardError || error instanceof CliError ? error.message : (error?.stack ?? error)}`
      )
      process.exitCode =
        error instanceof GuardError || error instanceof CliError ? EXIT_CODES.PRECONDITION : EXIT_CODES.FAIL
    }
  )
}
