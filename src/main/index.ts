import {
  app,
  BrowserWindow,
  crashReporter,
  globalShortcut,
  ipcMain,
  screen,
  desktopCapturer,
  session,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
  protocol,
  net,
  Notification,
  clipboard,
  powerSaveBlocker,
  systemPreferences
} from 'electron'
import { join, basename, dirname, resolve, extname } from 'node:path'
import { readFileSync, existsSync, writeFileSync, realpathSync, readdirSync, unlinkSync, createReadStream, statSync, renameSync, rmdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  IPC,
  AskStartSchema,
  SetApiKeyPayloadSchema,
  ClearApiKeyPayloadSchema,
  TestApiKeyPayloadSchema,
  McpCrmTestConnectionPayloadSchema,
  McpCrmSaveConnectionPayloadSchema,
  McpCrmPushPayloadSchema,
  LicenseActivatePayloadSchema,
  SetDealOutcomePayloadSchema,
  EntityRenamePayloadSchema,
  EntityMergePayloadSchema,
  EntityUnmergePayloadSchema,
  EntityUpdateFieldPayloadSchema,
  FieldDecisionPayloadSchema,
  CommitmentRejectPayloadSchema,
  MeetingExtractionQuerySchema,
  appendAsrCorrection,
  RenameMeetingPayloadSchema,
  UpdateRecapPayloadSchema,
  SetConfidentialPayloadSchema,
  RecallBackfillSpeakersPayloadSchema,
  ImportAudioStartSchema,
  ImportJobIdSchema,
  ImportDecoderChunkSchema,
  ImportDecoderCompleteSchema,
  ImportDecoderFailedSchema,
  LocalPrewarmPayloadSchema,
  ProviderIdSchema,
  DEFAULT_SHORTCUTS,
  ASK_MEMORY_IDLE_MS,
  type HotkeyAction,
  type ShortcutFailure,
  type PublicSettings,
  type CalendarEvent,
  type AskStart,
  type ImportJobView,
  type ScreenContextResult,
  type RecallExportPlainResult
} from '@shared/ipc'
import {
  getSettings,
  setSettings,
  getLockedKeys,
  getAllowedProviders,
  getEnvKeyProviders,
  getApiKey,
  setApiKey,
  clearApiKey,
  testApiKey,
  hasApiKey,
  hasKeysMap,
  encryptionAvailable,
  archiveEncryptedProfile,
  listDustAgents,
  dustSelectedAgentVision,
  recordMeetingSummarized
} from './store'
import { createStream } from './llm'
import { isTransient, nextBackoff } from './llm/retry'
import {
  isAuthFailure,
  isCoolingDown,
  recordAuthFailure,
  recordSuccess,
  resetProviderHealth,
  unhealthyProviders
} from './llm/provider-health'
import * as localRuntime from './llm/local-runtime'
import {
  localEligibleFor,
  localFallbackEligibleFor,
  localBaseReady,
  localPrewarmEligible,
  localVisionPrivacyRequired,
  pickPrimaryProvider,
  allowCrossProviderFailover
} from './llm/local-routing'
import { ensureLocalRuntimeStarted, prewarmLocal } from './llm/local'
import * as fmRuntime from './llm/fm-runtime'
import { extractScreenText } from './mac-helper'
import { createSpeakerId, type SpeakerId } from './speaker-id'

// Lazy Speaker Intelligence singleton — building it probes the sherpa addon + embedding model, so defer
// until the first THEM window with the feature enabled (never on the startup path).
let speakerIdInstance: SpeakerId | null = null
function getSpeakerId(): SpeakerId {
  if (!speakerIdInstance) speakerIdInstance = createSpeakerId()
  return speakerIdInstance
}
import { buildPrewarmMessages } from './llm/prewarm'
import { listModels as listLocalModels } from './llm/local-models'
import { createScreenPreprocess, type ScreenPreprocess } from './screen-preprocess'
import { startForegroundWatcher } from './foreground-watcher'
import { resetDustConversation, prewarmDustConversation, isDustAuthError } from './llm/dust'
import {
  createKeyedSingleFlight,
  getScreenSourcesWithRetry,
  isUsableScreenSource,
  screenCaptureUnavailableMessage
} from './screen-capture'
import {
  enqueueIngest,
  markBrainChanged,
  requestBackfill,
  requestSourceRefresh,
  brainBackfillProgress,
  brainLiveIngestProgress,
  ingestFailureCounts,
  ingestFailureDetails,
  resumeBackfillIfPending,
  reconcileMeetingsInBackground,
  settleCommitment,
  startRebuild
} from './brain/ingest'
import {
  renameEntity,
  mergeEntities,
  unmergeEntities,
  updateEntityField,
  readFieldProvenance,
  rejectCommitment,
  isJournalCorruptionBlocked,
  clearJournalCorruptionLock,
  readCorrectionsJournal,
  readAliasMap,
  resolveEntitySlug
} from './brain/corrections'
import { publishEntity, removeFromWiki, publishAll, removeWiki, wikiDir } from './brain/publish'
import { computeAttention } from './brain/attention'
import { openIntelligenceWindow, isIntelligenceSender, syncIntelContentProtection } from './intelligence'
import {
  readIndex as readBrainIndex,
  writeIndex as writeBrainIndex,
  readGraph as readBrainGraph,
  writeGraph as writeBrainGraph,
  readPerson as readBrainPerson,
  writePerson as writeBrainPerson,
  readAccount as readBrainAccount,
  writeAccount as writeBrainAccount,
  readDeal as readBrainDeal,
  writeDeal as writeBrainDeal,
  listEntities as listBrainEntities,
  listMeetingExtractions as listBrainMeetingExtractions,
  readMeetingExtraction as readBrainMeetingExtraction,
  purgeBrain,
  setDealOutcome,
  slugify as brainSlugify,
  brainDir as brainStoreDir
} from './brain/store'
import { buildBrainContext } from './brain/context'
import { buildSystem } from './personas'
import { initLogging, mainLog, auditLog } from './logger'
import { installProxyAwareFetch } from './net/install-proxy'
import { authStatus, signIn as authSignIn, signOut as authSignOut, requireAuth } from './auth'
import { calendarToday } from './calendar'
import { fetchTeamsTranscriptForMeeting } from './graph-transcript'
import {
  parakeetModelReady,
  ensureParakeetModel,
  parakeetTranscribe,
  parakeetRelease,
  parakeetAddonError
} from './parakeet'
import { appleSpeechLocale, appleSpeechTranscribe } from './apple-speech'
import { resetLanguageFollow as resetImportLanguageFollow, whisperImportTranscribe } from './whisper-import'
import { pickAudioFile, consumePickedAudio } from './import-audio'
import { ImportJobManager, type ImportJob } from './import-jobs'
import { EncryptedImportJobStore } from './import-job-store'
import { bundledFfmpegPath, startFfmpegDecode, type FfmpegDecoder } from './ffmpeg-decoder'
import {
  saveMeeting,
  meetingDurationMin,
  saveNote,
  appendDebrief,
  saveDraftTranscript,
  clearDraftTranscript,
  recoverOrphanDrafts,
  parseRecapMarkdown,
  recapMarkdownToHtml,
  resolveMeetingsFolder,
  ensureMeetingsFolder,
  isEncryptedFile,
  decryptToTemp,
  sweepStaleTempFiles,
  readSavedFile
} from './transcripts'
import { getPlatformPermissions, probeScreenCapture, noteScreenCaptureOutcome } from './platform-perms'
import {
  listMeetings,
  searchMeetings,
  recallRead,
  deleteMeeting,
  renameMeeting,
  updateMeetingRecap,
  updateMeetingTranscript,
  setMeetingConfidential,
  deleteAllMeetings,
  sweepExpiredMeetings
} from './recall'
import { initAutoUpdate, checkForUpdateNow } from './updater'
import { runSelfTest } from './selftest'
import { readEvalMetrics, aggregateMetrics } from './metrics'
import { importDustCliSession, refreshDustCliSession, setupDustCli } from './dustcli'
import { asrManifestComplete } from './asr-manifest'
import { isInsideResourceBase, realResourceBase } from './asr-model-path'
import { detectCli, testCli, setupCli, installCli, loginCli, prewarmCli } from './cli'
import { connectBidstack, pushToBidstack } from './mcp/bidstackClient'
import { activateLicense, checkLicenseGrace, heartbeat } from './license'
import {
  setBidstackApiKey,
  getBidstackApiKey,
  clearBidstackApiKey,
  hasBidstackApiKey
} from './mcp/bidstackSecrets'
import {
  graphifyStatus,
  buildGraph,
  relatedNotes,
  graphHtml,
  scheduleRebuild,
  purgeGraphArtifacts
} from './graphify'
import { SaveMeetingSchema, SaveNoteSchema } from '@shared/ipc'
import {
  PROVIDERS,
  resolveModelTier,
  applyInteractiveGuardrail,
  reasoningEffortFor,
  type ProviderId,
  type ProviderDef
} from '@shared/providers'
import { routeTier } from '@shared/routing'
import { redactSecrets } from '@shared/redact'
import { applySpeakerNames } from '@shared/transcript-align'
import { initializeCaheEditionIdentity, isCaheEdition } from './cahe-edition'
import { importEmbeddedCaheKey, seedCaheLocalAiForBackgroundScreen } from './cahe-embedded-key'

// KEYSTORE BACKEND — the default is PLATFORM-SPECIFIC, not global.
//
// macOS (forced file keystore): on a self-signed / un-notarized build the Keychain ACL is not stably
// trusted, so safeStorage prompts for the login-keychain password on launch — AND because the first
// getSettings() decrypt runs synchronously during boot, BEFORE the overlay window paints, that modal
// prompt blocks the entire UI behind it (the "load forever" / "I only see the keychain box" report).
// The AES-256-GCM file backend keeps secrets encrypted at rest (secret-key.bin, mode 0600) with zero
// OS prompt, so the app boots straight to its UI. Remove this once the app ships signed with an Apple
// Developer ID + notarization, so it can use the Keychain-backed store again.
//
// Windows (NOT forced): none of the above applies. safeStorage there is DPAPI-backed, tied to the
// signed-in Windows account rather than to the binary's code signature, and never shows a prompt.
// Forcing the file keystore anyway made useFileBackend() permanently true, which made canWrap
// permanently false (secrets.ts) — so the AES-256 master key was written to secret-key.bin as 32 RAW
// bytes sitting next to the ciphertext it protects. Leaving the var unset lets DPAPI wrap that key
// (and lets settings/API keys/transcript content keys use safeStorage directly), so a bare copy of
// the userData folder is no longer decryptable. TRADEOFF: the profile becomes bound to this Windows
// user account — see the DPAPI note in secrets.ts and the recoverEncryptedProfile IPC.
//
// `??=` on BOTH platforms leaves an explicit QA/operator override (ASKTOTO_LOCAL_KEYSTORE already set
// in the environment) untouched — including forcing the file keystore on Windows for isolated QA.
initializeCaheEditionIdentity()
if (process.platform === 'darwin') process.env.ASKTOTO_LOCAL_KEYSTORE ??= '1'

// Select the final user-data profile before crashReporter (or any other Electron service) can resolve
// a default path. In particular, ASKTOTO_USERDATA must isolate physical QA from a real encrypted profile.
if (process.env.ASKTOTO_USERDATA) app.setPath('userData', process.env.ASKTOTO_USERDATA)

// Unpackaged (npm run dev / QA) runs must never share the packaged app's userData: its settings.json
// is safeStorage-encrypted under the packaged binary's keychain identity, so a dev process can't
// decrypt it — reads fall back to defaults (onboarding reappears) and the write guard refuses to
// clobber it, wedging onboarding at the last slide. A '-dev' suffixed profile sidesteps all of it.
if (!app.isPackaged && !process.env.ASKTOTO_USERDATA) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

// Profile-dir migration across product-name changes. userData follows CFBundleName, so each rename
// moved the packaged dir: "AskToto" → "Métis" (rebrand) → "Metis" (ASCII bundle name — the accented
// "Métis Helper" child-process bundles crashed Chromium at launch on macOS 26+/Tahoe; see the
// productName note in electron-builder.yml). Adopt the newest existing prior profile once so settings,
// transcripts, and secret-key.bin survive the rename. Must run before anything opens userData.
if (app.isPackaged && !process.env.ASKTOTO_USERDATA && !isCaheEdition()) {
  try {
    const ud = app.getPath('userData')
    if (!existsSync(join(ud, 'settings.json'))) {
      // Newest-first: adopt the most recent prior name that actually holds a profile.
      const legacy = ['Métis', 'AskToto']
        .map((n) => join(dirname(ud), n))
        .find((p) => existsSync(join(p, 'settings.json')))
      if (legacy) {
        // Electron may have pre-created the new dir empty; clear it so rename can land.
        if (existsSync(ud)) rmdirSync(ud)
        renameSync(legacy, ud)
      }
    }
  } catch {
    // Non-fatal: worst case is a fresh profile; never block launch on a migration.
  }
}

// LOCAL-ONLY native crash capture (zero telemetry — uploadToServer:false means minidumps land in
// app.getPath('crashDumps') under userData and are NEVER transmitted anywhere; consistent with the
// no-crashReporter-upload design note near the uncaught-exception dialog below). Without this, a native
// Chromium CHECK crash (observed once: Electron 39.8.10 startup thread-pool SIGTRAP on the macOS 27
// beta, no app frames in the stack) dies invisibly — the OS crash log is the only trace and nothing in
// the app's own diagnostics can even count it. Must run before app ready.
crashReporter.start({ uploadToServer: false })

// Belt-and-braces with the per-meeting powerSaveBlocker below: keep Chromium itself from ever
// deprioritizing the (hidden) renderer that hosts the transcription worker. Must run before app ready.
app.commandLine.appendSwitch('disable-renderer-backgrounding')

const BAR_WIDTH = 880
const BAR_HEIGHT = 84 // initial idle height of the slimmer two-row widget; useAutoResize grows it for answers
const BAR_MIN_HEIGHT = 44 // floor for the resize clamp so the collapsed control mini-pill can shrink fully
const PILL_WIDTH = 220 // narrow width for the collapsed control mini-pill (so it isn't a wide click-trap)

/** Content protection hides the window from screen capture. Disable via env for dev/screenshots ONLY —
 *  gated to unpackaged builds so a packaged process can never have capture protection stripped by
 *  `setx ASKTOTO_DISABLE_CP 1` + relaunch (mirrors the safeStorage backend gate in secrets.ts). */
function contentProtectionOn(): boolean {
  if (!app.isPackaged && process.env.ASKTOTO_DISABLE_CP) return false
  return getSettings().contentProtection
}

// Private View — the user's "don't look at my screen" switch (bar eye button / Settings → Privacy).
// Distinct from contentProtection above, which only hides the WINDOW from other apps' capture:
// contentProtection defaults ON (the overlay should be invisible in screen-shares), so using it to
// also gate our own capture killed screen-asks on every fresh install.
function privateViewOn(): boolean {
  if (process.env.ASKTOTO_DISABLE_CP) return false
  return getSettings().privateView
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let audioArmed = false // loopback capture only granted during an explicit user-initiated Listen
// Fresh-question boundary state (written by IPC.listeningState / IPC.askResetContext / IPC.askStart, all
// registered below). Module-level rather than closed over the IPC registration so the render-process-gone
// recovery can re-sync it: main can never observe the listeningState(false) a dead renderer owed it, and a
// stuck `listeningActive` disables the boundary for the rest of the app session (MQA-038).
let listeningActive = false
let lastPlainAskAt = 0 // 0 = no live follow-up window; the next plain ask always starts clean
let lastBarHeight = BAR_HEIGHT // remember the bar's content height to restore on settings exit
let currentWidth = BAR_WIDTH // window width; narrows to PILL_WIDTH while collapsed to the control mini-pill
// True while collapsed to the control mini-pill. Guards lastBarHeight below: the pill's own (much shorter)
// content height must never overwrite the remembered full-bar height, or expanding back out would apply
// the tiny pill height first and squish/flash before the renderer's next resize report corrects it.
let isMinimized = false
const streams = new Map<string, { abort: () => void }>()
let importJobs: ImportJobManager | null = null
let decoderWin: BrowserWindow | null = null
let decoderJobId: string | null = null
let decoderExpectedUrl = ''
let closingDecoderJobId: string | null = null
let sourceAck: { jobId: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null
let decoderReady: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null
const ffmpegDecoders = new Map<string, FfmpegDecoder>()
const notifiedImportJobs = new Set<string>()

type BrainStatusCounts = { people: number; accounts: number; deals: number; nodes: number; edges: number }
let brainStatusCountsCache: { folder: string; revision: number; counts: BrainStatusCounts } | null = null

/** Status is polled frequently by two windows. Re-scan graph/entity directories only after a revision change. */
function brainStatusCounts(s: ReturnType<typeof getSettings>, revision: number): BrainStatusCounts {
  const folder = resolveMeetingsFolder(s)
  if (brainStatusCountsCache?.folder === folder && brainStatusCountsCache.revision === revision) {
    return brainStatusCountsCache.counts
  }
  const graph = readBrainGraph(s)
  const counts = {
    people: listBrainEntities(s, 'person').length,
    accounts: listBrainEntities(s, 'account').length,
    deals: listBrainEntities(s, 'deal').length,
    nodes: graph.nodes.length,
    edges: graph.edges.length
  }
  brainStatusCountsCache = { folder, revision, counts }
  return counts
}

/** Security: every privileged IPC handler must come from the main window's top frame.
 *  Compromised subframes, devtools, or unexpected webContents are rejected here. */
function assertMainWindow(event: Electron.IpcMainInvokeEvent): void {
  if (!win) throw new Error('Main window not available')
  if (event.sender !== win.webContents) {
    throw new Error('IPC denied: sender is not the main window')
  }
  const frame = event.senderFrame
  if (!frame || frame.parent !== null || frame.url !== win.webContents.getURL()) {
    throw new Error('IPC denied: not main frame')
  }
}

/** brain:status/brain:read (pure reads) and brain:backfill/brain:field-decision (narrow, guarded writes —
 *  a backfill request, and promoting one already-`extracted` field the human reviewed) are ALSO callable
 *  from the Mantu Intelligence window's top frame; that preload exposes nothing beyond these four (see
 *  src/preload/intelligence.ts). Every other privileged write stays main-window-only via assertMainWindow. */
function assertBrainReader(event: Electron.IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  if (isIntelligenceSender(event.sender)) {
    if (!frame || frame.parent !== null) throw new Error('IPC denied: not main frame')
    return
  }
  assertMainWindow(event)
}

function importJobView(job: ImportJob): ImportJobView {
  let pct: number | null = null
  if (job.state === 'done') pct = 100
  else if (job.progressPct !== undefined) pct = Math.min(99, Math.max(0, Math.round(job.progressPct)))
  else if (job.totalChunks > 0) pct = Math.min(99, Math.round((job.cursor / job.totalChunks) * 100))
  return {
    jobId: job.jobId,
    title: job.title,
    state: job.state,
    cursor: job.cursor,
    totalChunks: job.totalChunks,
    pct,
    error: job.error,
    recapError: job.recapError,
    file: job.file,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  }
}

function publishImportJob(job: ImportJob): void {
  const view = importJobView(job)
  if (win && !win.isDestroyed()) win.webContents.send(IPC.importAudioProgress, { job: view })
  if (job.state === 'done' && !notifiedImportJobs.has(job.jobId) && Notification.isSupported()) {
    notifiedImportJobs.add(job.jobId)
    const notification = new Notification({
      title: 'Import complete',
      body: job.recapError ? `${job.title} transcript is ready. Summary needs a retry.` : `${job.title} transcript and summary are ready.`
    })
    notification.on('click', () => {
      if (!win || win.isDestroyed()) createWindow()
      win?.show()
      win?.focus()
    })
    notification.show()
  }
}

function assertDecoderSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (!decoderWin || decoderWin.isDestroyed() || event.sender !== decoderWin.webContents) {
    throw new Error('IPC denied: sender is not the import decoder')
  }
  const frame = event.senderFrame
  if (!frame || frame.parent !== null || !decoderExpectedUrl || frame.url !== decoderExpectedUrl) {
    throw new Error('IPC denied: import decoder is not its expected main frame')
  }
}

// Non-throwing twin of assertDecoderSender, for use inside ipcMain.on listeners. A synchronous throw in an
// ipcMain.on handler isn't caught by Electron like an ipcMain.handle throw is — it escalates to a
// main-process uncaughtException, which brings up the app's fatal crash dialog. So .on listeners must
// reject unauthorized senders by returning, never by throwing.
function isDecoderSender(event: Electron.IpcMainEvent): boolean {
  if (!decoderWin || decoderWin.isDestroyed() || event.sender !== decoderWin.webContents) return false
  const frame = event.senderFrame
  if (!frame || frame.parent !== null || !decoderExpectedUrl || frame.url !== decoderExpectedUrl) return false
  return true
}

function rejectSourceAck(error: Error): void {
  if (!sourceAck) return
  clearTimeout(sourceAck.timer)
  sourceAck.reject(error)
  sourceAck = null
}

function rejectDecoderReady(error: Error): void {
  if (!decoderReady) return
  clearTimeout(decoderReady.timer)
  decoderReady.reject(error)
  decoderReady = null
}

function waitForDecoderReady(): Promise<void> {
  return new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      decoderReady = null
      rejectReady(new Error('Import decoder did not start.'))
    }, 15_000)
    decoderReady = { resolve: resolveReady, reject: rejectReady, timer }
  })
}

async function closeImportDecoder(jobId: string): Promise<void> {
  const ffmpeg = ffmpegDecoders.get(jobId)
  if (ffmpeg) {
    ffmpeg.cancel()
    await ffmpeg.completed
    ffmpegDecoders.delete(jobId)
    return
  }
  if (!decoderWin || decoderWin.isDestroyed() || decoderJobId !== jobId) return
  closingDecoderJobId = jobId
  rejectSourceAck(new Error('Import decoder closed.'))
  rejectDecoderReady(new Error('Import decoder closed.'))
  decoderWin.destroy()
}

function bundledImportFfmpeg(): string | null {
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'resources')
  return bundledFfmpegPath(resourcesDir)
}

async function sendSourceChunk(jobId: string, bytes: Uint8Array, done: boolean): Promise<void> {
  if (!decoderWin || decoderWin.isDestroyed() || decoderJobId !== jobId) throw new Error('Import decoder is unavailable.')
  await new Promise<void>((resolveAck, rejectAck) => {
    const timer = setTimeout(() => {
      if (sourceAck?.jobId === jobId) sourceAck = null
      rejectAck(new Error('Import decoder did not acknowledge source audio.'))
    }, 30_000)
    sourceAck = { jobId, resolve: resolveAck, reject: rejectAck, timer }
    decoderWin!.webContents.send('import-decoder:source-chunk', { jobId, bytes, done })
  })
}

async function streamSourceToDecoder(job: ImportJob): Promise<void> {
  for await (const chunk of createReadStream(job.sourcePath, { highWaterMark: 1024 * 1024 })) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    await sendSourceChunk(job.jobId, bytes, false)
  }
  await sendSourceChunk(job.jobId, new Uint8Array(0), true)
}

async function startImportDecoder(job: ImportJob): Promise<void> {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(job.sourcePath)
  } catch {
    throw new Error('The selected recording is no longer available. Choose it again to restart the import.')
  }
  if (stat.size !== job.sourceSizeBytes || stat.mtimeMs !== job.sourceMtimeMs) {
    throw new Error('The selected recording changed after import started. Choose it again to restart.')
  }
  const ffmpeg = bundledImportFfmpeg()
  if (ffmpeg) {
    // A transcription failure inside acceptDecodedChunk marks the job terminal and pumps the next FIFO
    // job synchronously (fail() -> pump() -> here), before this decoder's own onError callback — which
    // normally deletes the map entry — has had a chance to run. Reap any decoder whose job already
    // finished so it can't block the next job with a false "already active".
    for (const [id, stale] of ffmpegDecoders) {
      if (id === job.jobId) continue
      const staleState = importJobs?.get(id)?.state
      if (staleState === 'failed' || staleState === 'cancelled' || staleState === 'done' || staleState === undefined) {
        stale.cancel()
        ffmpegDecoders.delete(id)
      }
    }
    if (ffmpegDecoders.size) throw new Error('Another audio decoder is already active.')
    const decoder = startFfmpegDecode(ffmpeg, job.sourcePath, job.cursor, {
      onChunk: async (seq, samples) => {
        await importJobs?.acceptDecodedChunk(job.jobId, seq, 0, samples)
      },
      onProgress: async (pct) => {
        await importJobs?.reportProgress(job.jobId, pct)
      },
      onComplete: async (totalChunks) => {
        // Release the process slot before finishDecoding pumps the next FIFO job.
        ffmpegDecoders.delete(job.jobId)
        await importJobs?.finishDecoding(job.jobId, totalChunks)
      },
      onError: async (error) => {
        // A transcription failure inside onChunk (acceptDecodedChunk throwing) reaches here via the
        // decoder's own uncaught-rejection path with the ffmpeg child still alive and blocked on
        // write() (nothing is reading its stdout anymore) — cancel() sends SIGTERM so it can't leak as
        // an orphaned OS process. Read from the map rather than closing over `decoder` directly: in the
        // rare case spawn() itself throws synchronously, onError can fire before `decoder` is assigned.
        ffmpegDecoders.get(job.jobId)?.cancel()
        ffmpegDecoders.delete(job.jobId)
        await importJobs?.failDecoder(job.jobId, error.message)
      }
    })
    ffmpegDecoders.set(job.jobId, decoder)
    return
  }
  // MQA-090: the ffmpeg branch above reaps a finished job's decoder for exactly this reason, and the
  // hidden-window fallback needs the same reap. A transcription failure inside acceptDecodedChunk marks
  // its job terminal and pumps the next FIFO job synchronously (fail() -> pump() -> here) long before the
  // failing job's renderer learns of it and reports back through importDecoderFailed — which is the only
  // thing that would otherwise free this window. Without the reap the next queued job, and every job
  // behind it, dies with a false "Another audio decoder is already active."
  if (decoderWin && !decoderWin.isDestroyed() && decoderJobId && decoderJobId !== job.jobId) {
    const staleState = importJobs?.get(decoderJobId)?.state
    if (staleState === 'failed' || staleState === 'cancelled' || staleState === 'done' || staleState === undefined) {
      await closeImportDecoder(decoderJobId)
    }
  }
  if (decoderWin && !decoderWin.isDestroyed()) throw new Error('Another audio decoder is already active.')

  decoderJobId = job.jobId
  closingDecoderJobId = null
  decoderExpectedUrl = ''
  decoderWin = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/import-decoder.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  })
  const active = decoderWin
  active.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  active.webContents.on('will-navigate', (event) => event.preventDefault())
  active.on('closed', () => {
    // A cancelled job can be replaced immediately; a late close from its hidden window must not
    // tear down or fail the newer decoder that now owns these globals.
    if (decoderWin !== active || decoderJobId !== job.jobId) return
    const closedJobId = job.jobId
    decoderWin = null
    decoderJobId = null
    decoderExpectedUrl = ''
    rejectSourceAck(new Error('Import decoder closed.'))
    rejectDecoderReady(new Error('Import decoder closed.'))
    if (closedJobId && closingDecoderJobId !== closedJobId) void importJobs?.failDecoder(closedJobId, 'Audio decoder stopped unexpectedly.')
    closingDecoderJobId = null
  })
  active.webContents.on('render-process-gone', () => {
    if (decoderWin === active && decoderJobId === job.jobId) {
      closeImportDecoder(job.jobId)
      void importJobs?.failDecoder(job.jobId, 'Audio decoder stopped unexpectedly.')
    }
  })

  try {
    const decoderUrl = process.env.ELECTRON_RENDERER_URL
      ? new URL('/decoder.html', process.env.ELECTRON_RENDERER_URL).toString()
      : pathToFileURL(join(__dirname, '../renderer/decoder.html')).toString()
    decoderExpectedUrl = decoderUrl
    const ready = waitForDecoderReady()
    // Observe the rejection immediately so a loadURL/loadFile failure below can't surface as an
    // unhandled rejection before `await ready` runs; the real error still propagates at that await.
    ready.catch(() => {})
    if (process.env.ELECTRON_RENDERER_URL) await active.loadURL(decoderUrl)
    else await active.loadFile(join(__dirname, '../renderer/decoder.html'))
    if (active.isDestroyed() || decoderWin !== active) throw new Error('Import decoder closed before it started.')
    await ready
    active.webContents.send('import-decoder:source-start', { jobId: job.jobId, skipThrough: job.cursor })
    await streamSourceToDecoder(job)
  } catch (error) {
    closeImportDecoder(job.jobId)
    throw error
  }
}

function importedTranscriptText(lines: ImportJob['lines']): string {
  return lines.map((line) => `SPEAKER: ${line.text}`).join('\n')
}

