#!/usr/bin/env node
// Hosted acceptance for an in-place Windows upgrade from the published unsigned 1.9.6 installer
// to one provenance-bound 1.9.7 candidate. All app data is synthetic and lives under RUNNER_TEMP.
// This lane is intentionally fail-closed: only a complete set of PASS rows is accepted.
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  attach,
  freeLoopbackPort,
  launchPackagedCdp,
  packagedLaunchFailed,
  strictLaunchEnvironment,
  waitFor,
  waitForChildExit
} from './lib/app-driver.mjs'
import { candidateRunProblems, assertCandidateProvenance } from './candidate-scenarios.mjs'

export const BASELINE = Object.freeze({
  tag: 'v1.9.6-unsigned',
  version: '1.9.6',
  installer: 'Metis-Setup-1.9.6.exe',
  sha256: '77a532f3c33a0be6f9315e7e0df02c2420c25a297e90c5fa6baff18f84193df8'
})
export const CANDIDATE_VERSION = '1.9.7'
export const REPOSITORY = 'mysticalsin/AskToto-Mantu'
export const REQUIRED_CHECKS = Object.freeze([
  'baseline_installer_identity',
  'candidate_installer_identity',
  'baseline_install_version',
  'synthetic_cloud_provider_route_blocked',
  'synthetic_encrypted_settings_written',
  'synthetic_api_key_written',
  'synthetic_encrypted_meeting_written',
  'synthetic_encrypted_note_written',
  'meeting_and_note_ciphertext_at_rest',
  'baseline_clean_shutdown',
  'candidate_replaced_same_install_root',
  'candidate_launch_version',
  'settings_app_visible_after_upgrade',
  'api_key_app_visible_after_upgrade',
  'meeting_history_app_visible_after_upgrade',
  'meeting_content_app_visible_after_upgrade',
  'windows_dpapi_keystore_preserved',
  'meeting_ciphertext_preserved',
  'note_ciphertext_preserved',
  'note_content_app_visible_after_upgrade',
  'candidate_clean_shutdown'
])

const SYNTHETIC = Object.freeze({
  apiKey: 'qa-synthetic-never-valid-1f49c751',
  meetingTitle: 'QA Synthetic Upgrade Meeting 71f9',
  meetingLine: 'Synthetic transcript continuity 3b20',
  noteTitle: 'QA Synthetic Upgrade Note 19d4',
  noteQuestion: 'Synthetic preservation question 7b62',
  noteAnswer: 'Synthetic preservation answer 5c11'
})
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Validate the exact hosted candidate run and its Windows Setup byte binding before installation. */
export function verifyCandidateIdentity(run, provenance, candidateRun) {
  const problems = candidateRunProblems(run, candidateRun)
  if (problems.length) throw new Error(problems.join('\n'))
  if (run.repository?.full_name !== REPOSITORY) throw new Error(`candidate run repository is not ${REPOSITORY}.`)
  if (provenance.repository !== REPOSITORY) throw new Error(`candidate provenance repository is not ${REPOSITORY}.`)
  assertCandidateProvenance(provenance, candidateRun, run.run_attempt)
  if (provenance.version !== CANDIDATE_VERSION) throw new Error(`candidate version is ${provenance.version}, expected ${CANDIDATE_VERSION}.`)
  if (provenance.commit !== run.head_sha) throw new Error('candidate provenance commit differs from the Actions run head SHA.')
  const build = provenance.builds?.find((entry) => entry.variant === 'win')
  if (!build || build.platform !== 'win' || build.version !== CANDIDATE_VERSION) {
    throw new Error('candidate provenance has no Windows 1.9.7 Setup build.')
  }
  const matches = (build.assets ?? []).filter((asset) => asset.name === `Metis-Setup-${CANDIDATE_VERSION}.exe`)
  if (matches.length !== 1 || !SHA256.test(matches[0]?.sha256 ?? '') || !Number.isSafeInteger(matches[0]?.size) || matches[0].size <= 0) {
    throw new Error('Windows provenance must name exactly one non-empty 1.9.7 Setup installer with a sha256.')
  }
  return { run_id: String(candidateRun), attempt: run.run_attempt, commit: run.head_sha, version: CANDIDATE_VERSION, sha256: matches[0].sha256 }
}

