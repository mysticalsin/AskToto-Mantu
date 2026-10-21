// WP14 sandbox acceptance — the real-observation steps of the acceptance scenario and the soak's meeting phase. Each
// function either returns the evidence it observed or throws; nothing here reports success it did not see.
//
// How a meeting is driven (no QA-only hook needed): the overlay's own "Start listening" button is clicked through CDP, which
// Playwright delivers as a trusted input event (the preload only honours isTrusted clicks on [data-metis-meeting-start]).
// The microphone is Chromium's fake capture device fed from METIS_QA_CAPTURE_FILE (src/main/qa-capture-source.ts), so the
// real getUserMedia, worklet, VAD, ASR and save paths run on a known, synthetic input.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, waitFor } from '../lib/app-driver.mjs'
import { isDraftMeetingFile, isSavedMeetingFile, listMeetingFiles } from './lib.mjs'

const START_LABEL = 'Start listening'
const LIVE_LABEL = /Stop and end meeting|End meeting/
const STOP_LABEL = 'Stop and end meeting'

/** aria-labels of the buttons currently in the overlay: labels only, never page text. */
export const buttonLabels = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label')).slice(0, 60)
  )

/**
 * Refuse to start a meeting unless the app itself reported the file-fed capture source (`qa.capture.file_source`). Without
 * it the meeting would open the REAL microphone, which this tooling must never do.
 */
export function assertSyntheticCaptureActive(session) {
  if (!session.audit().some((record) => record.event === 'qa.capture.file_source')) {
    throw new Error(
      'the app did not report qa.capture.file_source: refusing to start a meeting that could open a real microphone'
    )
  }
}

/** Click "Start listening" and wait for the live-meeting controls. */
export async function startSyntheticMeeting(session, { timeoutMs = 45_000 } = {}) {
  assertSyntheticCaptureActive(session)
  const page = await session.connect()
  const start = page.getByRole('button', { name: START_LABEL }).first()
  try {
    await start.waitFor({ state: 'visible', timeout: 20_000 })
  } catch (error) {
    throw new Error(
      `"${START_LABEL}" is not visible (buttons: ${JSON.stringify(await buttonLabels(page).catch(() => []))}): ${error.message}`
    )
  }
  const clickedAt = Date.now()
  await start.click({ timeout: 10_000 })
  try {
    await page.getByRole('button', { name: LIVE_LABEL }).first().waitFor({ state: 'visible', timeout: timeoutMs })
  } catch (error) {
    throw new Error(
      `the meeting did not go live within ${Math.round(timeoutMs / 1000)}s (buttons: ${JSON.stringify(await buttonLabels(page).catch(() => []))}): ${error.message}`
    )
  }
  return {
    evidence: { listeningControlsVisible: true, msToLive: Date.now() - clickedAt, captureFileSourceAudit: true }
  }
}

/** Autosave drafts (`.autosave-draft-*.md`) are written by the real renderer every 60 s once it holds transcript lines. */
export async function observeTranscriptDraft(session, { speech, waitSeconds = 150 }) {
  const folder = session.layout.meetingsFolder
  if (!speech) {
    return {
      status: 'NOT_SUPPORTED',
      reason:
        'the synthetic input is a non-speech tone: no transcript text can be produced. Re-run with --audio speech or --audio file --wav <speech wav>.',
      evidence: { audio: 'tone' }
    }
  }
  const started = Date.now()
  try {
    const draft = await waitFor(
      () => {
        const names = listMeetingFiles(folder, isDraftMeetingFile)
        return names.length ? names[names.length - 1] : null
      },
      `no autosave draft appeared within ${waitSeconds}s of synthetic speech`,
      waitSeconds * 1000,
      2_000
    )
    const bytes = statSync(join(folder, draft)).size
    return {
      evidence: {
        draftFilePresent: true,
        draftBytes: bytes,
        secondsToFirstDraft: Math.round((Date.now() - started) / 1000)
      }
    }
  } catch (error) {
    throw new Error(
      `${error.message}. Either the speech engine produced no segments (model not installed or not ready) or the renderer never captured the file-fed audio.`
    )
  }
}