async function runImportedRecap(job: ImportJob): Promise<string | undefined> {
  const settings = getSettings()
  const allowed = getAllowedProviders()
  // An imported recording is a summary task. If the user opted into Métis Local summaries and its
  // installer-owned runtime is ready, try it first so the transcript stays on-device. Cloud providers
  // remain the explicit fallback when local is disabled or unavailable.
  const localSummaryReady = localEligibleFor({ mode: 'summary' }, settings, 'base', allowed)
  // MQA-056: the same zero-config safety net (localLlm.fallback) the live-ask seams and brain ingest
  // already honour. Without it a revoked cloud key left the imported meeting with no summary at all —
  // while the very same file was being indexed on-device under the identical flag — and the "retry the
  // summary" the card advises runs as mode:'recap', which is out of local's scope entirely. Strictly
  // LAST, after every cloud/CLI candidate (including `custom`, which sorts after `local` in PROVIDERS),
  // so the existing useFor.summary precedence above is untouched: cloud is still preferred when it works.
  const localFallbackReady =
    !localSummaryReady && localFallbackEligibleFor({ mode: 'summary' }, settings, 'base', allowed)
  const ordered: ProviderId[] = [
    ...(localSummaryReady ? (['local'] as ProviderId[]) : []),
    ...(settings.dustWorkspaceId && getApiKey('dust') && settings.providerModels.dust ? (['dust'] as ProviderId[]) : []),
    settings.provider,
    ...(Object.keys(PROVIDERS) as ProviderId[])
  ]
  const deduped = [...new Set(ordered)]
  const walk = localFallbackReady
    ? [...deduped.filter((provider) => provider !== 'local'), 'local' as ProviderId]
    : deduped
  const candidates = walk.filter((provider) => {
    const def = PROVIDERS[provider]
    if (!def || (allowed && !allowed.includes(provider))) return false
    if (provider === 'local') return localSummaryReady || localFallbackReady
    if (def.kind === 'cli') return !!settings.cliConnected[provider]
    if (!getApiKey(provider)) return false
    if (provider === 'dust' && !settings.dustWorkspaceId) return false
    return !!resolveModelTier(provider, settings.providerModels, settings.providerModelsThinking, 'think', settings.providerModelsDeep)
  })
  if (!candidates.length) return undefined

  const transcript = settings.redactSensitive ? redactSecrets(importedTranscriptText(job.lines)) : importedTranscriptText(job.lines)
  // Persona pinned at import start (ImportJob.mode) — NOT the live settings.mode, which may have been
  // switched while this job sat in the queue. Older checkpoints have no pin; they keep the live mode.
  const personaMode = job.mode || settings.mode
  let lastError: Error | null = null
  for (const provider of candidates) {
    const def = PROVIDERS[provider]
    const local = provider === 'local'
    const req: AskStart = { id: `import-recap-${job.jobId}`, mode: local ? 'summary' : 'recap', prompt: '', transcript, history: [] }
    const key = local ? '' : getApiKey(provider)
    const rawModel = local
      ? settings.localLlm.modelId
      : resolveModelTier(provider, settings.providerModels, settings.providerModelsThinking, 'think', settings.providerModelsDeep)
    const model = local ? rawModel : applyInteractiveGuardrail(provider, 'think', rawModel || def.defaultModel)
    try {
      const recap = await new Promise<string>((resolveRecap, rejectRecap) => {
        let text = ''
        createStream({
          providerId: provider,
          kind: def.kind,
          apiKey: key,
          baseURL: local ? undefined : provider === 'custom' ? settings.customBaseUrl : provider === 'dust' ? settings.dustBaseUrl : def.baseUrl,
          workspaceId: settings.dustWorkspaceId,
          refreshDustAuth:
            provider === 'dust'
              ? async () => {
                  const fresh = await refreshDustCliSession()
                  if (!fresh.ok || !fresh.token || !fresh.workspaceId) return null
                  setApiKey('dust', fresh.token)
                  const baseURL = fresh.baseUrl || 'https://dust.tt'
                  setSettings({ dustWorkspaceId: fresh.workspaceId, dustBaseUrl: baseURL, dustTokenMintedAt: Date.now() })
                  return { apiKey: fresh.token, workspaceId: fresh.workspaceId, baseURL }
                }
              : undefined,
          model,
          temperature: settings.temperature,
          // Same reasoning gate as the live stream (providers.ts reasoningEffortFor) — this path always
          // resolves at the 'think' tier, so a reasoning-by-default model is asked for full effort.
          reasoningEffort: reasoningEffortFor(provider, 'think', settings.thinkingMode === 'always'),
          idleMs: 120_000,
          freshConversation: true,
          system:
            buildSystem(req, personaMode, settings.profile, settings.modePrompts, settings.contextDocs[personaMode] || [], settings.outputLanguage, settings.summaryLanguage, settings.systemPrompt) +
            '\n\nThis is an imported recording with no speaker diarization. Do not attribute statements to YOU or THEM.',
          req,
          handlers: {
            onDelta: (delta) => {
              text += delta
            },
            onDone: () => resolveRecap(text),
            onError: (error) => {
              // A trailing stream error AFTER the summary has streamed must not discard the summary.
              // Seen live (2026-08-04) importing a real recording with the claude-cli provider: the CLI
              // lingers after its final token, the idle watchdog then fires, and a complete recap was
              // thrown away — transcript saved, Notes empty, recapError set. An idle timeout by
              // definition means the model stopped producing long ago, so substantial accumulated text
              // is a finished (or effectively finished) summary — keep it. Early/pre-token failures
              // (no meaningful text yet) still reject into the provider waterfall exactly as before.
              if (text.trim().length >= 200) {
                mainLog.warn(`[import-recap] keeping ${text.trim().length}-char summary despite trailing stream error: ${error}`)
                resolveRecap(text)
                return
              }
              rejectRecap(new Error(error))
            }
          }
        })
      })
      if (!recap.trim()) throw new Error('Summary provider returned an empty response.')
      return recap.trim()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw lastError ?? new Error('No configured AI provider could generate the imported summary.')
}

function initializeImportJobs(): void {
  if (importJobs) return
  importJobs = new ImportJobManager({
    store: new EncryptedImportJobStore(getSettings),
    decode: (job) => {
      // One reset per job, at decode start — a new import must never inherit the previous one's
      // converged language (same reasoning as the live worker's session-start resetFollow).
      resetImportLanguageFollow(getSettings().asrLanguage)
      return startImportDecoder(job)
    },
    transcribe: async (samples) => {
      const engine = getSettings().asrEngine
      if (engine === 'parakeet') {
        await ensureParakeetModel()
        return parakeetTranscribe(samples)
      }
      // 'whisper' and 'apple' both route to the bundled Whisper transcriber for imports. Apple's
      // SFSpeechRecognizer sidecar (apple-speech.ts) is a per-call, lazily-spawned, macOS-only process
      // built for live Listen's streaming windows, not a batch decoder — using Whisper for imports on
      // every platform (including when the live engine is 'apple') is the honest cross-platform choice
      // rather than making imports mac-only or silently changing accuracy profile by OS.
      try {
        // Probe hook: whisperImportTranscribe calls this at most once per job (auto language, window 1
        // only — see probeLanguage in whisper-import.ts) to pin the recording's language off a Parakeet
        // decode of that same first window, before whisper-base's own unreliable per-window auto-detect
        // gets a chance to hallucinate a wrong one. Wired here rather than inside whisper-import.ts so
        // that module stays decoupled from parakeet.ts — a plain callback, easy to fake in tests.
        return await whisperImportTranscribe(samples, getSettings().asrLanguage, async (probeSamples) => {
          await ensureParakeetModel()
          return parakeetTranscribe(probeSamples)
        })
      } catch (err) {
        // An engine choice must never fail an import (T14 guardrail). Whisper's Node runtime can be
        // unavailable for packaging reasons on a given platform (its transformers backend needs native
        // addons — e.g. sharp ships per-OS binaries); Parakeet's sherpa addon is provisioned per target
        // by the build gates, so it is the reliable floor. One warn, then degrade — worse language
        // routing beats a dead import.
        mainLog.warn(`[import] whisper transcriber unavailable, falling back to Parakeet: ${err instanceof Error ? err.message : String(err)}`)
        await ensureParakeetModel()
        return parakeetTranscribe(samples)
      }
    },
    saveMeeting: (meeting) => saveMeeting(getSettings(), meeting),
    deleteMeeting,
    enqueueIngest,
    recordMeetingSummarized,
    generateRecap: runImportedRecap,
    updateRecap: async (file, recap) => {
      const result = await updateMeetingRecap(getSettings(), file, recap)
      if (!result.ok) throw new Error(result.error || 'Could not save the imported summary.')
    },
    onChange: publishImportJob,
    onCancel: closeImportDecoder,
    personaMode: () => getSettings().mode,
    newId: () => randomBytes(16).toString('hex')
  })
}

/** Minimal .env loader (no dep) — dev convenience; prod uses in-app key. */
function loadDotEnv(): void {
  for (const p of [join(process.cwd(), '.env'), join(app.getAppPath(), '.env')]) {
    if (!existsSync(p)) continue
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    } catch {
      /* ignore */
    }
    break
  }
}

/**
 * MQA-062: a CLI provider holds no key of ours, so a credential rejection from one means the LOCAL CLI
 * session ended (`claude logout`, an expired CLI OAuth, an uninstalled binary) — not that a key needs
 * re-entering. `cliConnected` was otherwise write-once: only the user's own Disconnect button ever cleared
 * it, so providerReady below, the Bar's setup CTA and attempt()'s ineligible chain all kept reporting a
 * dead CLI as connected for the rest of the app's life while every ask spawned it and failed. Retiring the
 * flag hands the user back the Connect card and the CTA, and costs one "Reconnect" click in the rare case
 * the session was really still fine. No-op for API-key providers, whose verdict is provider-health's job.
 */
function retireCli(provider: ProviderId, message: string): void {
  if (PROVIDERS[provider].kind !== 'cli' || !isAuthFailure(message)) return
  const s = getSettings()
  if (!s.cliConnected[provider]) return
  setSettings({ cliConnected: { ...s.cliConnected, [provider]: false } })
  mainLog.warn(`[cli] ${provider} rejected our credentials — marking it disconnected`)
}

function publicSettings(): PublicSettings {
  const s = getSettings()
  let loginItemOpenAtLogin = false
  try {
    loginItemOpenAtLogin = app.getLoginItemSettings().openAtLogin
  } catch {
    /* not supported on this platform */
  }
  // Active provider is usable: key present AND any provider-specific setup done (Dust needs a workspace +
  // a chosen base agent; custom needs an https base URL). Drives the add-key CTA so it only shows when the
  // app genuinely can't answer yet — not when a key for a DIFFERENT provider exists.
  const activeDef = PROVIDERS[s.provider]
  // Org allowlist (null = unrestricted) — the SAME source of truth askStart's attempt()/failover() enforce
  // at request time. Folding it in here keeps UI readiness from drifting out of sync with what's actually
  // allowed to answer (previously a blocked provider could show "ready" with no setup CTA, then reject
  // every ask).
  const allowed = getAllowedProviders()
  const providerReady =
    (!allowed || allowed.includes(s.provider)) &&
    (activeDef.kind === 'cli'
      ? !!s.cliConnected[s.provider]
      : hasApiKey(s.provider) &&
        (s.provider === 'dust'
          ? !!s.dustWorkspaceId.trim() && !!s.providerModels.dust
          : s.provider === 'custom'
            ? /^https:\/\//i.test(s.customBaseUrl) && !!s.providerModels.custom
            : true))
  // Métis Local readiness (PLAN.md §4.3) — task-independent base, then one per in-scope task. Derived by
  // local-routing.ts's localBaseReady() so this snapshot and the live routing decision (attempt()/
  // pickFailover below) can never drift apart.
  const localReady = localBaseReady(s, allowed)
  const localSuggestReady = localReady && s.localLlm.useFor.suggest
  const localSummaryReady = localReady && s.localLlm.useFor.summary
  const localVisionReady = localReady && s.localLlm.useFor.vision
  // "Local as safety net" is live: with zero cloud/CLI configured, in-scope asks and meeting indexing
  // still run on-device (askStart's fallback seams + brain/ingest.ts's last-resort candidate). Surfaced
  // so renderer readiness gates (index CTA, screen-ask) match what routing will actually do.
  const localFallbackReady = localReady && s.localLlm.fallback
  return {
    ...s,
    hasApiKey: hasApiKey(s.provider),
    // Reflect the value actually applied to the window, not the raw stored setting — otherwise a dev
    // process running with ASKTOTO_DISABLE_CP would show "Content protection: On" in Settings while
    // capture protection is really off.
    contentProtection: contentProtectionOn(),
    providerReady,
    // gates screen-ask so shots never hit a non-vision model — ORs localVisionReady so a local-only setup
    // (no cloud provider configured at all) still counts as vision-ready. localFallbackReady counts too:
    // askStart's zero-config safety net routes a keyless vision ask to the on-device model.
    visionReady: (providerReady && activeDef.vision) || localVisionReady || localFallbackReady,
    // "Some configured provider can read images" — not necessarily the ACTIVE one. Mirrors the failover
    // candidate test (~1287): a keyed/CLI-connected provider with vision. Lets the renderer route a
    // screen-ask/quick-action to capture even when the active provider (e.g. Dust) is text-only, because
    // the main process transparently fails the vision turn over to this provider instead of dead-ending.
    // ORs localVisionReady for the same local-only-setup reason as visionReady above.
    // Dust's vision capability depends on the selected agent's underlying model, not the static
    // PROVIDERS.dust.vision flag (same distinction askStart's providerVisionOk makes) — consult
    // dustSelectedAgentVision for Dust so a vision-capable Dust agent isn't hidden behind a stale flag.
    visionAvailable:
      (Object.keys(PROVIDERS) as ProviderId[]).some(
        (p) =>
          (p === 'dust' ? dustSelectedAgentVision(s.providerModels['dust']) : PROVIDERS[p].vision) &&
          (!allowed || allowed.includes(p)) &&
          (PROVIDERS[p].kind === 'cli' ? !!s.cliConnected[p] : hasApiKey(p))
      ) || localVisionReady || localFallbackReady,
    localReady,
    localSuggestReady,
    localSummaryReady,
    localVisionReady,
    localFallbackReady,
    // MQA-004: the honest counterpart to providerReady — which providers actually REJECTED their
    // credentials recently, so the UI can say "your key stopped working" instead of claiming ready.
    unhealthyProviders: unhealthyProviders(),
    // Background on-device screen pre-analysis can actually run (toggle on AND the local model is ready).
    backgroundScreenReady: s.backgroundScreenContext && localReady,
    // Live sidecar process state (distinct from localReady's eligibility check) — drives the Local AI
    // card's status line only. localRuntimeState is the precise tri-state (stopped/starting/running/
    // unavailable) so the card can distinguish a normal idle stop from a session-long 'unavailable'
    // lockout; localRuntimeRunning is kept for existing boolean consumers.
    localRuntimeRunning: localRuntime.isRunning(),
    localRuntimeState: localRuntime.getState(),
    hasKeys: hasKeysMap(),
    hasEncryption: encryptionAvailable(),
    resolvedMeetingsFolder: resolveMeetingsFolder(s),
    managedKeys: getLockedKeys(),
    envKeys: getEnvKeyProviders(),
    loginItemOpenAtLogin,
    version: app.getVersion(),
    allowedProviders: allowed // org allowlist (null = unrestricted); surfaced so the picker matches enforcement
  }
}

function topCenter(width: number, height: number): { x: number; y: number } {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 24
  }
}

function createWindow(): void {
  // Crash/recovery guard: render-process-gone recovery and the boot-retry path both rebuild the window
  // from scratch, but isMinimized/currentWidth are module-level state that otherwise survives from before
  // the crash. If the overlay had been collapsed to the mini-pill (currentWidth === PILL_WIDTH) at the
  // moment it died, the freshly-recreated full-size window's mount effect calls setWindowMode() ->
  // setBounds({ width: currentWidth }), squeezing the recovered Bar down to the 220px pill width — with
  // resizable:false blocking any manual fix. Reset both so a recovered window always starts full-size.
  isMinimized = false
  currentWidth = BAR_WIDTH
  // Fresh-install onboarding is a ~640px panel, not the 84px bar. The renderer's content-driven auto-resize
  // can be starved by the macOS compositor on a just-created transparent, always-on-top overlay (rAF/timers
  // frozen for a beat after first paint), which would otherwise leave onboarding clipped to bar height with
  // its "Continue" buttons off-screen. Size the window to fit onboarding up front — deterministic, not
  // dependent on the renderer — and let auto-resize settle it back to the bar once onboarding is done.
  // getSettings() is safe to read here (file keystore, no Keychain prompt — see the keystore note at top).
  let initialHeight = BAR_HEIGHT
  try {
    if (!getSettings().onboardingDone) {
      initialHeight = Math.min(680, screen.getPrimaryDisplay().workArea.height - 48)
      lastBarHeight = initialHeight // so a later width-only change (mini-pill) doesn't snap it back to 84
    }
  } catch {
    /* getSettings unavailable — keep bar height; auto-resize grows onboarding if the renderer isn't frozen */
  }
  const { x, y } = topCenter(BAR_WIDTH, initialHeight)
  win = new BrowserWindow({
    width: BAR_WIDTH,
    height: initialHeight,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false, // panel paints its own shadow; window shadow would box the transparent area
    resizable: false,
    movable: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    acceptFirstMouse: true, // macOS: first click activates + hits the target without needing a second click
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  })

  try {
  win.setAlwaysOnTop(true, 'screen-saver')
  // setVisibleOnAllWorkspaces is a documented no-op on Windows (Electron: "This API does nothing on
  // Windows") — gate the call so it isn't dead code there. Windows has no public API for pinning a
  // window across Task View virtual desktops (that needs the native IVirtualDesktopManager COM
  // interface via a native addon, which this app doesn't ship); on Windows the overlay stays visible
  // only on the virtual desktop it was created on.
  if (process.platform !== 'win32') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setContentProtection(contentProtectionOn())
  win.setHiddenInMissionControl?.(true)
  // Windows: the constructor's skipTaskbar:true is not durable — Electron/Windows re-adds the taskbar
  // button after certain show/restore/focus transitions (long-standing upstream quirk). Re-assert on
  // every transition that can resurrect it so the overlay NEVER appears in the taskbar (Tony, 2026-07-16:
  // an overlay in the taskbar is pointless). Tray remains the discoverable affordance.
  if (process.platform === 'win32') {
    const overlay = win // capture THIS instance — the module-level `win` binding is reassignable
    const reassertSkipTaskbar = (): void => overlay.setSkipTaskbar(true)
    overlay.on('show', reassertSkipTaskbar)
    overlay.on('restore', reassertSkipTaskbar)
    overlay.on('focus', reassertSkipTaskbar)
  }
  } catch (e) {
    // A throw here (rare GPU/compositor-specific native call failure) previously left `win` pointing at a
    // half-configured, never-loaded BrowserWindow that ensureWindow() would treat as healthy forever — it
    // only checks `win && !win.isDestroyed()`, with no load-state check. Destroy the partial window and
    // null the module ref before rethrowing so the caller (the boot runStep's catch, or ensureWindow's own
    // try/catch on recovery) can cleanly recreate on its next attempt instead of reusing a broken window.
    mainLog.error('[createWindow] post-construction setup failed, discarding partial window:', e)
    try {
      win?.destroy()
    } catch {
      /* already gone */
    }
    win = null
    throw e
  }

  // Capture THIS window instance so a late 'closed' from a crashed/replaced window can't null out a
  // freshly-recreated one (render-process-gone recovery reassigns `win` before the old one's 'closed'
  // may fire). Only clear the module ref when it still points at the window that closed.
  const self = win
  win.on('closed', () => {
    // Abort any in-flight LLM streams so their callbacks don't fire against a destroyed window.
    streams.forEach((s) => s.abort())
    streams.clear()
    // Import jobs belong to main plus the hidden decoder window, so closing the overlay never abandons
    // a selected recording. Their checkpointed state resumes even if the entire app exits.
    win = null
  })

  // Security: never let model-output links navigate the trusted renderer or open child windows
  // that inherit the privileged preload. External https links open in the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  // Debug aid (opt-in via ASKTOTO_DEBUG_RENDERER): mirror renderer console warnings/errors into the
  // main-process log so a crash-to-error-boundary can be diagnosed without opening the renderer devtools.
  if (process.env.ASKTOTO_DEBUG_RENDERER) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      // console.* is a no-op in a packaged GUI build with no console — route to the real sink so this
      // debug mirror actually produces diagnosable output.
      if (level >= 2) mainLog.info(`[renderer] ${message}  (${sourceId}:${line})`)
    })
  }
  // The BrowserWindow survives a renderer crash (GPU/compositor crash, OOM in the in-renderer ASR
  // worker) — only its content dies, so `win` stays non-null while hotkeys/tray silently no-op into the
  // dead renderer and the overlay sits permanently blank. Previously this was only logged via
  // console.log gated behind ASKTOTO_DEBUG_RENDERER (never in a packaged build, never persisted).
  // Persist it like onFatal does for a main-process crash, then reload the same content so the overlay
  // recovers instead of hanging forever.
  win.webContents.on('render-process-gone', (_e, details) => {
    mainLog.error(`[renderer-gone] reason=${details.reason} exitCode=${details.exitCode}`)
    auditLog('app.crash', { kind: 'render-process-gone', reason: details.reason, exitCode: details.exitCode })
    // MQA-038: recovery reloads the SAME window, so createWindow()'s crash/recovery guard above never
    // runs and the renderer-OWNED module state survives the renderer that set it. The remounted renderer
    // starts idle and never sends the listeningState(false) it owed us, so `listeningActive` would stay
    // true for the rest of the session — permanently suspending the fresh-question boundary, so every
    // later plain ask keeps the dead meeting's Dust conversation and its replayed history. The tray dot
    // and the power-save block would likewise stay stuck on "meeting in progress" (before-quit reads
    // them as exactly that). Reset the whole set here, mirroring the meeting-start boundary.
    resetDustConversation()
    listeningActive = false
    lastPlainAskAt = 0
    audioArmed = false
    setTrayRecording(false)
    setRecordingPowerSaveBlock(false)
    if (!win || win.isDestroyed()) return
    if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    else win.loadFile(join(__dirname, '../renderer/index.html'))
  })
  // Dev-only: screenshot ONLY this window (no desktop) for verification. Privacy-safe.
  if (process.env.ASKTOTO_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win?.webContents
          .capturePage()
          .then((img) => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              require('node:fs').writeFileSync(process.env.ASKTOTO_SHOT as string, img.toPNG())
            } catch {
              /* ignore */
            }
          })
          .catch(() => {})
      }, 4500)
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    const params = new URLSearchParams()
    if (process.env.ASKTOTO_DEMO) params.set('demo', process.env.ASKTOTO_DEMO)
    // make the overlay visible in the capture; ASKTOTO_SHOTBG=light tests legibility over a bright backdrop
    if (process.env.ASKTOTO_SHOT) params.set('shotbg', process.env.ASKTOTO_SHOTBG || 'dark')
    const qs = params.toString()
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (qs ? `?${qs}` : ''))
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function resizeTo(height: number): void {
  if (!win) return
  // Clamp + reposition against the display the OVERLAY is actually on (not the cursor's). Otherwise, on a
  // laptop + external monitor of different heights, a streaming answer clamps to the wrong monitor and the
  // window jumps vertically while the cursor sits on the other screen.
  const { workArea } = screen.getDisplayMatching(win.getBounds())
  const h = Math.max(BAR_MIN_HEIGHT, Math.min(Math.round(height), workArea.height - 48))
  const b = win.getBounds()
  if (h === b.height && currentWidth === b.width) {
    // Only remember this height for restore-on-expand when it's the real bar, not the mini-pill's
    // much shorter content — see isMinimized comment above.
    if (!isMinimized) lastBarHeight = h
    return // idempotent — skip a no-op setBounds (belt-and-braces with the renderer-side resize dedup)
  }
  if (!isMinimized) lastBarHeight = h
  // Keep the panel fully on-screen; if it would grow below the work area, slide it up.
  const maxY = workArea.y + workArea.height - h - 8
  const y = Math.min(b.y, maxY)
  // When the width changes (collapse to / expand from the mini-pill), recenter around the old midpoint
  // so the overlay stays put; otherwise keep the left edge. Clamp x into the work area either way.
  let x = currentWidth === b.width ? b.x : Math.round(b.x + (b.width - currentWidth) / 2)
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - currentWidth - 8))
  win.setBounds({ x, y, width: currentWidth, height: h }, false)
}

/** Collapse to / expand from the control mini-pill by switching the window width; the renderer's
 *  auto-resize then settles the height to whichever surface is shown. */
function setMinimizedWidth(narrow: boolean): void {
  // Flip BEFORE resizeTo so the pill's own resize reports (while narrow) never clobber lastBarHeight,
  // and so expanding restores the last real bar height instead of the pill's tiny one.
  isMinimized = narrow
  currentWidth = narrow ? PILL_WIDTH : BAR_WIDTH
  resizeTo(lastBarHeight) // re-apply immediately so width + recenter land before the renderer re-measures
}

/**
 * Switch the overlay between the compact 'bar' and the wide, fixed 'settings' surface.
 * Settings keeps the same top edge (so it grows downward from the bar) and centers horizontally,
 * clamped to the work area. Exiting restores the bar's width and last content height.
 */
// Re-center the compact bar on its current display. The old fixed 'settings' window-mode was removed —
// settings renders as a panel under the bar now, so the window only ever lives in 'bar' mode.
function setWindowMode(): void {
  if (!win) return
  const { workArea } = screen.getDisplayMatching(win.getBounds())
  const b = win.getBounds()
  let x = Math.round(b.x + (b.width - currentWidth) / 2)
  x = Math.max(workArea.x + 16, Math.min(x, workArea.x + workArea.width - currentWidth - 16))
  win.setBounds({ x, y: b.y, width: currentWidth, height: lastBarHeight }, false)
}

/** Self-heal a null `win` (e.g. a one-time createWindow() throw during boot) by retrying the window
 *  creation once at call time, instead of leaving window-dependent hotkeys dead for the process
 *  lifetime. Callers that previously did `if (!win) return` should call this instead. A repeated
 *  failure is logged and swallowed — it just leaves win null again, same as the original no-op. */
function ensureWindow(): BrowserWindow | null {
  if (win && !win.isDestroyed()) return win
  win = null // a destroyed-but-non-null win is just as dead as null — treat it the same before recreating
  try {
    createWindow()
  } catch (e) {
    mainLog.error('[recover] createWindow retry failed:', e)
    auditLog('app.crash', { kind: 'boot_step', step: 'createWindow_retry' })
  }
  return win
}

function sendHotkey(action: HotkeyAction): void {
  const w = ensureWindow()
  if (!w) return
  if (!w.isVisible()) w.show()
  w.webContents.send(IPC.hotkey, action)
}

// Tie-breaker for persistCrash's filename: two crashes landing in the same millisecond (e.g. a renderer
// ErrorBoundary catch and a main-process onFatal firing back-to-back) would otherwise collide on
// `crash-${Date.now()}.log` and silently clobber one report. Monotonic per-process, resets on relaunch —
// fine, since it only has to be unique within one run's batch of writes.
let crashSeq = 0

/**
 * Log + audit + dump any crash (main-process fatal or a renderer ErrorBoundary catch) to a shared sink.
 * Redact BEFORE writing to any sink — an error stack/message routinely embeds the data involved in the
 * failing operation, so mainLog and auditLog (both persistent) must never see the raw value, same as the
 * crash-*.log dump below. Best-effort: logging must never throw out of a crash handler.
 */
function persistCrash(kind: string, detail: string, shortMessage: string): void {
  try {
    const redactedDetail = redactSecrets(detail)
    mainLog.error(`[${kind}]`, redactedDetail)
    auditLog('app.crash', { kind, message: redactSecrets(shortMessage) })
    writeFileSync(
      join(app.getPath('userData'), `crash-${Date.now()}-${crashSeq++}.log`),
      `${new Date().toISOString()} ${kind}\n${redactedDetail}\n`,
      { mode: 0o600 }
    )
  } catch {
    /* logging is best-effort — never throw out of the crash handler */
  }
}

let fatalHandled = false
/**
 * For a fatal exception, offer a ONE-TIME relaunch — but default to "Continue" so a benign async error
 * never kills the overlay. No crashReporter upload by design (zero telemetry).
 */
