#!/usr/bin/env node
// WP14 installed soak of the QA-identity build, inside _relay/goal-loop/sandbox-home/ only: idle, then a synthetic meeting,
// then post-meeting idle, sampling CPU and RSS of the owned process tree every 30 s, judged by SOAK-ACCEPT-1
// (soak-verdict.mjs; thresholds are printed in the summary). Default 60 minutes: 40% idle, 50% meeting, 10% post.
//
//   <isolate.sh> caffeinate -di node scripts/qa/sandbox-acceptance/soak.mjs [--minutes 60] [--dry-run] ...
//
// Writes soak-<runId>.json (samples, steps, verdict, queue) and soak-<runId>.md into the run's reports directory.
// Exit 0 PASS, 1 FAIL or INCOMPLETE, 2 PRECONDITION. A run shorter than 60 minutes is labelled as not a full soak.
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, platform as osPlatform, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from '../lib/app-driver.mjs'
import { COUNTED_EVENTS } from '../census/audit-counts.mjs'
import { AUDIO_KINDS, prepareAudio } from './audio.mjs'
import { mainExecutableSha256, readBundleId, readBundleVersion, readCodesign } from './bundle.mjs'
import { assertWritableInSandbox, deriveSandboxRoot, GuardError } from './guard.mjs'
import {
  CliError,
  EXIT_CODES,
  createReport,
  finishReport,
  formatSteps,
  newRunId,
  parseCli,
  runStep,
  sandboxLayout
} from './lib.mjs'
import { countByKind, sampleTree, totalRss } from './sampler.mjs'
import { guardReport, launchApp, prepareProfile, readAudit } from './session.mjs'
import { readQueue, startSyntheticMeeting, stopAndSave } from './scenario.mjs'
import { MINUTE_MS, evaluateSoak, planPhases, renderSummary } from './soak-verdict.mjs'
import { summarizeHelperCpu } from './voice-actions-lib.mjs'

/** Overlay layouts a soak profile can be seeded with. The product default is 'hide'; the soak has always seeded 'bar'. */
export const OVERLAY_LAYOUTS = Object.freeze(['bar', 'hide', 'island'])

export const CLI_SPEC = Object.freeze({
  app: { type: 'string' },
  'sandbox-root': { type: 'string' },
  'run-id': { type: 'string' },
  out: { type: 'string' },
  minutes: { type: 'number', default: 60, min: 4 },
  'idle-minutes': { type: 'number', min: 0 },
  'meeting-minutes': { type: 'number', min: 0 },
  'interval-seconds': { type: 'number', default: 30, min: 5 },
  audio: { type: 'string', default: 'speech' },
  wav: { type: 'string' },
  footprint: { type: 'boolean', default: false },
  'poll-queue': { type: 'boolean', default: true },
  'ready-timeout-seconds': { type: 'number', default: 120, min: 10 },
  'save-wait-seconds': { type: 'number', default: 180, min: 10 },
  layout: { type: 'string', default: 'bar' },
  'dry-run': { type: 'boolean', default: false }
})

export function resolveSoakConfig(argv, env = process.env) {
  const values = parseCli(argv, CLI_SPEC)
  if (!AUDIO_KINDS.includes(values.audio)) throw new CliError(`--audio must be one of ${AUDIO_KINDS.join(', ')}`)
  if (values.audio === 'file' && !values.wav) throw new CliError('--audio file needs --wav <path>')
  if (values.wav && values.audio !== 'file') throw new CliError('--wav is only valid with --audio file')
  if (!OVERLAY_LAYOUTS.includes(values.layout))
    throw new CliError(`--layout must be one of ${OVERLAY_LAYOUTS.join(', ')}`)
  const sandboxRoot =
    values['sandbox-root'] ??
    env.METIS_SANDBOX_ROOT ??
    deriveSandboxRoot(env.HOME) ??
    deriveSandboxRoot(env.ASKTOTO_USERDATA)
  if (!sandboxRoot)
    throw new CliError('cannot derive the sandbox root: run through _relay/goal-loop/isolate.sh or pass --sandbox-root')
  const runId = values['run-id'] ?? newRunId()
  if (!/^[A-Za-z0-9-]{1,16}$/.test(runId))
    throw new CliError('--run-id must be 1-16 characters of letters, digits and -')
  let phases
  try {
    phases = planPhases({
      minutes: values.minutes,
      idleMinutes: values['idle-minutes'],
      meetingMinutes: values['meeting-minutes']
    })
  } catch (error) {
    throw new CliError(error.message)
  }
  if (!phases.some((phase) => phase.id === 'meeting'))
    throw new CliError('the plan has no meeting phase; a soak needs idle and synthetic-meeting phases')
  if (!phases.some((phase) => phase.id === 'idle'))
    throw new CliError('the plan has no idle phase; a soak needs idle and synthetic-meeting phases')
  const layout = sandboxLayout({ sandboxRoot, runId })
  return { values, layout, phases, appPath: values.app ?? join(layout.appsDir, 'Metis QA.app') }
}