/** Missing, malformed, skipped, unrun and failing rows all fail the assessment. */
export function assessUpgradeReport(report, expected = {}) {
  const problems = []
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { accepted: false, problems: ['report is not an object'] }
  if (report.schema !== 1) problems.push('report schema must be 1')
  if (report.platform !== 'win32') problems.push('platform must be win32')
  if (report.baseline?.version !== BASELINE.version || report.baseline?.tag !== BASELINE.tag) problems.push('baseline identity is not pinned to v1.9.6-unsigned')
  if (report.candidate?.version !== CANDIDATE_VERSION) problems.push('candidate version must be 1.9.7')
  if (report.error !== null) problems.push('scenario contains an execution error')
  if (!SHA256.test(report.baseline?.sha256 ?? '') || (expected.baselineSha256 && report.baseline.sha256 !== expected.baselineSha256)) {
    problems.push('baseline installer sha256 is missing or does not match the expected bytes')
  }
  if (!SHA256.test(report.candidate?.sha256 ?? '') || (expected.candidateSha256 && report.candidate.sha256 !== expected.candidateSha256)) {
    problems.push('candidate installer sha256 is missing or does not match the expected bytes')
  }
  if (!COMMIT.test(report.candidate?.commit ?? '') || (expected.commit && report.candidate.commit !== expected.commit)) {
    problems.push('candidate commit is missing or does not match the expected run')
  }
  if (String(report.candidate?.run_id ?? '') !== String(expected.candidateRun ?? report.candidate?.run_id ?? '') || !/^[1-9]\d*$/.test(String(report.candidate?.run_id ?? ''))) {
    problems.push('candidate run id is missing or unexpected')
  }
  if (!Number.isSafeInteger(report.candidate?.attempt) || report.candidate.attempt < 1) problems.push('candidate attempt is missing or invalid')
  const checks = Array.isArray(report.checks) ? report.checks : []
  const byId = new Map(checks.map((check) => [check?.id, check]))
  if (byId.size !== checks.length) problems.push('duplicate check ids are not allowed')
  for (const id of REQUIRED_CHECKS) {
    const row = byId.get(id)
    if (!row) problems.push(`required check missing: ${id}`)
    else if (row.status !== 'PASS') problems.push(`${id} status is ${String(row.status ?? 'missing')}, expected PASS`)
    else if (typeof row.evidence !== 'string' || row.evidence.length < 8) problems.push(`${id} has no evidence summary`)
  }
  for (const row of checks) if (!REQUIRED_CHECKS.includes(row?.id)) problems.push(`unexpected check id: ${String(row?.id)}`)
  return { accepted: problems.length === 0, problems }
}

function record(checks, id, passed, evidence) {
  const row = checks.find((item) => item.id === id)
  if (!row) throw new Error(`unknown check ${id}`)
  row.status = passed ? 'PASS' : 'FAIL'
  row.evidence = String(evidence || (passed ? 'verified' : 'condition failed')).slice(0, 240)
}

function hashFile(path) {
  return sha256Bytes(readFileSync(path))
}

function inside(parent, child) {
  const root = resolve(parent) + sep
  return resolve(child).startsWith(root)
}

function findPages(browser) {
  return browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed())
}

async function startApp(executable, qaRoot, profile) {
  const paths = {
    home: qaRoot,
    userProfile: qaRoot,
    appData: join(qaRoot, 'roaming'),
    localAppData: join(qaRoot, 'local'),
    temp: join(qaRoot, 'temp'),
    userData: profile
  }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
  const managedPolicy = join(profile, 'managed-config.json')
  // Empty allowedProviders blocks the cloud providers. strictLaunchEnvironment also strips runner
  // credentials, the disposable runner has no configured CLI account, and local AI stays disabled.
  // The fixture may exercise storage, but must never submit its text.
  const policy = '{"allowedProviders":[]}\n'
  try {
    writeFileSync(managedPolicy, policy, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST' || readFileSync(managedPolicy, 'utf8') !== policy) {
      throw new Error('isolated profile provider-blocking policy is missing or changed')
    }
  }
  const env = strictLaunchEnvironment(process.env, paths, 'win32')
  const cdpPort = await freeLoopbackPort()
  let inspectPort = await freeLoopbackPort()
  while (inspectPort === cdpPort) inspectPort = await freeLoopbackPort()
  const launched = launchPackagedCdp({ executablePath: executable, env, cdpPort, inspectPort, platform: 'win32' })
  let browser = null
  try {
    browser = await waitFor(async () => {
      if (packagedLaunchFailed(launched.child, launched.latches)) throw new Error('packaged process exited before CDP attached')
      try { return await attach(launched.cdpEndpoint, 1_500) } catch { return null }
    }, 'packaged app did not expose loopback CDP', 60_000, 250)
    const page = await waitFor(async () => {
      for (const candidate of findPages(browser)) {
        try {
          if (await candidate.evaluate(() => Boolean(window.toto && typeof window.toto.getSettings === 'function'))) return candidate
        } catch { /* renderer still booting */ }
      }
      return null
    }, 'packaged app never exposed its window.toto bridge', 60_000, 250)
    return { ...launched, browser, page, profile, qaRoot }
  } catch (error) {
    try { await browser?.close() } catch { /* best effort */ }
    try { launched.child.kill() } catch { /* exact child only */ }
    throw error
  }
}