function onFatal(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  const detail = err instanceof Error ? err.stack || err.message : String(err)
  persistCrash(kind, detail, err instanceof Error ? err.message : String(err))
  if (kind !== 'uncaughtException' || fatalHandled) return
  fatalHandled = true
  try {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Métis hit a problem',
      message: 'Métis ran into an unexpected error.',
      detail: 'A crash report was saved to your Métis data folder. Relaunch now, or keep going.',
      buttons: ['Relaunch Métis', 'Continue'],
      defaultId: 1,
      cancelId: 1
    })
    if (choice === 0) {
      app.relaunch()
      app.exit(0)
    }
  } catch {
    /* if the dialog itself fails, leave the app running */
  }
}

// --- Screen capture (cached + pre-warmable for vision latency) -----------------------------------------
// A vision ask issued within CAPTURE_TTL_MS of a (pre-warmed) capture reuses the JPEG instead of paying the
// ~150-450ms capture cost again. Kept tiny so the screen the model sees is never visibly stale.
const CAPTURE_TTL_MS = 1500
let shotCache: { image: string; width: number; height: number; dispId: number; displayMismatch: boolean; ts: number } | null = null
type CapturedScreen = { image: string; width: number; height: number; dispId: number; displayMismatch: boolean }

async function captureScreenshotOnce(displayId: number): Promise<CapturedScreen> {
  const disp = screen.getAllDisplays().find(({ id }) => id === displayId)
  if (!disp) throw new Error('The selected display changed before Métis could capture it. Try again.')
  const sf = disp.scaleFactor || 1
  // Render the thumbnail already capped at VISION_MAX_EDGE (smaller = faster capture + ~50% smaller upload
  // + ~33% less model prefill). 1280px keeps dense on-screen text legible; q72 JPEG.
  const VISION_MAX_EDGE = 1280
  const VISION_JPEG_Q = 72
  const fullW = Math.round(disp.size.width * sf)
  const fullH = Math.round(disp.size.height * sf)
  const capScale = Math.min(1, VISION_MAX_EDGE / Math.max(fullW, fullH))
  const thumbnailSize = {
    width: Math.max(1, Math.round(fullW * capScale)),
    height: Math.max(1, Math.round(fullH * capScale))
  }
  // `not-determined` must still reach desktopCapturer: on macOS the tiny ScreenCaptureKit probe is what
  // registers this app with TCC and lets the system show its first permission prompt. A known denial,
  // however, cannot recover by retrying and must never fall through to a text-only vision answer.
  const accessStatus = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
  if (process.platform === 'darwin' && accessStatus !== 'granted' && accessStatus !== 'not-determined') {
    throw new Error(screenCaptureUnavailableMessage(process.platform, accessStatus))
  }
  const sources = await getScreenSourcesWithRetry(
    () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
    isUsableScreenSource,
    {
      onError: (error, attempt) =>
        mainLog.warn(`[capture] getSources failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`)
    }
  )
  // Match the source to the display under the cursor. With one available source it is necessarily the
  // requested display. With several, never fall back to an arbitrary one: sending another monitor to a
  // provider is worse than asking the user to retry after a display-topology change.
  // MQA-110: this real capture just proved whether screen recording works right now — fold that back
  // into the readiness cache so a permission revoked after the boot probe stops reporting stale 'granted'.
  noteScreenCaptureOutcome(sources.length > 0)
  const matched = sources.find((s) => String(s.display_id) === String(disp.id))
  if (!matched && sources.length > 1) {
    auditLog('capture.display_mismatch', {
      requested: String(disp.id),
      available: sources.map((s) => String(s.display_id))
    })
    throw new Error('Métis could not identify the selected display. Check your display connection and try again.')
  }
  const src = matched ?? sources[0]
  if (!src) {
    // Diagnose WHY before failing: a missing/revoked Screen Recording grant is by far the most common
    // cause, and it needs a specific, actionable message (macOS also requires an app RESTART after
    // granting — a fresh grant doesn't reach an already-running ScreenCaptureKit session).
    const status = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
    throw new Error(screenCaptureUnavailableMessage(process.platform, status))
  }
  let img = src.thumbnail
  const sz = img.getSize()
  const maxEdge = Math.max(sz.width, sz.height)
  if (maxEdge > VISION_MAX_EDGE) {
    const scale = VISION_MAX_EDGE / maxEdge
    img = img.resize({ width: Math.round(sz.width * scale), height: Math.round(sz.height * scale) })
  }
  const jpeg = img.toJPEG(VISION_JPEG_Q)
  const size = img.getSize()
  if (size.width < 1 || size.height < 1 || jpeg.length < 1) {
    throw new Error('Screen capture returned an empty image. Try again in a moment.')
  }
  // MQA-081: the single-source case is NOT proof that the source is the requested display — getScreenSources
  // WithRetry drops zero-pixel sources, so the cursor's own monitor can be filtered out (asleep/waking, HDR
  // switch, protected content) while another one survives. The old `sources.length > 1` test read that as
  // "necessarily the requested display" and sent the other monitor to the vision provider with no signal at
  // all. Flag it instead — this is the field CaptureResult documents and the renderer's soft "captured a
  // different monitor" notice already consumes. A blank display_id (some platforms report none) proves
  // nothing either way, so it is not treated as a mismatch.
  const capturedId = String(src.display_id ?? '')
  const displayMismatch = !matched && capturedId !== ''
  // Report the display actually captured, not the one requested. This is what makes getScreenshot's
  // "captured a different display" guard a real check rather than a comparison of disp.id with itself, and
  // it keeps a wrong-monitor frame from being cached under the cursor's display for the capture TTL.
  const dispId = /^\d+$/.test(capturedId) ? Number(capturedId) : disp.id
  return { image: jpeg.toString('base64'), width: size.width, height: size.height, dispId, displayMismatch }
}

/** Share a native capture only between pre-warm and click requests for the same display. */
const captureScreenshot = createKeyedSingleFlight<number, CapturedScreen>(captureScreenshotOnce)

/** Thrown by getScreenshot() when Private View is on — lets callers show a specific message instead of a
 *  generic capture failure. */
class PrivateViewBlockedError extends Error {
  constructor() {
    super('Private View is on — screen capture is blocked. Turn it off to let Métis see your screen.')
    this.name = 'PrivateViewBlockedError'
  }
}

async function getScreenshot(phase?: string): Promise<{ image: string; width: number; height: number; capturedAt: number; displayMismatch: boolean }> {
  // Private View promises Métis won't look at (or send) the screen while it's on — that has to mean
  // this app's own capture pipeline refuses to run, not just that OTHER apps can't screen-share our window
  // (that's the separate, still-active setContentProtection() call on the BrowserWindow itself).
  // AUDIT the block: a run of user-invisible capture failures used to leave zero trace in the audit log,
  // which made "couldn't capture my screen" reports undiagnosable after the fact.
  if (privateViewOn()) {
    // Prewarm is an opportunistic cache-fill fired on every ask-input focus — auditing its blocks/
    // failures would write a log line per focus while Private View is on (pure noise). Real asks audit.
    if (phase !== 'prewarm') auditLog('capture.blocked', { reason: 'private_view', ...(phase ? { phase } : {}) })
    throw new PrivateViewBlockedError()
  }
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (shotCache && Date.now() - shotCache.ts < CAPTURE_TTL_MS && shotCache.dispId === disp.id) {
    const { image, width, height, ts, displayMismatch } = shotCache
    return { image, width, height, capturedAt: ts, displayMismatch }
  }
  let shot: CapturedScreen
  try {
    shot = await captureScreenshot(disp.id)
  } catch (e) {
    if (phase !== 'prewarm') {
      auditLog('capture.failed', {
        reason: e instanceof Error ? e.message : String(e),
        ...(phase ? { phase } : {})
      })
    }
    throw e
  }
  // A drift we DETECTED and flagged is handed to the renderer as the documented soft "captured a different
  // monitor" notice — dead-ending an otherwise usable answer would be worse than telling the user. An
  // UNFLAGGED drift is still a bug we cannot explain, so it still hard-fails here.
  if (shot.dispId !== disp.id && !shot.displayMismatch) {
    throw new Error('Métis captured a different display than requested. Try again.')
  }
  // Re-check after the async capture: Private View could have been toggled ON while getSources()/resize
  // were in flight. Without this second check, a frame grabbed a moment before the toggle would still be
  // cached and sent to the model — breaking the Private View guarantee on a mid-capture toggle.
  if (privateViewOn()) {
    // Audit like the pre-check (this path used to throw traceless); `at` distinguishes the race.
    if (phase !== 'prewarm') auditLog('capture.blocked', { reason: 'private_view', at: 'post_capture', ...(phase ? { phase } : {}) })
    throw new PrivateViewBlockedError()
  }
  const capturedAt = Date.now()
  shotCache = { ...shot, ts: capturedAt }
  auditLog('capture.screen', { width: shot.width, height: shot.height, bytes: shot.image.length, ...(phase ? { phase } : {}) })
  const { image, width, height, displayMismatch } = shot
  return { image, width, height, capturedAt, displayMismatch }
}

/** Fill the cache + warm the OS capture pipeline ahead of a real ask. Fire-and-forget; auth-gated. */
function prewarmCapture(): void {
  if (!requireAuth()) return
  getScreenshot('prewarm').catch(() => {
    /* best-effort warm */
  })
}

// --- Background screen preprocessing (M13) ---------------------------------------------------------------
// On-device pre-analysis of the screen on window/content change, so a "what's on my screen" ask answers from
// a pre-computed description instead of a cold capture + image round trip. All the privacy/cost guardrails
// live in screen-preprocess.ts; this just wires it to the app's real capture, settings, and local runtime.
const screenPreprocess: ScreenPreprocess = createScreenPreprocess({
  getScreenshot,
  getSettings: () => {
    const s = getSettings()
    return { backgroundScreenContext: s.backgroundScreenContext, localLlm: s.localLlm }
  },
  localReady: () => localBaseReady(getSettings(), getAllowedProviders()),
  privateViewOn,
  ensureLocalRuntimeStarted,
  runtime: {
    baseURL: () => localRuntime.baseURL(),
    sessionKey: () => localRuntime.sessionKey(),
    markActivity: () => localRuntime.markActivity(),
    beginStream: () => localRuntime.beginStream(),
    endStream: () => localRuntime.endStream(),
    activeStreams: () => localRuntime.activeStreams()
  },
  startWatcher: (onChange) =>
    startForegroundWatcher(onChange, {
      onError: (message) => mainLog.warn(`[screen-preprocess] watcher: ${message}`)
    }),
  // macOS: Vision-framework OCR via the bundled metis-mac-helper — tried before the VLM caption.
  // Windows keeps the VLM-only path (extractScreenText returns null without a helper anyway, but gating
  // here keeps the win32 wiring visibly identical to before).
  extractScreenText: process.platform === 'darwin' ? extractScreenText : undefined,
  log: (level, message) => (level === 'warn' ? mainLog.warn(message) : mainLog.info(message)),
  audit: (event, data) => auditLog(event as Parameters<typeof auditLog>[0], data)
})

/** (Re)start or stop background screen preprocessing to match current auth + settings eligibility. Safe to
 *  call repeatedly — it's a no-op when the running state already matches. */
function refreshScreenPreprocess(): void {
  if (!requireAuth()) {
    screenPreprocess.stop()
    return
  }
  screenPreprocess.refresh()
}

/** Clamp a single axis (pos/size) into a work-area span, without inverting when the window is bigger
 *  than the display. Math.min(Math.max(pos, areaPos), areaPos + areaSpan - size) assumes
 *  areaPos + areaSpan - size >= areaPos; when size > areaSpan that upper bound falls below areaPos and
 *  min/max invert, pushing the window partially off-screen instead of pinning it. Pin to areaPos instead. */
function clampAxis(pos: number, size: number, areaPos: number, areaSpan: number): number {
  if (size >= areaSpan) return areaPos
  return Math.min(Math.max(pos, areaPos), areaPos + areaSpan - size)
}

// How much of the window must stay visibly reachable on some display while it's being dragged — enough
// to grab it back, not the whole thing. Below this it's treated as flung off-screen and pulled back in.
const DRAG_VISIBLE_MARGIN = 40

/** Loosened clampAxis: pins `pos` so between `margin` and `size` px (whichever is smaller) of the
 *  window stays inside [areaPos, areaPos + areaSpan), instead of pinning the WHOLE window inside it.
 *  Only used as the moveBy() fallback below — letting most of the window hang off a display's edge is
 *  what lets a drag glide across a gap to a neighboring monitor instead of stopping dead at the first
 *  display's boundary. */
function clampAxisMargin(pos: number, size: number, areaPos: number, areaSpan: number, margin: number): number {
  const m = Math.min(margin, size, areaSpan)
  return Math.min(Math.max(pos, areaPos - size + m), areaPos + areaSpan - m)
}

/** True if, positioned at (x, y), at least DRAG_VISIBLE_MARGIN px of the window overlaps the work area
 *  of at least one CONNECTED display — checked against the union of every display (getAllDisplays()),
 *  not just whichever one the window started the drag on. */
function isReachable(x: number, y: number, width: number, height: number): boolean {
  const marginW = Math.min(DRAG_VISIBLE_MARGIN, width)
  const marginH = Math.min(DRAG_VISIBLE_MARGIN, height)
  return screen.getAllDisplays().some(({ workArea: wa }) => {
    const overlapW = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x)
    const overlapH = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y)
    return overlapW >= marginW && overlapH >= marginH
  })
}

function moveBy(dx: number, dy: number): void {
  // Self-heal a null win (e.g. a one-time createWindow() throw during boot) — mirrors sendHotkey/
  // toggleVisible so scroll/move hotkeys recover instead of staying permanently dead for the process life.
  const w = ensureWindow()
  if (!w) return
  const b = w.getBounds()
  const x = b.x + dx
  const y = b.y + dy
  // Free movement anywhere that keeps the window reachable on SOME display — covers dragging clean
  // across to a neighboring monitor (or over the gap between two of them), not just within the one the
  // window started on. Clamping against only the "current" display here (the old behavior) is what used
  // to stick a drag pinned to that display's edge, since the matched display never changed until the
  // window had already fully crossed onto it — which the clamp itself was preventing.
  if (isReachable(x, y, b.width, b.height)) {
    w.setBounds({ ...b, x, y })
    return
  }
  // Unreachable (flung past every display): pull back onto the display nearest the ATTEMPTED position,
  // not the window's old bounds, so a fast drag lands on whichever monitor it was actually headed toward.
  const { workArea } = screen.getDisplayMatching({ x, y, width: b.width, height: b.height })
  const cx = clampAxisMargin(x, b.width, workArea.x, workArea.width, DRAG_VISIBLE_MARGIN)
  const cy = clampAxisMargin(y, b.height, workArea.y, workArea.height, DRAG_VISIBLE_MARGIN)
  w.setBounds({ ...b, x: cx, y: cy })
}

/**
 * Keep the overlay reachable across display topology changes (monitor unplugged, lid closed, resolution
 * change). Without this the window stays anchored to a display that no longer exists and is stranded
 * off-screen with no fix but a restart. On any change, if the window no longer intersects the visible work
 * area of its matched display, clamp it back in (same math as moveBy). App-scoped listeners; live for the
 * app's lifetime, so they're never removed.
 */
function registerScreenListeners(): void {
  const reanchor = (): void => {
    if (!win) return
    const b = win.getBounds()
    const { workArea: wa } = screen.getDisplayMatching(b)
    const visible =
      b.x + b.width > wa.x && b.x < wa.x + wa.width && b.y + b.height > wa.y && b.y < wa.y + wa.height
    if (visible) return // still (partly) on a real display — leave it where the user put it
    const x = clampAxis(b.x, b.width, wa.x, wa.width)
    const y = clampAxis(b.y, b.height, wa.y, wa.height)
    win.setBounds({ ...b, x, y })
  }
  screen.on('display-removed', reanchor)
  screen.on('display-added', reanchor)
  screen.on('display-metrics-changed', reanchor)
}

function toggleVisible(): void {
  // ensureWindow() silently CREATES a new window when `win` is null/destroyed (e.g. after a boot-time
  // createWindow() failure) — and a freshly created window starts visible. Without this check, the
  // isVisible() branch below would immediately re-hide the just-recovered window, so the first Ctrl+\
  // after such a failure looked like a no-op and the user had to press it twice.
  const hadNoWindow = !win || win.isDestroyed()
  const w = ensureWindow()
  if (!w) return
  if (!hadNoWindow && w.isVisible()) w.hide()
  else {
    w.show()
    w.focus()
    w.webContents.send(IPC.hotkey, 'ask')
  }
}

const shortcutActions: Record<string, () => void> = {
  ask: () => sendHotkey('ask'),
  hide: () => toggleVisible(),
  reset: () => sendHotkey('reset'),
  'toggle-listen': () => sendHotkey('toggle-listen'),
  capture: () => sendHotkey('capture'),
  factcheck: () => sendHotkey('factcheck'),
  whatnext: () => sendHotkey('whatnext'),
  explain: () => sendHotkey('explain'),
  summarize: () => sendHotkey('summarize'),
  'spotlight-ref': () => sendHotkey('spotlight-ref'),
  // 'settings' is in HOTKEY_ACTIONS (shared/ipc.ts) so Settings → Shortcuts renders a bindable "Open
  // settings" row, and the renderer already handles the hotkey action (App.tsx) — this entry was the one
  // missing piece: without it registerShortcuts() never registered the combo the row recorded, so it was
  // a silent no-op with no failure banner either. The tray's own Settings item already sends this same
  // 'settings' hotkey (sendHotkey('settings') above), so this mirrors that.
  settings: () => sendHotkey('settings'),
  'scroll-up': () => moveBy(0, -60),
  'scroll-down': () => moveBy(0, 60),
  'scroll-left': () => moveBy(-60, 0),
  'scroll-right': () => moveBy(60, 0)
}

function resolveShortcut(action: HotkeyAction, user: Record<string, string>): string {
  return user[action] ?? DEFAULT_SHORTCUTS[action] ?? ''
}

// Populated by registerShortcuts() and read by IPC.shortcutFailures — a register() failure (another
// app already holds the combo, or an OS-reserved one like Windows' Ctrl+Alt+Arrow display-rotation
// hotkey) previously only reached mainLog, which end users never see. Reset on every re-register so a
// later successful bind clears the stale entry instead of leaving a permanent false warning.
let shortcutFailures: ShortcutFailure[] = []

function registerShortcuts(): void {
  globalShortcut.unregisterAll()
  shortcutFailures = []
  const user = getSettings().shortcuts ?? {}
  // Electron's globalShortcut.register() returns true (success) even when the accelerator is already
  // claimed by a PREVIOUS action in this same loop — it just silently replaces that action's callback,
  // which is not a register() failure and so would never reach shortcutFailures below. Track claimed
  // accelerators ourselves so the second action loses deterministically and visibly instead.
  const claimedBy = new Map<string, string>()
  for (const [action, fn] of Object.entries(shortcutActions)) {
    const accel = resolveShortcut(action as HotkeyAction, user)
    if (!accel) continue
    const dupeOf = claimedBy.get(accel)
    if (dupeOf) {
      mainLog.warn(`[shortcuts] duplicate accelerator for ${action}: ${accel} (already bound to ${dupeOf})`)
      shortcutFailures.push({ action, accel })
      continue
    }
    try {
      const ok = globalShortcut.register(accel, fn)
      if (!ok) {
        mainLog.warn(`[shortcuts] failed to register ${action}: ${accel}`)
        shortcutFailures.push({ action, accel })
      } else {
        claimedBy.set(accel, action)
      }
    } catch (e) {
      mainLog.warn(`[shortcuts] invalid accelerator for ${action}: ${accel}`, e)
      shortcutFailures.push({ action, accel })
    }
  }
}

let notifTimer: ReturnType<typeof setInterval> | null = null
let notifPrevPollMs = 0 // wall time of the previous notifier poll — used for edge-trigger logic

// Long-lived background intervals (Dust token refresh, license heartbeat, brain reconcile, retention
// sweep) each do network/DNS or disk work on a timer. If one fires exactly as the process is torn down
// — an OS quit, or an abrupt kill of a dev/driven instance — a resolve-in-flight can trip a SIGTRAP on
// a blocking-pool thread (the shutdown-race crash class). Tracked here so will-quit cancels them ALL
// before the rest of teardown, closing that race for good.
const backgroundTimers: ReturnType<typeof setInterval>[] = []
const trackTimer = (t: ReturnType<typeof setInterval>): ReturnType<typeof setInterval> => {
  backgroundTimers.push(t)
  return t
}
const notifiedKeys = new Set<string>() // keys of events already notified this session

// Cache today's agenda (~30s) so startMeetingNotifier can cross-reference upcoming events against real
// calendar data without hammering Graph on every 30s poll.
let calendarCache: { events: CalendarEvent[]; ts: number } | null = null
const CALENDAR_CACHE_TTL_MS = 30_000

/**
 * Native notification scheduler: fires a system notification ~1 minute before each calendar event.
 * Polls every 30 s using the existing calendarCache (no extra Graph call when cache is warm).
 * Gated on the meetingNotifications setting; silently no-ops when notifications aren't supported.
 */
function startMeetingNotifier(): void {
  if (notifTimer) return
  notifTimer = setInterval(async () => {
    try {
      if (!getSettings().meetingNotifications) return
      if (!Notification.isSupported()) return

      // Resolve today's events from the warm cache or a fresh Outlook fetch.
      let events: CalendarEvent[] = []
      if (calendarCache && Date.now() - calendarCache.ts <= CALENDAR_CACHE_TTL_MS) {
        events = calendarCache.events
      } else if (requireAuth()) {
        let tz = 'UTC'
        try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { /* keep UTC */ }
        const res = await calendarToday(tz)
        if (res.ok && res.events) {
          calendarCache = { events: res.events, ts: Date.now() }
          events = res.events
        }
      }

      const now = Date.now()
      // Snapshot and advance the previous-poll timestamp for the edge-trigger calculation below.
      const prevPollMs = notifPrevPollMs
      notifPrevPollMs = now
      for (const ev of events) {
        if (!ev.start) continue
        const startMs = Date.parse(ev.start)
        if (isNaN(startMs)) continue
        // Edge-trigger: fire on the first poll where the 60 s mark has been crossed, regardless of
        // poll-interval jitter. The old "60–90 s window" would silently miss a notification when a
        // poll slipped past the 30 s interval (e.g. T=91 s then T=59 s skips the window entirely).
        const msUntil = startMs - now
        if (msUntil < -30_000) continue // event started > 30 s ago — too late to notify
        if (msUntil > 60_000) continue  // event is still > 60 s away — not yet due
        // prevPollMs=0 means this is the first poll ever; treat prevMsUntil as ∞ so we fire immediately
        // if an event is already within 60 s.
        const prevMsUntil = prevPollMs > 0 ? startMs - prevPollMs : Number.POSITIVE_INFINITY
        if (prevMsUntil <= 60_000) continue // threshold was already crossed at the previous poll
        const key = `${ev.subject}@${ev.start}`
        if (notifiedKeys.has(key)) continue
        notifiedKeys.add(key)
        try {
          // msUntil can be anywhere from -30s (event already started) to +60s here — "starts in 1 minute"
          // was hardcoded and wrong for the already-started/starting-now end of that range (most visible
          // right after launch, when the first poll fires immediately for any event already inside the
          // window). Phrase from the real remaining time instead of a fixed string.
          const body = msUntil <= 5_000 ? `${ev.subject} is starting now` : `${ev.subject} starts in 1 minute`
          new Notification({
            title: 'Meeting starting soon',
            body
          }).show()
        } catch {
          /* notifications may be blocked by the OS */
        }
      }
    } catch (e) {
      // calendarToday / Outlook fetch failure is transient (network, token expiry). Log a warning
      // rather than letting the rejection escape as an unhandledRejection → bogus crash audit.
      mainLog.warn('[meeting-notifier] tick failed:', e instanceof Error ? e.message : String(e))
    }
  }, 30_000)
  if (typeof notifTimer.unref === 'function') notifTimer.unref()
}

/** Builds the tray context menu template, reading shortcuts fresh from settings each call so the
 *  accelerator labels never go stale — see rebuildTrayMenu(). */
function buildTrayMenu(): Menu {
  const user = getSettings().shortcuts ?? {}
  const winKeys = process.platform === 'win32'
  const fmtAccel = (a: string): string =>
    !a ? '' : winKeys
      ? a.replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl').replace(/Command|Meta|Super/g, 'Win').replace(/Return/g, 'Enter')
      : a.replace(/CommandOrControl|CmdOrCtrl|Command|Meta/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥').replace(/Control/g, 'Ctrl').replace(/Return/g, '↵').replace(/\+/g, '')
  const label = (base: string, action: HotkeyAction): string => {
    const k = fmtAccel(resolveShortcut(action, user))
    return k ? `${base}  (${k})` : base
  }
  return Menu.buildFromTemplate([
    { label: label('Show / Hide', 'hide'), click: toggleVisible },
    { label: 'Settings…', click: () => {
      if (win && !win.isVisible()) win.show()
      sendHotkey('settings')
    } },
    { label: label('Listen / Stop listening', 'toggle-listen'), click: () => sendHotkey('toggle-listen') },
    { label: "Today's agenda", click: () => {
      if (win && !win.isVisible()) win.show()
      sendHotkey('agenda')
    } },
    { label: label('New', 'reset'), click: () => sendHotkey('reset') },
    { type: 'separator' },
    { label: 'Quit Métis', click: () => app.quit() }
  ])
}

function createTray(): void {
  try {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../build/icon.png')
    let img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) img = img.resize({ width: 18, height: 18 })
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    if (process.platform === 'darwin' && img.isEmpty()) tray.setTitle(' ◉ Métis')
    tray.setToolTip('Métis')
    tray.setContextMenu(buildTrayMenu())
  } catch {
    /* tray optional */
  }
}

/** Rebuild the tray's context menu after a shortcut rebind. createTray() only builds the menu once at
 *  boot (accelerator strings baked in from settings read at that moment); without this, the tray keeps
 *  showing stale accelerators for the rest of the process life after settingsSet's registerShortcuts()
 *  re-registers the new bindings. No-op if the tray was never created (optional feature). */
function rebuildTrayMenu(): void {
  if (!tray) return
  try {
    tray.setContextMenu(buildTrayMenu())
  } catch {
    /* tray optional */
  }
}