/** Audit events of the soak-relevant kinds, counted per phase by their own timestamps. */
export function auditCountsByPhase(records, t0Ms, phases) {
  const counts = {}
  for (const phase of phases) counts[phase.id] = {}
  for (const record of records) {
    const ts = Date.parse(record?.ts)
    if (!Number.isFinite(ts) || !COUNTED_EVENTS.includes(record.event)) continue
    const phase = phases.find((candidate) => ts - t0Ms >= candidate.startMs && ts - t0Ms < candidate.endMs)
    if (!phase) continue
    counts[phase.id][record.event] = (counts[phase.id][record.event] ?? 0) + 1
  }
  return counts
}

/** Fold the queue polls into the report's queue section. NOT_INSTRUMENTED is explicit, with where it would come from. */
export function summarizeQueue(polls) {
  const available = polls.filter((poll) => poll.available)
  if (!available.length) {
    return {
      status: 'NOT_INSTRUMENTED',
      polls: polls.length,
      reason:
        'The only app-exposed queue is the brain ingest queue (BrainStatus.live.pending and BrainStatus.backfill via window.toto.brainStatus()), and it returned no status on every poll ' +
        '(the profile is not signed in, so the brain is not running). A transcription/ASR job queue has no exposed metric: it would come from a QA-only counter in src/main/parakeet.ts ' +
        '(its bounded active+queued window) surfaced as a content-free audit record, which this run does not have.'
    }
  }
  return {
    status: 'MEASURED',
    source: 'window.toto.brainStatus() live.pending and backfill (ingest queue only; no ASR queue metric is exposed)',
    samples: available.length,
    polls: polls.length,
    maxLivePending: Math.max(...available.map((poll) => poll.livePending)),
    maxBackfillRemaining: Math.max(...available.map((poll) => poll.backfillRemaining))
  }
}