async function stopApp(app) {
  let quitDelivered = false
  try {
    quitDelivered = await app.page.evaluate(async () => {
      if (!window.toto || typeof window.toto.quit !== 'function') return false
      await window.toto.quit()
      return true
    })
  } catch { /* process exit may close CDP before reply */ }
  try { await app.browser?.close() } catch { /* best effort */ }
  const exited = await waitForChildExit(app.child, 30_000)
  if (!exited) {
    // Only kill the process tree rooted at this harness's direct child.
    const { spawnSync } = await import('node:child_process')
    spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
    await waitForChildExit(app.child, 5_000)
  }
  return { quitDelivered, exited: app.child.exitCode === 0 }
}

async function appCall(app, callback, argument = undefined) {
  return await app.page.evaluate(callback, argument)
}

function checkEncryptedFile(path, expectedPlaintext) {
  const bytes = readFileSync(path)
  const text = bytes.toString('utf8')
  return bytes.subarray(0, 8).toString('ascii') === 'ATKENC2\n' && !text.includes(expectedPlaintext)
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

async function runUpgrade({ baselineInstaller, candidateInstaller, candidateRun, candidateAttempt, candidateCommit, reportPath, installRoot, runnerRoot }) {
  const checks = REQUIRED_CHECKS.map((id) => ({ id, status: 'NOT_RUN', evidence: 'check was not reached' }))
  const report = {
    schema: 1,
    platform: process.platform,
    baseline: { tag: BASELINE.tag, version: BASELINE.version, sha256: null },
    candidate: { run_id: String(candidateRun), attempt: Number(candidateAttempt), commit: String(candidateCommit), version: CANDIDATE_VERSION, sha256: null },
    checks,
    error: null,
    coverage_limitations: []
  }
  const identityPath = join(dirname(reportPath), 'candidate-run.json')
  const provenancePath = join(dirname(reportPath), 'candidate-provenance', 'provenance.json')
  let activeApp = null
  let baselineMeetingPath = null
  let baselineNotePath = null
  let baselineMeetingHash = null
  let baselineNoteHash = null
  let baselineSecretKeyHash = null
  let baselineSecretKeySize = null
  let baselineApiKeyHash = null
  let baselineSettings = null
  let meetingFolder = null
  let keyFolder = resolve(runnerRoot, 'isolated-user-data')
  let overallError = null
  try {
    if (process.platform !== 'win32') throw new Error('This acceptance harness must run on a hosted Windows runner.')
    const baselineHash = hashFile(baselineInstaller)
    report.baseline.sha256 = baselineHash
    record(checks, 'baseline_installer_identity', baselineHash === BASELINE.sha256, `sha256=${baselineHash}`)
    if (baselineHash !== BASELINE.sha256) throw new Error('downloaded baseline installer is not the pinned public 1.9.6 byte set')

    const run = JSON.parse(readFileSync(identityPath, 'utf8'))
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
    const identity = verifyCandidateIdentity(run, provenance, candidateRun)
    const candidateHash = hashFile(candidateInstaller)
    report.candidate.sha256 = candidateHash
    record(checks, 'candidate_installer_identity', candidateHash === identity.sha256, `sha256=${candidateHash}; run=${identity.run_id}; attempt=${identity.attempt}`)
    if (candidateHash !== identity.sha256 || identity.commit !== candidateCommit || identity.attempt !== Number(candidateAttempt)) {
      throw new Error('candidate installer/run identity differs from the caller-pinned artifact identity')
    }

    mkdirSync(runnerRoot, { recursive: true })
    mkdirSync(installRoot, { recursive: true })
    const { spawnSync } = await import('node:child_process')
    const install = (installer) => {
      const result = spawnSync(installer, ['/S', `/D=${installRoot}`], { windowsHide: true, timeout: 5 * 60_000, encoding: 'utf8' })
      if (result.error || result.status !== 0) throw new Error(`installer failed with status ${result.status ?? 'null'}${result.error ? ` (${result.error.message})` : ''}`)
    }
    install(baselineInstaller)
    const baselineExe = join(installRoot, 'Metis.exe')
      if (statSync(baselineExe).size <= 0) throw new Error('baseline installed executable was empty')
    activeApp = await startApp(baselineExe, join(runnerRoot, 'windows-home'), keyFolder)
    const settings = await appCall(activeApp, async (synthetic) => {
      const initial = await window.toto.getSettings()
      const saved = await window.toto.setSettings({
        onboardingDone: true,
        encryptTranscripts: true,
        providerPriority: 'api',
        temperature: 0.42,
        // Keep this hosted fixture from sending its synthetic transcript to any provider.
        brainConsolidation: { enabled: true, maxPassesPerDay: 2, preferLocal: true },
        graphifyEnabled: false,
        graphifyAutoRebuild: false
      })
      const keyResult = await window.toto.setApiKey('openai', synthetic.apiKey)
      const meeting = await window.toto.saveTranscript({
        title: synthetic.meetingTitle, mode: 'general', startedAt: 1792000000000,
        durationMs: 64000, lines: [{ speaker: 'you', text: synthetic.meetingLine, t: 1792000002000 }], recap: 'Synthetic encrypted recap 495a'
      })
      const note = await window.toto.saveNote({
        title: synthetic.noteTitle, mode: 'general',
        question: synthetic.noteQuestion, answer: synthetic.noteAnswer
      })
      return {
        initialVersion: initial.version ?? null,
        saved: {
          onboardingDone: saved.onboardingDone,
          encryptTranscripts: saved.encryptTranscripts,
          temperature: saved.temperature,
          providersBlocked: Array.isArray(saved.allowedProviders) && saved.allowedProviders.length === 0
        },
        hasOpenAi: keyResult.hasKeys?.openai === true,
        hasKeysOpenAi: saved.hasKeys?.openai === true,
        meetingPath: meeting.path,
        notePath: note.path,
        after: await window.toto.getSettings()
      }
    }, SYNTHETIC)
    record(checks, 'baseline_install_version', settings.initialVersion === BASELINE.version, `version=${String(settings.initialVersion)}`)
    record(checks, 'synthetic_cloud_provider_route_blocked', settings.saved.providersBlocked, 'synthetic managed policy denies cloud providers; packaged app receives no runner credentials')
    record(checks, 'synthetic_encrypted_settings_written', settings.saved.onboardingDone === true && settings.saved.encryptTranscripts === true && settings.saved.temperature === 0.42, 'settings persisted through app IPC')
    record(checks, 'synthetic_api_key_written', settings.hasOpenAi, 'synthetic OpenAI key accepted through app IPC')
    record(checks, 'synthetic_encrypted_meeting_written', typeof settings.meetingPath === 'string' && settings.meetingPath.length > 0, 'synthetic meeting saved through app IPC')
    record(checks, 'synthetic_encrypted_note_written', typeof settings.notePath === 'string' && settings.notePath.length > 0, 'synthetic note saved through app IPC')
    if (settings.initialVersion !== BASELINE.version || !settings.saved.encryptTranscripts || !settings.hasOpenAi || !settings.meetingPath || !settings.notePath) {
      throw new Error('baseline app did not create the expected synthetic profile state')
    }
    meetingFolder = settings.after.resolvedMeetingsFolder
    if (typeof meetingFolder !== 'string' || !inside(keyFolder, meetingFolder) || !inside(meetingFolder, settings.meetingPath) || !inside(meetingFolder, settings.notePath)) {
      throw new Error('app reported a data path outside the disposable isolated profile')
    }
    baselineMeetingPath = settings.meetingPath
    baselineNotePath = settings.notePath
    if (!checkEncryptedFile(baselineMeetingPath, SYNTHETIC.meetingLine) || !checkEncryptedFile(baselineNotePath, SYNTHETIC.noteAnswer)) {
      throw new Error('one or more synthetic meeting/note files are not ATKENC2 ciphertext or contain their plaintext marker')
    }
    baselineMeetingHash = hashFile(baselineMeetingPath)
    baselineNoteHash = hashFile(baselineNotePath)
    baselineSecretKeyHash = hashFile(join(keyFolder, 'secret-key.bin'))
    baselineSecretKeySize = statSync(join(keyFolder, 'secret-key.bin')).size
    baselineApiKeyHash = hashFile(join(keyFolder, 'key-openai.bin'))
    record(checks, 'meeting_and_note_ciphertext_at_rest', true, `meeting=${baselineMeetingHash}; note=${baselineNoteHash}`)

    const baselineExit = await stopApp(activeApp)
    activeApp = null
    record(checks, 'baseline_clean_shutdown', baselineExit.quitDelivered && baselineExit.exited, `quit=${baselineExit.quitDelivered}; exit0=${baselineExit.exited}`)
    if (!baselineExit.quitDelivered || !baselineExit.exited) throw new Error('baseline app did not quit cleanly')

    // Re-run the same official Setup installer with the same /D target: this is an in-place replacement,
    // not a side-by-side install or a profile copy/restore.
    install(candidateInstaller)
    if (!statSync(baselineExe).isFile()) throw new Error('candidate installer removed the stable install-root executable')
    record(checks, 'candidate_replaced_same_install_root', true, 'candidate Setup reran at the unchanged disposable install root')
    activeApp = await startApp(baselineExe, join(runnerRoot, 'windows-home'), keyFolder)

    const after = await appCall(activeApp, async ({ noteFile, expected }) => {
      const settingsNow = await window.toto.getSettings()
      const history = await window.toto.recallList()
      const meeting = Array.isArray(history) ? history.find((item) => item.title === expected.meetingTitle) : null
      const read = meeting?.file ? await window.toto.recallRead(meeting.file) : null
      const bridge = window.toto
      let noteRead = { available: typeof bridge.recallReadNote === 'function', result: null }
      if (noteRead.available) noteRead.result = await bridge.recallReadNote(noteFile)
      return {
        version: settingsNow.version ?? null,
        onboardingDone: settingsNow.onboardingDone,
        encryptTranscripts: settingsNow.encryptTranscripts,
        temperature: settingsNow.temperature,
        providersBlocked: Array.isArray(settingsNow.allowedProviders) && settingsNow.allowedProviders.length === 0,
        hasOpenAi: settingsNow.hasKeys?.openai === true,
        historyTitles: Array.isArray(history) ? history.map((item) => item.title) : null,
        meeting: meeting ? { file: meeting.file, title: meeting.title, locked: meeting.locked === true } : null,
        read: read ? { ok: read.ok, title: read.title, lines: read.lines?.map((line) => line.text) ?? [] } : null,
        noteRead
      }
    }, { noteFile: basename(baselineNotePath), expected: SYNTHETIC })
    record(checks, 'candidate_launch_version', after.version === CANDIDATE_VERSION, `version=${String(after.version)}`)
    record(checks, 'settings_app_visible_after_upgrade', after.onboardingDone === true && after.encryptTranscripts === true && after.temperature === 0.42 && after.providersBlocked, 'settings values and synthetic provider-blocking policy read from candidate app IPC')
    record(checks, 'api_key_app_visible_after_upgrade', after.hasOpenAi === true, 'hasKeys.openai=true from candidate app IPC')
    record(checks, 'meeting_history_app_visible_after_upgrade', Array.isArray(after.historyTitles) && after.historyTitles.includes(SYNTHETIC.meetingTitle), 'History contains the synthetic meeting title')
    record(checks, 'meeting_content_app_visible_after_upgrade', after.read?.ok === true && after.read.title === SYNTHETIC.meetingTitle && after.read.lines.includes(SYNTHETIC.meetingLine), 'candidate recallRead decrypted the synthetic transcript')
    record(checks, 'windows_dpapi_keystore_preserved', baselineSecretKeySize > 32 && statSync(join(keyFolder, 'secret-key.bin')).size === baselineSecretKeySize && hashFile(join(keyFolder, 'secret-key.bin')) === baselineSecretKeyHash && hashFile(join(keyFolder, 'key-openai.bin')) === baselineApiKeyHash && after.hasOpenAi, 'non-raw Windows safeStorage-wrapped key and encrypted provider key are byte-identical; app decrypted key after upgrade')
    record(checks, 'meeting_ciphertext_preserved', hashFile(baselineMeetingPath) === baselineMeetingHash && checkEncryptedFile(baselineMeetingPath, SYNTHETIC.meetingLine), 'meeting ciphertext is byte-identical and remains encrypted')
    record(checks, 'note_ciphertext_preserved', hashFile(baselineNotePath) === baselineNoteHash && checkEncryptedFile(baselineNotePath, SYNTHETIC.noteAnswer), 'note ciphertext is byte-identical and remains encrypted')
    const noteResult = after.noteRead?.result
    const noteReadable = after.noteRead?.available === true && noteResult?.ok === true &&
      (noteResult.answer === SYNTHETIC.noteAnswer || noteResult.content?.includes(SYNTHETIC.noteAnswer))
    const noteEvidence = noteReadable
      ? 'candidate note-read API returned the expected synthetic answer'
      : after.noteRead?.available
        ? 'FAIL: candidate note-read API did not return the expected synthetic answer'
        : 'BLOCKED: candidate bridge does not expose saved-note read; ciphertext alone cannot prove app-visible decryption'
    record(checks, 'note_content_app_visible_after_upgrade', noteReadable, noteEvidence)
    if (!noteReadable) {
      report.coverage_limitations.push('The candidate did not prove saved-note app-visible decryption; preserved ciphertext alone is not an acceptance substitute.')
    }
    const candidateExit = await stopApp(activeApp)
    activeApp = null
    record(checks, 'candidate_clean_shutdown', candidateExit.quitDelivered && candidateExit.exited, `quit=${candidateExit.quitDelivered}; exit0=${candidateExit.exited}`)
    if (!after.version || !after.onboardingDone || !after.encryptTranscripts || !after.hasOpenAi || !after.meeting || !after.read?.ok || !noteReadable || !candidateExit.quitDelivered || !candidateExit.exited) {
      throw new Error('candidate failed at least one app-visible preservation assertion')
    }
  } catch (error) {
    overallError = error instanceof Error ? error.message : String(error)
  } finally {
    if (activeApp) {
      try { await stopApp(activeApp) } catch { /* report is already fail-closed */ }
    }
    report.error = overallError
    report.assessment = assessUpgradeReport(report, { candidateRun, candidateSha256: report.candidate.sha256, commit: candidateCommit })
    writeReport(reportPath, report)
  }
  if (report.assessment.accepted) process.stdout.write(`Profile upgrade acceptance: PASS (${reportPath})\n`)
  else {
    process.stderr.write(`Profile upgrade acceptance: FAIL\n${report.assessment.problems.join('\n')}\n`)
    process.exitCode = 1
  }
}

function verifyCandidateCommand(runPath, provenancePath, candidateRun, outputPath) {
  const run = JSON.parse(readFileSync(runPath, 'utf8'))
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
  const identity = verifyCandidateIdentity(run, provenance, candidateRun)
  writeFileSync(outputPath, `${JSON.stringify(identity, null, 2)}\n`)
}

async function main(argv) {
  const [command, ...args] = argv
  if (command === 'verify-candidate') {
    const [runPath, provenancePath, candidateRun, outputPath] = args
    if (!runPath || !provenancePath || !candidateRun || !outputPath) throw new Error('usage: profile-upgrade.mjs verify-candidate <run.json> <provenance.json> <run-id> <identity.json>')
    verifyCandidateCommand(runPath, provenancePath, candidateRun, outputPath)
    return
  }
  if (command === 'run') {
    const [baselineInstaller, candidateInstaller, candidateRun, candidateAttempt, candidateCommit, reportPath, installRoot, runnerRoot] = args
    if (![baselineInstaller, candidateInstaller, candidateRun, candidateAttempt, candidateCommit, reportPath, installRoot, runnerRoot].every(Boolean)) {
      throw new Error('usage: profile-upgrade.mjs run <baseline.exe> <candidate.exe> <run-id> <attempt> <commit> <report.json> <install-root> <runner-root>')
    }
    await runUpgrade({ baselineInstaller, candidateInstaller, candidateRun, candidateAttempt, candidateCommit, reportPath, installRoot, runnerRoot })
    return
  }
  throw new Error('usage: profile-upgrade.mjs <verify-candidate|run> ...')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`profile-upgrade: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