// macOS App Nap (and equivalent OS-level suspension elsewhere) can throttle a minimized/occluded window's
// process the same way it throttles any backgrounded app — independent of Electron's own
// `backgroundThrottling` flag, which only covers Blink's internal timer/rAF throttling. If the renderer's
// transcription worker gets deprioritized mid-meeting, the audio queue backs up and oldest windows are
// silently dropped (see MAX_QUEUE in listen.ts), which reads as "the transcript stopped." Holding a
// power-save blocker for the duration of a meeting keeps the process at normal priority regardless of
// window visibility. Module-level id: only one meeting can be active at a time.
let recordingPowerSaveBlockerId: number | null = null
// Guards the before-quit meeting-flush handler below from re-entering when it re-issues app.quit()
// itself, and lets the IPC.windowQuit handler (whose caller, App.tsx's quitApp(), already AWAITS a
// flush before invoking it) skip the redundant flush-and-wait entirely.
let quitFlushDone = false
function setRecordingPowerSaveBlock(on: boolean): void {
  if (on) {
    if (recordingPowerSaveBlockerId === null || !powerSaveBlocker.isStarted(recordingPowerSaveBlockerId)) {
      recordingPowerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
  } else if (recordingPowerSaveBlockerId !== null) {
    if (powerSaveBlocker.isStarted(recordingPowerSaveBlockerId)) powerSaveBlocker.stop(recordingPowerSaveBlockerId)
    recordingPowerSaveBlockerId = null
  }
}

/** Updates the tray/menubar to reflect whether recording is active. */
function setTrayRecording(on: boolean): void {
  if (!tray) return
  if (on) {
    tray.setToolTip('🔴 Métis — Recording')
    if (process.platform === 'darwin') tray.setTitle(' 🔴 Métis')
  } else {
    tray.setToolTip('Métis')
    if (process.platform === 'darwin') tray.setTitle(' ◉ Métis')
  }
}

/**
 * Speaker Intelligence (Phases A/B) — best-effort backfill of resolved human names onto a saved
 * meeting's transcript lines, from the Microsoft Teams transcript of the SAME online meeting (when one
 * exists — see graph-transcript.ts's own doc comment for the tenant prerequisites). Runs fire-and-forget
 * right after a live meeting's normal save (IPC.saveTranscript below), and is also reachable directly via
 * recall:backfillSpeakers so a past meeting can be retried manually from Review — the Teams transcript
 * can take a few minutes to finish processing after the meeting itself ends, so the very first attempt
 * often legitimately finds nothing yet.
 *
 * Every failure path degrades to a quiet, non-throwing result: a missing Graph permission, a meeting with
 * no Teams transcript, no text/time overlap, or being signed out must never surface as an error to the
 * user or touch the saved file. `named: 0` is a normal outcome, not a failure.
 */
async function backfillSpeakerNames(file: string): Promise<{ ok: boolean; named?: number; error?: string }> {
  if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
  try {
    const settings = getSettings()
    const safeName = basename(file)
    const read = await recallRead(safeName)
    if (!read.ok || !read.lines) return { ok: false, error: read.error || 'Meeting file not found.' }
    if (!read.startedAt) return { ok: false, error: 'This meeting has no recorded start time.' }

    const endedAt = read.lines.length ? read.lines[read.lines.length - 1].t : read.startedAt
    const fetched = await fetchTeamsTranscriptForMeeting({ startedAt: read.startedAt, endedAt })
    if (!fetched) return { ok: true, named: 0 } // no Teams transcript available yet — quiet no-op

    const operatorName = authStatus().name
    const { lines, named } = applySpeakerNames(read.lines, fetched.entries, { operatorName })
    if (named === 0) return { ok: true, named: 0 }

    const result = await updateMeetingTranscript(settings, safeName, lines)
    if (!result.ok) return { ok: false, error: result.error }

    auditLog('transcript.speakers_backfilled', { named })
    // Re-run extraction now that the saved transcript names real speakers — the brain prompt already
    // attributes commitments to "you"/"them"/a name when the speaker is clear (see shared/brain.ts).
    await enqueueIngest(join(resolveMeetingsFolder(settings), safeName), { force: true })
    return { ok: true, named }
  } catch (e) {
    mainLog.warn('[speaker-backfill] failed:', e instanceof Error ? e.message : String(e))
    return { ok: false, error: 'Could not backfill speaker names.' }
  }
}

/** Snapshot of the getSettings()-derived values that drive live side effects OUTSIDE settingsSet (window
 *  content protection, global shortcuts, tray labels). getSettings() already refreshes live from
 *  managed-config.json via its own mtime cache (store.ts), but nothing re-ran those side effects when only
 *  the managed file changed — an admin edit never reached the running window until an unrelated
 *  settingsSet call or a restart. Compared on every settingsGet (see below) so it does. */
function managedEffectsSnapshot(): string {
  const s = getSettings()
  return JSON.stringify({ contentProtection: s.contentProtection, shortcuts: s.shortcuts })
}

/** Best-effort, idempotent cleanup: delete any lingering CLEARTEXT knowledge-graph artifacts whenever
 *  at-rest encryption is effectively ON. Exists because a managed-config/admin `encryptTranscripts:true`
 *  never goes through settingsSet (it's picked up live by getSettings()'s mtime cache, and a locked key
 *  is dropped from every settingsSet patch besides), so the settingsSet-time purge below never fires for
 *  it — graph.json/graph.html would otherwise linger forever, undeletable in-app, defeating the org
 *  encryption guarantee. Safe to call on every settingsGet poll and at boot: graphHtml() is a single
 *  existsSync, and purgeGraphArtifacts() itself no-ops once the files are gone. */
function purgeGraphIfEncryptedAndStale(reason: string): void {
  if (getSettings().encryptTranscripts && graphHtml()) {
    purgeGraphArtifacts()
    auditLog('graph.purged', { reason })
  }
}
let lastAppliedManagedSnapshot: string | null = null

function registerIpc(): void {
  // --- Settings & permissions ---
  ipcMain.handle(IPC.settingsGet, (e) => {
    assertMainWindow(e)
    const s = publicSettings()
    // Re-apply the live side effects of a managed-config change (content protection / shortcuts / tray)
    // if the relevant values drifted since we last applied them — but only then, so a plain settings poll
    // (this handler runs on every renderer settings fetch) stays a cheap no-op. `null` means "just booted,
    // createWindow/registerShortcuts already applied the current values" — establish the baseline without
    // re-running them.
    const managedSnap = managedEffectsSnapshot()
    if (lastAppliedManagedSnapshot !== null && managedSnap !== lastAppliedManagedSnapshot) {
      win?.setContentProtection(contentProtectionOn())
      syncIntelContentProtection() // keep the dashboard window's Private View in lockstep with the overlay
      registerShortcuts()
      rebuildTrayMenu()
    }
    lastAppliedManagedSnapshot = managedSnap
    // Close the managed-config gap described above — runs on every poll, not just on detected drift,
    // so it also catches encryption enabled at boot with a stale plaintext graph already on disk.
    purgeGraphIfEncryptedAndStale('encryption-active')
    // Auth is enforced and this caller isn't signed in: don't hard-fail (the renderer needs settings to
    // render the SignInWall itself), but redact PII an unauthenticated renderer/DevTools caller has no
    // business reading — the resume/job-description/notes profile fields and any imported per-mode
    // reference documents (contextDocs), which can contain arbitrary pasted personal/meeting content.
    if (!requireAuth()) {
      return {
        ...s,
        profile: { ...s.profile, resume: '', jobDescription: '', notes: '' },
        contextDocs: {}
      }
    }
    return s
  })
  ipcMain.handle(IPC.permissionsGet, (e) => {
    assertMainWindow(e)
    return getPlatformPermissions()
  })
  // A failed globalShortcut.register() (combo already held by another app, or OS-reserved) previously
  // only reached mainLog — end users never see that. The renderer can poll this after registerShortcuts()
  // runs (boot, and every settings save) to show the user which binding(s) didn't take.
  ipcMain.handle(IPC.shortcutFailures, (e) => {
    assertMainWindow(e)
    return shortcutFailures
  })
  // Deep-link to the relevant macOS Privacy pane once a permission has been denied — getUserMedia never
  // re-prompts after a Deny, so without this a denied user has no in-app path back to granting it. The
  // x-apple.systempreferences scheme only exists on macOS; a no-op elsewhere.
  ipcMain.handle(IPC.permissionsOpenSettings, (e, kind: unknown) => {
    assertMainWindow(e)
    if (process.platform === 'darwin') {
      const pane = kind === 'screenRecording' ? 'Privacy_ScreenCapture' : 'Privacy_Microphone'
      void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
      return
    }
    if (process.platform === 'win32') {
      // Windows has no single TCC-style "Screen Recording" permission like macOS; the closest deep link
      // is the App graphics capture privacy page (added in the Windows 10 2004 update). Picked over the
      // generic 'ms-settings:privacy' page because it's the actual per-capability toggle; on Windows
      // builds that predate it, an unrecognized ms-settings URI opens the Settings home instead of
      // erroring, so no separate fallback URI is needed here.
      const uri = kind === 'screenRecording' ? 'ms-settings:privacy-graphicscaptureprogrammatic' : 'ms-settings:privacy-microphone'
      void shell.openExternal(uri)
    }
  })
  // Front-load the OS permission prompts during onboarding (macOS only) so the first real meeting
  // isn't interrupted by them. Serial, and only for permissions not yet granted: mic has a direct
  // prompt API; Screen Recording has none, but a 1px desktopCapturer probe registers the app with
  // TCC and raises the system prompt. Accessibility is deliberately NOT requested — nothing in the
  // app needs it since meeting-detect was removed, and an unexplained Accessibility prompt is
  // exactly the kind of thing enterprise IT flags. Never re-prompts after an explicit Deny (macOS
  // suppresses those anyway); the checklist's "Open System Settings" link stays the recovery path.
  ipcMain.handle(IPC.permissionsRequestUpfront, async (e) => {
    assertMainWindow(e)
    if (process.platform === 'darwin') {
      if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
        await systemPreferences.askForMediaAccess('microphone').catch(() => false)
      }
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        await probeScreenCapture()
      }
    }
    if (process.platform === 'win32') {
      // Windows used to fall straight through to a bare status read, so onboarding "front-loads the
      // permission prompts" was a macOS-only promise and a Windows user's first screenshot ask was the
      // first time anyone discovered capture was blocked. The probe raises no prompt here — it just
      // establishes the truth while the user is still in setup, where the checklist can act on it.
      // Mic cannot be prompted from main on Windows (askForMediaAccess is macOS-only); the renderer's
      // getUserMedia call is what raises that prompt, so this only reports what the OS already knows.
      await probeScreenCapture()
    }
    return getPlatformPermissions()
  })

  ipcMain.handle(IPC.settingsSet, async (e, patch) => {
    assertMainWindow(e)
    // Trust boundary is main, not the renderer's SignInWall — block the mutation for an unauthenticated
    // caller (DevTools/compromised renderer) when auth is enforced. Return the current (unchanged)
    // settings so the shape matches the normal success return exactly; nothing is persisted.
    if (!requireAuth()) return publicSettings()
    const p = patch ?? {}
    // License STATE is server-authoritative: only main's activateLicense/heartbeat (license.ts) may
    // write it. Without this strip, any renderer code could self-issue an unlimited license with a
    // plain settings patch ({licenseValid:true, licenseSeatCap:999999}) and defeat the gate once it's
    // wired. licenseServerUrl + licenseGateEnabled stay writable — those are genuine user inputs.
    for (const k of ['licenseKey', 'licenseCompanyName', 'licenseSeatCap', 'licenseExpiresAt', 'licenseValid', 'licenseLastValidatedAt']) {
      if (k in p) delete (p as Record<string, unknown>)[k]
    }
    const cur = getSettings()
    const wasEncrypted = cur.encryptTranscripts
    // Task MI-5 consent gate: turning publishBrainPages ON while transcripts stay encrypted writes
    // readable meeting intelligence outside the encryption boundary — require an explicit, unmissable
    // confirmation before it takes effect, the same native-dialog-before-mutation pattern recallDelete
    // uses ("Confirmed with a native, unmissable modal BEFORE deleting"). Declining silently drops just
    // that one key from the patch; every other setting in the same patch still saves normally.
    const willEncrypt = 'encryptTranscripts' in p ? !!p.encryptTranscripts : wasEncrypted
    let publishConsentAsked = false
    if ('publishBrainPages' in p && p.publishBrainPages && !cur.publishBrainPages && willEncrypt) {
      const dialogOpts = {
        type: 'warning' as const,
        title: 'Publish meeting intelligence?',
        message: 'This publishes readable meeting intelligence to your OneDrive folder.',
        detail:
          'Plain-text account/people/deal pages and meeting note cards will be written to your meetings folder (wiki/) so Dust and other tools can read them, even though transcript encryption stays on. Meetings flagged confidential are excluded.',
        buttons: ['Publish', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      }
      const { response } = win ? await dialog.showMessageBox(win, dialogOpts) : await dialog.showMessageBox(dialogOpts)
      const granted = response === 0
      auditLog('brain.publish.consent', { granted })
      if (!granted) delete (p as Record<string, unknown>).publishBrainPages
      publishConsentAsked = true
    }
    // MQA-070: the same end state — readable meeting intelligence sitting outside the encryption boundary —
    // is reachable from the OTHER direction: publishing already on, encryption turned on afterwards. The
    // gate above justifies its modal by that STATE, not by which toggle happened to arrive last, yet only
    // one of the two edges into it was gated, so this one flipped silently while the Privacy copy started
    // promising "contents stay locked to this device" over a folder that still holds a plaintext wiki/ —
    // and keeps regenerating it on every later merge. Declining drops only encryptTranscripts: nothing is
    // deleted (the wiki was written under its own explicit consent and stays the user's, per the QA #9
    // no-side-effect rule), and the rest of the patch still saves. Suppressed when the gate above already
    // asked about this exact combination in the same patch — one decision, not two modals.
    const willPublish = 'publishBrainPages' in p ? !!p.publishBrainPages : cur.publishBrainPages
    if (!publishConsentAsked && 'encryptTranscripts' in p && p.encryptTranscripts && !wasEncrypted && willPublish) {
      const dialogOpts = {
        type: 'warning' as const,
        title: 'Keep publishing meeting intelligence?',
        message: 'Encrypting transcripts does not encrypt your published wiki.',
        detail:
          'Publish meeting intelligence is on, so plain-text account/people/deal pages and meeting note cards stay in your meetings folder (wiki/) and keep being rewritten there in plain text after every new meeting — outside the at-rest encryption you are turning on. Meetings flagged confidential are excluded. Cancel to leave encryption off, or turn publishing off first.',
        buttons: ['Turn on encryption', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      }
      const { response } = win ? await dialog.showMessageBox(win, dialogOpts) : await dialog.showMessageBox(dialogOpts)
      const granted = response === 0
      auditLog('brain.publish.consent', { granted, at: 'encryption-enabled' })
      if (!granted) delete (p as Record<string, unknown>).encryptTranscripts
    }
    const next = setSettings(p)
    auditLog('settings.changed', { keys: Object.keys(p) })
    // Flipping follow-up memory is itself a conversation boundary. Without this, turning it ON would
    // retroactively inherit the Q&A recorded — and the Dust conversation created — while the user was
    // being told each question "starts completely fresh" (review finding, 2026-08-04). Zeroing the idle
    // clock makes the gate's staleness check trip on the very next plain ask, clearing both carriers;
    // the renderer clears its own history refs on the same transition (App.tsx effect).
    if ('askFollowUpMemory' in p && next.askFollowUpMemory !== cur.askFollowUpMemory) {
      resetDustConversation()
      lastPlainAskAt = 0
    }
    // Start/stop background screen pre-analysis to match the new settings (backgroundScreenContext toggle,
    // or Local AI being enabled/disabled/provisioned) — takes effect immediately, no relaunch.
    refreshScreenPreprocess()
    // At-rest encryption just turned on → purge any previously-built CLEARTEXT knowledge graph so it
    // can't leak meeting topics/entities the encryption is meant to protect. (Builds are already
    // blocked while encryption is on, so no graph will be regenerated until it's turned back off.)
    if (!wasEncrypted && next.encryptTranscripts) {
      purgeGraphArtifacts()
      auditLog('graph.purged', { reason: 'encryption-enabled' })
    }
    // publishBrainPages turned off → the wiki mirror is derived-never-canonical, so delete it outright
    // (audit-logged). Turned on → materialize it right away instead of waiting for the next meeting/merge.
    if (cur.publishBrainPages && !next.publishBrainPages) {
      const r = removeWiki(next)
      auditLog('brain.publish.disabled', { ok: r.ok })
    } else if ('publishBrainPages' in p && next.publishBrainPages && !cur.publishBrainPages) {
      // Materialize the wiki ONLY when the user EXPLICITLY turned publishing on in THIS patch (it has
      // already passed the consent gate above). Never fire on a derived/side-effect flip of the value
      // caused by an unrelated setting change — that was the silent-publish path in QA #9.
      // Deliberately not awaited (a full regen must not hold up the settings save), but the rejection is
      // observed: escaping as an unhandledRejection writes a crash-*.log + an app.crash audit line for a
      // failed publish that never crashed anything (MQA-075, same shape as recallSetConfidential).
      void publishAll(next).catch((error) =>
        mainLog.error(`[publish] initial wiki build failed: ${error instanceof Error ? error.message : String(error)}`)
      )
    }
    win?.setContentProtection(contentProtectionOn())
    syncIntelContentProtection() // keep the dashboard window's Private View in lockstep with the overlay
    // Only reconfigure the OS login item when that setting actually changed. Calling it on every
    // unrelated save is wasteful and, on unsigned/dev builds, logs a noisy "Operation not permitted".
    if ('launchAtLogin' in p) {
      try {
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
      } catch {
        /* not supported on this platform */
      }
    }
    // Shortcuts may have changed — re-register from the new settings, then rebuild the tray menu so its
    // accelerator labels reflect the new bindings instead of the ones baked in at createTray() boot time.
    registerShortcuts()
    rebuildTrayMenu()
    return publicSettings()
  })

  // Explicit recovery for an existing file-backend profile whose key is still wrapped by a Keychain
  // this build cannot unlock. The native confirmation is deliberately before any filesystem mutation;
  // archiveEncryptedProfile() moves the encrypted files into a hidden, reversible recovery folder.
  ipcMain.handle(IPC.settingsRecoverProfile, async (e) => {
    assertMainWindow(e)
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Create a new local profile?',
      message: 'Métis cannot unlock your existing encrypted profile.',
      detail:
        'Métis will preserve the existing encrypted settings, API keys, and sign-in cache in a hidden recovery folder inside its data folder, then start a fresh local profile. Nothing is deleted. Restore Keychain access later and the archived files can be put back to recover the old profile.',
      buttons: ['Create new local profile', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = win
      ? await dialog.showMessageBox(win, dialogOpts)
      : await dialog.showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, canceled: true }
    try {
      const archive = archiveEncryptedProfile()
      auditLog('settings.profile_recovered', { movedFiles: archive.files.length })
      return {
        ok: true,
        backupName: archive.backupDir.split(/[\\/]/).pop(),
        movedFiles: archive.files.length
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not create a recovery archive.'
      }
    }
  })

  // --- Licensing (phone-home activation; see main/license.ts) ---
  ipcMain.handle(IPC.licenseActivate, async (e, payload: unknown) => {
    assertMainWindow(e)
    // No requireAuth() here on purpose: license enforcement outranks SSO (see the boot-gate ordering in
    // App.tsx). If activation required a signed-in session, a device blocked by the license gate could
    // never activate before reaching the SSO screen — a sign-in-to-activate / activate-to-sign-in
    // deadlock. The license key itself is the credential being checked; there's nothing an SSO session
    // would additionally protect here.
    const parsed = LicenseActivatePayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    // Anti-self-licensing: when an enterprise pins licenseServerUrl via managed-config (locks the key),
    // ignore any renderer-supplied URL and activate ONLY against the pinned server. Otherwise a customer
    // could point activation at a fake localhost server that always returns ok:true and self-license.
    // With the key unlocked (the default / single-operator case) the supplied URL is used as before.
    const urlLocked = getLockedKeys().includes('licenseServerUrl')
    const serverUrl = urlLocked ? getSettings().licenseServerUrl || parsed.data.serverUrl : parsed.data.serverUrl
    return activateLicense(serverUrl, parsed.data.licenseKey)
  })
  // Read-only, local settings only — never touches the network. Mirrors metricsRead's pattern of
  // returning a safe empty/default shape (rather than throwing) when signed out.
  ipcMain.handle(IPC.licenseStatus, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) {
      return {
        licenseServerUrl: '',
        licenseCompanyName: '',
        licenseSeatCap: 0,
        licenseExpiresAt: null,
        licenseValid: false,
        licenseLastValidatedAt: 0,
        licenseGateEnabled: false
      }
    }
    const s = getSettings()
    return {
      licenseServerUrl: s.licenseServerUrl,
      licenseCompanyName: s.licenseCompanyName,
      licenseSeatCap: s.licenseSeatCap,
      licenseExpiresAt: s.licenseExpiresAt,
      licenseValid: s.licenseValid,
      licenseLastValidatedAt: s.licenseLastValidatedAt,
      licenseGateEnabled: s.licenseGateEnabled
    }
  })
  // Startup-gate verdict for App.tsx's <LicenseGate/>. Deliberately NOT behind requireAuth(): this is
  // the check that decides whether the app runs at all, so it must be reachable even before an SSO
  // sign-in — otherwise a revoked/unlicensed customer would be stuck behind (or burn) an SSO round trip
  // before ever learning why they're blocked. Nothing here is sensitive beyond gateEnabled/allowed/reason.
  ipcMain.handle(IPC.licenseGate, (e) => {
    assertMainWindow(e)
    const verdict = checkLicenseGrace()
    return { gateEnabled: getSettings().licenseGateEnabled, ...verdict }
  })

  // --- Provider API keys ---
  ipcMain.handle(IPC.setApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    // Trust boundary is main, not the renderer — block persisting an attacker-supplied credential for an
    // unauthenticated caller when auth is enforced. Return the current (unchanged) hasKeys map so the
    // shape matches the normal success return exactly; no key is written.
    if (!requireAuth()) return { hasKeys: hasKeysMap() }
    const parsed = SetApiKeyPayloadSchema.parse(payload)
    setApiKey(parsed.provider, parsed.key)
    // MQA-003/MQA-004: the recorded "this key is broken" verdict was about the OLD credential. Clearing
    // it here is what makes pasting a working key feel like it fixed the problem immediately, instead of
    // the provider staying demoted and flagged until the cooldown happened to expire.
    resetProviderHealth(parsed.provider)
    // setApiKey() silently treats an empty/whitespace key as "clear the saved key" (store.ts) — audit the
    // actual effect, not just the channel name, so a credential removal is never mislabeled as a set.
    auditLog(parsed.key.trim() ? 'key.set' : 'key.removed', { provider: parsed.provider })
    return { hasKeys: hasKeysMap() }
  })

  ipcMain.handle(IPC.clearApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { hasKeys: hasKeysMap() }
    const parsed = ClearApiKeyPayloadSchema.parse(payload)
    clearApiKey(parsed.provider)
    resetProviderHealth(parsed.provider) // same reason as setApiKey above

    auditLog('key.removed', { provider: parsed.provider })
    return { hasKeys: hasKeysMap() }
  })

  ipcMain.handle(IPC.testApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    // testApiKey() makes an outbound HTTP call to the target provider (SSRF-class surface for an
    // unauthenticated caller when the provider/base URL is attacker-controlled) — gate it like every
    // other privileged handler.
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = TestApiKeyPayloadSchema.parse(payload)
    return testApiKey(parsed.provider, parsed.key)
  })

  // --- Dust integration ---
  ipcMain.handle(IPC.dustListAgents, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    // A transient network blip (the raw "Unexpected network error from DustAPI: TypeError: fetch failed"
    // the user hit while connected) must not surface as a dead end — retry a few times with backoff first.
    let r = await listDustAgents()
    for (let i = 0; !r.ok && isTransient(r.error) && i < 3; i++) {
      await new Promise((res) => setTimeout(res, nextBackoff(i)))
      r = await listDustAgents()
    }
    if (r.ok) return r
    // On-401 self-heal: the Dust CLI OAuth token lasts ~1h; refresh it once and retry so the picker
    // doesn't just go empty when the token lapses between sessions.
    if (isDustAuthError(r.error)) {
      const s = await refreshDustCliSession()
      if (!s.ok || !s.token || !s.workspaceId) return r
      setApiKey('dust', s.token)
      setSettings({ dustWorkspaceId: s.workspaceId, dustBaseUrl: s.baseUrl || 'https://dust.tt', dustTokenMintedAt: Date.now() })
      return await listDustAgents()
    }
    // Still unreachable after retries → a clean, actionable message instead of the raw fetch error.
    if (isTransient(r.error)) return { ok: false, error: 'Could not reach Dust. Check your connection and try again.' }
    return r
  })

  // Connect to Dust locally by importing the Dust CLI's keychain session (token + workspace + region).
  // refreshDustCliSession first runs `dust status` so the CLI mints a fresh access token before we read
  // it — without this, a reconnect after the ~1h OAuth token expires imports the stale token (import
  // "succeeds" but every agent call then 401s). Refresh is cheap when the token is still valid.
  ipcMain.handle(IPC.dustImportCli, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const s = await refreshDustCliSession()
    if (!s.ok || !s.token || !s.workspaceId) return { ok: false, error: s.error, accessDenied: s.accessDenied, incomplete: s.incomplete }
    setApiKey('dust', s.token)
    setSettings({ dustWorkspaceId: s.workspaceId, dustBaseUrl: s.baseUrl || 'https://dust.tt', dustTokenMintedAt: Date.now() })
    return { ok: true, workspaceId: s.workspaceId, baseUrl: s.baseUrl }
  })

  // Read-only session probe for the Settings-open live check. CRITICALLY this does NOT call
  // refreshDustCliSession: that runs `dust status`, which rotates the single-use OAuth token, and firing
  // it on mount races the concurrent agent-list load onto a token the rotation just invalidated (a 401
  // cascade). importDustCliSession only READS the keychain — no rotation, no persist — and returns
  // booleans only (the token never crosses to the renderer). A present-but-expired token reports ok:true
  // (it is refreshable on the ask/list path); only a genuinely absent session reports ok:false.
  ipcMain.handle(IPC.dustProbeSession, async (e) => {
    assertMainWindow(e)
    const s = await importDustCliSession()
    return { ok: s.ok, accessDenied: s.accessDenied, incomplete: s.incomplete }
  })

  // No CLI session yet → kick off the install + interactive login for the user (opens a Terminal window).
  // Then poll the keychain until the login lands and import it automatically — one login, zero extra
  // clicks: without this the user had to come back and press "Connect from Dust CLI" a second time.
  let dustSetupPoll: ReturnType<typeof setInterval> | null = null
  let dustSetupPollInFlight = false
  ipcMain.handle(IPC.dustSetupCli, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const r = await setupDustCli()
    // Poll the OS secret store until `dust login` lands, then auto-import — cross-platform now that the
    // read (importDustCliSession → dust-secret-store) works on every OS.
    if (r.ok) {
      if (dustSetupPoll) clearInterval(dustSetupPoll)
      const startedAt = Date.now()
      dustSetupPoll = setInterval(() => {
        if (Date.now() - startedAt > 5 * 60 * 1000) {
          if (dustSetupPoll) clearInterval(dustSetupPoll)
          dustSetupPoll = null
          // Silent give-up was undiagnosable — this is the only signal that the user never finished
          // `dust login` (or got stuck on its separate workspace-picker step) within the 5-minute window.
          auditLog('dust.setup.timeout')
          return
        }
        if (dustSetupPollInFlight) return
        dustSetupPollInFlight = true
        void importDustCliSession().then((s) => {
          if (!s.ok || !s.token || !s.workspaceId) return
          if (dustSetupPoll) clearInterval(dustSetupPoll)
          dustSetupPoll = null
          setApiKey('dust', s.token)
          setSettings({
            dustWorkspaceId: s.workspaceId,
            dustBaseUrl: s.baseUrl || 'https://dust.tt',
            dustTokenMintedAt: Date.now()
          })
          auditLog('dust.token.refreshed', { at: 'setup-autoimport' })
          if (Notification.isSupported()) {
            new Notification({
              title: 'Dust connected',
              body: 'Métis is linked to your Dust workspace.'
            }).show()
          }
        }).finally(() => {
          dustSetupPollInFlight = false
        })
      }, 5000)
    }
    return r
  })

  // --- CLI providers (Claude Code / Codex / Gemini) ---
  // CLI provider detection/testing/setup (claude-cli, codex-cli).
  ipcMain.handle(IPC.cliDetect, (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    // Validate against the known provider enum (parse, don't blind-cast) — an unrecognized string falls
    // back to the default CLI provider instead of reaching detectCli() as a bogus id.
    const parsed = ProviderIdSchema.safeParse(provider)
    return detectCli(parsed.success ? parsed.data : 'claude-cli')
  })
  ipcMain.handle(IPC.cliTest, async (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsedProvider = ProviderIdSchema.safeParse(provider)
    const p = parsedProvider.success ? parsedProvider.data : 'claude-cli'
    const r = await testCli(p)
    if (r.ok) {
      const s = getSettings()
      setSettings({ cliConnected: { ...s.cliConnected, [p]: true } })
    }
    return r
  })
  ipcMain.handle(IPC.cliSetup, (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return setupCli(typeof provider === 'string' ? (provider as ProviderId) : 'claude-cli')
  })
  ipcMain.handle(IPC.cliInstall, (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = typeof provider === 'string' ? (provider as ProviderId) : 'claude-cli'
    return installCli(p, (line) => win?.webContents.send(IPC.cliInstallProgress, { provider: p, line }))
  })
  ipcMain.handle(IPC.cliLogin, (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return loginCli(typeof provider === 'string' ? (provider as ProviderId) : 'claude-cli')
  })

  // --- BidStack MCP / CRM push ---
  // BidStack 360° CRM — MCP push (Settings → CLI Integration card + Review's "Push to CRM").
  // Test connection: connects + authenticates + lists tools, persists NOTHING (mirrors BidStack's own
  // "Test endpoint" button). Lets the user verify before committing an endpoint/key to disk.
  ipcMain.handle(IPC.mcpCrmTestConnection, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpCrmTestConnectionPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    return connectBidstack(parsed.data.endpointUrl, parsed.data.apiKey)
  })

  // Save connection: re-verifies (never trust a stale/unverified endpoint+key) then persists the
  // endpoint to settings, the key to the BidStack secrets file, and the discovered tools for the picker.
  ipcMain.handle(IPC.mcpCrmSaveConnection, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpCrmSaveConnectionPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const r = await connectBidstack(parsed.data.endpointUrl, parsed.data.apiKey)
    if (!r.ok) return r
    // MQA-064: bidstackSecrets.ts writes user-facing diagnostics for exactly this step ("Encryption is
    // unavailable on this machine…", "Métis can't write to its data folder…"), but they are THROWN. An
    // unhandled throw here rejects the renderer's invoke, and the Settings card has no catch — it sits on
    // "saving" with the deliberately-authored message never reaching the user. Route it through the
    // {ok,error} channel the card already renders, mirroring the provider-key save (Settings.tsx).
    try {
      setBidstackApiKey(parsed.data.apiKey)
      setSettings({
        bidstackEndpointUrl: parsed.data.endpointUrl.trim(),
        bidstackConnected: true,
        bidstackTools: r.tools ?? []
      })
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : 'Could not store the Polo Pre-Sales API key.' }
    }
    auditLog('bidstack.connected', { tools: (r.tools ?? []).length })
    return r
  })

  ipcMain.handle(IPC.mcpCrmDisconnect, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const keyRemoved = clearBidstackApiKey()
    setSettings({ bidstackConnected: false, bidstackTools: [] })
    auditLog('bidstack.disconnected', { keyFileRemoved: keyRemoved })
    // Don't falsely report a clean disconnect when the secret is still on disk — the connection is marked
    // off, but the user needs to know the key file survived so they can remove it manually.
    if (!keyRemoved)
      return { ok: false, error: 'Disconnected, but the stored BidStack key file could not be deleted — remove it manually.' }
    return { ok: true }
  })

  // Push: uses the already-saved endpoint + key. Never accepts an endpoint/key from the renderer here —
  // only a previously tested-and-saved connection can push, so a compromised renderer can't redirect the
  // push to an attacker-controlled MCP endpoint by passing arbitrary payload fields.
  ipcMain.handle(IPC.mcpCrmPush, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpCrmPushPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const s = getSettings()
    if (!s.bidstackConnected || !s.bidstackEndpointUrl || !hasBidstackApiKey()) {
      return { ok: false, error: 'Polo Pre-Sales is not connected. Set it up in Settings → Mantu Intelligence first.' }
    }
    // Only a tool the user actually saw and picked when the connection was tested/saved may be invoked —
    // otherwise a compromised or buggy renderer call could reach an unintended (possibly destructive) MCP
    // tool on the user's live CRM connection.
    if (!s.bidstackTools.includes(parsed.data.toolName)) {
      return { ok: false, error: 'Unknown Polo Pre-Sales tool.' }
    }
    const apiKey = getBidstackApiKey()
    const r = await pushToBidstack(s.bidstackEndpointUrl, apiKey, parsed.data.toolName, parsed.data.args)
    auditLog('bidstack.push', { tool: parsed.data.toolName, ok: r.ok })
    return r
  })

  // --- Auth ---
  ipcMain.handle(IPC.authStatus, (e) => {
    assertMainWindow(e)
    return authStatus()
  })
  ipcMain.handle(IPC.authSignIn, async (e) => {
    assertMainWindow(e)
    const status = await authSignIn()
    prewarmCapture() // warm the cold capture pipeline now that we're signed in (no-op if not authed)
    prewarmCli() // warm the CLI binary cache so the first CLI ask doesn't stall on a login-shell lookup
    refreshScreenPreprocess() // start background screen pre-analysis if eligible now that we're signed in
    return status
  })
  ipcMain.handle(IPC.authSignOut, async (e) => {
    assertMainWindow(e)
    await importJobs?.cancelAll()
    return authSignOut()
  })
  // --- Calendar ---
  ipcMain.handle(IPC.calendarToday, async (e, tz: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return calendarToday(typeof tz === 'string' ? tz : 'UTC')
  })

  // --- Recall (meeting history): read/delete ---
  // Recall read: load a saved meeting back for "Resume session" (decode + parse the markdown).
  ipcMain.handle(IPC.recallRead, async (e, file: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return recallRead(String(file ?? ''))
  })

  // Recall export: a user-initiated DECRYPTED markdown copy of ONE saved meeting, so an external tool —
  // Claude local ingesting it into the second brain, an email, an archive — can read it even when
  // at-rest encryption is on. Deliberately per-meeting and behind a native save dialog: never a bulk
  // decrypt, and the plaintext lands only where the user explicitly pointed. Audited.
  ipcMain.handle(IPC.recallExportPlain, async (e, file: unknown): Promise<RecallExportPlainResult> => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const safeName = basename(String(file ?? ''))
    // Same guard set as every recall.ts sibling: only meeting .md files, never the plaintext index/README.
    if (!safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
      return { ok: false, error: 'Not a saved meeting file.' }
    }
    try {
      const source = join(resolveMeetingsFolder(getSettings()), safeName)
      const text = readSavedFile(source) // decodes the ATKENC2 envelope when the file is encrypted
      // readSavedFile returns '' (never throws) when the envelope can't be decrypted on this device —
      // without this guard the export would "succeed" as a 0-byte file (adversarial review finding).
      if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }
      const dialogOpts = {
        title: 'Export meeting copy',
        defaultPath: join(app.getPath('downloads'), safeName),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const res = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts)
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true }
      writeFileSync(res.filePath, text, 'utf8')
      auditLog('recall.export', { file: safeName })
      return { ok: true, path: res.filePath }
    } catch (err) {
      // Sanitized like recall.ts's siblings — never the raw err.message (it can carry absolute paths).
      const code = (err as NodeJS.ErrnoException | null)?.code
      return { ok: false, error: code === 'ENOENT' ? 'Meeting file not found.' : 'Could not export the meeting file.' }
    }
  })

  // Recall delete: GDPR right-to-erasure for a saved meeting — removes the file + its index row.
  // Confirmed with a native, unmissable modal BEFORE deleting (sync — blocks until the user answers) so a
  // single click is unambiguous: no "did that register?" two-click pattern that's easy to misread as broken.
  ipcMain.handle(IPC.recallDelete, async (e, file: unknown, title: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const safeName = basename(String(file ?? ''))
    const label = typeof title === 'string' && title.trim() ? title.trim() : 'this meeting'
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete meeting',
      message: `Delete "${label}"?`,
      detail: 'This removes the saved transcript and notes from disk. This cannot be undone.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = win ? await dialog.showMessageBox(win, dialogOpts) : await dialog.showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const result = await deleteMeeting(safeName)
    if (result.ok) {
      auditLog('transcript.deleted', { file: safeName })
      await requestSourceRefresh(getSettings())
    }
    return result
  })

  // Recall rename: fix an auto-generated (recap-derived) title after the fact. Updates the frontmatter
  // `title:` value + the file's H1 in place — the file itself is never renamed, so index.md rows and
  // knowledge-graph links (both keyed by filename) stay valid. No confirm dialog: unlike delete, this is
  // trivially reversible (rename again). Not audit-logged: 'transcript.renamed' isn't in logger.ts's
  // AuditEvent union, and logger.ts is outside this feature's owned files.
  ipcMain.handle(IPC.recallRename, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = RenameMeetingPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid rename request.' }
    const result = await renameMeeting(getSettings(), parsed.data.file, parsed.data.title)
    if (result.ok) {
      auditLog('transcript.renamed', { file: basename(parsed.data.file) })
      await enqueueIngest(join(resolveMeetingsFolder(getSettings()), basename(parsed.data.file)), { force: true })
    }
    return result
  })

  // Recall update-recap: edit a saved meeting's recap ("## Notes & follow-ups") after the fact — fix a
  // mis-heard name, tick an action item, annotate. Rewrites only that section in place; frontmatter + the
  // full transcript are untouched, and the file is never renamed (mirrors recallRename's reasoning). No
  // confirm dialog: reversible by editing again. Audit-logged (metadata only — never the recap text) for
  // parity with 'transcript.renamed'.
  ipcMain.handle(IPC.recallUpdateRecap, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = UpdateRecapPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid edit request.' }
    const result = await updateMeetingRecap(getSettings(), parsed.data.file, parsed.data.recap)
    if (result.ok) {
      auditLog('transcript.recap_edited', { file: basename(parsed.data.file) })
      await enqueueIngest(join(resolveMeetingsFolder(getSettings()), basename(parsed.data.file)), { force: true })
    }
    return result
  })

  // Task MI-5: flag/unflag a saved meeting as confidential — excludes it from every published wiki
  // surface (note card, entity timelines/current-facts, indexes). Same guard pattern as
  // recallUpdateRecap; audit-logged. A full republish is the simplest correct way to make the exclusion
  // (or its reversal) take effect everywhere at once — cheap at this app's single-exec scale, and it's
  // the exact same idempotent full regen rebuildAll already relies on.
  ipcMain.handle(IPC.recallSetConfidential, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = SetConfidentialPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    const s = getSettings()
    const result = await setMeetingConfidential(s, parsed.data.file, parsed.data.confidential)
    if (result.ok) {
      auditLog('transcript.confidential_set', { file: basename(parsed.data.file), confidential: parsed.data.confidential })
      // MQA-075: the republish IS the enforcement — the wiki is static markdown, so until it regenerates
      // the meeting's title/TL;DR/decisions/deal facts are still on every published page. Fired detached
      // it could fail (a locked wiki file, an EPERM mkdir) while this handler had already returned ok, so
      // Review painted "excluded from published intelligence" over pages that still contain the meeting —
      // and the rejection escaped to the unhandledRejection handler, writing a crash log for a non-crash.
      // Await it and report the truth instead; the frontmatter write itself is already durable.
      try {
        await publishAll(s)
      } catch (error) {
        mainLog.error(`[confidential] republish failed: ${error instanceof Error ? error.message : String(error)}`)
        return {
          ok: false,
          error: 'Flag saved, but the published pages could not be updated — this meeting may still appear in your published wiki. Try again.'
        }
      }
    }
    return result
  })

  // Speaker Intelligence: manual (re)trigger of the Teams-transcript speaker-name backfill for a past
  // meeting — Review's automatic post-save attempt may have found nothing yet (the Teams transcript can
  // take a few minutes to finish processing after the meeting ends). Same guard pattern as the other
  // recall writes; the actual work is shared with the automatic post-save path (see backfillSpeakerNames).
  ipcMain.handle(IPC.recallBackfillSpeakers, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = RecallBackfillSpeakersPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    return backfillSpeakerNames(parsed.data.file)
  })

  // 90-Second Debrief (innovation #6): the user's off-record gut-read, appended to the saved meeting.
  // Same file → inherits encryption/retention/deletion, and the brain re-ingest below folds the unsaid
  // observations into signals on the next extraction pass.
  ipcMain.handle(IPC.debriefSave, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = raw as { file?: unknown; text?: unknown }
    const safeName = basename(String(p?.file ?? ''))
    const text = String(p?.text ?? '').slice(0, 8000)
    if (!safeName.endsWith('.md') || !text.trim()) return { ok: false, error: 'Nothing to save.' }
    const s = getSettings()
    const result = await appendDebrief(s, safeName, text)
    if (result.ok) {
      auditLog('transcript.debrief', { file: safeName })
      await enqueueIngest(join(resolveMeetingsFolder(s), safeName), { force: true }) // fold the unsaid layer into the brain
    }
    return result
  })

  // Commitment settlement — the human closes the loop the LLM never may (kept/broken are only ever
  // set here or by future CRM sync). Main-window only: it's a brain WRITE, unlike the read channels.
  ipcMain.handle(IPC.brainCommitmentSettle, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = raw as { deal?: unknown; text?: unknown; status?: unknown }
    const status = String(p?.status ?? '')
    if (!['open', 'kept', 'broken'].includes(status)) return { ok: false, error: 'Bad status.' }
    const deal = String(p?.deal ?? '')
    const text = String(p?.text ?? '')
    if (!deal || !text) return { ok: false, error: 'Missing commitment.' }
    // The renderer sends the deal's CURRENT display name, but a rename keeps the original id (see
    // applyRename: "`id` (the slug) never changes"), so slugifying the name here missed the file and every
    // promise on a renamed deal was permanently unsettleable. Resolve through the alias map exactly as
    // ingest does; it falls back to slugify(name) when there is no alias, so un-renamed deals are
    // unaffected (MQA-013).
    const s = getSettings()
    const r = await settleCommitment(s, resolveEntitySlug(readAliasMap(s), 'deal', deal), text, status as 'open' | 'kept' | 'broken')
    if (r.ok) {
      await markBrainChanged(getSettings())
      auditLog('brain.commitment.settled', { status })
    }
    return r
  })

  // Delete EVERYTHING: every saved meeting + the index + the knowledge graph. For a GDPR/CCPA erasure
  // request or a full account wipe — not the same as recallDelete's one-at-a-time flow. Extra-emphatic
  // confirm (shows the real count, defaults to Cancel) since this is the single most destructive action
  // in the app and cannot be undone.
  ipcMain.handle(IPC.recallDeleteAll, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const meetings = await listMeetings()
    if (meetings.length === 0) return { ok: true, deleted: 0 }
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete all Métis data',
      message: `Delete all ${meetings.length} saved meeting${meetings.length === 1 ? '' : 's'}?`,
      detail:
        'This permanently removes every saved transcript, note, and the knowledge graph from this device. This cannot be undone.',
      buttons: ['Delete everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = win ? await dialog.showMessageBox(win, dialogOpts) : await dialog.showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const result = await deleteAllMeetings()
    purgeGraphArtifacts() // legacy userData/graph artifacts
    const brainPurge = purgeBrain(getSettings()) // the `.brain/` knowledge store — entities, quotes, graph
    auditLog('transcript.deleted', {
      bulk: true,
      deleted: result.deleted,
      failed: result.failed.length,
      brainPurged: brainPurge.ok
    })
    return result
  })

  // --- Parakeet ASR engine ---
  // Parakeet (on-device, main-process). Whisper stays the renderer default; these only run when the user
  // selects the Parakeet engine. All wrapped so a failure degrades to Whisper rather than breaking Listen.
  ipcMain.handle(IPC.parakeetStatus, (e) => {
    assertMainWindow(e)
    // addonError surfaces WHY the engine isn't ready (native addon missing for this platform/build) as
    // distinct from "bundled model assets missing" — Settings reads this to show an actionable message.
    return { ready: parakeetModelReady(), addonError: parakeetAddonError() }
  })
  ipcMain.handle(IPC.parakeetEnsure, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false }
    try {
      await ensureParakeetModel((pct) => win?.webContents.send(IPC.parakeetProgress, { pct }))
      return { ok: parakeetModelReady() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.parakeetFeed, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const p = payload as { samples?: unknown; speaker?: unknown }
    if (!(p?.samples instanceof Float32Array)) return ''
    // Cap a single feed chunk generously above the renderer's real ~6s windows (WINDOW_SEC in listen.ts) at
    // 16kHz mono — every other renderer-supplied blob in this file is bounded the same way (debriefSave,
    // openMailDraft, McpCrmArgValueSchema); without this a malicious/malfunctioning renderer could force a
    // synchronous decode of an arbitrarily large buffer and hang or OOM the whole app.
    if (p.samples.length > 16_000 * 30) return ''
    const text = await parakeetTranscribe(p.samples)
    // Speaker Intelligence (SPEAKER-INTELLIGENCE-PLAN §3): label THEM windows with a voice-derived name
    // ("Jane Doe" from an enrolled profile, else a stable "Speaker N" session label). Same PCM buffer the
    // ASR just consumed — no extra capture. Strictly additive and best-effort: any failure or the feature
    // being off/unprovisioned attaches no name and the line renders exactly as before.
    if (text && p.speaker === 'them' && getSettings().speakerId.enabled) {
      try {
        const label = getSpeakerId().labelWindow(p.samples)
        if (label) return { text, name: label.name }
      } catch (err) {
        mainLog.warn('[speaker-id] labeling failed', err instanceof Error ? err.message : String(err))
      }
    }
    return { text }
  })

  // --- Apple Speech ASR engine (on-device via the mac-helper sidecar, opt-in, macOS only) ---
  // Mirrors the parakeet:feed handler exactly (same auth gate, same Float32 check, same cap, same
  // Speaker Intelligence ride-along) — appleSpeechTranscribe never throws (resolves '' on any failure),
  // so unlike parakeetTranscribe this needs no try/catch around the call itself.
  ipcMain.handle(IPC.appleSpeechFeed, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const p = payload as { samples?: unknown; speaker?: unknown }
    if (!(p?.samples instanceof Float32Array)) return ''
    // Same defensive cap as parakeetFeed — see its own comment for why.
    if (p.samples.length > 16_000 * 30) return ''
    // Spoken-language hint (Settings → Audio) pins the recognizer locale; 'auto' keeps system locale.
    const text = await appleSpeechTranscribe(p.samples, appleSpeechLocale(getSettings().asrLanguage))
    if (text && p.speaker === 'them' && getSettings().speakerId.enabled) {
      try {
        const label = getSpeakerId().labelWindow(p.samples)
        if (label) return { text, name: label.name }
      } catch (err) {
        mainLog.warn('[speaker-id] labeling failed', err instanceof Error ? err.message : String(err))
      }
    }
    return { text }
  })

  // --- Métis Local (on-device LLM): bundled-model readiness metadata ---
  // Paths stay in main; the renderer only learns whether the installer-owned files are ready.
  ipcMain.handle(IPC.localModelsList, (e) => {
    assertMainWindow(e)
    return listLocalModels()
  })

  // Live-meeting pre-warm (PLAN.md §4.4): a debounced transcript tail from the renderer's
  // instant-suggestions effect, fire-and-forget, so the sidecar's per-slot KV cache stays hot between
  // real suggest requests. Best-effort by design — NEVER throws to the renderer; a failed prewarm just
  // means the next real suggest pays full cost (same fallback local-runtime.ts's own prewarm() already
  // assumes). No audit event: this isn't a new lifecycle transition, and ensureLocalRuntimeStarted already
  // routes through local-runtime.ts's own start()/audit calls when it actually spins the sidecar up.
  ipcMain.handle(IPC.localPrewarm, (e, payload: unknown) => {
    assertMainWindow(e)
    const parsed = LocalPrewarmPayloadSchema.safeParse(payload)
    if (!parsed.success) return
    const s = getSettings()
    // publicSettings().providerReady is the same "can a cloud/CLI provider actually answer" test the ask
    // path uses — when it is false, local is what will serve the next suggest, so it is worth warming.
    if (!localPrewarmEligible(s, getAllowedProviders(), publicSettings().providerReady)) return
    // Warm the EXACT same [system, user] prefix a real suggest request sends (F4 hardening) — built by
    // the SAME helper (llm/prewarm.ts) a unit test cross-checks against buildSystem()/userText() directly,
    // so any future drift between the live suggest path and what prewarm warms fails a test.
    // prewarmLocal (llm/local.ts) is engine-aware: it warms whichever engine pickLocalEngine would give
    // the next real suggest — fm serve on macOS 27+ with Apple Intelligence live, llama-server otherwise.
    void prewarmLocal(s.localLlm.modelId, buildPrewarmMessages(parsed.data.text, s))
      .catch((err) => mainLog.warn('[local-prewarm] failed', err instanceof Error ? err.message : String(err)))
  })

  // --- Screen capture ---
  ipcMain.handle(IPC.captureScreen, async (event) => {
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    return getScreenshot()
  })
  // Pre-warm: prime the cache + spin up the OS capture pipeline so the next real vision ask is instant.
  ipcMain.handle(IPC.prewarmCapture, (e) => {
    assertMainWindow(e)
    prewarmCapture()
  })
  // Screen-ask fast-path: hand the renderer the freshest on-device screen description (or null). Non-null
  // lets askScreen skip the capture entirely and route a mode:'answer' ask that main grounds from its OWN
  // cache. The description text is re-derived by main at ask time — the renderer only learns it exists.
  ipcMain.handle(IPC.screenContext, (e): ScreenContextResult => {
    assertMainWindow(e)
    if (!requireAuth()) return null
    return screenPreprocess.currentFreshContext()
  })

  // --- Ask / LLM streaming ---
  // Fresh-question boundary state (declared at module scope, shared with IPC.listeningState /
  // IPC.askResetContext below). A plain typed/screen question OUTSIDE a live meeting must not inherit the
  // previous question's Q&A: prior answers rode along in TWO independent carriers — the renderer's history
  // array (replayed verbatim into the model's message list) and the server-side Dust conversation (reused
  // for up to 2h regardless of topic) — and clearing only one leaks through the other. Enforced at main's
  // single ask choke point so every renderer surface (typed ask, screen ask, fact-check) gets the same rule.
  ipcMain.handle(IPC.askStart, (e, raw) => {
    assertMainWindow(e)
    const id =
      raw && typeof raw === 'object' && 'id' in (raw as object)
        ? String((raw as { id: unknown }).id)
        : ''
    if (!requireAuth()) {
      win?.webContents.send(IPC.streamError, {
        id,
        message: 'Sign in with your Mantu account to use Métis.'
      })
      return
    }
    try {
    const req = AskStartSchema.parse(raw)
    const s = getSettings()
    // Fresh-question boundary (see the state block above): a plain interactive ask outside a live meeting
    // starts clean unless the user opted into follow-up memory — and even then the memory expires after
    // ASK_MEMORY_IDLE_MS of inactivity. Pinned/cascaded requests (agentOverride / providerOverride —
    // Spotlight Ref, follow-up drafting, recap cascades) and mid-meeting asks keep their deliberate
    // continuity; recap/suggest/summary modes never carried ad-hoc chat history to begin with.
    if (
      (req.mode === 'answer' || req.mode === 'vision') &&
      !req.agentOverride &&
      !req.providerOverride &&
      !listeningActive
    ) {
      if (!s.askFollowUpMemory || Date.now() - lastPlainAskAt > ASK_MEMORY_IDLE_MS) {
        req.history = []
        resetDustConversation()
      }
      lastPlainAskAt = Date.now()
    }
    // Local-first redaction (brief section I): strip high-confidence secrets from the captured transcript
    // before it leaves the device for a cloud model. Only the auto-captured transcript — never the user's
    // own typed prompt, and never the locally-saved meeting file (which keeps the verbatim original).
    if (s.redactSensitive && req.transcript) req.transcript = redactSecrets(req.transcript)
    // screenContext is a MAIN-ONLY field (like brainContext): never trust a value the renderer sent. Clear
    // it unconditionally after parse, then set it below strictly from main's own on-device screen cache.
    req.screenContext = undefined
    // req.redactPrompt is set by callers whose "prompt" is itself transcript-derived rather than user-typed
    // (e.g. fact-check's transcript-fallback ask, which stuffs the transcript tail into prompt when there's
    // no typed claim) — redact it the same way so a secret-shaped pattern in that fallback text isn't sent
    // to the provider. Typed-claim fact-check asks never set this flag, so normal prompts are untouched.
    if (s.redactSensitive && req.redactPrompt) req.prompt = redactSecrets(req.prompt)
    // Receipt Mode: ground a typed answer in the user's own past meetings. Match the brain against the
    // question (which already carries the live transcript tail via the renderer's withContext) and inject
    // the relevant, meeting-cited slice per-turn. Answer mode only — never the latency-critical spoken
    // suggest line or the screen-only vision turn. Best-effort: a brain read must never block an answer.
    // Excludes fact-check (mode:'answer', kind:'factcheck'): personas.ts strips GROUNDING_RAIL for it
    // (its contract is a VERDICT-only response), so injecting brainContext here would add citable
    // material with no citation/anti-fabrication guardrail attached — gate identically to the rail.
    if (req.mode === 'answer' && req.kind !== 'factcheck') {
      try {
        const hit = buildBrainContext(s, `${req.prompt}\n${req.transcript ?? ''}`)
        req.brainContext = hit.block || undefined
      } catch (err) {
        console.warn('[brain] context assembly failed', err)
      }
    }
    // Screen fast-path (M13): the renderer asked to answer from the pre-analyzed on-device screen context.
    // Inject main's OWN cached description (re-validated for freshness/window match), plus a short recent-
    // conversation tail so the answer fuses what's on screen with what's being said. Best-effort: if the
    // cache went stale between the renderer's screen:context probe and now, answer from the prompt alone.
    // Deliberately a SIBLING of the brainContext gate above, not nested in it: the fact-check exclusion is
    // scoped to brainContext (missing GROUNDING_RAIL), while this block carries its own untrusted-data
    // guard (llm/shared.ts screenContextBlock). Nested, "fact-check what's on my screen" reached the model
    // with zero screen data — a verdict about a screen it never saw (MQA-009).
    if (req.mode === 'answer' && req.wantsScreenContext) {
      try {
        const ctx = screenPreprocess.currentFreshContext()
        if (ctx?.description) {
          // Same local-first redaction contract as the transcript above (review finding): on macOS the
          // description can be a VERBATIM OCR extract of the screen — an open password manager or API
          // key must be stripped before this text reaches a cloud answer provider. The tail is already
          // redacted (req.transcript was, at parse time).
          const description = s.redactSensitive ? redactSecrets(ctx.description) : ctx.description
          const tail = (req.transcript ?? '').slice(-1500).trim()
          req.screenContext = tail
            ? `${description}\n\nRecent conversation (most recent speech):\n${tail}`
            : description
        }
      } catch (err) {
        mainLog.warn(`[screen-preprocess] context injection failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const allowed = getAllowedProviders() // org allowlist (null = unrestricted)

    // Screen-vision capability. Static per provider, EXCEPT Dust: its ability to read a screenshot depends
    // on the selected agent's underlying model (it uploads the shot as a content fragment), so consult the
    // per-agent capability instead of the static flag. Everything else uses PROVIDERS[p].vision.
    const providerVisionOk = (p: ProviderId): boolean =>
      p === 'dust' ? dustSelectedAgentVision(s.providerModels['dust']) : PROVIDERS[p].vision

    // Pick the next eligible keyed provider not yet tried — the waterfall target when the primary (e.g.
    // Dust) can't answer. Pure (no side effect) so the retry gate can cheaply ask "is there anywhere to
    // fall over to?" before deciding how long to keep retrying a dead primary.
    const pickFailover = (tried: ProviderId[]): ProviderId | null => {
      // A request pinned to a specific Dust agent (Spotlight Ref) has NO valid failover target — no other
      // provider hosts that managed agent, so falling over would silently answer from the active generic
      // provider (e.g. Kimi) with a reply that never touched the agent. Returning null here suppresses
      // failover at BOTH seams that consult pickFailover (the retry-budget sizing and the pre-token
      // failover line), letting the flow fall through to the reconnect-Dust message instead.
      if (!allowCrossProviderFailover(req)) return null
      const tier = routeTier(req, s.thinkingMode)
      // Candidate order honors the CLI-vs-API priority: when 'cli', CLI-kind providers sort first so a
      // failover reaches for another local CLI before a metered API. V8's Array.sort is stable, so equal-
      // rank providers keep their PROVIDERS declaration order; 'api' (default) leaves the order unchanged.
      const order = (Object.keys(PROVIDERS) as ProviderId[]).slice().sort((a, b) =>
        s.providerPriority === 'cli'
          ? (PROVIDERS[a].kind === 'cli' ? 0 : 1) - (PROVIDERS[b].kind === 'cli' ? 0 : 1)
          : 0
      )
      const eligible = (p: ProviderId): boolean => {
        if (tried.includes(p)) return false
        // Métis Local replaces the generic key/model/vision checks with localEligibleFor — the SAME
        // mode-scope gate the ineligible chain below enforces, so local can never become a failover
        // target for an out-of-scope mode (answer/recap or escalated text) even though it's a keyless,
        // always-vision-capable entry in PROVIDERS (PLAN.md §4.3: "enforced at BOTH gates").
        if (p === 'local') return localEligibleFor(req, s, tier, allowed)
        return (
          (!allowed || allowed.includes(p)) &&
          (PROVIDERS[p].kind === 'cli' ? !!s.cliConnected[p] : getApiKey(p).length > 0) &&
          (req.mode !== 'vision' || providerVisionOk(p)) &&
          // CLI providers (e.g. codex-cli) may have no configured model at all — attempt() below
          // already exempts kind==='cli' from the "no model" ineligibility check (the CLI just uses
          // its own default), so a failover candidate must be exempted the same way or a fully
          // default-configured CLI provider can never be selected.
          (PROVIDERS[p].kind === 'cli' ||
            !!resolveModelTier(p, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep))
        )
      }
      // MQA-003: prefer a provider that has not just had its credentials rejected. Deliberately two
      // passes rather than a filter — a cooling provider is still a legitimate last resort, so it is
      // demoted, never removed. Skipping it outright would let one revoked key lock a user out of the
      // only provider they have configured.
      const found = order.find((p) => eligible(p) && !isCoolingDown(p)) ?? order.find(eligible)
      if (found) return found
      // Safety net (localLlm.fallback): every cloud/CLI candidate is tried or unconfigured — offer the
      // on-device model as the strictly-LAST resort so an in-scope ask still gets answered instead of
      // dying with a provider error. Checked only after the find() above so local-by-fallback can never
      // jump ahead of an untried cloud candidate (useFor-driven local keeps its normal position via
      // localEligibleFor inside the find). Same mode-scope + tier + localBaseReady gates as everywhere.
      if (!tried.includes('local') && localFallbackEligibleFor(req, s, tier, allowed)) return 'local'
      return null
    }
    // Find the next eligible keyed provider not yet tried and start it — for failover when the primary
    // can't answer (Dust down → your configured Claude/GPT key takes over).
    const failover = (tried: ProviderId[]): boolean => {
      const next = pickFailover(tried)
      if (!next) return false
      attempt(next, tried)
      return true
    }

    // Validate a provider, start the stream, and on a PRE-token (TTFT) failure retry the same provider
    // (transient errors) then fall over to the next one. `retryCount` tracks same-provider transient
    // retries; failover resets it (each provider gets its own retry budget).
    const MAX_TRANSIENT_RETRIES = 3
    const attempt = (provider: ProviderId, attempted: ProviderId[], retryCount = 0): void => {
      const def = PROVIDERS[provider]
      if (allowed && !allowed.includes(provider)) {
        auditLog('provider.blocked', { provider })
        if (attempted.length === 0) {
          // Name an actual next step, not just what's wrong: prefer an approved provider that's already
          // keyed/CLI-connected (so "switch to X" is immediately actionable), falling back to just naming
          // the first approved provider when none of them are configured yet.
          const approvedCandidates = allowed
            .filter((p) => p !== provider)
            .map((p) => ({ id: p as ProviderId, def: PROVIDERS[p as ProviderId] as ProviderDef | undefined }))
            .filter((c): c is { id: ProviderId; def: ProviderDef } => !!c.def)
          const readyApproved = approvedCandidates.find((c) =>
            c.def.kind === 'cli' ? !!s.cliConnected[c.id] : getApiKey(c.id).length > 0
          )
          const approvedLabel = (readyApproved ?? approvedCandidates[0])?.def.label
          win?.webContents.send(IPC.streamError, {
            id: req.id,
            message: approvedLabel
              ? `${def.label} is not on your organization's approved provider list. Switch to ${approvedLabel} in Settings.`
              : `${def.label} is not on your organization's approved provider list.`
          })
        } else if (!failover(attempted.concat(provider))) {
          win?.webContents.send(IPC.streamError, { id: req.id, message: 'No approved provider could answer.' })
        }
        return
      }
      // Métis Local is keyless: its per-session sidecar key lives only in local-runtime.ts memory, never
      // on disk (getApiKey('local') always resolves empty, by design — see store.ts's ENV_VAR entry).
      const key = provider === 'local' ? localRuntime.sessionKey() : getApiKey(provider)
      const tier = routeTier(req, s.thinkingMode)
      // Métis Local's "model" is the local-models.ts manifest id the sidecar loads — settings.localLlm.
      // modelId, NOT the generic per-provider tier resolution (which would otherwise fall back to
      // PROVIDERS.local.fastModel regardless of the installer-owned model selected in settings).
      let model =
        provider === 'local'
          ? s.localLlm.modelId
          : req.agentOverride && provider === 'dust'
            ? req.agentOverride
            : resolveModelTier(provider, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep)
      // Guardrail (per Tony): CLI is Sonnet-only, Anthropic base/think are pinned to Haiku/Sonnet — both
      // regardless of what routeTier or a user's providerModels override picked. Opus stays reachable only
      // through the Graph pipeline (brain/ingest.ts, graphify.ts), which never calls this function.
      model = applyInteractiveGuardrail(provider, tier, model)
      // Dust interactive speed pin: think/deep Dust AGENTS run server-side orchestration before their
      // first token (measured 6.6-28.3s TTFT vs ~2.6s for the base agent) — unusable mid-conversation.
      // Interactive asks (chat/vision/suggest) always use the base agent; recaps, summaries, background
      // jobs, and explicit agentOverride (Spotlight Ref) keep the think/deep agents where depth > speed.
      if (
        provider === 'dust' &&
        !req.agentOverride &&
        (req.mode === 'answer' || req.mode === 'vision' || req.mode === 'suggest')
      ) {
        model = (s.providerModels['dust'] || '').trim() || model
      }
      // Métis Local replaces the ENTIRE generic key/model/vision chain below with localEligibleFor — the
      // same mode-scope + readiness gate the settings snapshot and pickFailover's candidate filter use, so
      // an out-of-scope request (answer/recap or escalated text) can never actually route to the local
      // provider. Opted-in vision deliberately stays local at every tier so prompt complexity cannot
      // silently turn a screenshot into a cloud upload.
      const ineligible =
        provider === 'local'
          ? localEligibleFor(req, s, tier, allowed) || localFallbackEligibleFor(req, s, tier, allowed)
            ? ''
            : localVisionRequired
              ? 'Métis Local could not process this screenshot on this device. Nothing was sent to a cloud provider. Restart Métis, or reinstall it if the bundled model is missing.'
              : 'Métis Local handles live suggestions, summaries and screenshots — this request type uses your cloud provider.'
          : def.kind === 'cli' && !s.cliConnected[provider]
            ? `${def.label} is not connected. Open Settings → CLI Integration to set it up.`
            : def.kind !== 'cli' && !key
              ? `No API key for ${def.label}. Open Settings (gear) and add it.`
              : def.kind !== 'cli' && !model
                ? provider === 'dust'
                  ? `No ${tier === 'think' ? 'thinking' : 'base'} Dust agent set. Open Settings → Connect Dust and pick your agents.`
                  : `No model set for ${def.label}. Pick a model in Settings.`
                : req.mode === 'vision' && !providerVisionOk(provider)
                  ? `${def.label} can't read screenshots. Switch to Claude or GPT in Settings, or ask without a screen capture.`
                  : provider === 'dust' && !s.dustWorkspaceId
                    ? 'Add your Dust workspace ID in Settings → AI → Dust setup.'
                    : ''
      if (ineligible) {
        // Vision turn, but the active provider can't read images (e.g. Dust agents). Transparently fail
        // over to a configured vision-capable provider (Claude/GPT) so a user who captured their screen
        // still gets an answer — `failover` only picks a provider that has both a key and a model. Surface
        // the error only when NO vision-capable provider is set up.
        const visionGap = req.mode === 'vision' && !providerVisionOk(provider)
        if (visionGap && failover(attempted.concat(provider))) return
        if (attempted.length === 0) {
          // Zero-config safety net (localLlm.fallback): the very FIRST provider can't even start — no
          // key, CLI not connected, Dust half-configured. Historically this surfaced the setup error
          // immediately (no failover on a first-attempt ineligibility, unlike runtime failures). With a
          // provisioned on-device model and fallback on, answer the in-scope ask locally instead: a
          // fresh zero-API-key install gets a working assistant, and Settings still shows the real
          // setup state. Out-of-scope modes (answer/recap) fail exactly as before —
          // localFallbackEligibleFor enforces the same v1 mode scope as every other local gate.
          // allowCrossProviderFailover: a request pinned to one managed Dust agent (agentOverride) has
          // no honest substitute — same suppression pickFailover applies at the other two seams. Today's
          // sole agentOverride caller uses mode:'answer' (out of local scope anyway), but the pinned
          // contract must hold at THIS seam by construction, not by coincidence of that caller's mode.
          if (
            provider !== 'local' &&
            allowCrossProviderFailover(req) &&
            localFallbackEligibleFor(req, s, tier, allowed)
          ) {
            attempt('local', attempted.concat(provider))
            return
          }
          win?.webContents.send(IPC.streamError, { id: req.id, message: ineligible })
        } else if (!failover(attempted.concat(provider))) {
          win?.webContents.send(IPC.streamError, { id: req.id, message: ineligible })
        }
        return
      }
      const baseURL =
        provider === 'custom' ? s.customBaseUrl : provider === 'dust' ? s.dustBaseUrl : def.baseUrl
      auditLog('provider.request', { provider, model, mode: req.mode, tier, retry: attempted.length > 0 })
      // Tell the waiting UI WHO is answering ("Asking your Dust agent…") — re-sent on retry/failover so
      // the display follows the live attempt. Metadata only (provider id + tier), never the model/agent id.
      win?.webContents.send(IPC.streamMeta, { id: req.id, provider, tier })
      // Per-tier idle budget: a live suggest gives up fast to stay real-time; recaps + deep answers get the
      // full headroom. Bounds time-to-first-token and triggers failover when a provider stalls before a token.
      const baseIdleMs =
        req.mode === 'suggest'
          ? 15_000
          : req.mode === 'recap' || req.mode === 'summary'
            ? 120_000
            : tier === 'deep'
              ? 120_000
              : tier === 'think'
                ? 90_000
                : req.mode === 'vision'
                  ? 60_000
                  : 45_000
      // Each failover attempt re-derives a fresh, full idle budget with no shared cross-provider deadline —
      // on a silent-drop offline network (captive portal / dead-gateway WiFi that accepts the connection
      // then black-holes packets) that compounds into N x the base budget of blank spinner before the user
      // sees any error. Retries (attempted.length > 0) get a much shorter cap: a healthy provider still
      // answers well inside it, while a silent-drop network surfaces the "Connection error." in seconds.
      // MQA-037: the cap is a NETWORK diagnostic, so it must never apply to Métis Local — a 127.0.0.1
      // sidecar cannot be a silent-drop victim, and the zero-config safety net always reaches it with
      // attempted.length >= 1 (the preceding step was an in-memory config check that never opened a
      // socket). Without this exemption a warm-sidecar summary/vision fallback got 20s of prefill budget
      // for the same work the identical useFor-driven request gets 120s/60s for, and local has no
      // failover to rescue it.
      const RETRY_IDLE_CAP_MS = 20_000
      // MQA-006: a COLD Métis Local request must first load ~730 MB of GGUF weights off disk before it can
      // emit a token — routinely longer than the 15s suggest budget and longer than the retry cap, so the
      // first on-device answer after launch (exactly what a zero-API-key install gets) died with "Stream
      // timed out" while the model was still loading correctly. The floor applies only while the sidecar
      // is not yet running: once warm, local is fast and keeps the normal, tighter budgets. This is a
      // load allowance, not a licence to hang — a genuinely stuck sidecar still aborts, just later.
      const LOCAL_COLD_START_IDLE_MS = 90_000
      const localColdStart = provider === 'local' && !localRuntime.isRunning()
      const idleMs = localColdStart
        ? Math.max(baseIdleMs, LOCAL_COLD_START_IDLE_MS)
        : attempted.length > 0 && provider !== 'local'
          ? Math.min(baseIdleMs, RETRY_IDLE_CAP_MS)
          : baseIdleMs
      const startedAt = Date.now()
      let gotToken = false
      let ttftMs: number | undefined
      const handle = createStream({
        providerId: provider,
        kind: def.kind,
        apiKey: key,
        baseURL,
        workspaceId: s.dustWorkspaceId,
        // Dust OAuth tokens (imported from the local CLI) expire after ~1h. On a pre-token 401 the
        // stream asks for fresh creds: re-mint via the CLI, persist them, and replay once — so an
        // expired token self-heals invisibly instead of surfacing an error.
        refreshDustAuth:
          provider === 'dust'
            ? async () => {
                const fresh = await refreshDustCliSession()
                if (!fresh.ok || !fresh.token || !fresh.workspaceId) return null
                setApiKey('dust', fresh.token)
                const baseUrl = fresh.baseUrl || 'https://dust.tt'
                setSettings({ dustWorkspaceId: fresh.workspaceId, dustBaseUrl: baseUrl, dustTokenMintedAt: Date.now() })
                auditLog('dust.token.refreshed', {})
                return { apiKey: fresh.token, workspaceId: fresh.workspaceId, baseURL: baseUrl }
              }
            : undefined,
        model,
        temperature: s.temperature,
        // Reasoning-by-default models (Kimi, DeepSeek V4) burn hidden tokens and stall a 15s live-suggest
        // budget unless told otherwise — providers.ts reasoningEffortFor decides per provider AND tier;
        // undefined for every other provider, so their request bodies stay byte-identical.
        reasoningEffort: reasoningEffortFor(provider, tier, s.thinkingMode === 'always'),
        idleMs,
        system: buildSystem(req, s.mode, s.profile, s.modePrompts, s.contextDocs[s.mode] || [], s.outputLanguage, s.summaryLanguage, s.systemPrompt),
        req,
        handlers: {
          onDelta: (text) => {
            if (!gotToken) {
              ttftMs = Date.now() - startedAt
              // Tokens are flowing, so these credentials demonstrably work — clear any prior auth
              // verdict (MQA-003/MQA-004) rather than leaving a stale "broken" mark on a live provider.
              recordSuccess(provider)
            }
            gotToken = true
            win?.webContents.send(IPC.streamDelta, { id: req.id, text })
          },
          onDone: (u) => {
            streams.delete(req.id)
            // MQA-020 (belt-and-braces half): a provider that completes with ZERO content deltas has not
            // answered — the user gets a blank bubble and the waterfall stops, because "done" reads as
            // success. The known instance was claude-cli settling an `is_error: true` terminal line as
            // success (fixed at source in llm/cli.ts), but ANY strategy that reaches onDone pre-token has
            // the same effect, so treat it as a pre-token failure here and let the normal failover run.
            // Only for cloud/CLI: a local no-output must surface rather than silently upload the request.
            if (!gotToken && provider !== 'local' && failover(attempted.concat(provider))) return
            // MQA-102: the cloud/CLI branch above is deliberately gated `provider !== 'local'`, so a LOCAL
            // completion with zero content deltas used to fall straight through to streamDone — the exact
            // blank-bubble MQA-020 fixed for cloud/CLI, still live for the on-device last resort (the
            // "my key died" end state, where local is what answers). Surface it as an actionable error
            // instead. No failover: a local failure must never silently upload the request to cloud.
            if (!gotToken && provider === 'local') {
              win?.webContents.send(IPC.streamError, {
                id: req.id,
                message: 'Métis Local produced no answer — try again, or add a cloud provider in Settings for longer questions.'
              })
              return
            }
            // Latency + token telemetry (metadata only) — feeds the p50/p95 latency + cost evals (H/D/F).
            auditLog('provider.request', {
              provider,
              model,
              mode: req.mode,
              tier,
              phase: 'done',
              ttftMs,
              totalMs: Date.now() - startedAt,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens
            })
            win?.webContents.send(IPC.streamDone, { id: req.id, ...u })
          },
          onError: (message) => {
            streams.delete(req.id)
            auditLog('provider.failed', { provider, gotToken, retry: retryCount })
            // MQA-003/MQA-004: remember a CREDENTIAL rejection (not a transport blip) so routing can stop
            // re-paying this provider's round trip on every subsequent ask, and so Settings can finally
            // tell the user their key stopped working instead of reporting it ready forever.
            // MQA-101: Dust's own auth-rejection wording drifts across API versions and the current
            // "does not have a valid authenticated credential" phrasing carries no 401 digits, so the
            // generic isAuthFailure misses it — the circuit breaker never trips for a genuinely dead Dust
            // session. dust.ts already maintains the broadened matcher for exactly this; use it for Dust.
            const isCredentialRejection =
              provider === 'dust' ? isDustAuthError({ message }) : isAuthFailure(message)
            if (!gotToken && isCredentialRejection) recordAuthFailure(provider, String(message))
            if (!gotToken) retireCli(provider, message)
            // Pre-token transient failure (dropped socket, 5xx, 429, DNS blip): retry the SAME provider
            // with bounded backoff before switching. `gotToken` guards it — once tokens are on the wire
            // we never re-run. A cancel handle keeps an abort during the backoff wait from firing the retry.
            // Waterfall: when another configured provider can take over (e.g. Dust down but a Claude/GPT key
            // is set), cap same-provider retries at ONE so the API answers in seconds instead of after the
            // full ~30s of retrying a dead primary. With nowhere to fall over to, keep the full retry budget.
            // A request routed to Métis Local stays on-device. Cloud providers may waterfall into another
            // configured provider, but a local failure must be surfaced to the user instead of silently
            // uploading the transcript/screenshot they explicitly chose to process locally.
            // (pickFailover may also name 'local' here — a sole cloud provider that transport-fails now
            // retries once and then answers on-device instead of burning the full ~30s retry budget.)
            const hasFailoverTarget = provider !== 'local' && !!pickFailover(attempted.concat(provider))
            const retryBudget = hasFailoverTarget ? 1 : MAX_TRANSIENT_RETRIES
            if (!gotToken && retryCount < retryBudget && isTransient(message)) {
              const delayMs = nextBackoff(retryCount)
              auditLog('provider.retry', { provider, attempt: retryCount + 1, delayMs })
              const timer = setTimeout(() => attempt(provider, attempted, retryCount + 1), delayMs)
              streams.set(req.id, { abort: () => clearTimeout(timer) })
              return
            }
            // Retries exhausted or non-transient: fall over to another provider (pre-token only).
            if (!gotToken && provider !== 'local' && failover(attempted.concat(provider))) return
            // Replace raw client transport strings ("Unexpected network error from DustAPI: fetch failed")
            // with a clean message; keep the Dust-auth one-click reconnect path; else pass the message.
            const friendly = isTransient(message)
              ? "Connection issue — couldn't reach the provider after retrying. Check your network and try again."
              : // MQA-101: use dust.ts's maintained matcher, not a second copy of the phrasing regex —
                // the inline copy missed the current "authenticated credential" wording, so a dead Dust
                // session surfaced its raw 401 instead of this reconnect prompt.
                provider === 'dust' && isDustAuthError({ message })
                ? 'Your Dust session expired and could not refresh automatically. Open Settings and reconnect Dust once.'
                : // MQA-062: a CLI provider has no API key to "re-enter" — sending the user to Settings →
                  // AI for a key that does not exist is an actively wrong remedy. Name the real fix: sign
                  // the CLI back in and reconnect it (retireCli has already retired the stale flag).
                  def.kind === 'cli' && isAuthFailure(message)
                  ? `${def.label} is no longer signed in. Sign in to the CLI again, then reconnect it in Settings → CLI Integration.`
                  : // MQA-005: a credential rejection used to fall through as the provider's raw string —
                    // users saw literally "403 status code (no body)", which names neither the problem nor
                    // the fix. Say which provider failed and where to go, matching the no-key path's copy.
                    isAuthFailure(message)
                    ? `${def.label} rejected your API key (it may have been revoked, expired, or run out of credit). Open Settings → AI to re-enter it.`
                    : message
            win?.webContents.send(IPC.streamError, { id: req.id, message: friendly })
          }
        }
      })
      streams.set(req.id, handle)
    }

    // Honor the CLI-vs-API priority for the FIRST provider tried: 'cli' prefers a connected CLI integration
    // (Claude, then Codex) so the user's local subscription is used before any metered API. Otherwise — and
    // whenever no CLI is connected — the user's explicitly-chosen `provider` stays primary (unchanged).
    // req.providerOverride wins over all of that: it means "this specific request must go to provider X"
    // (e.g. cascading a recap/follow-up/Spotlight-Ref request into Dust) regardless of what's globally active.
    const cliPrimary =
      s.providerPriority === 'cli'
        ? (['claude-cli', 'codex-cli'] as ProviderId[]).find(
            (p) => s.cliConnected[p] && (!allowed || allowed.includes(p))
          )
        : undefined
    // Métis Local outranks cliPrimary (but never providerOverride): an in-scope suggest/summary/vision ask
    // routes to the on-device model first whenever it's eligible right now (PLAN.md §4.3 "Routing
    // precedence, explicit") — see local-routing.ts's pickPrimaryProvider for the exact precedence rule.
    const localPrimaryEligible = localEligibleFor(req, s, routeTier(req, s.thinkingMode), allowed)
    const localVisionRequired = localVisionPrivacyRequired(req, s)
    const primary = pickPrimaryProvider(
      req.providerOverride,
      localPrimaryEligible,
      cliPrimary,
      s.provider,
      localVisionRequired
    )
    // MQA-003: when the primary's credentials were just rejected, start at the next eligible provider
    // instead of re-paying its round trip on every ask (measured 6.5–9.3s wasted against a 15s
    // live-suggest budget). It stays in `attempted` so the walk never circles back to it. pickFailover
    // returns null for a pinned Dust-agent request, so a pinned ask is never silently substituted.
    const skipDeadPrimary = isCoolingDown(primary) ? pickFailover([primary]) : null
    attempt(skipDeadPrimary ?? primary, skipDeadPrimary ? [primary] : [])
    } catch (e) {
      win?.webContents.send(IPC.streamError, {
        id,
        message: e instanceof Error ? e.message : 'Could not start the answer.'
      })
    }
  })

  ipcMain.handle(IPC.askCancel, (e, id: string) => {
    assertMainWindow(e)
    streams.get(id)?.abort()
    streams.delete(id)
  })

  // Explicit "New chat" from the renderer (History screen button / Cmd+Shift+R). The renderer clears its
  // own history refs; this clears the main-owned carriers — the server-side Dust conversation (previously
  // NOT reset here, so "New chat" was a no-op against Dust's accumulated thread) and the follow-up-memory
  // idle clock.
  ipcMain.handle(IPC.askResetContext, (e) => {
    assertMainWindow(e)
    resetDustConversation()
    lastPlainAskAt = 0
  })

  // --- Audio capture arming ---
  ipcMain.handle(IPC.armAudio, (e, on: boolean) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    audioArmed = !!on
  })

  // --- Transcript, notes & feedback persistence ---
  ipcMain.handle(IPC.saveTranscript, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const m = SaveMeetingSchema.parse(raw)
    const r = { path: await saveMeeting(getSettings(), m) }
    // Time-saved: the meeting file just landed — credit it ONCE to the durable lifetime counters. This is
    // the live-meeting save path; the import path credits itself separately once its file is durable. A
    // rebuild never reaches here, so a meeting is counted once for its lifetime.
    recordMeetingSummarized(meetingDurationMin(m))
    void clearDraftTranscript(getSettings(), m.startedAt) // the real save landed — this autosave is now stale
    auditLog('transcript.saved', {
      mode: m.mode,
      lines: m.lines.length,
      durMin: Math.round((Date.now() - m.startedAt) / 60_000),
      encrypted: !!getSettings().encryptTranscripts
    })
    scheduleRebuild() // refresh the knowledge graph with the new note (debounced; no-op if disabled)
    // Persist the small background-work marker before confirming the transcript save. The actual LLM
    // extraction remains asynchronous, but a quit immediately after Save can now resume it.
    await enqueueIngest(r.path)
    // Speaker Intelligence (Phases A/B): best-effort, fire-and-forget backfill of resolved names from the
    // meeting's own Teams transcript (if one exists yet). Never awaited — must never delay or fail the
    // save response itself; see backfillSpeakerNames's own doc comment for the full quiet-no-op contract.
    void backfillSpeakerNames(r.path).catch(() => {})
    return r
  })

  // --- Mantu Intelligence brain (see src/main/brain/) ---
  ipcMain.handle(IPC.brainOpenDashboard, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const result = openIntelligenceWindow()
    // Opening the full dashboard is an explicit request for current meeting knowledge. Kick off one
    // backlog pass for saved transcripts that predate the brain; new saves already call enqueueIngest.
    // This is deliberately fire-and-forget so a slow OneDrive listing never delays the window itself.
    void (async () => {
      try {
        // Source versions, not only a count of successful filenames, decide whether Intelligence is
        // current. requestBackfill detects changed/deleted sources and schedules the clean rebuild.
        const r = requestBackfill()
        auditLog('brain.backfill.start', { queued: r.queued, deferred: r.deferred, automatic: true })
      } catch (err) {
        mainLog.warn('[brain] automatic dashboard backfill check failed:', err)
      }
    })()
    return result
  })
  ipcMain.handle(IPC.brainStatus, (e) => {
    assertBrainReader(e)
    if (!requireAuth()) return null
    const s = getSettings()
    const idx = readBrainIndex(s)
    const counts = brainStatusCounts(s, idx.revision)
    // T6 6c: durable failure counts read straight from the index — unlike backfill.failed below (an
    // ephemeral per-run counter), these stay visible for as long as a source has ok:false, independent
    // of whether a backfill run happens to be active right now.
    const failure = ingestFailureCounts(idx)
    // Per-file error text for the same failing sources, bounded to 20 — powers the failed-row tooltip
    // (RecallView) and the expandable failure detail (BrainView) without shipping the whole ledger.
    const failureDetails = ingestFailureDetails(idx)
    return {
      meetings: Object.values(idx.ingested).filter((v) => v.ok).length,
      ingestedFiles: Object.entries(idx.ingested).filter(([, v]) => v.ok).map(([file]) => file),
      // 6d: failing-source filenames, the failed-side counterpart to ingestedFiles above — lets a
      // per-meeting indicator (indexed/pending/failed) be derived without a second, heavier IPC call.
      failedFiles: Object.entries(idx.ingested).filter(([, v]) => !v.ok).map(([file]) => file),
      ...(failureDetails.length ? { failedDetails: failureDetails } : {}),
      backfillRequested: idx.backfillRequested,
      ...counts,
      warnings: idx.warnings.length,
      revision: idx.revision,
      backfill: brainBackfillProgress(),
      live: brainLiveIngestProgress(),
      failed: failure.failed,
      exhausted: failure.exhausted,
      ...(failure.topError ? { topError: failure.topError } : {}),
      // MI-2.5 review round 3: computed fresh from the on-disk sentinel each poll — lets BrainView offer
      // the in-app "Reset corrections lock" recovery instead of a hand-deleted hidden .brain file.
      corruptionBlocked: isJournalCorruptionBlocked(s)
    }
  })
  ipcMain.handle(IPC.brainBackfill, (e) => {
    assertBrainReader(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const r = requestBackfill()
    auditLog('brain.backfill.start', { queued: r.queued })
    return r
  })
  // Full rebuild: wipe the DERIVED store (entities/graph/extractions — never the source transcripts)
  // and re-extract everything with the current schema/prompt. This is the upgrade path for legacy
  // extractions (e.g. untagged feedback that rendered as a flat confidence wall in the dashboard).
  ipcMain.handle(IPC.brainRebuildAll, async (e) => {
    // Privileged write (purges the derived brain store) — main-window only, like brainCommitmentSettle,
    // never the Mantu Intelligence window's assertBrainReader (used by its read channels and narrow,
    // guarded backfill request only).
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    // The full orchestration lives in ingest.ts's startRebuild (unit-testable, keeps this handler thin):
    //  - preserveCorrections purge whose result is CHECKED (MI-2.5 Fix F — abort on a partial wipe);
    //  - a corrupt/blocked-journal guard (MI-2.5 review Fix 2 — refuse rather than rebuild atop a store
    //    onto which zero corrections could be replayed, which would silently revert every human fix);
    //  - the replayPending flag (Fix E) + the onDrained replay that clears it only on a clean replay.
    const r = await startRebuild(getSettings())
    if (r.error) {
      auditLog('brain.rebuild.aborted', {})
      return r
    }
    auditLog('brain.backfill.start', { queued: r.queued, rebuild: true })
    return r
  })
  // MI-2.5 review round 3: user-invoked recovery from a durable correction-journal corruption lock —
  // clears the sentinel so corrections resume (the quarantined corrections.corrupt-*.json copy is left
  // for inspection). Privileged (mutates correction-engine state) — main-window only + requireAuth, same
  // guards as brainSetDealOutcome. Takes no payload, so there is nothing to zod-validate beyond the guards.
  ipcMain.handle(IPC.brainClearJournalCorruption, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const cleared = clearJournalCorruptionLock(getSettings())
    auditLog('brain.corrections.lock_cleared', { cleared })
    return { ok: true, cleared }
  })
  // Full assembled dataset for the Mantu Intelligence dashboard (decrypted in main when needed).
  ipcMain.handle(IPC.brainRead, (e) => {
    assertBrainReader(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const s = getSettings()
    const index = readBrainIndex(s)
    return {
      index,
      graph: readBrainGraph(s),
      people: listBrainEntities(s, 'person').map((slug) => readBrainPerson(s, slug)).filter(Boolean),
      accounts: listBrainEntities(s, 'account').map((slug) => readBrainAccount(s, slug)).filter(Boolean),
      deals: listBrainEntities(s, 'deal').map((slug) => readBrainDeal(s, slug)).filter(Boolean),
      meetings: listBrainMeetingExtractions(s)
        .map((slug) => readBrainMeetingExtraction(s, slug))
        .filter((meeting): meeting is NonNullable<typeof meeting> => !!meeting && !!index.ingested[meeting.source_file]?.ok)
    }
  })
  // Canonical people/account NAMES ONLY (never quotes, roles, deals, or any other entity field) — feeds
  // the renderer's ASR entity-casing bias (lib/entity-casing.ts) so a live transcript can spell a known
  // name correctly. Read-only, best-effort: an unsigned-in/empty brain just yields no names, never throws,
  // since this runs opportunistically (mount + after a meeting saves), not in response to a user action.
  ipcMain.handle(IPC.brainEntityNames, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { names: [] }
    const s = getSettings()
    const people = listBrainEntities(s, 'person')
      .map((slug) => readBrainPerson(s, slug)?.name)
      .filter((n): n is string => !!n)
    const accounts = listBrainEntities(s, 'account')
      .map((slug) => readBrainAccount(s, slug)?.name)
      .filter((n): n is string => !!n)
    return { names: Array.from(new Set([...people, ...accounts])).slice(0, 500) }
  })
  // Deal outcome — the human closes the loop the LLM never may (see DealEntitySchema.outcome). Main-window
  // only: it's a brain WRITE, like brainCommitmentSettle. Same slug convention too: the renderer sends the
  // deal's display name in `dealSlug`, resolved to the entity's stable id here before it reaches the store
  // — through the alias map, not slugify, or a renamed deal could never be closed (MQA-013).
  ipcMain.handle(IPC.brainSetDealOutcome, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = SetDealOutcomePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const s = getSettings()
    const updated = await setDealOutcome(s, resolveEntitySlug(readAliasMap(s), 'deal', parsed.data.dealSlug), parsed.data.outcome)
    if (!updated) return { ok: false, error: 'Deal not found.' }
    await markBrainChanged(getSettings())
    auditLog('brain.deal.outcome', { outcome: parsed.data.outcome })
    return { ok: true }
  })

  // Correction engine (Task MI-2): five human-correction channels, each cloned from
  // brain:setDealOutcome's pattern above — zod safeParse + main-window-only + requireAuth + audit. Every
  // mutation goes through src/main/brain/corrections.ts so brain:rebuildAll's journal replay (which
  // calls the exact same functions) can reproduce it deterministically — see corrections.ts's module
  // doc comment for the single-mutation-implementation invariant.
  ipcMain.handle(IPC.brainEntityRename, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = EntityRenamePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid rename request.' }
    const { kind, id, newName, alsoFixAsr } = parsed.data
    // Captured BEFORE the rename so alsoFixAsr can pair the OLD display name with the new one.
    const oldName =
      kind === 'person'
        ? readBrainPerson(getSettings(), id)?.name
        : kind === 'account'
          ? readBrainAccount(getSettings(), id)?.name
          : readBrainDeal(getSettings(), id)?.name
    const r = await renameEntity(getSettings(), { kind, id, newName })
    if (!r.ok) return r
    await markBrainChanged(getSettings())
    await publishEntity(getSettings(), kind, id) // Task MI-5: keep the wiki page in sync with the live rename
    // alsoFixAsr composition lives here, not in corrections.ts (that module owns brain-entity
    // mutations only) — appends the {from, to} pair to settings.asrCorrections in the exact shape
    // commitLine's correctionsRef consumer expects (see lib/listen.ts), so the live transcript stops
    // mishearing the old name going forward. appendAsrCorrection validates the PAIR before it ever
    // reaches setSettings: store.ts's validKeysOnly drops the whole asrCorrections array when one
    // element fails validation (e.g. a name over the 80-char cap), which would silently wipe every
    // correction the user already had. A skipped pair never blocks the rename itself — the caller
    // gets { ok: true, asrSkipped: true, reason } and the skip is audit-logged.
    if (alsoFixAsr && oldName && oldName !== newName) {
      const composed = appendAsrCorrection(getSettings().asrCorrections, oldName, newName)
      if (composed.kind === 'append') {
        setSettings({ asrCorrections: composed.pairs })
        // MI-2.5 Fix H: a DISTINCT audit event, separate from brain.entity.renamed below — installing an
        // ASR rewrite rule silently changes how future spoken transcripts get transcribed, a
        // security-relevant setting mutation that must be visible in the trail on its own, not just
        // inferable from the rename. (The skipped-pair path already got its own distinct log below.)
        auditLog('brain.entity.asr_correction_added', { kind })
      }
      if (composed.kind === 'skipped') {
        auditLog('brain.entity.renamed', { kind, asrSkipped: true })
        return { ok: true, asrSkipped: true, reason: composed.reason }
      }
    }
    auditLog('brain.entity.renamed', { kind })
    return { ok: true }
  })
  ipcMain.handle(IPC.brainEntityMerge, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = EntityMergePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid merge request.' }
    const r = await mergeEntities(getSettings(), parsed.data)
    if (r.ok) {
      await markBrainChanged(getSettings())
      auditLog('brain.entity.merged', { kind: parsed.data.kind })
      // Task MI-5: the survivor's page picks up the merged-in data; the source's stale page is removed.
      const s = getSettings()
      await publishEntity(s, parsed.data.kind, parsed.data.intoId)
      await removeFromWiki(s, parsed.data.kind, parsed.data.fromId)
    }
    return r
  })
  ipcMain.handle(IPC.brainEntityUnmerge, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = EntityUnmergePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    const s = getSettings()
    // Task MI-5: unmergeEntities' payload is just {targetSeq} — read the journal (read-only, before the
    // mutation) for the kind/fromId/intoId this hook needs to know which wiki pages to republish once
    // both entities are restored. unmergeEntities re-derives the same entry internally to do the actual
    // restore; this is a second, harmless read of the same journal.
    const journalEntry = readCorrectionsJournal(s).find((en) => en.kind === 'entity_merge' && en.seq === parsed.data.targetSeq)
    const r = await unmergeEntities(s, parsed.data)
    if (r.ok) {
      await markBrainChanged(s)
      auditLog('brain.entity.unmerged', {})
      if (journalEntry && journalEntry.kind === 'entity_merge') {
        await publishEntity(s, journalEntry.payload.kind, journalEntry.payload.fromId)
        await publishEntity(s, journalEntry.payload.kind, journalEntry.payload.intoId)
      }
    }
    return r
  })
  ipcMain.handle(IPC.brainEntityUpdateField, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = EntityUpdateFieldPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid field update.' }
    const r = await updateEntityField(getSettings(), parsed.data)
    if (r.ok) {
      await markBrainChanged(getSettings())
      auditLog('brain.entity.field_updated', { kind: parsed.data.kind, field: parsed.data.field })
      await publishEntity(getSettings(), parsed.data.kind, parsed.data.id)
    }
    return r
  })
  ipcMain.handle(IPC.brainCommitmentReject, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = CommitmentRejectPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid commitment.' }
    const r = await rejectCommitment(getSettings(), parsed.data)
    if (r.ok) {
      await markBrainChanged(getSettings())
      auditLog('brain.commitment.rejected', {})
    }
    return r
  })
  // Dashboard suggestion accept/dismiss (deferred CRM pattern 3) — the one privileged write the Mantu
  // Intelligence window gets (assertBrainReader, not assertMainWindow), because it's exactly as narrow as
  // brain:backfill already was: promote ONE already-`extracted` field the human just reviewed, nothing more.
  ipcMain.handle(IPC.brainFieldDecision, async (e, raw) => {
    assertBrainReader(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = FieldDecisionPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    const { entityKind, entityId, field, decision } = parsed.data
    if (decision === 'dismiss') {
      // No legal expression exists yet: updateEntityField only ever pins a NEW human value (always ->
      // state 'pinned') — there is no field_update variant that clears/reverts one, and some fields
      // (account.sector's enum, deal.amount's {value, currency}) have no null/empty value to revert to
      // even if there were. Refused honestly rather than silently no-opping.
      return { ok: false, error: 'Dismissing a suggestion is not supported yet.' }
    }
    const s = getSettings()
    const provenance = readFieldProvenance(s, { kind: entityKind, id: entityId, field })
    if (!provenance) return { ok: false, error: `"${field}" has no pending suggestion to accept.` }
    if (provenance.state !== 'extracted') return { ok: false, error: 'This field is not pending review.' }
    // "Accept" = the human confirms the extracted value is correct, so it's re-pinned UNCHANGED. This
    // moves it from 'extracted' (never renders as fact — see RENDERABLE_PROVENANCE_STATES) to 'pinned'
    // (does), the same outcome an in-place edit-then-save-with-no-changes would produce today — there is
    // no separate "verify without editing" mutation, so this is the correction engine's exact legal
    // expression of "accept".
    const r = await updateEntityField(s, { kind: entityKind, id: entityId, field, value: provenance.value })
    if (r.ok) {
      await markBrainChanged(s)
      auditLog('brain.entity.field_decision', { kind: entityKind, field, decision })
      await publishEntity(s, entityKind, entityId)
    }
    return r
  })

  // Task MI-3: two read-only channels feeding the CRM record pages, the Review.tsx entity strip, and the
  // needs-attention queue. Same guard pattern as the other brain reads — no audit event (nothing mutates).
  ipcMain.handle(IPC.brainMeetingExtraction, (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return null
    const parsed = MeetingExtractionQuerySchema.safeParse(raw)
    if (!parsed.success) return null
    return readBrainMeetingExtraction(getSettings(), brainSlugify(basename(parsed.data.file)))
  })
  ipcMain.handle(IPC.brainAttention, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { items: [] }
    return { items: computeAttention(getSettings()) }
  })

  // Periodic best-effort snapshot of an IN-PROGRESS meeting (renderer calls this every ~60s while
  // Listen is active — see App.tsx). Never throws into the caller; a failed autosave must not interrupt
  // the meeting. See saveDraftTranscript's own doc comment for why this exists (crash/force-quit recovery).
  ipcMain.handle(IPC.saveDraftTranscript, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    const parsed = SaveMeetingSchema.safeParse(raw)
    if (!parsed.success) return
    await saveDraftTranscript(getSettings(), parsed.data)
  })

  ipcMain.handle(IPC.saveNote, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const n = SaveNoteSchema.parse(raw)
    const r = { path: await saveNote(getSettings(), n) }
    auditLog('note.saved', { mode: n.mode })
    scheduleRebuild()
    return r
  })

  // Answer feedback (good/bad) → audit log only. Metadata-only: the rating + answer kind, NEVER the
  // answer text or question (those would be content). Seeds the H-section acceptance-rate eval later.
  ipcMain.handle(IPC.answerFeedback, (e, raw: unknown) => {
    assertMainWindow(e)
    const r = raw as { rating?: unknown; kind?: unknown } | null
    const rating = r?.rating === 'up' || r?.rating === 'down' ? r.rating : null
    if (!rating) return
    auditLog('answer.feedback', { rating, kind: typeof r?.kind === 'string' ? r.kind : undefined })
  })

  // --- Import audio jobs (main-owned so navigation and overlay closure cannot interrupt them) ---
  ipcMain.handle(IPC.importAudioPick, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { error: 'Not signed in.' }
    return pickAudioFile(win)
  })
  ipcMain.handle(IPC.importAudioStart, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportAudioStartSchema.parse(raw)
    if (!importJobs) throw new Error('Audio import service is unavailable.')
    return importJobView(await importJobs.start(consumePickedAudio(parsed.token)))
  })
  ipcMain.handle(IPC.importJobsList, (e) => {
    assertMainWindow(e)
    if (!requireAuth() || !importJobs) return []
    return importJobs.list().map(importJobView)
  })
  ipcMain.handle(IPC.importJobCancel, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportJobIdSchema.parse(raw)
    if (!importJobs) throw new Error('Audio import service is unavailable.')
    await importJobs.cancel(parsed.jobId)
  })
  ipcMain.handle(IPC.importJobResume, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportJobIdSchema.parse(raw)
    if (!importJobs) throw new Error('Audio import service is unavailable.')
    return importJobView(await importJobs.resume(parsed.jobId))
  })
  ipcMain.handle(IPC.importJobRemove, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const parsed = ImportJobIdSchema.parse(raw)
    if (!importJobs) throw new Error('Audio import service is unavailable.')
    await importJobs.remove(parsed.jobId)
  })

  ipcMain.on(IPC.importDecoderReady, (e) => {
    if (!isDecoderSender(e)) {
      mainLog.warn('[import-decoder] rejected importDecoderReady from an unauthorized sender')
      return
    }
    if (!decoderReady) return
    clearTimeout(decoderReady.timer)
    const ready = decoderReady
    decoderReady = null
    ready.resolve()
  })
  ipcMain.on(IPC.importDecoderSourceAck, (e, raw: unknown) => {
    if (!isDecoderSender(e)) {
      mainLog.warn('[import-decoder] rejected importDecoderSourceAck from an unauthorized sender')
      return
    }
    const parsed = ImportDecoderCompleteSchema.safeParse(raw)
    if (!parsed.success || !sourceAck || sourceAck.jobId !== parsed.data.jobId) return
    clearTimeout(sourceAck.timer)
    const ack = sourceAck
    sourceAck = null
    ack.resolve()
  })
  ipcMain.handle(IPC.importDecoderChunk, async (e, raw) => {
    assertDecoderSender(e)
    const parsed = ImportDecoderChunkSchema.parse(raw)
    if (parsed.jobId !== decoderJobId || !importJobs) throw new Error('Import decoder job mismatch.')
    await importJobs.acceptDecodedChunk(parsed.jobId, parsed.seq, parsed.totalChunks, parsed.samples)
  })
  ipcMain.handle(IPC.importDecoderComplete, async (e, raw) => {
    assertDecoderSender(e)
    const parsed = ImportDecoderCompleteSchema.parse(raw)
    if (parsed.jobId !== decoderJobId || !importJobs) throw new Error('Import decoder job mismatch.')
    // Free the decoder window BEFORE finishDecoding can pump the next FIFO job — finishDecoding clears
    // activeJobId and pumps in its own finally, so a closeImportDecoder left for AFTER it (in this
    // handler's finally) runs too late and startImportDecoder's "already active" guard cascade-fails
    // every queued job. Mirrors the ffmpeg onComplete path, which frees its slot first for the same reason.
    await closeImportDecoder(parsed.jobId)
    try {
      await importJobs.finishDecoding(parsed.jobId)
    } finally {
      await closeImportDecoder(parsed.jobId)
    }
  })
  ipcMain.handle(IPC.importDecoderFailed, async (e, raw) => {
    assertDecoderSender(e)
    const parsed = ImportDecoderFailedSchema.parse(raw)
    if (parsed.jobId !== decoderJobId || !importJobs) throw new Error('Import decoder job mismatch.')
    // Same ordering requirement as importDecoderComplete above: free the slot before failDecoder can pump.
    await closeImportDecoder(parsed.jobId)
    try {
      await importJobs.failDecoder(parsed.jobId, parsed.error)
    } finally {
      await closeImportDecoder(parsed.jobId)
    }
  })

  // --- Metrics, export & PDF ---
  // On-device eval metrics from the local audit log (latency p50/p95, acceptance, failures). Read-only,
  // metadata-only — nothing leaves the device. Surfaced in Settings → About → Diagnostics.
  ipcMain.handle(IPC.metricsRead, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return aggregateMetrics([])
    return readEvalMetrics()
  })

  // Parse a recap's markdown into a structured object (decisions + action-items-with-owners) the renderer
  // can copy as JSON for Jira/Asana/Notion. Pure transform of text the renderer already holds — no disk I/O.
  ipcMain.handle(IPC.exportRecapJson, (e, markdown: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return parseRecapMarkdown(typeof markdown === 'string' ? markdown : '')
  })

  // Local, Dust-independent PDF export of a recap — works with zero external prerequisites (no Dust
  // tool config, no Graph scope). Renders a small self-contained HTML doc in a hidden throwaway window
  // and prints it via Electron's own printToPDF; no PDF npm dependency needed for this one job.
  ipcMain.handle(IPC.recapPdf, async (e, input: { markdown?: string; title?: string }) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const md = typeof input?.markdown === 'string' ? input.markdown : ''
    if (!md.trim()) throw new Error('No recap to export.')
    const safeName = (input?.title || 'Meeting recap').replace(/[\\/:*?"<>|]/g, '-')
    // Métis is an LSUIElement (accessory) app — no Dock icon, not a normal foreground app. A dialog
    // opened with no parent BrowserWindow has nothing to attach its sheet to and no window to activate,
    // so it can silently fail to ever surface on screen: the promise just hangs forever with no error and
    // no visible dialog. Anchoring it to `win` (already on screen) is what every other dialog in this
    // file does — this one was the one exception.
    const dialogOwner = win ?? undefined
    const r = dialogOwner
      ? await dialog.showSaveDialog(dialogOwner, { defaultPath: `${safeName}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      : await dialog.showSaveDialog({ defaultPath: `${safeName}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (r.canceled || !r.filePath) return { ok: false as const }
    const html = recapMarkdownToHtml(md, input?.title)
    const pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
    })
    try {
      await pdfWin.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))
      const buffer = await pdfWin.webContents.printToPDF({ printBackground: true })
      writeFileSync(r.filePath, buffer)
    } finally {
      pdfWin.destroy()
    }
    return { ok: true as const, path: r.filePath }
  })

  // --- Graphify knowledge graph ---
  ipcMain.handle(IPC.graphifyStatus, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { enabled: false, installed: false, backend: null, building: false, hasGraph: false }
    return graphifyStatus()
  })

  ipcMain.handle(IPC.graphifyRebuild, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return buildGraph(false) // explicit user rebuild = full
  })

  ipcMain.handle(IPC.graphifyRelated, (e, file: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Not signed in.', topics: [], notes: [] }
    return relatedNotes(String(file || ''))
  })

  ipcMain.handle(IPC.graphifyOpenGraph, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const html = graphHtml()
    if (!html) return ''
    await shell.openPath(html)
    return html
  })

  // --- Filesystem pickers ---
  ipcMain.handle(IPC.pickFolder, async (e) => {
    assertMainWindow(e)
    // Trust boundary is main, not the renderer — this persists a settings write (meetingsFolder), so it
    // must be gated the same as every other settings-writer. Without this, a DevTools/compromised-renderer
    // caller could silently redirect where transcripts are written even with auth enforced.
    if (!requireAuth()) return { cancelled: true }
    // Same LSUIElement-accessory-app reasoning as recapPdf above: anchor to `win` so the dialog actually
    // surfaces instead of silently hanging with nothing to attach to.
    const openDialogOpts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      message: 'Choose where Métis saves meeting transcripts'
    }
    const r = win ? await dialog.showOpenDialog(win, openDialogOpts) : await dialog.showOpenDialog(openDialogOpts)
    if (!r.canceled && r.filePaths[0]) setSettings({ meetingsFolder: r.filePaths[0] })
    return publicSettings()
  })

  // Team transcripts: pick a shared folder whose meeting transcripts are ALSO ingested into this brain
  // (settings.teamTranscriptFolders). Appended (deduped) rather than replacing meetingsFolder — this
  // never touches where the user's OWN meetings are saved.
  ipcMain.handle(IPC.addTeamTranscriptFolder, async (e) => {
    assertMainWindow(e)
    const openDialogOpts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      message: "Choose a shared folder whose transcripts feed this brain (e.g. a teammate's meetings folder)"
    }
    const r = win ? await dialog.showOpenDialog(win, openDialogOpts) : await dialog.showOpenDialog(openDialogOpts)
    if (!r.canceled && r.filePaths[0]) {
      const picked = r.filePaths[0]
      const current = getSettings().teamTranscriptFolders ?? []
      if (!current.includes(picked)) setSettings({ teamTranscriptFolders: [...current, picked] })
    }
    return publicSettings()
  })
  ipcMain.handle(IPC.removeTeamTranscriptFolder, async (e, folder: unknown) => {
    assertMainWindow(e)
    const target = typeof folder === 'string' ? folder : ''
    const current = getSettings().teamTranscriptFolders ?? []
    setSettings({ teamTranscriptFolders: current.filter((f) => f !== target) })
    return publicSettings()
  })

  ipcMain.handle(IPC.openPath, (e) => {
    assertMainWindow(e)
    return requireAuth() ? shell.openPath(resolveMeetingsFolder(getSettings())) : ''
  })
  // --- Recall (meeting history): list/search/open ---
  ipcMain.handle(IPC.recallList, (e) => {
    assertMainWindow(e)
    return requireAuth() ? listMeetings() : []
  })
  ipcMain.handle(IPC.recallSearch, (e, q: string) => {
    assertMainWindow(e)
    return requireAuth() ? searchMeetings(String(q ?? '')) : []
  })
  ipcMain.handle(IPC.recallOpen, (e, file: string) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const folder = resolveMeetingsFolder(getSettings())
    const safeName = basename(String(file ?? '')) // basename blocks traversal
    // Only ever open Métis's own .md meeting transcripts. The meetings folder is user-chosen
    // (could be Desktop/Downloads), and shell.openPath launches the OS handler for whatever it finds,
    // which would execute a .command/.app/.exe. Mirror deleteMeeting()/debriefSave()'s .md guard.
    if (!safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') return ''
    const path = join(folder, safeName)
    const encrypted = isEncryptedFile(path)
    auditLog('recall.open', { encrypted })
    // Encrypted transcripts are unreadable in an editor — open a decrypted temp copy instead.
    if (encrypted) return shell.openPath(decryptToTemp(path))
    return shell.openPath(path)
  })

  // "Open brain folder for Claude" (the handshake): reveal the published wiki — a plaintext, self-describing
  // mirror with a CLAUDE.md entry doc — so the user can point Claude at it (a Claude Project, Claude Desktop,
  // or a synced-folder connector). Gated on publishBrainPages in the UI; when publishing is on the folder
  // exists (settingsSet fires publishAll on enable). Returns the path so the renderer can show/copy it.
  ipcMain.handle(IPC.openBrainForClaude, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, path: '' }
    const s = getSettings()
    const dir = wikiDir(s)
    if (!s.publishBrainPages || !existsSync(dir)) return { ok: false, path: dir }
    await shell.openPath(dir)
    return { ok: true, path: dir }
  })

  // --- Listening state (tray icon + Dust conversation reset + power-save block) ---
  ipcMain.handle(IPC.listeningState, (e, on: unknown) => {
    assertMainWindow(e)
    listeningActive = !!on // fresh-question boundary (askStart) is suspended while a meeting is live
    setTrayRecording(!!on)
    setRecordingPowerSaveBlock(!!on)
    // A new meeting starting is the one clean boundary for Dust conversation continuity — everything
    // from here until the NEXT meeting starts shares one conversation (see resetDustConversation).
    // It's also the clean boundary to free Parakeet's ~487MB native recognizer between meetings/on idle,
    // instead of leaving it resident in the main process for the rest of the app's life.
    if (on) {
      resetDustConversation()
      // MQA-043: the same boundary must reset Speaker Intelligence's session labels. speaker-id.ts only
      // auto-resets after a >30 min silence gap, so two meetings closer together than that inherited the
      // previous meeting's cluster identities — a new participant would be labelled "Speaker 3" because
      // two other people spoke in the earlier call. resetSession() existed and was unit-tested but had no
      // production caller. Deliberately NOT wrapped in a lazy getter: if Speaker Intelligence was never
      // started this session there is no session state to clear, and building the instance here would
      // probe the sherpa addon on a path that does not need it.
      speakerIdInstance?.resetSession()
      // Pre-create the new meeting's conversation in the background (fire-and-forget) so the FIRST
      // quick action / ask of the meeting doesn't pay the createConversation round trip. Keyed to the
      // base agent — the interactive speed pin in attempt() routes all mid-meeting asks there.
      const s = getSettings()
      const dustKey = getApiKey('dust')
      const baseAgent = (s.providerModels['dust'] || '').trim()
      if (dustKey && s.dustWorkspaceId && baseAgent) {
        void prewarmDustConversation(
          { apiKey: dustKey, workspaceId: s.dustWorkspaceId, baseURL: s.dustBaseUrl },
          baseAgent
        )
      }
    } else parakeetRelease()
  })

  // --- Window management ---
  ipcMain.handle(IPC.windowResize, (e, payload: { height: number; width?: number }) => {
    assertMainWindow(e)
    // A view can opt into reporting its own visible width (the collapsed control mini-pill, and a toast
    // that widens the pill to fit itself while minimized) instead of relying on the fixed
    // BAR_WIDTH/PILL_WIDTH guess. Without this the pill's real content (~170px) sat centered inside the
    // fixed 220px window, leaving an invisible ~25px-per-side strip that still blocked clicks to whatever
    // was behind it. Floor/ceiling guard against a measurement glitch reporting something absurd — the
    // ceiling is BAR_WIDTH itself since nothing legitimately needs to be wider than the full bar (a lower
    // ceiling here once clipped a wider toast's own content that had genuinely asked for more room).
    if (typeof payload?.width === 'number' && Number.isFinite(payload.width)) {
      // +10 (not the height report's +2) gives the pill's own box-shadow/glow room to render without
      // being hard-clipped at the window edge — see the .aw-pill / .aw-mark-glow comments in styles.css.
      currentWidth = Math.max(120, Math.min(Math.ceil(payload.width) + 10, BAR_WIDTH))
    }
    // Same finite-number guard as width: a NaN/Infinity height from a renderer layout glitch would
    // otherwise reach resizeTo's Math.round/min/max unclamped, poisoning them to NaN and making
    // win.setBounds throw or leave the window in a broken size. Fall back to BAR_HEIGHT instead.
    const height =
      typeof payload?.height === 'number' && Number.isFinite(payload.height) ? payload.height : BAR_HEIGHT
    resizeTo(height)
  })
  ipcMain.handle(IPC.windowMode, (e) => {
    assertMainWindow(e)
    setWindowMode()
  })
  ipcMain.handle(IPC.windowMinimize, (e, narrow: unknown) => {
    assertMainWindow(e)
    setMinimizedWidth(!!narrow)
  })
  // Renderer ErrorBoundary catch: persist via the same sink as onFatal's main-process crashes, so a
  // caught render-throw survives to disk instead of only reaching console (gated behind
  // ASKTOTO_DEBUG_RENDERER, never on in a packaged build).
  ipcMain.handle(IPC.rendererCrash, (e, raw: unknown) => {
    assertMainWindow(e)
    const r = raw as { message?: unknown; stack?: unknown; componentStack?: unknown } | null
    const message = typeof r?.message === 'string' ? r.message : 'unknown renderer error'
    const stack = typeof r?.stack === 'string' ? r.stack : ''
    const componentStack = typeof r?.componentStack === 'string' ? r.componentStack : ''
    persistCrash('renderer-error-boundary', `${message}\nstack: ${stack}\ncomponentStack: ${componentStack}`, message)
  })
  // Drag the overlay from anywhere on the bar (the renderer's JS drag drives this with screen-pixel deltas).
  ipcMain.handle(IPC.windowMoveBy, (e, d: unknown) => {
    assertMainWindow(e)
    const { dx, dy } = (d ?? {}) as { dx?: number; dy?: number }
    if (typeof dx === 'number' && typeof dy === 'number' && Number.isFinite(dx) && Number.isFinite(dy)) {
      moveBy(dx, dy)
    }
  })
  ipcMain.handle(IPC.windowHide, (e) => {
    assertMainWindow(e)
    win?.hide()
  })
  ipcMain.handle(IPC.windowToggle, (e) => {
    assertMainWindow(e)
    toggleVisible()
  })
  ipcMain.handle(IPC.windowQuit, (e) => {
    assertMainWindow(e)
    // App.tsx's quitApp() already `await`s flushLiveMeeting() (a best-effort saveTranscript) before
    // invoking this — the meeting is already on disk by the time we get here, so the before-quit
    // handler below must not add its own redundant flush-and-wait on top of an already-safe quit.
    quitFlushDone = true
    app.quit()
  })
  // A fresh Screen Recording grant only takes effect for a NEW launch (macOS applies TCC changes to the
  // next process, not the already-running one) — this is the one-click recovery for that dead end, wired
  // to the Restart button the renderer shows once it detects the permission flipped mid-session. Leaves
  // quitFlushDone unset so the normal before-quit handler still flushes a live meeting first.
  ipcMain.handle(IPC.windowRelaunch, (e) => {
    assertMainWindow(e)
    app.relaunch()
    app.quit()
  })
  // --- Auto-update ---
  // Manual check for Settings → About → Updates. Exists alongside electron-updater's silent flow so
  // builds that cannot auto-install (unsigned macOS) still let the user DISCOVER a newer version and
  // reach the download page. Never throws — failures come back as a short human-readable error.
  ipcMain.handle(IPC.updateCheck, (e) => {
    assertMainWindow(e)
    return checkForUpdateNow()
  })
  ipcMain.handle(IPC.updateInstall, (e) => {
    assertMainWindow(e)
    // Lazy-required (same pattern + rationale as updater.ts): a static import here put
    // electron-updater's whole require tree (~46ms) on every boot for a once-per-update button.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    autoUpdater.quitAndInstall()
  })
  // --- Mail draft ---
  // mailto: fallback for the follow-up draft (Phase 1) — opens the user's own default mail client with
  // a prefilled draft; sending stays entirely manual. No attachments possible via mailto (real Outlook
  // drafts with attachments are a later phase, gated on Microsoft Graph scope consent). Some mail
  // clients/OSes cap mailto: URL length, so long bodies are truncated with the full text left on the
  // clipboard instead of silently cutting content the user can't recover.
  ipcMain.handle(IPC.openMailDraft, (e, input: { subject?: string; body?: string }) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const subject = typeof input?.subject === 'string' ? input.subject : ''
    const rawBody = typeof input?.body === 'string' ? input.body : ''
    const MAX_BODY = 1500
    const truncated = rawBody.length > MAX_BODY
    const body = truncated ? rawBody.slice(0, MAX_BODY) + '\n\n[Truncated — full text copied to your clipboard.]' : rawBody
    if (truncated) clipboard.writeText(rawBody)
    void shell.openExternal(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`)
    return { truncated }
  })
}

// ─── asr-model:// custom protocol ────────────────────────────────────────────
// The packaged renderer loads over file://, which cannot fetch from the network.
// We register a privileged custom scheme so the Whisper worker and transformers.js
// can load bundled model weights (and the ONNX-runtime WASM blobs) via fetch()
// without any network call. registerSchemesAsPrivileged MUST run before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'asr-model',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })
  app.whenReady().then(async () => {
  initLogging() // route main-process logs to a rotated file before anything else can fail
  await installProxyAwareFetch() // route provider fetch through the env/OS proxy so Dust etc. work behind a corporate proxy
  // Warm the CLI binary cache at boot when a CLI provider is connected, so the session's FIRST CLI ask
  // doesn't stall on the login-shell PATH lookup (it only ran on sign-in before — i.e. once ever).
  try {
    const s0 = getSettings()
    if (s0.cliConnected['claude-cli'] || s0.cliConnected['codex-cli']) prewarmCli()
  } catch {
    /* best-effort warm-up */
  }
  // Cahê pilot only (a no-op everywhere else): seed the installer-embedded Kimi key into the normal
  // encrypted keystore, exactly once per profile. Settings/the keystore are safe to touch here — same
  // phase as the first getSettings() read just above. See cahe-embedded-key.ts for the one-time-seed
  // design that lets a user's later key change/removal stick.
  importEmbeddedCaheKey()
  // Cahê M13: one-time enable of the on-device model so the background screen reader works out of the box
  // (own marker → also migrates existing pilot profiles upgraded from 1.0.7). See cahe-embedded-key.ts.
  seedCaheLocalAiForBackgroundScreen()
  // Windows toast attribution: a process's AppUserModelID must match the installed shortcut's AUMID
  // (electron-builder sets it to appId) or Windows silently drops native Notifications — which breaks
  // the meeting-reminder toast for portable-build and launch-at-login users (no shortcut in the launch
  // path). Set it to the exact appId, before createTray/createWindow/any Notification.
  if (process.platform === 'win32') app.setAppUserModelId('com.mantu.asktoto')
  // Windows CreateProcess searches the current working directory for a bare-name child executable
  // before it searches PATH — if AskToto is ever launched from an attacker-writable cwd, a planted
  // binary (uv/python/npm/where/tar/cmd, etc.) could get executed by any later spawn. Move cwd to our
  // own userData dir (always exists at startup; nothing in the app relies on process.cwd()) before any
  // spawn/createTray/createWindow happens, so that class of attack has nothing left to land in.
  if (process.platform === 'win32') {
    try { process.chdir(app.getPath('userData')) } catch { /* best-effort */ }
  }
  // Reconcile the OS login item with the effective launchAtLogin setting once at boot. Covers two gaps:
  // a managed-config/default launchAtLogin:true is never registered (setLoginItemSettings only ran on an
  // explicit user patch), and OS-side drift (Task Manager Startup disable, AV cleanup, profile migration)
  // silently diverges from the persisted preference. Idempotent — only writes when they actually differ.
  try {
    const want = getSettings().launchAtLogin
    if (app.getLoginItemSettings().openAtLogin !== want) app.setLoginItemSettings({ openAtLogin: want })
  } catch { /* best-effort — never block startup */ }
  // Unpackaged (dev/QA) runs show Electron's default icon in the Dock — brand them with the Mantu M so
  // a dev window is never mistaken for "the Electron thing". Packaged builds get build/icon.png baked
  // in by electron-builder (mac .icns / win .ico) and don't need this.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try { app.dock?.setIcon(join(__dirname, '../../build/icon.png')) } catch { /* cosmetic only */ }
  }
  // Prune stale crash logs to the most recent 5 (best-effort; filenames sort lexicographically by ts, then
  // by persistCrash's per-process tie-breaker suffix — both fixed-width-enough within a run to sort right).
  try {
    const ud = app.getPath('userData')
    const crashLogs = readdirSync(ud)
      .filter((f) => /^crash-\d+-\d+\.log$/.test(f))
      .sort()
    for (const f of crashLogs.slice(0, Math.max(0, crashLogs.length - 5))) {
      try { unlinkSync(join(ud, f)) } catch { /* ignore */ }
    }
  } catch { /* best-effort — never block startup */ }
  // Never let an unhandled error crash the overlay silently — log to file, audit, write a crash dump, and
  // (for a fatal exception) offer a one-time relaunch while defaulting to keep-alive.
  process.on('uncaughtException', (err) => onFatal('uncaughtException', err))
  process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason))
  if (process.env.ASKTOTO_SELFTEST) {
    try {
      await runSelfTest(process.env.ASKTOTO_SELFTEST)
    } catch (e) {
      console.error('selftest failed', e)
    }
    app.quit()
    return
  }
  if (!app.isPackaged) loadDotEnv() // dev convenience only; never read a stray .env in production
  sweepStaleTempFiles() // remove any decrypted-transcript temp copies orphaned by a previous hard-kill
  // Promote any orphaned crash-recovery drafts into real meetings BEFORE the retention sweep, so a
  // recovered meeting is visible in History and immediately subject to the same retention policy.
  recoverOrphanDrafts(getSettings()).then((r) => {
    if (r.recovered > 0) auditLog('transcript.recovered', { recovered: r.recovered })
  }).catch(() => { /* best-effort — never block startup */ })
  // Auto-delete meetings past the configured retention window (off by default — see transcriptRetentionDays).
  // Runs at launch AND every 6 hours after: this overlay realistically stays up for weeks, so a launch-only
  // sweep silently stopped enforcing retention the day after boot (storage-limitation promise broken).
  const runRetentionSweep = (): void => {
    sweepExpiredMeetings(getSettings().transcriptRetentionDays).then((r) => {
      if (r.deleted > 0) {
        auditLog('transcript.deleted', { bulk: true, expired: true, deleted: r.deleted })
        void requestSourceRefresh(getSettings())
      }
    }).catch(() => { /* best-effort — never block startup or the interval */ })
  }
  runRetentionSweep()
  trackTimer(setInterval(runRetentionSweep, 6 * 60 * 60 * 1000))
  // Guarded like the neighboring dock.setIcon / crash-log pruning below — a throw here must never abort
  // createTray/registerShortcuts/createWindow further down the boot sequence.
  if (process.platform === 'darwin') {
    try {
      app.dock?.hide()
    } catch { /* best-effort — never block startup */ }
  }

  // Boot each subsystem in its own try/catch so a failure in one can't silently abort the rest. Defined
  // here (ahead of its call sites) so the display-media/permission/asr-model registrations immediately
  // below — previously registered unguarded — run inside it too: a throw during any of those must not
  // take out createTray/registerShortcuts/createWindow further down the boot sequence.
  const runStep = (name: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      // console.error is a no-op in a packaged GUI build with no console — route to the real sinks so a
      // boot-step failure is actually diagnosable and shows up in the audit trail.
      mainLog.error(`[boot] ${name} failed:`, e)
      auditLog('app.crash', { kind: 'boot_step', step: name })
    }
  }

  // System-audio loopback: when the renderer calls getDisplayMedia for audio,
  // hand back the system audio loopback device (the "Them" channel) only.
  // Screenshot capture uses desktopCapturer directly, so no video track is ever returned here.
  runStep('setDisplayMediaHandler', () => {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      // Electron validates the callback argument against the request: denying a request that asked for
      // video (our renderer requests a 1fps video track to bootstrap the macOS ScreenCaptureKit session
      // for audio loopback) with callback({}) makes Electron throw "Video was requested, but no video
      // stream was provided". Because this handler is async, that throw escapes as an unhandledRejection.
      // Wrap every callback call: the deny still reaches the renderer (its getDisplayMedia rejects and
      // listen.ts falls back to mic-only), we just don't let the validation throw crash the main process.
      const respond = (spec: Parameters<typeof callback>[0]): void => {
        try {
          callback(spec)
        } catch (err) {
          mainLog.warn(`[display-media] callback rejected: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      try {
        await handleDisplayMedia(request, respond)
      } catch (err) {
        // Absolute backstop: nothing in the loopback grant path may escape as an unhandledRejection.
        mainLog.warn(`[display-media] handler error: ${err instanceof Error ? err.message : String(err)}`)
        respond({})
      }
    },
    { useSystemPicker: false }
  )

  async function handleDisplayMedia(
    request: Parameters<NonNullable<Parameters<typeof session.defaultSession.setDisplayMediaRequestHandler>[0]>>[0],
    callback: Parameters<NonNullable<Parameters<typeof session.defaultSession.setDisplayMediaRequestHandler>[0]>>[1]
  ): Promise<void> {
      const frame = request.frame
      const mainFrame = win?.webContents.mainFrame
      const origin = request.securityOrigin
      const mainUrl = win?.webContents.getURL() ?? ''
      let expectedOrigin = ''
      try {
        expectedOrigin = new URL(mainUrl).origin
      } catch {
        expectedOrigin = mainUrl
      }
      const isMainFrame = !!frame && frame === mainFrame
      // In the PACKAGED app the renderer is loaded from file://, whose origin is the opaque string
      // "null" (from new URL(...).origin) while the request reports securityOrigin "file:///". Without
      // this case the check denied EVERY system-audio request in production. The real identity guard is
      // isMainFrame (frame === the main window's frame); the origin match is defense-in-depth.
      const isFileOrigin = origin.startsWith('file://')
      const originOk =
        !mainUrl || origin === expectedOrigin || origin === mainUrl || (expectedOrigin === 'null' && isFileOrigin)
      if (process.env.ASKTOTO_DEBUG) {
        console.log('[display-media]', {
          origin,
          expectedOrigin,
          frameUrl: frame?.url,
          mainUrl,
          mainFrame: isMainFrame,
          originOk,
          audioRequested: request.audioRequested,
          videoRequested: request.videoRequested,
          armed: audioArmed
        })
      }
      if (!audioArmed) {
        callback({}) // deny unless the user explicitly started Listen
        return
      }
      if (!isMainFrame || !originOk) {
        callback({}) // deny requests from unexpected origins or subframes
        return
      }
      if (!request.audioRequested) {
        callback({}) // must be an audio (loopback) request
        return
      }
      // Windows loopback doesn't bind audio to a video stream the way macOS's ScreenCaptureKit does
      // (see the comment below) — listen.ts's isWindows branch requests getDisplayMedia({ audio: true })
      // with no video key at all, so request.videoRequested is false here. Skip desktopCapturer entirely
      // in that case: no screen source is grabbed for a request that never wanted one.
      // CAVEAT: Chromium's support for Windows loopback-audio-without-video hasn't been validated on real
      // hardware yet. If it turns out a bound video track is still required, listen.ts already retries
      // with { video: { frameRate: 1 }, audio: true }, which falls through to the video path below.
      if (!request.videoRequested) {
        callback({ audio: 'loopback' })
        return
      }
      // macOS binds system-audio loopback to a ScreenCaptureKit screen stream, so the loopback only
      // starts when a screen video source is attached. We grant one here (gated above on armed +
      // main-frame + origin); the renderer drops the video track instantly, so no frame is rendered,
      // saved, or sent. This is the only way to capture the "them" side of a call on macOS.
      //
      // getSources can BOTH return empty transiently (fresh grant) AND reject outright with "Failed to
      // get sources." (a ScreenCaptureKit hiccup, often right after a content-protection toggle). This
      // callback is async, so a reject escapes as a fatal unhandledRejection and crashes the app on
      // Listen start. Guard every path: retry on empty OR throw, then deny gracefully — a callback({})
      // makes the renderer's getDisplayMedia reject with AbortError, which listen.ts already catches and
      // surfaces as "couldn't capture system audio" instead of taking the whole app down.
      const sources: Electron.DesktopCapturerSource[] = await getScreenSourcesWithRetry(
        () => desktopCapturer.getSources({ types: ['screen'] }),
        isUsableScreenSource,
        {
          onError: (error, attempt) =>
            mainLog.warn(`[display-media] getSources failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`)
        }
      )
      if (!sources.length) {
        auditLog('capture.failed', { reason: 'loopback_no_screen_source', phase: 'listen' })
      }
      const screenSrc = sources[0]
      callback(screenSrc ? { video: screenSrc, audio: 'loopback' } : {})
  }
  })

  // Deny every web permission by default; only the main window may use audio media (the Listen mic) or
  // write to the system clipboard (Copy Summary / Export JSON / copy-code buttons all need this — it's a
  // one-way, user-initiated write of text the app itself built, not a snooping vector). clipboard-READ
  // (reading arbitrary external clipboard content) stays denied along with geolocation, notifications,
  // camera, USB, MIDI, etc.
  runStep('permissionHandlers', () => {
    const allowPermission = (wc: Electron.WebContents | null, permission: string): boolean =>
      (permission === 'media' || permission === 'clipboard-sanitized-write') && !!win && wc === win.webContents
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) =>
      callback(allowPermission(wc, permission))
    )
    session.defaultSession.setPermissionCheckHandler((wc, permission) => allowPermission(wc, permission))
  })

  // ─── asr-model:// protocol handler ───────────────────────────────────────
  // Maps asr-model://<host>/<pathname> → RES_BASE/<host>/<pathname> on disk.
  // This lets the Whisper worker (served over file://) use fetch() to load
  // bundled ONNX model weights and WASM blobs with zero network access.
  // Path-traversal guard: the resolved target must stay within RES_BASE (separator-safe on Windows).
  runStep('asrModelProtocol', () => {
    const REPO_ROOT = join(__dirname, '..', '..')
    const RES_BASE = app.isPackaged
      ? process.resourcesPath
      : join(REPO_ROOT, 'resources')
    // The traversal check below compares against the REAL base: request targets are realpath-resolved
    // (symlink-escape guard), so an unresolved base would describe the same directory in different words
    // and 403 every asset — see realResourceBase for the Windows-junction case this broke.
    const RES_BASE_REAL = realResourceBase(RES_BASE)

    // A packaged app is ALWAYS offline-only, even if its installer is corrupt/incomplete. Returning true
    // keeps the worker's remote resolver disabled so missing assets fail locally with a reinstall message
    // instead of silently downloading after install. Development may still use its explicit remote path.
    const ASR_BUNDLED = app.isPackaged || asrManifestComplete(RES_BASE)
    ipcMain.handle(IPC.asrBundled, (e) => {
      assertMainWindow(e)
      return ASR_BUNDLED
    })

    protocol.handle('asr-model', async (req) => {
      // The renderer/worker that calls fetch() here is loaded over file:// (a distinct origin from
      // asr-model://), so this is a cross-origin request. registerSchemesAsPrivileged's corsEnabled just
      // ADMITS the scheme to Chromium's CORS protocol — it does not exempt its responses from the CORS
      // response check the way, say, a plain `file:` fetch is exempt. Every response below (success or
      // error) carries an explicit Access-Control-Allow-Origin so a future CORS-sensitive caller of this
      // scheme can't hit the same generic "TypeError: Failed to fetch" this app's real root cause (a
      // corrupted default User-Agent — see cahe-edition.ts's initializeCaheEditionIdentity) was originally
      // mistaken for.
      const respond = (body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}): Response => {
        const headers = new Headers(init.headers)
        headers.set('Access-Control-Allow-Origin', '*')
        return new Response(body, { ...init, headers })
      }
      try {
        const url = new URL(req.url)
        // Restrict to the two roots this protocol is meant to serve. Without this, app.asar and other
        // resourcesPath siblings resolve inside RES_BASE too and would be served as raw source bytes.
        if (url.host !== 'models' && url.host !== 'ort') return respond(null, { status: 403 })
        // url.host = e.g. "models" or "ort"; url.pathname = e.g. "/Xenova/whisper-base/config.json"
        const rel = decodeURIComponent(url.host + url.pathname)
        const abs = resolve(RES_BASE, rel)
        // Symlink escape guard: resolve symlinks to their real path before the traversal check.
        // realpathSync throws ENOENT for non-existent paths → return 404.
        let real: string
        try {
          real = realpathSync(abs)
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return respond(null, { status: 404 })
          }
          throw e
        }
        // Path-traversal guard (separator-safe on Windows): reject any path that escapes RES_BASE.
        // Run the check against the real (symlink-resolved) path on BOTH sides, not the raw abs path.
        if (!isInsideResourceBase(RES_BASE_REAL, real)) {
          return respond(null, { status: 403 })
        }
        const resp = await net.fetch(pathToFileURL(real).toString())
        const TYPES: Record<string, string> = {
          '.mjs': 'text/javascript',
          '.js': 'text/javascript',
          '.wasm': 'application/wasm',
          '.json': 'application/json',
          '.onnx': 'application/octet-stream',
          '.txt': 'text/plain'
        }
        const ct = TYPES[extname(real).toLowerCase()]
        const headers = new Headers(resp.headers)
        if (ct) headers.set('Content-Type', ct)
        // net.fetch() against a file:// URL doesn't itself supply Content-Length, which makes
        // transformers.js fall back to a growable buffer with a "Will expand buffer when needed" console
        // warning on every load. RES_BASE files are trusted, already-realpath-resolved local disk reads —
        // statSync here is cheap and lets the caller size its buffer up front.
        if (!headers.has('Content-Length')) {
          try {
            headers.set('Content-Length', String(statSync(real).size))
          } catch {
            /* best-effort — a missing Content-Length just re-enables the growable-buffer path */
          }
        }
        return respond(resp.body, { status: resp.status, statusText: resp.statusText, headers })
      } catch {
        return respond(null, { status: 500 })
      }
    })
  })

  // runStep is defined above (ahead of the display-media/permission/asr-model registrations so they can
  // use it too). From here: stand up the tray + global shortcuts BEFORE the window. If createWindow() ever
  // throws (transparent / always-on-top windows can fail on some GPU/compositor configs), the user still
  // keeps a Show/Quit path instead of a hidden, unkillable process — the dock is already hidden and the
  // taskbar is skipped.
  // Eagerly refresh the Dust CLI session at launch (Tony: "always stay connected") rather than waiting
  // for a request to 401 first. Reading the Dust CLI's keychain item from Métis — a different binary
  // than the `dust`/keytar process that created it — does trigger a one-time macOS "allow access" prompt;
  // on a real (signed or at least stable) install macOS remembers "Always Allow" for that app identity, so
  // this costs one prompt ever, not one per restart. Only bothers if Dust was connected before; best-effort
  // and fully silent on failure — the existing lazy on-401 refresh (refreshDustAuth above) still covers it
  // if this doesn't run or doesn't succeed.
  // Skip the eager refresh while the imported token is still fresh (<45 min of its ~1h life): the
  // keychain read behind refreshDustCliSession can cost a macOS keychain password prompt on builds
  // whose code identity churns (unsigned dev builds), and a fresh token has nothing to gain from it.
  // The lazy on-401 refresh (refreshDustAuth above) still self-heals expiry invisibly either way.
  // MQA-051/MQA-054: that freshness window is the ONLY thing this needs to be gated on. The keep-warm
  // used to be darwin-only, back when the whole Dust CLI path was — but the prompt cost it was avoiding
  // does not exist off macOS (dust-secret-store.ts: reading the current user's own credential never
  // prompts on Windows/Linux) and dustcli.ts already routes the Windows `dust.cmd` shim. Gated to darwin
  // it left Windows with no proactive re-mint at all, so the ~1h token lapsed and the hookless background
  // paths (brain ingest, which passes no refreshDustAuth) dead-ended on a 401.
  const DUST_TOKEN_FRESH_MS = 45 * 60 * 1000
  const refreshAndPersistDust = (at: string): void => {
    if (!hasApiKey('dust')) return
    if (Date.now() - getSettings().dustTokenMintedAt <= DUST_TOKEN_FRESH_MS) return
    void refreshDustCliSession()
      .then((fresh) => {
        if (!fresh.ok || !fresh.token || !fresh.workspaceId) return
        setApiKey('dust', fresh.token)
        setSettings({
          dustWorkspaceId: fresh.workspaceId,
          dustBaseUrl: fresh.baseUrl || 'https://dust.tt',
          dustTokenMintedAt: Date.now()
        })
        auditLog('dust.token.refreshed', { at })
      })
      .catch(() => {
        /* best-effort — the lazy on-401 refresh in dust.ts still covers this */
      })
  }
  // Wrapped in runStep: refreshAndPersistDust does synchronous work (getSettings, hasApiKey) before its
  // async refreshDustCliSession() call, so an unguarded throw here would abort createTray/registerShortcuts/
  // createWindow below it — a startup Dust-refresh hiccup must never take down window creation.
  runStep('refreshDustSession', () => refreshAndPersistDust('startup'))
  // Keep the session warm for the app's whole lifetime: re-mint whenever the token passes 45 min of
  // its ~1h life, so it never expires mid-meeting and the user never sees a Dust reconnect. The
  // single-flight guard inside refreshDustCliSession makes this safe alongside the on-401 path.
  trackTimer(setInterval(() => refreshAndPersistDust('interval'), 10 * 60 * 1000))

  // License re-validation, same fire-and-forget lifetime interval as the Dust keep-warm above: skips
  // entirely unless the gate is actually on and this device is currently activated, so an unlicensed
  // build (the shipped default) never touches the network here. For an always-on machine that's
  // offline for days, this is what lands a revocation within half a day instead of waiting for the
  // renderer's own once-per-launch check (which only runs at the next relaunch).
  trackTimer(
    setInterval(
      () => {
        if (getSettings().licenseGateEnabled && getSettings().licenseValid) void heartbeat()
      },
      12 * 60 * 60 * 1000
    )
  )

  // Catch the case where encryption was already on (managed-config or a previous run) with a stale
  // plaintext graph sitting on disk since before the first settingsGet poll from the renderer.
  runStep('purgeGraphIfEncryptedAndStale', () => purgeGraphIfEncryptedAndStale('encryption-active-boot'))
  // createTray/registerShortcuts stay ahead of createWindow (see the boot-order comment above) — but
  // registerIpc has no such dependency: every ipcMain.handle closure inside it reads `win`/`tray` lazily
  // at INVOCATION time (assertMainWindow etc.), never at registration time, and the renderer can't issue
  // its first IPC call before its own <script> has executed anyway. Moving it after createWindow lets the
  // OS start loading/compositing the renderer a little earlier instead of waiting behind ~60 synchronous
  // ipcMain.handle registrations first.
  runStep('createTray', createTray)
  runStep('registerShortcuts', registerShortcuts)
  runStep('createWindow', createWindow)
  // Synchronous OneDrive filesystem work (mkdir + two writeFileSync calls on first run) — nothing
  // before the window depends on the folder existing yet (saveMeeting/saveNote create it themselves on
  // first use), so it no longer sits ahead of createWindow on the boot path.
  runStep('ensureMeetingsFolder', () => ensureMeetingsFolder(getSettings()))
  runStep('initializeImportJobs', initializeImportJobs)
  runStep('registerIpc', registerIpc)
  // Import checkpoints are encrypted and main-owned. Resume after IPC registration so the hidden decoder
  // can safely report chunks as soon as it starts, without delaying first paint.
  const recoverImports = (): void => {
    if (!requireAuth()) {
      setTimeout(recoverImports, 1000)
      return
    }
    void importJobs?.recover().catch((error) => mainLog.warn('[import-jobs] recovery failed:', error))
  }
  recoverImports()
  runStep('registerScreenListeners', registerScreenListeners)
  // Establish real screen-capture readiness at boot on Windows, where the probe raises NO system prompt
  // and there is no queryable permission to read instead — without it getPlatformPermissions() reports
  // 'unknown' forever and the readiness checklist cannot tell the user whether screenshots will work
  // until one fails mid-meeting. Deliberately NOT run at boot on macOS: there the same call raises the
  // TCC prompt, which belongs in onboarding (permissionsRequestUpfront) where it is explained, not as an
  // unattended pop-up seconds after launch. Fire-and-forget: readiness reporting must never delay boot.
  if (process.platform === 'win32') {
    runStep('probeScreenCapture', () => {
      void probeScreenCapture().catch(() => false)
    })
  }
  runStep('startMeetingNotifier', startMeetingNotifier)
  runStep('initAutoUpdate', () => initAutoUpdate(() => win))
  // Resume durable live/backfill work and reconcile OneDrive-synced meeting files after first paint.
  // Directory scans, rather than fs.watch, are deliberate: Files On-Demand and Windows sync do not
  // reliably emit every watcher event. A one-minute cadence keeps Intelligence current without
  // depending on cloud-sync events; provider-free runs only repair already-saved local extractions.
  const BRAIN_RECONCILE_MS = 60 * 1000
  setTimeout(() => {
    resumeBackfillIfPending()
    reconcileMeetingsInBackground()
  }, 15_000)
  trackTimer(setInterval(reconcileMeetingsInBackground, BRAIN_RECONCILE_MS))

  app.on('activate', () => {
    if (!win) createWindow()
    else win.show()
  })
  }).catch((e) => {
    // console.error is a no-op in a packaged GUI build with no console — route to the real sinks (same
    // redact-before-log discipline as onFatal) so a boot failure is actually diagnosable and audited.
    const detail = e instanceof Error ? e.stack || e.message : String(e)
    mainLog.error('[boot] Métis startup failed:', redactSecrets(detail))
    auditLog('app.crash', { kind: 'boot', message: redactSecrets(e instanceof Error ? e.message : String(e)) })
  })
}