/** Click Stop and wait for the saved meeting file (the transcript is saved when the drain completes, before any recap). */
export async function stopAndSave(session, { waitSeconds = 180 } = {}) {
  const page = await session.connect()
  const folder = session.layout.meetingsFolder
  const before = new Set(listMeetingFiles(folder))
  const stop = page.getByRole('button', { name: STOP_LABEL }).first()
  try {
    await stop.waitFor({ state: 'visible', timeout: 10_000 })
  } catch (error) {
    throw new Error(
      `"${STOP_LABEL}" is not visible (buttons: ${JSON.stringify(await buttonLabels(page).catch(() => []))}): ${error.message}`
    )
  }
  const clickedAt = Date.now()
  await stop.click({ timeout: 10_000 })
  const file = await waitFor(
    () => listMeetingFiles(folder, isSavedMeetingFile).find((name) => !before.has(name)) ?? null,
    `no saved meeting file appeared in the sandbox meetings folder within ${waitSeconds}s of Stop`,
    waitSeconds * 1000,
    1_000
  )
  const bytes = statSync(join(folder, file)).size
  const audit = session.audit()
  return {
    file,
    evidence: {
      savedMeetingFile: file,
      bytes,
      secondsToSave: Math.round((Date.now() - clickedAt) / 1000),
      auditTranscriptSaved: audit.filter((record) => record.event === 'transcript.saved').length,
      meetingsFolderInsideSandbox: true
    }
  }
}

/**
 * "Review opens it": the History/Recall list must list the saved meeting and Resume/Review's own reader (recallRead, the same
 * IPC the Review view uses) must decode it. recallOpen is NOT used: it calls shell.openPath, which hands the file to the OS.
 * Only counts and flags are recorded, never text or titles.
 */
export async function reviewSavedMeeting(session, file, { speech }) {
  return session.withPage(async (page) => {
    const result = await page.evaluate(async (name) => {
      const list = await window.toto.recallList()
      const entry = list.find((item) => item.file === name) ?? null
      const read = entry ? await window.toto.recallRead(name) : null
      return {
        listed: Boolean(entry),
        locked: Boolean(entry?.locked),
        readOk: read?.ok === true,
        lines: Array.isArray(read?.lines) ? read.lines.length : 0,
        hasStartedAt: typeof read?.startedAt === 'number',
        recapChars: typeof read?.recap === 'string' ? read.recap.length : 0
      }
    }, file)
    if (!result.listed) throw new Error('the saved meeting is not in the History list (recallList)')
    if (!result.readOk) throw new Error('recallRead could not open the saved meeting')
    if (speech && result.lines === 0)
      throw new Error('the saved meeting opens but holds no transcript lines after synthetic speech')
    return { evidence: result }
  })
}

/** After a relaunch: the meeting saved earlier must still be listed and readable (data preserved across quit). */
export async function verifyMeetingPreserved(session, file) {
  const onDisk = listMeetingFiles(session.layout.meetingsFolder, isSavedMeetingFile).includes(file)
  const review = await reviewSavedMeeting(session, file, { speech: false })
  const started = session.audit().find((record) => record.event === 'app.started')
  return {
    evidence: {
      ...review.evidence,
      fileStillOnDisk: onDisk,
      prevShutdown: typeof started?.prevShutdown === 'string' ? started.prevShutdown : null
    }
  }
}

/**
 * Brain ingest queue depth, the only app-exposed queue: BrainStatus.live.pending (newly saved meetings waiting to be mapped)
 * and BrainStatus.backfill (total - done). It reads null while the profile is signed out, in which case the queue is
 * reported NOT_INSTRUMENTED rather than guessed.
 */
export async function readQueue(session) {
  try {
    return await session.withPage((page) =>
      page.evaluate(async () => {
        const status = await window.toto.brainStatus()
        if (!status) return { available: false }
        const backfillRemaining = status.backfill ? Math.max(0, status.backfill.total - status.backfill.done) : 0
        return {
          available: true,
          livePending: status.live?.pending ?? 0,
          liveRunning: Boolean(status.live?.running),
          backfillRemaining
        }
      })
    )
  } catch (error) {
    return { available: false, error: String(error?.message ?? error).slice(0, 200) }
  }
}

/** Saved meeting files currently in the folder (names only). */
export const savedMeetingNames = (layout) => {
  try {
    return readdirSync(layout.meetingsFolder).filter(isSavedMeetingFile)
  } catch {
    return []
  }
}

export { sleep }