async function main(argv) {
  let config
  try {
    config = resolveSoakConfig(argv)
  } catch (error) {
    console.error(`[soak] ${error.message}`)
    return EXIT_CODES.PRECONDITION
  }
  const { layout, appPath, values, phases } = config
  const guards = guardReport({ layout, appPath, parentEnv: process.env, captureFile: layout.captureWav })
  for (const check of guards.checks) console.log(`[guard] ${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}`)
  if (!guards.ok) {
    console.error('[soak] a guard refused; nothing was launched.')
    return EXIT_CODES.PRECONDITION
  }
  if (values['dry-run']) {
    console.log(
      `[soak] dry run only. Plan: ${JSON.stringify({ minutes: values.minutes, phases, intervalSeconds: values['interval-seconds'], audio: values.audio, runRoot: layout.runRoot, childEnvKeys: guards.childEnvKeys }, null, 2)}`
    )
    return EXIT_CODES.PASS
  }
  const outDir = values.out ?? layout.reportsDir
  try {
    assertWritableInSandbox(outDir, layout.sandboxRoot)
  } catch (error) {
    console.error(`[soak] ${error.message}`)
    return EXIT_CODES.PRECONDITION
  }
  // Seeds the overlay layout on the run's first launch (prepareProfile never rewrites an existing profile).
  prepareProfile(layout, { overlayLayout: values.layout })
  let audio
  try {
    audio = prepareAudio({ kind: values.audio, layout, wavSource: values.wav })
  } catch (error) {
    console.error(`[soak] ${error.message}`)
    return EXIT_CODES.PRECONDITION
  }

  const log = (line) => console.log(`[soak] ${line}`)
  const intervalMs = values['interval-seconds'] * 1000
  const totalMs = values.minutes * MINUTE_MS
  const idleMs = phases.find((phase) => phase.id === 'idle').minutes * MINUTE_MS
  const meetingMs = phases.find((phase) => phase.id === 'meeting').minutes * MINUTE_MS
  const report = createReport({
    tool: 'soak',
    config: {
      minutes: values.minutes,
      phases,
      intervalSeconds: values['interval-seconds'],
      audio: values.audio,
      runId: layout.runId,
      footprint: values.footprint,
      overlayLayout: values.layout
    },
    meta: {
      bundleId: readBundleId(appPath),
      appVersion: readBundleVersion(appPath),
      codesign: (({ adhoc, signature, teamIdentifier }) => ({ adhoc, signature, teamIdentifier }))(
        readCodesign(appPath)
      ),
      mainExecutableSha256: mainExecutableSha256(appPath),
      audio,
      host: { platform: osPlatform(), arch: arch(), osRelease: release(), node: process.version },
      note: 'RSS is summed per owned process from ps; CDP is attached only briefly for the meeting clicks and queue polls, but --remote-debugging-port stays open for the whole run.'
    }
  })
  let session = null
  let aborted = false
  const samples = []
  const polls = []
  const marks = { meetingStartMs: null, meetingEndMs: null }
  const cleanup = async () => {
    if (session) await session.kill().catch(() => {})
  }
  process.once('SIGINT', () => {
    aborted = true
    log('SIGINT: stopping the soak early; the verdict will be INCOMPLETE')
  })

  let t0 = 0
  const background = []
  // Every CDP use (meeting clicks, queue polls, disconnects) runs one at a time, in order, so a poll never races a disconnect.
  let chain = Promise.resolve()
  const serial = (fn) => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  try {
    await runStep(report, 'launch-and-renderer-ready', async () => {
      session = await launchApp({
        layout,
        appPath,
        parentEnv: process.env,
        captureFile: layout.captureWav,
        readyTimeoutMs: values['ready-timeout-seconds'] * 1000,
        connect: false,
        log
      })
      // Idle is measured without a standing CDP session; the meeting step and queue polls connect briefly.
      return {
        evidence: {
          pid: session.pid,
          rendererReadyAudit: session.audit().some((record) => record.event === 'app.renderer.ready'),
          captureFileSourceAudit: session.audit().some((record) => record.event === 'qa.capture.file_source')
        }
      }
    })
    if (session) {
      t0 = Date.now()
      log(`soak clock started: ${values.minutes} min, sampling every ${values['interval-seconds']} s`)
      let deadMain = 0
      let meetingAction = null
      let stopAction = null
      for (let tick = 0; !aborted; tick += 1) {
        const target = t0 + tick * intervalMs
        if (tick > 0 && Date.now() < target) await sleep(target - Date.now())
        const tMs = Date.now() - t0
        if (tMs > totalMs) break
        const sample = sampleTree({ mainPid: session.pid, installRoot: appPath, footprint: values.footprint })
        samples.push({ tMs, ...sample })
        deadMain = sample.mainAlive ? 0 : deadMain + 1
        if (tick % 10 === 0)
          log(
            `t=${(tMs / MINUTE_MS).toFixed(1)} min main ${sample.mainAlive ? 'alive' : 'DEAD'} procs ${sample.processes.length} rss ${((totalRss(sample) ?? 0) / 1048576).toFixed(0)} MiB`
          )
        if (deadMain >= 2) {
          log('the main process is gone; ending the soak')
          break
        }
        if (values['poll-queue'] && sample.mainAlive && tick % 2 === 0)
          background.push(serial(() => readQueue(session)).then((poll) => polls.push({ tMs, ...poll })))
        if (!meetingAction && tMs >= idleMs) {
          marks.meetingStartMs = tMs
          meetingAction = serial(async () => {
            const step = await runStep(report, 'meeting-live', () => startSyntheticMeeting(session), {
              requires: ['launch-and-renderer-ready']
            })
            await session.disconnect()
            return step
          })
          background.push(meetingAction)
        }
        if (meetingAction && !stopAction && tMs >= idleMs + meetingMs) {
          marks.meetingEndMs = tMs
          stopAction = serial(async () => {
            const step = await runStep(
              report,
              'stop-and-save',
              async () => ({
                evidence: (await stopAndSave(session, { waitSeconds: values['save-wait-seconds'] })).evidence
              }),
              { requires: ['meeting-live'] }
            )
            await session.disconnect()
            return step
          })
          background.push(stopAction)
        }
      }
      await Promise.allSettled(background)
      await runStep(
        report,
        'clean-quit',
        async () => {
          const quit = await session.quit()
          if (!quit.cleanShutdown || !quit.cleanShutdownRecord)
            throw new Error(
              `the app did not shut down cleanly (request ${quit.request}, exit ${quit.exit}, audit ${quit.cleanShutdownRecord})`
            )
          if (quit.leftovers.length) throw new Error(`${quit.leftovers.length} owned process(es) survived the quit`)
          return { evidence: { exit: quit.exit, appShutdownCleanAudit: true, leftoverProcesses: 0 } }
        },
        { requires: ['launch-and-renderer-ready'] }
      )
    }
  } finally {
    await cleanup()
  }

  // Actual phase boundaries, from the moments the meeting was started and stopped, bounded by the last sample.
  const lastT = samples.length ? samples.at(-1).tMs : 0
  const actualPhases = []
  if (samples.length) {
    const meetingStart = marks.meetingStartMs ?? Math.min(idleMs, lastT)
    actualPhases.push({ id: 'idle', startMs: 0, endMs: meetingStart })
    const meetingEnd = marks.meetingEndMs ?? lastT
    actualPhases.push({ id: 'meeting', startMs: meetingStart, endMs: Math.max(meetingStart, meetingEnd) })
    if (marks.meetingEndMs !== null && lastT > marks.meetingEndMs)
      actualPhases.push({ id: 'post', startMs: marks.meetingEndMs, endMs: lastT })
  }
  const queue = summarizeQueue(polls)
  let verdict
  try {
    verdict = evaluateSoak({
      samples,
      phases: actualPhases,
      intervalMs,
      requestedMinutes: aborted ? 0 : values.minutes,
      layout: values.layout
    })
  } catch (error) {
    verdict = {
      rule: { id: 'SOAK-ACCEPT-1' },
      outcome: 'INCOMPLETE',
      fullSoak: false,
      requestedMinutes: values.minutes,
      validity: [],
      checks: [],
      failed: [`evaluation: ${error.message}`],
      phases: {}
    }
  }
  const stepsVerdict = finishReport(report).verdict
  const overall =
    stepsVerdict === 'FAIL' || verdict.outcome === 'FAIL'
      ? 'FAIL'
      : stepsVerdict === 'PASS' && verdict.outcome === 'PASS'
        ? 'PASS'
        : 'INCOMPLETE'
  const auditCounts = t0 ? auditCountsByPhase(readAudit(layout), t0, actualPhases) : {}
  const final = finishReport(report, {
    overall,
    growth: verdict,
    queue,
    // V08: the chord helper's idle CPU against the voice-actions budget. Advisory here; absent helper reads null.
    helperCpu: summarizeHelperCpu(samples, actualPhases),
    auditCountsByPhase: auditCounts,
    phases: actualPhases,
    samples: samples.map((sample) => ({
      tMs: sample.tMs,
      mainAlive: sample.mainAlive,
      processes: sample.processes,
      rssTotalBytes: totalRss(sample),
      byKind: countByKind(sample)
    }))
  })

  mkdirSync(outDir, { recursive: true })
  const base = join(outDir, `soak-${layout.runId}`)
  writeFileSync(`${base}.json`, `${JSON.stringify(final, null, 2)}\n`)
  writeFileSync(`${base}.md`, renderSummary({ verdict, queue, meta: report.meta }))
  console.log(formatSteps(final.steps))
  console.log(
    `[soak] growth ${verdict.outcome}${verdict.failed.length ? ` (${verdict.failed.join(', ')})` : ''}; steps ${stepsVerdict}; overall ${overall}; queue ${queue.status}`
  )
  console.log(`[soak] wrote ${base}.json and ${base}.md`)
  return overall === 'PASS' ? EXIT_CODES.PASS : EXIT_CODES.FAIL
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(
        `[soak] ${error instanceof GuardError || error instanceof CliError ? error.message : (error?.stack ?? error)}`
      )
      process.exitCode =
        error instanceof GuardError || error instanceof CliError ? EXIT_CODES.PRECONDITION : EXIT_CODES.FAIL
    }
  )
}