app.on('window-all-closed', () => {
  // Overlay app: stay alive in tray; quit only via tray/menu.
})

// Tray "Quit AskToto" (and any other path that calls app.quit() directly, e.g. Cmd+Q on macOS) used to
// tear the process down with zero drain: the in-progress meeting's transcript lives only in renderer
// React state, written to disk solely by a 60s autosave interval, so a graceful-looking Quit could lose
// up to 60s of a meeting or the entire thing for a sub-60s one. The in-app Settings "Quit" button is
// already safe — App.tsx's quitApp() awaits flushLiveMeeting() before calling window.toto.quit(), which
// marks quitFlushDone above and lets this handler no-op. For every other quit path, give the renderer one
// bounded chance to save: recordingPowerSaveBlockerId is non-null for exactly the duration of an active
// meeting (see setRecordingPowerSaveBlock), so it's a reliable "is a meeting in progress" signal here in
// main. Reuses the existing 'reset' hotkey, which already runs saveMeetingNow() for a live meeting
// (App.tsx's reset()) — no new IPC channel needed.
app.on('before-quit', (e) => {
  if (quitFlushDone || recordingPowerSaveBlockerId === null || !win || win.isDestroyed()) return
  e.preventDefault()
  quitFlushDone = true
  try {
    win.webContents.send(IPC.hotkey, 'reset')
  } catch {
    /* window may already be gone */
  }
  setTimeout(() => app.quit(), 2000)
})

app.on('will-quit', () => {
  // will-quit can fire BEFORE the app ever finished becoming ready — a quit requested during the async
  // startup sequence, an automation/Playwright app.close(), or an early abort. Calling globalShortcut in
  // that window throws "globalShortcut cannot be used before the app is ready" as an UNCAUGHT exception
  // (the observed crash), and there is nothing registered to unregister anyway — so gate it on isReady().
  // Each cleanup step is independent (its own try): a throw in one must never skip the sidecar kill
  // below, because an orphaned llama-server outliving the app the user just quit is the worse failure.
  if (app.isReady()) {
    try {
      globalShortcut.unregisterAll()
    } catch (e) {
      mainLog.warn('[will-quit] globalShortcut.unregisterAll failed', e)
    }
  }
  if (notifTimer) clearInterval(notifTimer)
  // Cancel every tracked background poller FIRST, before the network stack is torn down — a Dust-refresh
  // or reconcile interval firing a resolve mid-teardown is the shutdown-race SIGTRAP class.
  for (const t of backgroundTimers) {
    try {
      clearInterval(t)
    } catch {
      /* already cleared */
    }
  }
  backgroundTimers.length = 0
  // Stop the background screen-preprocess watcher (kills its long-lived powershell child) before the
  // sidecar kill — an orphaned watcher process outliving the app would keep polling the foreground window.
  try {
    screenPreprocess.stop()
  } catch (e) {
    mainLog.warn('[will-quit] screenPreprocess.stop failed', e)
  }
  // Kill the llama-server sidecar synchronously (SIGKILL, F3 hardening) — without this an on-device
  // suggest/summary/vision sidecar could outlive the app the user just quit.
  try {
    localRuntime.stop()
  } catch (e) {
    mainLog.warn('[will-quit] localRuntime.stop failed', e)
  }
  // Same F3 contract for the Apple fm-serve sidecar (macOS 27+ text engine) — an orphaned unauthenticated
  // loopback server outliving the app is strictly worse than an orphaned llama-server.
  try {
    fmRuntime.stop()
  } catch (e) {
    mainLog.warn('[will-quit] fmRuntime.stop failed', e)
  }
})
