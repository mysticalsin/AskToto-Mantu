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
import { readFileSync, existsSync, writeFileSync, realpathSync, readdirSync, unlinkSync, createReadStream, statSync, renameSync, rmdirSync, mkdirSync, copyFileSync } from 'node:fs'

// Enterprise checkbox: DevTools stay reachable only where they are a development tool. No secret ever
// reaches the renderer (publicSettings strips key material), but DevTools on a packaged build still
// exposes in-memory renderer state (transcript text, screen-context strings) to anyone at the keyboard,
// and every security questionnaire asks. ASKTOTO_DEVTOOLS=1 is the deliberate field-debugging override —
// an env var a local user could set, which is fine: whoever controls the local environment already owns
// this session; the control is about the DEFAULT posture, not about defeating a local admin.
// Shared with intelligence.ts so every window in src/main gates on ONE decision — see
// dev-env.ts's devToolsEnabled() for why this moved out of this file.
const DEVTOOLS_ENABLED = devToolsEnabled()
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  IPC,
  AskStartSchema,
  SetApiKeyPayloadSchema,
  ClearApiKeyPayloadSchema,
  TestApiKeyPayloadSchema,
  McpTestConnectionPayloadSchema,
  McpSaveConnectionPayloadSchema,
  McpDisconnectPayloadSchema,
  McpPushPayloadSchema,
  McpConnectionKindSchema,
  type McpConnection,
  type McpConnectionKind,
  LicenseActivatePayloadSchema,
  LicenseConfigPayloadSchema,
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
  SetCrmPushedPayloadSchema,
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
  type DiagnosticsExportResult,
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
  clearDustRefreshToken,
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
import { isProxyOperatorFault, isTransient, nextBackoff, stripProxyFaultMarker } from './llm/retry'
import { classifyExhaustion, type ExhaustionSignal } from './llm/exhaustion'
import { isBudgetExhausted, resetHeadroom } from './llm/usage-headroom'
import {
  isAuthFailure,
  isCoolingDown,
  recordAuthFailure,
  recordExhausted,
  recordRateLimited,
  recordSuccess,
  resetProviderHealth,
  unhealthyProviders
} from './llm/provider-health'

/** Wave 2 — session-scoped last successful failover hop for the one-shot UI chip. Never persisted. */
let lastFailoverNotice: { from: string; to: string; at: number; reason: string } | null = null
export function peekLastFailoverNotice(): typeof lastFailoverNotice {
  return lastFailoverNotice
}
export function dismissLastFailoverNotice(): void {
  lastFailoverNotice = null
}
import * as localRuntime from './llm/local-runtime'
import {
  localEligibleFor,
  localFallbackEligibleFor,
  localAnswerFloorEligibleFor,
  localBaseReady,
  localPrewarmEligible,
  localVisionPrivacyRequired,
  localPrimaryEligibleFor,
  pickPrimaryProvider,
  allowCrossProviderFailover,
  resolveRoutingMode
} from './llm/local-routing'
import { ensureLocalRuntimeStarted, prewarmLocal } from './llm/local'
import * as fmRuntime from './llm/fm-runtime'
import { extractScreenText } from './mac-helper'
import { createSpeakerId, type SpeakerId, type SpeakerLabel } from './speaker-id'
import {
  clampAxis,
  clampAxisMargin,
  clampHeight as islandClampHeight,
  isReachable as islandIsReachable,
  recenterXForWidth,
  refitToDisplay as islandRefitToDisplay,
  exclusiveOnboardingBounds,
  overlayRestSize,
  parkAfterExclusiveOnboarding,
  shouldIgnoreResizeWhilePeekResting,
  topCenterPosition,
  topClamp
} from './island/geometry'
import { getDisplayMetrics, registerDisplayMetricsInvalidation } from './island/metrics'
import { overlayUsesHover, parseOverlayLayout, type OverlayLayout } from '@shared/overlay-chrome'

// Lazy Speaker Intelligence singleton — building it probes the sherpa addon + embedding model, so defer
// until the first THEM window with the feature enabled (never on the startup path).
let speakerIdInstance: SpeakerId | null = null
function getSpeakerId(): SpeakerId {
  if (!speakerIdInstance) speakerIdInstance = createSpeakerId()
  return speakerIdInstance
}

/** Shared Speaker Intelligence label lookup for a THEM window — parakeetFeed, appleSpeechFeed and
 *  speakerEmbed all funnel through this one place so the settings gate + failure handling can't drift
 *  between the three chokepoints. Degrades to null on any failure, the feature being off, or the model
 *  being unprovisioned — a missing label must never break transcription. See speaker-id.ts's labelWindow
 *  for the echo-defense flag (`label.echo`) callers must check before attaching `label.name` anywhere. */
function labelThemAudio(samples: Float32Array): SpeakerLabel | null {
  if (!getSettings().speakerId.enabled) return null
  try {
    return getSpeakerId().labelWindow(samples)
  } catch (err) {
    mainLog.warn('[speaker-id] labeling failed', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Echo defense + operator profile upkeep (SPEAKER-INTELLIGENCE-PLAN §3.3) — feed a 'you' (mic) window's
 *  raw audio into the operator's rolling voiceprint so labelThemAudio can recognize the operator's own
 *  voice bleeding through the loopback. Fire-and-forget by construction (void return, swallows errors):
 *  called from the SAME handlers that already transcribe the window, and must never affect their result. */
function observeOperatorAudio(samples: Float32Array): void {
  if (!getSettings().speakerId.enabled) return
  try {
    getSpeakerId().observeOperatorWindow(samples)
  } catch (err) {
    mainLog.warn('[speaker-id] operator observation failed', err instanceof Error ? err.message : String(err))
  }
}
import { buildPrewarmMessages } from './llm/prewarm'
import { listModels as listLocalModels, bestModelForMachine, isDownloaded as localModelDownloaded } from './llm/local-models'
import { ensureLocalModel, localModelDownloadState, shouldFetchWeights } from './llm/local-model-download'
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
  exciseDeletedMeeting,
  markBrainChanged,
  requestBackfill,
  requestSourceRefresh,
  brainBackfillProgress,
  brainLiveIngestProgress,
  ingestFailureCounts,
  ingestFailureDetails,
  isPendingIngestRecord,
  resumeBackfillIfPending,
  reconcileMeetingsInBackground,
  settleCommitment,
  startRebuild
} from './brain/ingest'
import { runConsolidationIfDue, scheduleConsolidation } from './brain/consolidate'
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
import { publishEntity, removeFromWiki, publishAll, publishMeetingCard, removeWiki, wikiDir } from './brain/publish'
import { computeAttention } from './brain/attention'
import {
  openIntelligenceWindow,
  closeIntelligenceWindow,
  isIntelligenceSender,
  syncIntelContentProtection
} from './intelligence'
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
import { asrModelDownloadState, ensureHighTierAsrModel, isHighTierAsrModelReady, removeHighTierAsrModel } from './asr-model-download'
import { asrModelBytes } from './asr-model-manifest'
import { beginBootWatch, endBootWatch, describeEarlyDeath } from './boot-sentinel'
import { installProxyAwareFetch } from './net/install-proxy'
import {
  authStatus,
  signIn as authSignIn,
  signOut as authSignOut,
  requireAuth,
  setSessionClearedHandler,
  ssoBootstrapAllowed
} from './auth'
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
import { resetLanguageFollow as resetImportLanguageFollow, whisperImportTranscribe, stopWhisperHost } from './whisper-import'
import { buildPolishPrompt, parsePolishResponse, polishBatches, type PolishLine } from './polish'
import { detectLanguage as detectTextLanguage } from '@shared/lang-id'
import type { TranscriptLine } from '@shared/ipc'
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
  setMeetingCrmPushed,
  isMeetingConfidentialOnDisk,
  deleteAllMeetings,
  sweepExpiredMeetings
} from './recall'
import { initAutoUpdate, checkForUpdateNow, startUpdateDownload } from './updater'
import { runSelfTest } from './selftest'
import { devEnv, devToolsEnabled } from './dev-env'
import { readEvalMetrics, aggregateMetrics } from './metrics'
import { importDustCliSession, refreshDustCliSession } from './dustcli'
import {
  beginDustDeviceLogin,
  pollDustDeviceLoginOnce,
  listDustWorkspacesForToken,
  completeDustOAuthLogin,
  refreshDustOAuthSession
} from './dust-oauth'
import { asrManifestComplete } from './asr-manifest'
import { isInsideResourceBase, realResourceBase } from './asr-model-path'
import { detectCli, testCli, setupCli, installCli, loginCli, prewarmCli, checkCliSession } from './cli'
import { connectMcp, pushToMcp } from './mcp/mcpClient'
import { pushQueue, type OutboundAction, type OutboundActionKind } from './mcp/pushQueue'
import { activateLicense, checkLicenseGrace, fetchLicenseConfig, heartbeat, licenseDisplayStatus, noteQualifyingUse } from './license'
import {
  setMcpApiKey,
  getMcpApiKey,
  clearMcpApiKey,
  hasMcpApiKey,
  setMcpRefreshToken,
  getMcpRefreshToken,
  clearMcpRefreshToken
} from './mcp/mcpSecrets'
import {
  runClickupOAuth,
  refreshClickupToken,
  CLICKUP_MCP_ENDPOINT,
  tryAcquireClickupTokenLock,
  releaseClickupTokenLock
} from './mcp/clickupOAuth'
import {
  graphifyStatus,
  buildGraph,
  relatedNotes,
  graphHtml,
  scheduleRebuild,
  purgeGraphArtifacts
} from './graphify'
import { SaveMeetingSchema, SaveNoteSchema, stripProvisionalLines } from '@shared/ipc'
import {
  PROVIDERS,
  PROVIDER_IDS,
  providerBaseUrl,
  requiresUserBaseUrl,
  resolveModelTier,
  applyInteractiveGuardrail,
  reasoningEffortFor,
  type ProviderId,
  type ProviderDef
} from '@shared/providers'
import { routeTier } from '@shared/routing'
import { HedgeRace, HEDGE_DELAY_MS, HEDGE_DELAY_SUGGEST_MS, type HedgeLeg } from './llm/hedge'
import { ThinkStripper } from './llm/think-strip'
import { redactSecrets } from '@shared/redact'
import { isSafeAccelerator } from '@shared/accelerator'
import { formatResetPhrase } from '@shared/reset-time'
import { applySpeakerNames, clusterNamePairsFromAlignment } from '@shared/transcript-align'
import { initializeCaheEditionIdentity, isCaheEdition } from './cahe-edition'
import { importEmbeddedCaheKey, seedCaheLocalAiForBackgroundScreen } from './cahe-embedded-key'
import { importEmbeddedCloudflareKey, embeddedCloudflareKeyAvailable, restoreEmbeddedCloudflareKey } from './embedded-cloudflare-key'

/**
 * Builds the `refreshDustAuth` callback a Dust-routed stream/recap call hands to createStream — branches
 * on which login path minted the CURRENT session (dustSessionOrigin) so a mid-stream 401 always re-mints
 * through the SAME flow the token came from. Mixing the native-OAuth and CLI-import refresh paths for one
 * session would recreate the single-use-rotating-refresh-token race each refresh function individually
 * guards against (see dust-oauth.ts's and dustcli.ts's own single-flight comments).
 */
function makeRefreshDustAuth(current: {
  dustSessionOrigin: 'oauth' | 'cli'
  dustWorkspaceId: string
  dustBaseUrl: string
}): () => Promise<{ apiKey: string; workspaceId: string; baseURL: string } | null> {
  return async () => {
    if (current.dustSessionOrigin === 'oauth') {
      const fresh = await refreshDustOAuthSession()
      if (!fresh.ok || !fresh.token) return null
      return { apiKey: fresh.token, workspaceId: current.dustWorkspaceId, baseURL: current.dustBaseUrl }
    }
    const fresh = await refreshDustCliSession()
    if (!fresh.ok || !fresh.token || !fresh.workspaceId) return null
    setApiKey('dust', fresh.token)
    const baseURL = fresh.baseUrl || 'https://dust.tt'
    setSettings({ dustWorkspaceId: fresh.workspaceId, dustBaseUrl: baseURL, dustTokenMintedAt: Date.now() })
    auditLog('dust.token.refreshed', { at: 'cli-mid-stream' })
    return { apiKey: fresh.token, workspaceId: fresh.workspaceId, baseURL }
  }
}

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
// Ceiling used when telling the Intelligence dashboard what to open clear of. NOT BAR_HEIGHT: that is the
// initial idle constant (84), while a real collapsed bar measures ~120 once its two rows render, so
// capping at 84 described a shorter bar than exists and the collision check missed a 23px overlap that
// was really there. This is the height a COLLAPSED bar can occupy, with margin — high enough to cover the
// real thing, low enough that an expanded panel (up to ~992) cannot shove the dashboard off-screen.
const BAR_COLLAPSED_MAX_HEIGHT = 160
const PILL_WIDTH = 220 // narrow width for the collapsed control mini-pill (so it isn't a wide click-trap)

/** Content protection hides the window from screen capture. Disable via env for dev/screenshots ONLY —
 *  devEnv() gates it to unpackaged builds so a packaged process can never have capture protection
 *  stripped by `setx ASKTOTO_DISABLE_CP 1` + relaunch (see dev-env.ts). */
function contentProtectionOn(): boolean {
  if (devEnv('ASKTOTO_DISABLE_CP')) return false
  return getSettings().contentProtection
}

// Private View — the user's "don't look at my screen" switch (bar eye button / Settings → Privacy).
// Distinct from contentProtection above, which only hides the WINDOW from other apps' capture:
// contentProtection defaults ON (the overlay should be invisible in screen-shares), so using it to
// also gate our own capture killed screen-asks on every fresh install.
// Private View is the STRONGER of the two promises — it stops us capturing at all — so the same
// dev-only env gate applies (MQA-148): this is the single authority behind getScreenshot()'s pre- and
// post-capture checks and screen-preprocess's describe pass, so an ungated `setx ASKTOTO_DISABLE_CP 1`
// would open every one of them at once while Settings still read "on".
function privateViewOn(): boolean {
  if (devEnv('ASKTOTO_DISABLE_CP')) return false
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
// The top edge the USER last put the window at (drag, hotkey move, display reanchor). resizeTo slides the
// window up when a growing panel would run off the bottom, but that slide used to be permanent: it wrote
// the raised y back as the new position, and shrinking never undid it. One long answer therefore walked a
// bar parked near the bottom all the way to the top of the screen, 24px at a time, and it stayed there.
// Keeping the anchor separate lets the slide be temporary — up to fit, back down when the content shrinks.
let userAnchorY: number | null = null
let currentWidth = BAR_WIDTH // window width; narrows to PILL_WIDTH while collapsed to the control mini-pill
// True while collapsed to the control mini-pill. Guards lastBarHeight below: the pill's own (much shorter)
// content height must never overwrite the remembered full-bar height, or expanding back out would apply
// the tiny pill height first and squish/flash before the renderer's next resize report corrects it.
let isMinimized = false
// Hide/island rest after exclusive onboarding. Stale exclusive / 880×816 measures must not grow the park.
let islandResting = false
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
      // Non-activating: clicking the notification surfaces the overlay but must not steal focus from
      // whatever app the user was in (the island's "never steals focus" contract) — see showForAsk's
      // doc comment for the one deliberate exception.
      win?.showInactive()
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
    // vad-v1 jobs: cursor counts WINDOWS (phase 2); a resume re-decodes the whole file (seconds of
    // ffmpeg) and the deterministic re-segmentation + window cursor skip the already-transcribed part.
    const skipThrough = job.pipeline === 'vad-v1' ? 0 : job.cursor
    const decoder = startFfmpegDecode(ffmpeg, job.sourcePath, skipThrough, {
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
      devTools: DEVTOOLS_ENABLED,
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
  // Diarization lands on line.name (enrolled profile or "Speaker N") — the recap prompt asks the model
  // to attribute by those labels, so erasing them here made every import look like one anonymous SPEAKER.
  return lines.map((line) => `${line.name?.trim() || 'SPEAKER'}: ${line.text}`).join('\n')
}

/** Text-side language name for one probe window's Parakeet decode, or null when inconclusive. */
function detectImportLanguage(text: string): string | null {
  return detectTextLanguage(text).lang ?? null
}

/**
 * MQA-235: the Plaud-style polish pass over a finished import's lines — stutter/punctuation cleanup,
 * never a paraphrase, per-line, order-preserving (src/main/polish.ts owns the prompt + strict parsing).
 *
 * Redaction rule, decided not defaulted: with `redactSensitive` ON, a cloud polish would ship the raw
 * transcript off-device, and redacting first would write REDACTED text into the saved transcript (the
 * polish output replaces the lines — unlike the recap, which only derives from them). So under
 * redaction the pass runs on-device or not at all. Fail-open everywhere: any fault keeps the raw lines.
 */
async function runImportPolish(lines: TranscriptLine[]): Promise<TranscriptLine[]> {
  const settings = getSettings()
  const allowed = getAllowedProviders()
  const localReady =
    localEligibleFor({ mode: 'summary' }, settings, 'base', allowed) ||
    localFallbackEligibleFor({ mode: 'summary' }, settings, 'base', allowed)
  const cloudReady =
    (!allowed || allowed.includes(settings.provider)) &&
    (PROVIDERS[settings.provider]?.kind === 'cli'
      ? !!settings.cliConnected[settings.provider]
      : getApiKey(settings.provider).length > 0) &&
    (!requiresUserBaseUrl(settings.provider) || !!providerBaseUrl(settings.provider, settings))
  const candidates: ProviderId[] = settings.redactSensitive
    ? localReady
      ? (['local'] as ProviderId[])
      : []
    : [
        ...(cloudReady ? [settings.provider] : []),
        ...(localReady ? (['local'] as ProviderId[]) : [])
      ]
  if (!candidates.length) return lines

  const out = [...lines]
  const asPolish = (l: TranscriptLine): PolishLine => ({
    speaker: l.name || l.speaker,
    t: new Date(l.t).toISOString().slice(11, 19),
    text: l.text
  })
  // polishBatches slices are contiguous and ordered — track the running offset directly.
  let offset = 0
  // MQA-239: the org's known people/account names, so the polish can correct near-miss transcriptions
  // ("Coer" -> "Cohere") — the decode-time alternative was spiked and rejected (it splices names into
  // unrelated speech; see polish.ts). Capped small on purpose: a kitchen-sink list dilutes the rule.
  const entityNames = (() => {
    try {
      const s2 = getSettings()
      const people = listBrainEntities(s2, 'person').map((slug) => readBrainPerson(s2, slug)?.name)
      const accounts = listBrainEntities(s2, 'account').map((slug) => readBrainAccount(s2, slug)?.name)
      return Array.from(new Set([...people, ...accounts].filter((n): n is string => !!n))).slice(0, 60)
    } catch {
      return []
    }
  })()
  // Batches of 8, not the module default 24: live runs showed a 24-line French batch's JSON answer
  // (3000+ chars) frequently arrives truncated/malformed, and strict parsing rightly rejects it.
  // Short outputs parse; a batch that still fails is split in half and each half retried once, and
  // ONLY the finally-unparseable slice keeps its raw lines — one bad batch no longer costs the meeting.
  const polishOne = async (batch: PolishLine[]): Promise<string[] | null> => {
    const prompt = buildPolishPrompt(batch, entityNames)
    for (const provider of candidates) {
      const def = PROVIDERS[provider]
      const local = provider === 'local'
      const model = local
        ? settings.localLlm.modelId
        : applyInteractiveGuardrail(
            provider,
            'base',
            resolveModelTier(provider, settings.providerModels, settings.providerModelsThinking, 'base', settings.providerModelsDeep) || def.defaultModel
          )
      try {
        const raw = await new Promise<string>((resolvePolish, rejectPolish) => {
          let text = ''
          createStream({
            providerId: provider,
            kind: def.kind,
            apiKey: local ? '' : getApiKey(provider),
            baseURL: local ? undefined : providerBaseUrl(provider, settings),
            workspaceId: settings.dustWorkspaceId,
            model,
            temperature: 0,
            idleMs: 120_000,
            freshConversation: true,
            system:
              'You clean up raw speech-to-text transcript lines. Follow the instructions in the user message exactly and output only the JSON array.',
            // mode 'answer', deliberately: 'summary' makes userText() build a summarize-the-transcript
            // scaffold and DISCARD the prompt — both candidates answered an empty summary request
            // (cloudflare: "[", local: '["Summarize it as instructed."]'). 'answer' passes the prompt
            // through verbatim, which is the whole job here.
            req: { id: `import-polish-${Date.now()}`, mode: 'answer', prompt, history: [] },
            handlers: {
              onDelta: (delta) => {
                text += delta
              },
              onDone: () => resolvePolish(text),
              onError: (error) => rejectPolish(new Error(String(error)))
            }
          })
        })
        const cleaned = parsePolishResponse(raw, batch.length)
        if (cleaned) return cleaned
        mainLog.warn(`[polish] ${provider} answered but the response did not parse (len ${raw.length}): ${raw.slice(0, 160)}`)
      } catch (e) {
        mainLog.warn(`[polish] ${provider} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return null
  }
  const applyCleaned = (cleaned: string[], at: number, count: number): void => {
    for (let i = 0; i < count; i++) {
      const next = cleaned[i]?.trim()
      if (next) out[at + i] = { ...out[at + i], text: next }
    }
  }
  for (const batch of polishBatches(lines.map(asPolish), 8)) {
    const cleaned = await polishOne(batch)
    if (cleaned) {
      applyCleaned(cleaned, offset, batch.length)
    } else if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2)
      const first = await polishOne(batch.slice(0, mid))
      if (first) applyCleaned(first, offset, mid)
      const second = await polishOne(batch.slice(mid))
      if (second) applyCleaned(second, offset + mid, batch.length - mid)
      if (!first || !second) mainLog.warn('[polish] a split batch still failed — its lines stay raw')
    } else {
      mainLog.warn('[polish] single-line batch unparseable — line stays raw')
    }
    offset += batch.length
  }
  auditLog('transcript.imported', { polished: true, lines: out.length })
  return out
}

async function runImportedRecap(job: ImportJob): Promise<string | undefined> {
  const settings = getSettings()
  const allowed = getAllowedProviders()
  // An imported recording is a summary task. If the user opted into Métis Local summaries and its
  // installer-owned runtime is ready, try it first so the transcript stays on-device. Cloud providers
  // remain the explicit fallback when local is disabled or unavailable.
  // localPrimaryEligibleFor (not bare localEligibleFor) honors routingMode:'local' the same way live
  // ask primary pick does — otherwise Routing mode → Local still forced every import recap through cloud.
  const localSummaryReady = localPrimaryEligibleFor({ mode: 'summary' }, settings, 'base', allowed)
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
    // MQA-215: same rule as pickFailover and the brain-ingest walk. A provider whose endpoint the USER
    // supplies (Custom, and Cloudflare's operator-deployed Worker) is not a candidate until it has one.
    // Cloudflare ships a default model, so a stored METIS_PROXY_KEY alone would otherwise leave it in
    // this waterfall as the LAST cloud candidate, and streamOpenAI's own guard message would become the
    // lastError an import that failed for unrelated reasons reports back to the user.
    if (requiresUserBaseUrl(provider) && !providerBaseUrl(provider, settings)) return false
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
          baseURL: local ? undefined : providerBaseUrl(provider, settings),
          workspaceId: settings.dustWorkspaceId,
          refreshDustAuth: provider === 'dust' ? makeRefreshDustAuth(settings) : undefined,
          model,
          temperature: settings.temperature,
          // Same reasoning gate as the live stream (providers.ts reasoningEffortFor) — this path always
          // resolves at the 'think' tier, so a reasoning-by-default model is asked for full effort.
          reasoningEffort: reasoningEffortFor(provider, 'think', settings.thinkingMode === 'always'),
          idleMs: 120_000,
          freshConversation: true,
          system:
            buildSystem(req, personaMode, settings.profile, settings.modePrompts, settings.contextDocs[personaMode] || [], settings.outputLanguage, settings.summaryLanguage, settings.systemPrompt) +
            (job.lines.some((l) => l.name)
              ? '\n\nThis is an imported recording. Lines carry on-device voice-matched speaker labels (e.g. "Speaker 1" or an enrolled name) — attribute statements to those labels, never to YOU or THEM.'
              : '\n\nThis is an imported recording with no speaker diarization. Do not attribute statements to YOU or THEM.'),
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
      // MQA-235: fresh diarization session per recording — cluster labels ("Speaker 1") are meeting-
      // scoped, never carried across imports.
      getSpeakerId().resetSession()
      return startImportDecoder(job)
    },
    transcribe: async (samples, opts) => {
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
        // MQA-235: the manager's whole-recording majority vote outranks both the per-window guess and
        // the single window-0 probe (a greeting in the other language mis-pinned a whole meeting on
        // 2026-08-05). The user's explicit Settings pin still outranks the vote.
        const userPin = getSettings().asrLanguage
        const language = userPin !== 'auto' ? userPin : (opts?.language ?? 'auto')
        return await whisperImportTranscribe(samples, language, async (probeSamples) => {
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
    // MQA-235: one language-ID vote sample — Parakeet decodes the window (language-agnostic), text-side
    // lang-id classifies it. Same signal probeLanguage uses, but the manager votes across windows spread
    // over the whole recording instead of trusting window 0.
    probeLanguageName: async (samples) => {
      try {
        await ensureParakeetModel()
        const text = await parakeetTranscribe(samples)
        if (text.trim().split(/\s+/).filter(Boolean).length < 4) return null
        return detectImportLanguage(text)
      } catch {
        return null
      }
    },
    // MQA-235: diarize one utterance window — enrolled profile name or session cluster label. Same
    // CAM++ extractor the live path uses; a fresh session is reset per job in `decode` above.
    speakerFor: async (samples) => getSpeakerId().labelWindow(samples)?.name ?? null,
    finalizeSpeakers: () => getSpeakerId().finalizeSession(),
    polish: (lines) => runImportPolish(lines),
    // Free the whisper helper's model memory between imports; the next job spawns a fresh child.
    onIdle: () => stopWhisperHost(),
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

/**
 * MQA-062: retiring on a credential rejection only fires once the user has already ASKED something and
 * watched it fail. Until then Settings shows the card as Connected/Active, providerReady is true and the
 * Bar's setup CTA stays hidden — the app asserting a session it has not checked. Dust's rule for this
 * exact credential class (renderer/lib/dust-live-check.ts) is that opening Settings must verify the real
 * session rather than trust "already connected"; this is that check for the two CLI providers, run once
 * at startup and whenever the AI settings tab opens.
 *
 * Throttled per provider because the probe spawns a (cheap, zero-token) child process and the settings
 * panel can be opened repeatedly. Only an explicit 'signed-out' retires the flag — see checkCliSession on
 * why 'unknown' must change nothing.
 */
const CLI_SESSION_RECHECK_MS = 60_000
const cliSessionCheckedAt = new Map<ProviderId, number>()
let cliSessionSweep: Promise<void> | null = null

async function verifyCliSessions(now = Date.now()): Promise<void> {
  // Single-flighted: startup and a settings-panel open can land together, and two concurrent sweeps
  // would spawn the probe twice for the same provider.
  if (cliSessionSweep) return cliSessionSweep
  cliSessionSweep = (async () => {
    // Never reject. One caller is a bare `void verifyCliSessions()` at boot, and an async body with no
    // guard is precisely how a transient settings-read failure becomes an unhandledRejection — which
    // onFatal turns into a crash-*.log and an `app.crash` audit entry for something that crashed nothing.
    // Same guarded shape startMeetingPoller uses, and for the same reason.
    try {
      for (const provider of PROVIDER_IDS) {
        if (PROVIDERS[provider].kind !== 'cli') continue
        if (!getSettings().cliConnected[provider]) continue
        const last = cliSessionCheckedAt.get(provider) ?? 0
        if (now - last < CLI_SESSION_RECHECK_MS) continue
        cliSessionCheckedAt.set(provider, now)
        const verdict = await checkCliSession(provider)
        if (verdict !== 'signed-out') continue
        const s = getSettings()
        if (!s.cliConnected[provider]) continue // disconnected by the user while the probe ran
        setSettings({ cliConnected: { ...s.cliConnected, [provider]: false } })
        mainLog.warn(`[cli] ${provider} is no longer signed in — marking it disconnected`)
      }
    } catch (error) {
      mainLog.warn('[cli] session verification could not complete:', error instanceof Error ? error.message : String(error))
    }
  })().finally(() => {
    cliSessionSweep = null
  })
  return cliSessionSweep
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
            : // Cloudflare ships a default model but NO endpoint (the operator's own Worker), so the
              // https URL is the whole extra setup step. Unlike Custom it needs no model check —
              // resolveModelTier always yields the registry default.
              s.provider === 'cloudflare'
              ? /^https:\/\//i.test(s.cloudflareBaseUrl)
              : true))
  // Métis Local readiness (PLAN.md §4.3) — task-independent base, then one per in-scope task. Derived by
  // local-routing.ts's localBaseReady() so this snapshot and the live routing decision (attempt()/
  // pickFailover below) can never drift apart.
  const localReady = localBaseReady(s, allowed)
  // routingMode:'local' is a standing opt-in for every in-scope mode (see localPrimaryEligibleFor) —
  // the per-task useFor toggles are only required under 'auto'. Without this, Settings → Routing mode
  // → Local left the readiness chips and requireProvider() gates claiming Local was off.
  const routingLocal = resolveRoutingMode(s) === 'local'
  const localSuggestReady = localReady && (s.localLlm.useFor.suggest || routingLocal)
  const localSummaryReady = localReady && (s.localLlm.useFor.summary || routingLocal)
  const localVisionReady = localReady && (s.localLlm.useFor.vision || routingLocal)
  // "Local as safety net" is live: with zero cloud/CLI configured, meeting indexing and — through the
  // absolute floor — asks of ANY mode still run on-device (askStart's fallback seams + brain/ingest.ts's
  // last-resort candidate). Surfaced so renderer readiness gates match what routing will actually do:
  // this one flag is what tells the renderer not to demand an API key it does not need (MQA-242).
  const localFallbackReady = localReady && s.localLlm.fallback
  return {
    ...s,
    hasApiKey: hasApiKey(s.provider),
    // Reflect the value actually applied to the window, not the raw stored setting — otherwise a dev
    // process running with ASKTOTO_DISABLE_CP would show "Content protection: On" in Settings while
    // capture protection is really off.
    contentProtection: contentProtectionOn(),
    // Same rule for the stronger switch: the Privacy toggle must show what capture actually obeys.
    privateView: privateViewOn(),
    // MQA-261: does a shipped key exist to fall back on? The renderer pairs this with
    // hasKeys.cloudflare to decide whether to offer a restore — available AND not currently stored.
    embeddedCloudflareKeyAvailable: embeddedCloudflareKeyAvailable(),
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
          (PROVIDERS[p].kind === 'cli' ? !!s.cliConnected[p] : hasApiKey(p)) &&
          // A key alone is not reachability. Cloudflare (and custom) answer at an endpoint the operator
          // supplies, so a stored METIS_PROXY_KEY with no Worker URL yet is a provider that can never be
          // reached — and advertising vision on it makes the app CAPTURE THE USER'S SCREEN, and prewarm
          // more captures, for a request that cannot be sent. Same gate providerReady already applies.
          (!requiresUserBaseUrl(p) || !!providerBaseUrl(p, s))
      ) || localVisionReady || localFallbackReady,
    localReady,
    localSuggestReady,
    localSummaryReady,
    localVisionReady,
    localFallbackReady,
    // MQA-004: the honest counterpart to providerReady — which providers actually REJECTED their
    // credentials recently, so the UI can say "your key stopped working" instead of claiming ready.
    unhealthyProviders: unhealthyProviders(),
    lastFailover: lastFailoverNotice,
    // Background on-device screen pre-analysis can actually run. Asked of the ENGINE, never recomputed
    // here: the old `s.backgroundScreenContext && localReady` copy missed the macOS OCR engine (Settings
    // said "not running" while it captured every 6s) and could not see a dead foreground watcher at all.
    backgroundScreenReady: screenPreprocess.canRun(),
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

/** Wiped-profile / mid-tour: exclusive fullscreen owns the display until onboardingDone. */
function onboardingExclusiveLive(): boolean {
  try {
    return !getSettings().onboardingDone
  } catch {
    return false
  }
}

function applyExclusiveOnboardingStage(w: BrowserWindow, display = screen.getDisplayMatching(w.getBounds())): void {
  const stage = exclusiveOnboardingBounds(display.bounds, display.workArea)
  currentWidth = stage.width
  lastBarHeight = stage.height
  isMinimized = false
  islandResting = false
  try {
    w.setFullScreenable?.(true)
    w.setBackgroundColor('#3A0B6B')
    w.setBounds(stage)
  } catch {
    /* headless / already destroyed */
  }
  try {
    if (process.platform === 'darwin' && typeof w.setSimpleFullScreen === 'function') {
      if (!w.isSimpleFullScreen()) w.setSimpleFullScreen(true)
    } else if (process.platform === 'win32' && typeof w.setKiosk === 'function') {
      if (!w.isKiosk()) w.setKiosk(true)
    }
  } catch {
    /* CI / Linux kiosk unsupported — bounds still cover the display */
  }
}

/** After onboardingDone only: leave exclusive fullscreen and park hide/island peek (never 880×816). */
function exitExclusiveOnboardingStage(): void {
  if (!win || win.isDestroyed()) return
  try {
    if (typeof win.isSimpleFullScreen === 'function' && win.isSimpleFullScreen()) win.setSimpleFullScreen(false)
    if (typeof win.isKiosk === 'function' && win.isKiosk()) win.setKiosk(false)
  } catch {
    /* headless */
  }
  try {
    win.setFullScreenable?.(false)
    win.setBackgroundColor('#00000000')
  } catch {
    /* ignore */
  }
  applyOverlayAlwaysOnTop(win)
  isMinimized = false
  lastBarHeight = BAR_HEIGHT
  const display = screen.getDisplayMatching(win.getBounds())
  const layout = liveOverlayLayout()
  const park = parkAfterExclusiveOnboarding(layout, getDisplayMetrics(display), ISLAND_TOP_MARGIN)
  currentWidth = park.width
  islandResting = overlayUsesHover(layout)
  userAnchorY = park.y
  win.setBounds(park, false)
}

function applyOverlayAlwaysOnTop(w: BrowserWindow): void {
  try {
    w.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform !== 'win32') w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch {
    /* headless / already destroyed */
  }
}

function createWindow(): void {
  // Idempotent: `second-instance` is registered before app-ready and can call ensureWindow() while boot's
  // own runStep('createWindow') is still queued behind its awaits. Without this, the boot step would
  // overwrite `win` with a second BrowserWindow and orphan the first one — still visible, still
  // always-on-top, unreferenced.
  if (win && !win.isDestroyed()) return
  // MQA-249: the one unconditional "this build came up" signal, and the only portable one.
  //
  // check-packaged-launch.mjs proves a packaged app actually starts, but it is Win32-only: it asserts on
  // the real top-level window via PowerShell + UI Automation, and the macOS equivalents all need a TCC
  // Automation grant an unattended build cannot answer. Its own doc names the missing piece — "no
  // unconditional audit event fires at startup — so today there is no portable positive signal to assert
  // on". This is that signal. auditLog writes to userData/logs/audit.log, which ASKTOTO_USERDATA relocates
  // (electron-log's main.log does NOT on macOS — it goes to ~/Library/Logs), so a gate can point a clean
  // profile at a temp directory and read the answer out of it on either platform.
  //
  // Emitted here rather than at app-ready because reaching createWindow means the main process survived
  // module load, bytecode load, and boot — which is exactly the class of failure that shipped DOA twice.
  auditLog('app.started', { version: app.getVersion(), platform: process.platform, arch: process.arch })
  // Crash/recovery guard: render-process-gone recovery and the boot-retry path both rebuild the window
  // from scratch, but isMinimized/currentWidth are module-level state that otherwise survives from before
  // the crash. If the overlay had been collapsed to the mini-pill (currentWidth === PILL_WIDTH) at the
  // moment it died, the freshly-recreated full-size window's mount effect calls setWindowMode() ->
  // setBounds({ width: currentWidth }), squeezing the recovered Bar down to the 220px pill width — with
  // resizable:false blocking any manual fix. Reset both so a recovered window always starts full-size.
  isMinimized = false
  currentWidth = BAR_WIDTH
  // Wiped-profile onboarding owns the display (exclusiveOnboardingBounds) — never the 880×816 card
  // that overlapped Tony's work. Auto-resize must not shrink this until onboardingDone; exit then
  // parks the island at islandSafeTop (path A then C). getSettings() is file-keystore-safe here.
  const placementDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const onboardingLive = onboardingExclusiveLive()
  const stage = exclusiveOnboardingBounds(placementDisplay.bounds, placementDisplay.workArea)
  const layout = liveOverlayLayout()
  const restPark = parkAfterExclusiveOnboarding(layout, getDisplayMetrics(placementDisplay), ISLAND_TOP_MARGIN)
  if (onboardingLive) {
    currentWidth = stage.width
    lastBarHeight = stage.height
    islandResting = false
  } else {
    currentWidth = restPark.width
    lastBarHeight = BAR_HEIGHT
    islandResting = overlayUsesHover(layout)
  }
  win = new BrowserWindow({
    width: onboardingLive ? stage.width : restPark.width,
    height: onboardingLive ? stage.height : restPark.height,
    x: onboardingLive ? stage.x : restPark.x,
    y: onboardingLive ? stage.y : restPark.y,
    frame: false,
    transparent: true,
    hasShadow: false, // panel paints its own shadow; window shadow would box the transparent area
    resizable: false,
    movable: true,
    skipTaskbar: true,
    fullscreenable: onboardingLive,
    maximizable: false,
    minimizable: false,
    roundedCorners: !onboardingLive,
    backgroundColor: onboardingLive ? '#3A0B6B' : '#00000000',
    acceptFirstMouse: true, // macOS: first click activates + hits the target without needing a second click
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: DEVTOOLS_ENABLED,
      backgroundThrottling: false,
      webSecurity: true
    }
  })

  try {
  if (onboardingLive) applyExclusiveOnboardingStage(win, placementDisplay)
  applyOverlayAlwaysOnTop(win)
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
    if (win === self) win = null
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
    // MQA-196: the geometry half of the same root cause. If the overlay was collapsed to the mini-pill
    // when the renderer died, the remounted App boots `minimized` false and renders the full Bar, but its
    // mount-effect windowMode('bar') would setBounds({ width: currentWidth }) with the surviving pill
    // width — squeezing the recovered bar into a ~130px sliver that resizable:false makes unfixable. Same
    // two lines createWindow's crash guard uses, for the reload path that never reaches it.
    isMinimized = false
    if (onboardingExclusiveLive() && win && !win.isDestroyed()) {
      applyExclusiveOnboardingStage(win)
    } else {
      currentWidth = BAR_WIDTH
    }
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
  // Exclusive onboarding owns the display. Auto-resize must not shrink to the 880×816 card.
  if (onboardingExclusiveLive()) {
    applyExclusiveOnboardingStage(win)
    return
  }
  const rest = overlayRestSize(liveOverlayLayout())
  if (shouldIgnoreResizeWhilePeekResting(islandResting, height, rest.height)) return
  // Clamp + reposition against the display the OVERLAY is actually on (not the cursor's). Otherwise, on a
  // laptop + external monitor of different heights, a streaming answer clamps to the wrong monitor and the
  // window jumps vertically while the cursor sits on the other screen.
  const display = screen.getDisplayMatching(win.getBounds())
  const { workArea } = display
  const h = clampHeight(Math.round(height), workArea.height)
  const b = win.getBounds()
  if (h === b.height && currentWidth === b.width) {
    // Only remember this height for restore-on-expand when it's the real bar, not the mini-pill's
    // much shorter content — see isMinimized comment above.
    if (!isMinimized) lastBarHeight = h
    return // idempotent — skip a no-op setBounds (belt-and-braces with the renderer-side resize dedup)
  }
  if (!isMinimized) lastBarHeight = h
  // Island: peek and revealed share the safe Y (below the notch) so hover grows DOWN, leave shrinks
  // in place. Do not slide into bounds.y — that clips the capsule on a notch Mac.
  const y = topClamp(liveOverlayLayout(), getDisplayMetrics(display), ISLAND_TOP_MARGIN)
  // When the width changes (collapse to / expand from the mini-pill), recenter around the old midpoint
  // so the overlay stays put; otherwise keep the left edge. Clamp x into the work area either way.
  const x = recenterXForWidth(b.x, b.width, currentWidth, workArea, RESIZE_EDGE_MARGIN)
  win.setBounds({ x, y, width: currentWidth, height: h }, false)
}

/** Collapse to / expand from the control mini-pill by switching the window width; the renderer's
 *  auto-resize then settles the height to whichever surface is shown. */
function setMinimizedWidth(narrow: boolean): void {
  if (onboardingExclusiveLive()) return
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
// Top margin (px) for the auto-hide peek on a NON-notch display. Notch Macs use islandSafeTop
// (workArea.y, or a strut if workArea.y is 0) and ignore this margin so the capsule is not clipped.
const ISLAND_TOP_MARGIN = 8
// Top margin (px) for the ONE-TIME initial window placement in createWindow — deliberately larger than
// ISLAND_TOP_MARGIN so a freshly-launched window doesn't appear jammed against the very top edge before
// the user has ever triggered the auto-hide anchor.
const TOP_CENTER_MARGIN_PX = 24
// Edge margin (px) resizeTo keeps clear on every side while sliding/recentering a growing or narrowing
// bar — small breathing room from the raw screen edge, distinct from ISLAND_TOP_MARGIN (the auto-hide
// anchor's OWN resting position, which intentionally sits closer to y=0).
const RESIZE_EDGE_MARGIN = 8

/** Where THIS window's top-center placement should land on a display, honoring the notch clamp
 *  (island/geometry.ts's topClamp) — the single call every top-anchor site in this file routes through,
 *  so hide/island hug the notch on a notch Mac and bar floats on the work area. */
function liveOverlayLayout(): OverlayLayout {
  return parseOverlayLayout(getSettings().overlayLayout)
}

function islandTopCenter(width: number, display: Electron.Display, topMargin: number): { x: number; y: number } {
  return topCenterPosition(width, liveOverlayLayout(), getDisplayMetrics(display), topMargin)
}

/** Pin the overlay to the top-center of the display it is currently on, and re-arm the resizeTo anchor
 *  there, so the auto-hide peek strip and the revealed bar both grow DOWNWARD from the same safe Y
 *  (below the notch). Uses getDisplayMatching(win bounds) so it stays correct on the overlay's actual
 *  display. A pure setBounds — never show()/focus(). */
function anchorTopCenter(): void {
  if (!win) return
  if (onboardingExclusiveLive()) {
    applyExclusiveOnboardingStage(win)
    return
  }
  const display = screen.getDisplayMatching(win.getBounds())
  const b = win.getBounds()
  const { x, y } = islandTopCenter(b.width, display, ISLAND_TOP_MARGIN)
  userAnchorY = y // resizeTo slides against this, so a growing bar returns to the top edge when it shrinks
  win.setBounds({ x, y, width: b.width, height: b.height }, false)
}

/** Reveal from the auto-hide peek: widen to the full bar and grow height downward from the same
 *  safe Y. Leave collapse is the inverse (resizeTo with peek height, same Y). */
function restoreBarWidth(): void {
  if (!win || onboardingExclusiveLive()) return
  islandResting = false
  if (currentWidth === BAR_WIDTH) return
  const display = screen.getDisplayMatching(win.getBounds())
  const b = win.getBounds()
  currentWidth = BAR_WIDTH
  const x = recenterXForWidth(b.x, b.width, BAR_WIDTH, display.workArea, 0)
  const y = topClamp(liveOverlayLayout(), getDisplayMetrics(display), ISLAND_TOP_MARGIN)
  const revealedHeight = Math.max(b.height, lastBarHeight, BAR_HEIGHT)
  win.setBounds({ x, y, width: BAR_WIDTH, height: revealedHeight }, false)
}

// Re-center the compact bar on its current display. The old fixed 'settings' window-mode was removed —
// settings renders as a panel under the bar now, so the window only ever lives in 'bar' mode.
function setWindowMode(): void {
  if (!win) return
  if (onboardingExclusiveLive()) {
    applyExclusiveOnboardingStage(win)
    return
  }
  if (islandResting) {
    const display = screen.getDisplayMatching(win.getBounds())
    const park = parkAfterExclusiveOnboarding(liveOverlayLayout(), getDisplayMetrics(display), ISLAND_TOP_MARGIN)
    currentWidth = park.width
    userAnchorY = park.y
    win.setBounds(park, false)
    return
  }
  const { workArea } = screen.getDisplayMatching(win.getBounds())
  const b = win.getBounds()
  const x = recenterXForWidth(b.x, b.width, currentWidth, workArea, 16)
  // lastBarHeight was measured on whatever display the bar was on at the time. The renderer sends
  // windowMode('bar') on every mount — including the reload after a renderer crash — which can land after
  // the overlay has moved to a shorter monitor, so re-apply that monitor's ceiling instead of restoring a
  // height it cannot show (resizable:false leaves no manual way back).
  win.setBounds({ x, y: b.y, width: currentWidth, height: clampHeight(lastBarHeight, workArea.height) }, false)
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

/**
 * The ONE deliberate, user-initiated focus grab in this file (MQA-275 / Phase 1d of the island rebuild:
 * "never steals focus" except a deliberate ask). `show()` (unlike `showInactive()`) activates the window
 * on both macOS and Windows, stealing focus from whatever app the user was typing in — acceptable ONLY
 * when the user just explicitly asked to type into the overlay (the `ask` hotkey, or the show/hide
 * toggle's reveal, which always opens `ask` immediately after). Every other reveal in this file must call
 * `showInactive()` instead — enforced by `no-show-steals-focus.contract.test.ts`, which greps this file
 * for bare `.show()` calls and fails on any occurrence outside this function.
 */
function showForAsk(w: BrowserWindow): void {
  w.show()
  w.focus()
}

function sendHotkey(action: HotkeyAction): void {
  const w = ensureWindow()
  if (!w) return
  if (!w.isVisible()) {
    if (action === 'ask') showForAsk(w)
    else w.showInactive()
  }
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
// ~150-450ms capture cost again. 4s covers hover→click and shortcut→Enter without showing a visibly stale
// frame; Private View / display-id checks still refuse a bad send.
const CAPTURE_TTL_MS = 4000
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

/** The one wording for the one promise. getScreenshot() throws it when Private View blocks a LIVE capture;
 *  IPC.askStart sends it verbatim when it refuses an already-captured frame (MQA-182). Keeping both on the
 *  same string is what lets the renderer's /private view/i copy paths recognise either one. */
const PRIVATE_VIEW_BLOCKED_MESSAGE =
  'Private View is on — screen capture is blocked. Turn it off to let Métis see your screen.'

/** Thrown by getScreenshot() when Private View is on — lets callers show a specific message instead of a
 *  generic capture failure. */
class PrivateViewBlockedError extends Error {
  constructor() {
    super(PRIVATE_VIEW_BLOCKED_MESSAGE)
    this.name = 'PrivateViewBlockedError'
  }
}

async function getScreenshot(phase?: string): Promise<{ image: string; width: number; height: number; capturedAt: number; dispId: number; displayMismatch: boolean }> {
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
    const { image, width, height, ts, dispId, displayMismatch } = shotCache
    return { image, width, height, capturedAt: ts, dispId, displayMismatch }
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
  // dispId is the monitor this frame is really OF. Callers that cache a DERIVED artifact (the background
  // screen description) need it: the capture always follows the cursor, which an alt-tab does not move,
  // so without it a cached description cannot tell it is about a monitor the user has looked away from.
  const { image, width, height, dispId, displayMismatch } = shot
  return { image, width, height, capturedAt, dispId, displayMismatch }
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
  authorized: requireAuth,
  currentDisplayId: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id,
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
  // macOS: never let this background loop be the thing that asks for Screen Recording. captureScreenshotOnce
  // deliberately lets a `not-determined` status reach desktopCapturer because that is what registers the app
  // with TCC and raises the system dialog — fine for a user-initiated capture, wrong for a loop armed at boot
  // (MQA-178), which would pop an unexplained prompt seconds after launch (MQA-209). Undefined off darwin:
  // Windows has no queryable screen grant and its capture prompts nothing.
  screenCaptureGranted:
    process.platform === 'darwin'
      ? () => systemPreferences.getMediaAccessStatus('screen') === 'granted'
      : undefined,
  log: (level, message) => (level === 'warn' ? mainLog.warn(message) : mainLog.info(message)),
  audit: (event, data) => auditLog(event as Parameters<typeof auditLog>[0], data)
})

/**
 * The ONE place that reconciles background screen preprocessing with reality. Call it from every event
 * that can change canRun(): boot, a settings write, sign-in, session clear, the local-model download
 * landing, and the onboarding permission request (on macOS the Screen Recording grant is part of
 * eligibility — MQA-209). Safe to call repeatedly — it's a no-op when the running state already matches.
 *
 * Auth is not re-checked here: it is a dep of the engine's own eligibility (screen-preprocess.ts), so the
 * lifecycle and the `backgroundScreenReady` flag Settings renders read one expression instead of two that
 * drifted apart (MQA-178/MQA-179).
 */
function refreshScreenPreprocess(): void {
  screenPreprocess.refresh()
}

/**
 * Revoke everything privileged that outlives a single IPC call, the moment the session does. ONE place
 * on purpose: the sign-out handler used to tear down only what it remembered, so the background screen
 * pre-analysis engine kept capturing + describing (MQA-154) and the Intelligence dashboard kept
 * rendering the decrypted brain (MQA-169) for a signed-out user, with no in-app way to stop either.
 * Registered on auth's session-cleared hook rather than called from the handler, because a session also
 * ends with no user action at all — max-age eviction and the background re-validation sweep. Import
 * jobs stay at the handler: cancelAll() is async and this hook is not.
 */
function revokePrivilegedSurface(): void {
  refreshScreenPreprocess() // stops the watcher child, the 6s tick and the cached description
  if (!requireAuth()) closeIntelligenceWindow()
}
setSessionClearedHandler(revokePrivilegedSurface)

// How much of the window must stay visibly reachable on some display while it's being dragged — enough
// to grab it back, not the whole thing. Below this it's treated as flung off-screen and pulled back in.
const DRAG_VISIBLE_MARGIN = 40

/** Ceiling a window height to a display's work area, keeping the 48px reserve. Lives here rather than
 *  inside resizeTo because the ceiling has to be re-applied every time the overlay lands on a DIFFERENT
 *  display — while the rest of resizeTo (width, recenter, lastBarHeight) must NOT run on those paths.
 *  Thin index.ts-local name preserved at every call site (MQA-275); the clamp math itself now lives in
 *  island/geometry.ts so it is unit-tested there without booting Electron. */
function clampHeight(height: number, areaHeight: number): number {
  return islandClampHeight(height, areaHeight, BAR_MIN_HEIGHT)
}

/** True if, positioned at (x, y), at least DRAG_VISIBLE_MARGIN px of the window overlaps the work area
 *  of at least one CONNECTED display — checked against the union of every display (getAllDisplays()),
 *  not just whichever one the window started the drag on. Math lives in island/geometry.ts. */
function isReachable(x: number, y: number, width: number, height: number): boolean {
  return islandIsReachable(
    x,
    y,
    width,
    height,
    screen.getAllDisplays().map((d) => d.workArea),
    DRAG_VISIBLE_MARGIN
  )
}

/** Re-apply the work-area height ceiling when a move lands the window on a DIFFERENT display than it
 *  left. Every setBounds on the move/reanchor paths spreads the old bounds, so a window grown to fit a
 *  4K panel keeps that height when it is dragged onto a 1080p monitor — hanging a thousand pixels below
 *  the bottom edge, where resizable:false leaves the user no way to fix it. Height only: x/y stay the
 *  caller's, except that y is re-checked, because the caller validated it against the OLD (taller)
 *  height and a shorter window can lose the overlap that made that position reachable. Math lives in
 *  island/geometry.ts; this wrapper resolves the live `screen.getDisplayMatching` display. */
function refitToDisplay(next: Electron.Rectangle, fromDisplayId: number): Electron.Rectangle {
  const { id, workArea } = screen.getDisplayMatching(next)
  return islandRefitToDisplay(next, id, workArea, fromDisplayId, BAR_MIN_HEIGHT, DRAG_VISIBLE_MARGIN)
}

function moveBy(dx: number, dy: number): void {
  // Self-heal a null win (e.g. a one-time createWindow() throw during boot) — mirrors sendHotkey/
  // toggleVisible so scroll/move hotkeys recover instead of staying permanently dead for the process life.
  const w = ensureWindow()
  if (!w) return
  const b = w.getBounds()
  const fromDisplayId = screen.getDisplayMatching(b).id
  const x = b.x + dx
  const y = b.y + dy
  // Free movement anywhere that keeps the window reachable on SOME display — covers dragging clean
  // across to a neighboring monitor (or over the gap between two of them), not just within the one the
  // window started on. Clamping against only the "current" display here (the old behavior) is what used
  // to stick a drag pinned to that display's edge, since the matched display never changed until the
  // window had already fully crossed onto it — which the clamp itself was preventing.
  if (isReachable(x, y, b.width, b.height)) {
    const next = refitToDisplay({ ...b, x, y }, fromDisplayId)
    userAnchorY = next.y // a deliberate move re-arms the anchor resizeTo slides against
    w.setBounds(next)
    return
  }
  // Unreachable (flung past every display): pull back onto the display nearest the ATTEMPTED position,
  // not the window's old bounds, so a fast drag lands on whichever monitor it was actually headed toward.
  const { workArea } = screen.getDisplayMatching({ x, y, width: b.width, height: b.height })
  const cx = clampAxisMargin(x, b.width, workArea.x, workArea.width, DRAG_VISIBLE_MARGIN)
  const cy = clampAxisMargin(y, b.height, workArea.y, workArea.height, DRAG_VISIBLE_MARGIN)
  const pulled = refitToDisplay({ ...b, x: cx, y: cy }, fromDisplayId)
  userAnchorY = pulled.y
  w.setBounds(pulled)
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
    if (onboardingExclusiveLive()) {
      applyExclusiveOnboardingStage(win)
      return
    }
    const b = win.getBounds()
    const { workArea: wa } = screen.getDisplayMatching(b)
    // Height first, and BEFORE the reachability guard below. A window grown to fit a tall display keeps
    // that height when the display is unplugged or its resolution shrinks — and in that state it is
    // normally still partly visible, so the guard would skip exactly the case that leaves the overlay
    // hanging off the bottom of the remaining screen with resizable:false and no in-app fix.
    const height = clampHeight(b.height, wa.height)
    const visible =
      b.x + b.width > wa.x && b.x < wa.x + wa.width && b.y + b.height > wa.y && b.y < wa.y + wa.height
    if (visible) {
      // Still (partly) on a real display — leave it where the user put it, sliding up only as far as the
      // newly clamped height needs to sit inside the work area (same slide resizeTo does).
      if (height !== b.height) {
        win.setBounds({ ...b, y: Math.min(b.y, wa.y + wa.height - height - 8), height })
      }
      return
    }
    const x = clampAxis(b.x, b.width, wa.x, wa.width)
    const y = clampAxis(b.y, height, wa.y, wa.height)
    win.setBounds({ ...b, x, y, height })
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
    // Revealing via the show/hide hotkey always opens the ask input right after — the same deliberate,
    // user-initiated focus grab as sendHotkey('ask'). See showForAsk's doc comment.
    showForAsk(w)
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
    // settings.json is user-editable and ipc's `shortcuts` field accepts any string, so what lands here is
    // untrusted. A navigation key bound globally (MQA-184: the recorder used to commit 'Shift+Tab') takes
    // that key away from every app for as long as Metis runs, and a bare key would fire on ordinary typing.
    // Refuse it here rather than at the recorder alone, and report it so the Settings banner offers a rebind.
    if (!isSafeAccelerator(accel)) {
      mainLog.warn(`[shortcuts] unsafe accelerator for ${action}: ${accel}`)
      shortcutFailures.push({ action, accel })
      continue
    }
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
    // sendHotkey() already reveals the window itself (non-activating — see showForAsk's doc comment)
    // when it isn't visible, so no separate show call is needed (or wanted) here.
    { label: 'Settings…', click: () => {
      sendHotkey('settings')
    } },
    { label: label('Listen / Stop listening', 'toggle-listen'), click: () => sendHotkey('toggle-listen') },
    { label: "Today's agenda", click: () => {
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

    // Auto-enrollment flywheel (SPEAKER-INTELLIGENCE-PLAN §3.4): a THEM line VTT alignment just resolved
    // to a real name, whose PRE-alignment name was a live session cluster label ("Speaker N"), is exactly
    // the join needed to grow a permanent voiceprint with zero user effort — this session's "Speaker N"
    // IS that person. Best-effort and silent: a missed window (feature off, no session buffer left, below
    // the quality gate) never affects the save this function already guarantees.
    const clusterNamePairs = clusterNamePairsFromAlignment(read.lines, lines)
    if (clusterNamePairs.length) {
      try {
        const enrolled = getSpeakerId().autoEnrollFromLabeledWindows(clusterNamePairs)
        if (enrolled) auditLog('speaker.auto_enrolled', { enrolled })
      } catch (err) {
        mainLog.warn('[speaker-id] auto-enroll failed', err instanceof Error ? err.message : String(err))
      }
    }

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
 *  it — graph.json/graph.html/graphify-out would otherwise linger forever, undeletable in-app, defeating
 *  the org encryption guarantee. Safe to call on every settingsGet poll and at boot: purgeGraphArtifacts()
 *  is three existsSync calls once the artifacts are gone, and it reports whether it actually removed
 *  anything — which is what keeps the audit line from being written on every poll forever. */
function purgeGraphIfEncryptedAndStale(reason: string): void {
  if (getSettings().encryptTranscripts && purgeGraphArtifacts()) auditLog('graph.purged', { reason })
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
  ipcMain.handle(IPC.dismissFailoverNotice, (e) => {
    assertMainWindow(e)
    dismissLastFailoverNotice()
    return { ok: true as const }
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
    // The grant just asked for here is part of the background screen reader's eligibility on macOS
    // (MQA-209), so reconcile at the one moment it can change. Often it won't have yet: macOS applies a
    // fresh Screen Recording grant to the NEXT launch (PermissionsSection offers that relaunch), and the
    // boot reconcile picks it up there. This costs one no-op call to cover the case where it already did.
    refreshScreenPreprocess()
    return getPlatformPermissions()
  })

  ipcMain.handle(IPC.settingsSet, async (e, patch) => {
    assertMainWindow(e)
    // Trust boundary is main, not the renderer's SignInWall — block the mutation for an unauthenticated
    // caller (DevTools/compromised renderer) when auth is enforced. Return the current (unchanged)
    // settings so the shape matches the normal success return exactly; nothing is persisted.
    //
    // MQA-066: with ONE exception, and only the exact one that makes the wall escapable. When enforcement
    // is on but nothing supplies a tenant, the wall's own message tells the user to enter the Entra IDs in
    // Settings → Calendar — and this line is what made typing them there silently not persist, leaving
    // the machine unusable with no in-app recovery. ssoBootstrapAllowed() re-checks every gate (no session,
    // enforcement on, NOTHING resolving a config, and never once sticky-configured), and the patch is
    // narrowed here to exactly the three self-serve azure fields, so no other privileged setting rides
    // along. env / machine-wide managed-config still outrank these in readConfig(), so an org deployment
    // cannot be loosened through this — it can only fill a vacuum.
    if (!requireAuth()) {
      if (!ssoBootstrapAllowed()) return publicSettings()
      const bootstrap: Partial<Record<'azureClientId' | 'azureTenantId' | 'azureAllowedDomain', string>> = {}
      for (const k of ['azureClientId', 'azureTenantId', 'azureAllowedDomain'] as const) {
        const v = (patch as Record<string, unknown> | null | undefined)?.[k]
        if (typeof v === 'string') bootstrap[k] = v
      }
      if (Object.keys(bootstrap).length === 0) return publicSettings()
      setSettings(bootstrap)
      auditLog('settings.changed', { keys: Object.keys(bootstrap), reason: 'sso_bootstrap' })
      return publicSettings()
    }
    const p = patch ?? {}
    // License STATE is server-authoritative: only main's activateLicense/heartbeat (license.ts) may
    // write it. Without this strip, any renderer code could self-issue an unlimited license with a
    // plain settings patch ({licenseValid:true, licenseSeatCap:999999}) and defeat the gate once it's
    // wired. licenseServerUrl + licenseGateEnabled stay writable — those are genuine user inputs.
    // licenseLease (MQA-282) and trialStartedAt (MQA-281) are the same class of field: only
    // activateLicense/heartbeat may set the former, only noteQualifyingUse the latter — a renderer patch
    // must not be able to self-issue a signed-looking lease string or grant itself a fresh trial.
    for (const k of [
      'licenseKey',
      'licenseCompanyName',
      'licenseSeatCap',
      'licenseExpiresAt',
      'licenseValid',
      'licenseLastValidatedAt',
      'licenseLease',
      'trialStartedAt'
    ]) {
      if (k in p) delete (p as Record<string, unknown>)[k]
    }
    // MCP connection STATE is main-owned for the same reason. IPC.mcpPush deliberately reads the endpoint
    // from saved settings rather than the payload so "a compromised renderer can't redirect the push to an
    // attacker-controlled MCP endpoint" (see that handler's own comment) — but a generic settings patch
    // could rewrite mcpConnections[].endpointUrl and defeat exactly that pin, sending the stored bearer
    // token (a BidStack/Plane key, or a ClickUp OAuth access token) to any host that passes the SSRF
    // guard. Every legitimate write already happens in main, inside a handler that re-verifies the
    // connection first: mcpSaveConnection, mcpClickupConnect and mcpDisconnect. The renderer's own
    // patch({ mcpConnections }) calls are redundant echoes of what main just persisted, and state.ts's
    // patch() re-seeds React state from this handler's return value, so dropping the key here costs the
    // UI nothing. clickupClientId is main-owned too (written only by the DCR step).
    for (const k of ['mcpConnections', 'clickupClientId']) {
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
    // Exclusive stage exits only here: onboardingDone false→true. Replay (true→false) re-enters it.
    if (!cur.onboardingDone && next.onboardingDone) exitExclusiveOnboardingStage()
    else if (cur.onboardingDone && !next.onboardingDone && win && !win.isDestroyed()) {
      applyExclusiveOnboardingStage(win)
    }
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
    // Local AI turned ON → re-arm the weight fetch if boot somehow skipped it (offline first launch,
    // under-RAM machine later upgraded). Boot already starts the download whenever the app opens
    // (RAM permitting); this edge is the second chance, not the only path to the weights.
    if (!cur.localLlm.enabled && next.localLlm.enabled && shouldFetchWeights(next.localLlm.modelId)) {
      void ensureLocalModel(next.localLlm.modelId)
        .then(() => refreshScreenPreprocess())
        .catch((e) => mainLog.warn('[settings] local model provisioning failed:', e))
    }
    // At-rest encryption just turned on → purge any previously-built CLEARTEXT knowledge graph so it
    // can't leak meeting topics/entities the encryption is meant to protect. (Builds are already
    // blocked while encryption is on, so no graph will be regenerated until it's turned back off.)
    if (!wasEncrypted && next.encryptTranscripts && purgeGraphArtifacts()) {
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
        licenseGateEnabled: false,
        leaseExpiresAt: null,
        trialActive: false,
        trialDaysRemaining: 0
      }
    }
    const s = getSettings()
    // Act 5 (MQA-281/282): lease/trial status is live-verified (licenseDisplayStatus), not a raw
    // settings echo — a tampered/expired licenseLease string must never read back as "active".
    const display = licenseDisplayStatus()
    return {
      licenseServerUrl: s.licenseServerUrl,
      licenseCompanyName: s.licenseCompanyName,
      licenseSeatCap: s.licenseSeatCap,
      licenseExpiresAt: s.licenseExpiresAt,
      licenseValid: s.licenseValid,
      licenseLastValidatedAt: s.licenseLastValidatedAt,
      licenseGateEnabled: s.licenseGateEnabled,
      leaseExpiresAt: display.leaseExpiresAt,
      trialActive: display.trialActive,
      trialDaysRemaining: display.trialDaysRemaining
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
  // Informational read of the server's declared license-gate intent (GET /license/config) — used by the
  // onboarding ActLicense scene. No requireAuth(): reachable before sign-in, like licenseGate above, and
  // the server route itself is unauthenticated (see license-server/lib/license-gate.mjs's header).
  ipcMain.handle(IPC.licenseConfig, async (e, payload: unknown) => {
    assertMainWindow(e)
    const parsed = LicenseConfigPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    return fetchLicenseConfig(parsed.data.serverUrl)
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
    resetHeadroom(parsed.provider) // the old key's remaining-budget snapshot is meaningless for a new key
    // setApiKey() silently treats an empty/whitespace key as "clear the saved key" (store.ts) — audit the
    // actual effect, not just the channel name, so a credential removal is never mislabeled as a set.
    auditLog(parsed.key.trim() ? 'key.set' : 'key.removed', { provider: parsed.provider })
    return { hasKeys: hasKeysMap() }
  })

  // MQA-261: put the shipped Cloudflare key back. Main-window-gated like every other credential write —
  // the Intelligence window's reader preload must never reach a key mutation.
  //
  // resetProviderHealth is not incidental: the reason a user reaches for this is usually that asks started
  // failing, and a recorded auth verdict against 'cloudflare' would otherwise keep the restored key
  // demoted until it happened to succeed. Same pairing setApiKey and clearApiKey already use.
  ipcMain.handle(IPC.restoreEmbeddedCloudflareKey, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Unlock Metis first.', hasKeys: hasKeysMap() }
    const result = restoreEmbeddedCloudflareKey()
    if (result.ok) {
      resetProviderHealth('cloudflare')
      resetHeadroom('cloudflare')
    }
    return { ...result, hasKeys: hasKeysMap() }
  })

  ipcMain.handle(IPC.clearApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { hasKeys: hasKeysMap() }
    const parsed = ClearApiKeyPayloadSchema.parse(payload)
    clearApiKey(parsed.provider)
    resetProviderHealth(parsed.provider) // same reason as setApiKey above
    resetHeadroom(parsed.provider)
    // Dust's credential is a PAIR: the access token (the provider key just cleared) and the WorkOS
    // refresh token in its own encrypted file. Clearing only the key left dust-refresh.bin on disk, so
    // the next refresh could silently re-mint a working Dust key and reconnect an integration the user
    // had explicitly removed — the same "a disconnect must actually remove the secret" rule mcpDisconnect
    // already follows for its own refresh slot. Report an undeletable file honestly instead of claiming a
    // clean removal while the secret survives.
    let dustRefreshRemoved = true
    if (parsed.provider === 'dust') {
      dustRefreshRemoved = clearDustRefreshToken()
      // Take the session OFF the oauth branch as well. refreshAndPersistDust only re-mints while
      // dustSessionOrigin === 'oauth', so leaving it there means a later hand-pasted Dust key could be
      // silently overwritten by a token minted from the account the user just disconnected — the exact
      // resurrection this clear exists to prevent, and the one path still open when the token file could
      // not be deleted above. Whichever way the user reconnects next sets the origin itself (OAuth at
      // dust-oauth.ts's completeDustOAuthLogin, CLI at dustImportCli), so this value is inert until then.
      setSettings({ dustSessionOrigin: 'cli', dustTokenMintedAt: 0 })
    }
    auditLog('key.removed', { provider: parsed.provider, ...(parsed.provider === 'dust' ? { dustRefreshRemoved } : {}) })
    return { hasKeys: hasKeysMap(), ...(dustRefreshRemoved ? {} : { error: "Removed the Dust key, but its saved sign-in file couldn't be deleted — remove it manually." }) }
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
    // On-401 self-heal: the Dust OAuth token lasts ~1h; refresh it once and retry so the picker doesn't
    // just go empty when the token lapses between sessions. Branches on dustSessionOrigin — a native-OAuth
    // session must never be refreshed via the CLI path (there is no `dust-cli` keytar item to read) and
    // vice versa.
    if (isDustAuthError(r.error)) {
      const origin = getSettings().dustSessionOrigin
      if (origin === 'oauth') {
        const fresh = await refreshDustOAuthSession()
        if (!fresh.ok || !fresh.token) return r
      } else {
        const s = await refreshDustCliSession()
        if (!s.ok || !s.token || !s.workspaceId) return r
        setApiKey('dust', s.token)
        setSettings({ dustWorkspaceId: s.workspaceId, dustBaseUrl: s.baseUrl || 'https://dust.tt', dustTokenMintedAt: Date.now() })
      }
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
    setSettings({
      dustWorkspaceId: s.workspaceId,
      dustBaseUrl: s.baseUrl || 'https://dust.tt',
      dustTokenMintedAt: Date.now(),
      dustSessionOrigin: 'cli'
    })
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

  // Native OAuth sign-in (no CLI, no system Node.js — see main/dust-oauth.ts). `pendingDustLogin` bridges
  // a successful poll to the workspace-pick step: the access/refresh tokens never cross to the renderer,
  // so they have to live somewhere in main between "we have tokens" and "the user picked a workspace".
  // Reset on every dustLoginBegin so a second sign-in attempt can never complete against stale tokens
  // from an earlier, abandoned attempt.
  let pendingDustLogin: { accessToken: string; refreshToken: string; region: string } | null = null
  // The device code stays in MAIN and is never handed to the renderer. Polling a renderer-supplied code
  // would let a caller complete a login against a code minted out-of-band against the public WorkOS
  // client id (dust-oauth.ts) — installing someone else's Dust tokens as this user's credential. The
  // renderer only needs the user code and verification URL to show the consent prompt.
  let pendingDustDeviceCode: string | null = null
  ipcMain.handle(IPC.dustLoginBegin, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    pendingDustLogin = null
    pendingDustDeviceCode = null
    const r = await beginDustDeviceLogin()
    pendingDustDeviceCode = r.ok && r.deviceCode ? r.deviceCode : null
    const { deviceCode: _withheld, ...safe } = r
    return safe
  })
  ipcMain.handle(IPC.dustLoginPoll, async (e) => {
    assertMainWindow(e)
    // Same gate as dustLoginBegin above. Without it the begin-step's check is decorative: this pair is
    // what actually writes the credential, and pendingDustLogin is set HERE, not by begin. Every mutating
    // handler in this file gates on requireAuth().
    if (!requireAuth()) return { status: 'error', error: 'Sign in with your Mantu account first.' }
    // Main's own code — never one supplied by the caller (see pendingDustDeviceCode above).
    const deviceCode = pendingDustDeviceCode
    if (!deviceCode) return { status: 'error', error: 'Start the Dust sign-in again.' }
    const r = await pollDustDeviceLoginOnce(deviceCode)
    if (r.status !== 'ok') return { status: r.status, error: 'error' in r ? r.error : undefined }
    pendingDustLogin = { accessToken: r.accessToken, refreshToken: r.refreshToken, region: r.region }
    const ws = await listDustWorkspacesForToken(r.accessToken, r.region)
    if (!ws.ok) return { status: 'error', error: ws.error }
    return { status: 'ok', workspaces: ws.workspaces }
  })
  ipcMain.handle(IPC.dustLoginPickWorkspace, async (e, workspaceIdRaw: unknown) => {
    assertMainWindow(e)
    // This is the step that actually persists the tokens (completeDustOAuthLogin below) — gate it too,
    // not just the begin step. See the dustLoginPoll comment above.
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const workspaceId = typeof workspaceIdRaw === 'string' ? workspaceIdRaw : ''
    if (!workspaceId) return { ok: false, error: 'Missing workspace id.' }
    if (!pendingDustLogin) return { ok: false, error: 'Sign-in session expired — start again.' }
    completeDustOAuthLogin({ ...pendingDustLogin, workspaceId })
    pendingDustLogin = null
    pendingDustDeviceCode = null // consumed — a finished login must not leave a pollable code behind
    if (Notification.isSupported()) {
      new Notification({ title: 'Dust connected', body: 'Métis is linked to your Dust workspace.' }).show()
    }
    return { ok: true }
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
  // MQA-062: the Settings AI tab calls this on open, the way Settings already live-checks Dust. Gated
  // and shaped like every other settings-writing handler (main window, requireAuth) — it can clear a
  // cliConnected flag, so an unauthenticated caller must not reach it. Returns the fresh snapshot so a
  // retired flag lands in the panel that asked, without waiting for the next settings poll.
  ipcMain.handle(IPC.cliVerifySessions, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return publicSettings()
    await verifyCliSessions()
    return publicSettings()
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

  // --- MCP connections: BidStack CRM push + Plane "Book next steps" ---
  // Generalized from the old single-connection BidStack-only handlers (Settings → Mantu Intelligence
  // cards + Review's "Push to CRM" / "Book next steps"). `connectionId` identifies WHICH
  // settings.mcpConnections entry a call targets (id === kind in v1 — see McpConnectionSchema in
  // shared/ipc.ts). ClickUp has no handler here — it's schema-reserved only (see McpConnectionKindSchema).

  // Default display label for a connection id BEFORE it has ever been saved (so "Test connection" —
  // which runs before any persistence — still gets a real label for its error/log messages instead of
  // the bare id). Falls back to a previously saved label (reconnect flow) or the id itself.
  const MCP_KIND_LABELS: Record<McpConnectionKind, string> = {
    bidstack: 'Polo Pre-Sales',
    clickup: 'ClickUp',
    plane: 'Plane'
  }
  function mcpLabelFor(connectionId: string): string {
    const existing = getSettings().mcpConnections.find((c) => c.id === connectionId)
    if (existing?.label) return existing.label
    const kind = McpConnectionKindSchema.safeParse(connectionId)
    return kind.success ? MCP_KIND_LABELS[kind.data] : connectionId
  }

  // Wave 4: mcp:push's own MCP tool names are per-connection and user/operator-configured — there is no
  // registry mapping them to the queue's small action-kind enum. A cheap name heuristic is enough for
  // this queue's own purposes (it only affects a retry-log label, never routing): most tools are named
  // for what they do (push_meeting_recap, create_task, log_note, update_deal, …).
  function inferPushActionKind(toolName: string): OutboundActionKind {
    const t = toolName.toLowerCase()
    if (t.includes('deal')) return 'update_deal'
    if (t.includes('task')) return 'create_task'
    return 'log_note'
  }

  // The background half of the retry queue: re-attempts one durable OutboundAction against whatever the
  // named connection's CURRENT endpoint/key are (a retry may run long after the original attempt, so the
  // key may have since been rotated or the connection reconnected). Deliberately does not repeat the
  // interactive handler's ClickUp-401-refresh dance below — that stays exclusive to the live, synchronous
  // path; a ClickUp token that expired between attempts here simply dead-letters like any other repeated
  // failure, which is an acceptable (and honest — "reconnect ClickUp") outcome for a background retry.
  async function retryOutboundAction(action: OutboundAction): Promise<{ ok: boolean; error?: string }> {
    // Re-check disk on every retry tick — a meeting flagged confidential AFTER enqueue must never leave.
    if (action.meetingFile && isMeetingConfidentialOnDisk(getSettings(), action.meetingFile)) {
      // Dequeue without sending — returning ok:true removes the entry; a hard error would retry forever.
      auditLog('mcp.push.skipped_confidential', { kind: action.kind, action: action.action, source: 'disk' })
      return { ok: true }
    }
    const s = getSettings()
    const conn = s.mcpConnections.find((c) => c.kind === action.kind)
    if (!conn || !conn.connected || !conn.endpointUrl || !hasMcpApiKey(conn.id)) {
      return { ok: false, error: `${mcpLabelFor(action.kind)} is no longer connected.` }
    }
    const apiKey = getMcpApiKey(conn.id)
    return pushToMcp(conn.endpointUrl, apiKey, conn.extraHeaders, action.toolName, action.payload, conn.label)
  }

  // Same minute-ish cadence as the brain reconcile tick (BRAIN_RECONCILE_MS, set up below in
  // app.whenReady) — cheap enough to poll often, and pushQueue.processDue itself no-ops instantly when
  // the queue is empty or every due action is still cooling down on backoff. Lives here (registerIpc),
  // not next to that tick, because retryOutboundAction and mcpLabelFor above are this function's own
  // locals — pulling the timer out to whenReady's scope would mean hoisting both to module scope for no
  // real benefit.
  trackTimer(setInterval(() => {
    void pushQueue.processDue(retryOutboundAction).catch((e) => mainLog.warn('[mcp-push-queue] processDue tick failed:', e))
  }, 60 * 1000))

  // Test connection: connects + authenticates + lists tools, persists NOTHING (mirrors BidStack's own
  // "Test endpoint" button). Lets the user verify before committing an endpoint/key to disk.
  ipcMain.handle(IPC.mcpTestConnection, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpTestConnectionPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    return connectMcp(parsed.data.endpointUrl, parsed.data.apiKey, parsed.data.extraHeaders, mcpLabelFor(parsed.data.connectionId))
  })

  // Save connection: re-verifies (never trust a stale/unverified endpoint+key) then persists the
  // endpoint/label/headers to settings, the key to the per-connection MCP secrets file, and the
  // discovered tools for the picker.
  ipcMain.handle(IPC.mcpSaveConnection, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpSaveConnectionPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const { connectionId, endpointUrl, apiKey, extraHeaders, label } = parsed.data
    const kindParsed = McpConnectionKindSchema.safeParse(connectionId)
    if (!kindParsed.success) return { ok: false, error: 'Unknown MCP connection id.' }
    const r = await connectMcp(endpointUrl, apiKey, extraHeaders, label)
    if (!r.ok) return r
    // MQA-064: mcpSecrets.ts writes user-facing diagnostics for exactly this step ("Encryption is
    // unavailable on this machine…", "Métis can't write to its data folder…"), but they are THROWN. An
    // unhandled throw here rejects the renderer's invoke, and the Settings card has no catch — it sits on
    // "saving" with the deliberately-authored message never reaching the user. Route it through the
    // {ok,error} channel the card already renders, mirroring the provider-key save (Settings.tsx).
    try {
      setMcpApiKey(connectionId, apiKey)
      const s = getSettings()
      const entry: McpConnection = {
        id: connectionId,
        kind: kindParsed.data,
        label,
        endpointUrl: endpointUrl.trim(),
        connected: true,
        tools: r.tools ?? [],
        extraHeaders
      }
      setSettings({ mcpConnections: [...s.mcpConnections.filter((c) => c.id !== connectionId), entry] })
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : `Could not store the ${label} API key.` }
    }
    auditLog('mcp.connected', { connectionId, tools: (r.tools ?? []).length })
    return r
  })

  ipcMain.handle(IPC.mcpDisconnect, (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpDisconnectPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const { connectionId } = parsed.data
    const keyRemoved = clearMcpApiKey(connectionId)
    // A no-op for a connection kind that never had one (BidStack, Plane) — only ClickUp's OAuth token
    // pair populates this file, but clearing unconditionally means disconnect never has to know which
    // kinds are OAuth-based.
    const refreshRemoved = clearMcpRefreshToken(connectionId)
    const s = getSettings()
    setSettings({
      mcpConnections: s.mcpConnections.map((c) => (c.id === connectionId ? { ...c, connected: false, tools: [] } : c))
    })
    auditLog('mcp.disconnected', { connectionId, keyFileRemoved: keyRemoved, refreshFileRemoved: refreshRemoved })
    // Don't falsely report a clean disconnect when a secret is still on disk — the connection is marked
    // off, but the user needs to know a file survived so they can remove it manually.
    if (!keyRemoved || !refreshRemoved)
      return {
        ok: false,
        error: `Disconnected, but the stored ${mcpLabelFor(connectionId)} credentials could not be fully deleted — remove them manually.`
      }
    return { ok: true }
  })

  // Push: uses the already-saved endpoint + key for the named connection. Never accepts an endpoint/key
  // from the renderer here — only a previously tested-and-saved connection can push, so a compromised
  // renderer can't redirect the push to an attacker-controlled MCP endpoint by passing arbitrary payload
  // fields.
  ipcMain.handle(IPC.mcpPush, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpPushPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const { connectionId, toolName, args, meetingFile } = parsed.data
    const s = getSettings()
    // Wave 4 / QA defense-in-depth: never push confidential meetings. Prefer disk frontmatter over the
    // renderer flag — a buggy UI could omit args.confidential. Unreadable files fail closed.
    const diskConfidential = meetingFile ? isMeetingConfidentialOnDisk(s, meetingFile) : false
    const argConfidential = args && typeof args === 'object' && (args as { confidential?: unknown }).confidential === true
    if (diskConfidential || argConfidential) {
      auditLog('mcp.push.skipped_confidential', {
        connectionId,
        tool: toolName,
        source: diskConfidential ? 'disk' : 'args'
      })
      return { ok: false, error: 'This meeting is marked confidential — push is blocked.' }
    }
    const conn = s.mcpConnections.find((c) => c.id === connectionId)
    if (!conn || !conn.connected || !conn.endpointUrl || !hasMcpApiKey(connectionId)) {
      return { ok: false, error: `${mcpLabelFor(connectionId)} is not connected. Set it up in Settings → Mantu Intelligence first.` }
    }
    // Only a tool the user actually saw and picked when the connection was tested/saved may be invoked —
    // otherwise a compromised or buggy renderer call could reach an unintended (possibly destructive) MCP
    // tool on the user's live connection.
    if (!conn.tools.includes(toolName)) {
      return { ok: false, error: `Unknown ${conn.label} tool.` }
    }
    const apiKey = getMcpApiKey(connectionId)
    let r = await pushToMcp(conn.endpointUrl, apiKey, conn.extraHeaders, toolName, args, conn.label)
    // ClickUp-only: its credential is an OAuth access token, not a pasted key that only changes when the
    // user edits it — a 401 here can mean the token simply expired. Attempt exactly one refresh + retry
    // before surfacing reconnect-required, gated on the SAME single-flight lock the interactive OAuth
    // flow uses (see clickupOAuth.ts) so a background refresh here and a user-initiated Reconnect in
    // Settings can never both persist tokens at once.
    if (!r.ok && conn.kind === 'clickup' && /401|403|unauthor|forbidden/i.test(r.error || '')) {
      if (tryAcquireClickupTokenLock()) {
        try {
          const refreshToken = getMcpRefreshToken(connectionId)
          const refreshed = refreshToken ? await refreshClickupToken(refreshToken) : { ok: false as const }
          if (refreshed.ok && refreshed.accessToken) {
            setMcpApiKey(connectionId, refreshed.accessToken)
            setMcpRefreshToken(connectionId, refreshed.refreshToken ?? refreshToken ?? '')
            r = await pushToMcp(conn.endpointUrl, refreshed.accessToken, conn.extraHeaders, toolName, args, conn.label)
          } else {
            r = { ok: false, error: 'Your ClickUp session expired. Reconnect ClickUp in Settings.' }
          }
        } finally {
          releaseClickupTokenLock()
        }
      } else {
        r = { ok: false, error: 'A ClickUp sign-in or refresh is already in progress. Try again in a moment.' }
      }
    }
    auditLog('mcp.push', { connectionId, tool: toolName, ok: r.ok })
    // Wave 4: the live attempt above already gave the renderer an immediate answer. A FAILURE also goes
    // into the durable retry queue so a transient MCP-endpoint blip doesn't silently drop the push —
    // enqueue is idempotent (same connection+tool+payload collapses to one entry), so a user who clicks
    // "Push" again after a failure never double-queues the same write. Confidential is read straight off
    // `args` (McpArgValueSchema already allows a boolean value there) — never sent, ever, by processDue.
    if (!r.ok) {
      pushQueue.enqueue({
        kind: conn.kind,
        action: inferPushActionKind(toolName),
        toolName,
        payload: args,
        ...(meetingFile ? { meetingFile: meetingFile.split(/[/\\]/).pop() || meetingFile } : {}),
        confidential: argConfidential || diskConfidential
      })
    }
    return r
  })

  // ClickUp has no endpoint/key form — one button runs the OAuth 2.1 + PKCE consent flow (opens the
  // system browser), then persists exactly like mcpSaveConnection does for a pasted key.
  ipcMain.handle(IPC.mcpClickupConnect, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const tokens = await runClickupOAuth()
    if (!tokens.ok || !tokens.accessToken) return { ok: false, error: tokens.error || 'Could not connect ClickUp.' }
    const r = await connectMcp(CLICKUP_MCP_ENDPOINT, tokens.accessToken, {}, 'ClickUp')
    if (!r.ok) return r
    try {
      setMcpApiKey('clickup', tokens.accessToken)
      setMcpRefreshToken('clickup', tokens.refreshToken ?? '')
      const s = getSettings()
      const entry: McpConnection = {
        id: 'clickup',
        kind: 'clickup',
        label: 'ClickUp',
        endpointUrl: CLICKUP_MCP_ENDPOINT,
        connected: true,
        tools: r.tools ?? [],
        extraHeaders: {}
      }
      setSettings({ mcpConnections: [...s.mcpConnections.filter((c) => c.id !== 'clickup'), entry] })
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : 'Could not store the ClickUp connection.' }
    }
    auditLog('mcp.connected', { connectionId: 'clickup', tools: (r.tools ?? []).length })
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
    // MQA-236: no prewarmCapture() here anymore — it takes a REAL frame, and signing in is not screen
    // intent. The warm rides hovering the Capture button (Bar.tsx), the moment intent is signalled.
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
  // Support diagnosability: nothing in this app uploads anywhere by design (crashReporter
  // uploadToServer:false, zero telemetry), so the ONLY way the log trail reaches support is the user
  // exporting it. Copies logs/ (main + audit + rotated audit generations), crash-*.log dumps, and the
  // boot sentinel into a user-chosen folder, plus a MANIFEST naming the app version and every file
  // copied. Deliberately NEVER copies meetings, .brain/, wiki/, or settings.json — diagnostics must not
  // become an accidental data-exfiltration path for content.
  ipcMain.handle(IPC.diagnosticsExport, async (e): Promise<DiagnosticsExportResult> => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
      const dialogOpts = {
        title: 'Export diagnostics bundle',
        defaultPath: join(app.getPath('downloads'), `Metis-diagnostics-${stamp}`),
        buttonLabel: 'Export here'
      }
      const res = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts)
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true }
      const dest = res.filePath
      mkdirSync(dest, { recursive: true })
      const userData = app.getPath('userData')
      const copied: string[] = []
      const copy = (src: string, name: string): void => {
        try {
          copyFileSync(src, join(dest, name))
          copied.push(name)
        } catch {
          /* a locked/absent file is skipped, and the manifest shows exactly what made it */
        }
      }
      const logsDir = join(userData, 'logs')
      if (existsSync(logsDir)) {
        for (const f of readdirSync(logsDir)) {
          if (/\.log$/.test(f)) copy(join(logsDir, f), f)
        }
      }
      for (const f of readdirSync(userData)) {
        if (/^crash-.*\.log$/.test(f)) copy(join(userData, f), f)
      }
      const sentinel = join(userData, 'boot-incomplete.json')
      if (existsSync(sentinel)) copy(sentinel, 'boot-incomplete.json')
      const manifest = [
        `Métis diagnostics bundle`,
        `exported: ${new Date().toISOString()}`,
        `version: ${app.getVersion()}`,
        `platform: ${process.platform} ${process.arch}`,
        `packaged: ${app.isPackaged}`,
        ``,
        `files (${copied.length}):`,
        ...copied.map((f) => `  ${f}`),
        ``,
        `Deliberately NOT included: meeting transcripts, the .brain/ knowledge store, the wiki mirror,`,
        `and settings.json — this bundle is for diagnosing the app, never for moving content.`
      ].join('\n')
      writeFileSync(join(dest, 'MANIFEST.txt'), manifest, 'utf8')
      auditLog('diagnostics.export', { files: copied.length })
      return { ok: true, path: dest, files: copied.length }
    } catch {
      return { ok: false, error: 'Could not export the diagnostics bundle.' }
    }
  })

  ipcMain.handle(IPC.recallDelete, async (e, file: unknown, title: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const safeName = basename(String(file ?? ''))
    const label = typeof title === 'string' && title.trim() ? title.trim() : 'this meeting'
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete meeting',
      message: `Delete "${label}"?`,
      detail: 'This removes the saved transcript, its notes, and its extracted knowledge from this device. This cannot be undone.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = win ? await dialog.showMessageBox(win, dialogOpts) : await dialog.showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const result = await deleteMeeting(safeName)
    if (result.ok) {
      auditLog('transcript.deleted', { file: safeName })
      // The published note card is derived from a file that no longer exists — publishMeetingCard unlinks
      // it in exactly that case (and no-ops when publishing is off). Done here rather than left to the
      // next rebuild: requestSourceRefresh below bails on a busy queue, a pending replay, or a profile
      // with no usable provider, which would leave the deleted meeting's plaintext card on disk for good.
      await publishMeetingCard(getSettings(), safeName).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        mainLog.warn(`[publish] could not remove the note card for a deleted meeting: ${detail}`)
      })
      // MQA-230: the deleted meeting's own extraction JSON + ledger row need no provider to remove —
      // erase them NOW rather than leaving them to the refresh below, which no-ops while no provider is
      // usable. Best-effort like the card removal above: a locked file must not fail the delete the user
      // already confirmed, but it is logged so the residue is never silent.
      await exciseDeletedMeeting(getSettings(), safeName)
        .then(({ gone }) => {
          if (!gone) mainLog.warn(`[brain] extraction for a deleted meeting could not be removed: ${safeName}`)
        })
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error)
          mainLog.warn(`[brain] excise failed for a deleted meeting: ${detail}`)
        })
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

  // MQA-092: durable record that this recap already reached the CRM. Same guard shape as every other
  // recall write (main window, requireAuth, zod, basename re-checked inside recall.ts). No republish
  // here — unlike the confidential flag, this marker changes nothing about what is published; it only
  // stops the push panel re-offering a send that already happened.
  ipcMain.handle(IPC.recallSetCrmPushed, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = SetCrmPushedPayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid request.' }
    return setMeetingCrmPushed(getSettings(), parsed.data.file, parsed.data.key)
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
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete all Métis data',
      // Zero meetings is NOT an empty profile: the derived artifacts (.brain, the published wiki mirror,
      // the graph) outlive the transcripts they were built from, so a folder whose meetings were already
      // deleted one at a time still has plaintext to erase. This flow runs for it too.
      message: meetings.length
        ? `Delete all ${meetings.length} saved meeting${meetings.length === 1 ? '' : 's'}?`
        : 'Delete all Métis data on this device?',
      detail:
        'This permanently removes every saved transcript, note, and the knowledge graph from this device. This cannot be undone.',
      buttons: ['Delete everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = win ? await dialog.showMessageBox(win, dialogOpts) : await dialog.showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const result = await deleteAllMeetings()
    purgeGraphArtifacts() // legacy userData/graph artifacts + the runner's graphify-out/ manifest
    const brainPurge = purgeBrain(getSettings()) // the `.brain/` knowledge store — entities, quotes, graph
    // The wiki mirror is that same derived knowledge in CLEARTEXT (publish.ts writes it with
    // `encrypt: false` by design), so an erasure that skipped it would leave a readable copy of every
    // meeting, person and open commitment behind — and, with the brain gone, one nothing can ever prune.
    // Unconditional, not gated on publishBrainPages: a mirror survives the publish OFF edge whenever that
    // removal failed, and this promise is "everything", not "everything currently enabled".
    const wiki = removeWiki(getSettings())
    auditLog('transcript.deleted', {
      bulk: true,
      deleted: result.deleted,
      failed: result.failed.length,
      brainPurged: brainPurge.ok,
      wikiRemoved: wiki.ok
    })
    if (!wiki.ok) {
      return {
        ...result,
        ok: false,
        error: 'Deleted the transcripts, but the published wiki pages could not be removed. Close anything using the meetings folder, then try again.'
      }
    }
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
    // openMailDraft, McpArgValueSchema); without this a malicious/malfunctioning renderer could force a
    // synchronous decode of an arbitrarily large buffer and hang or OOM the whole app.
    if (p.samples.length > 16_000 * 30) return ''
    const text = await parakeetTranscribe(p.samples)
    // Speaker Intelligence (SPEAKER-INTELLIGENCE-PLAN §3): label THEM windows with a voice-derived name
    // ("Jane Doe" from an enrolled profile, else a stable "Speaker N" session label). Same PCM buffer the
    // ASR just consumed — no extra capture. Strictly additive and best-effort: any failure or the feature
    // being off/unprovisioned attaches no name and the line renders exactly as before.
    if (text && p.speaker === 'them') {
      const label = labelThemAudio(p.samples)
      // P2 echo defense: this window is the operator's OWN voice bleeding through the loopback, not the
      // other person — drop the transcribed text entirely rather than mislabel the operator's words as
      // "them" (a name/cluster label attached here would otherwise show up as something THEY said).
      if (label?.echo) return { text: '', echo: true }
      if (label) return { text, name: label.name }
    } else if (p.speaker === 'you') {
      // ME windows never get a THEM label — feed straight into operator echo-defense/profile upkeep.
      observeOperatorAudio(p.samples)
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
    if (text && p.speaker === 'them') {
      const label = labelThemAudio(p.samples)
      if (label?.echo) return { text: '', echo: true } // see parakeetFeed's identical echo-defense comment above
      if (label) return { text, name: label.name }
    } else if (p.speaker === 'you') {
      observeOperatorAudio(p.samples)
    }
    return { text }
  })

  // Speaker Intelligence (SPEAKER-INTELLIGENCE-PLAN §3) — the Whisper engine's speaker-embedding tap.
  // Whisper runs entirely in a renderer Worker with no main-process round trip of its own (unlike
  // Parakeet/Apple, which already ride the label along on parakeetFeed/appleSpeechFeed above), so
  // listen.ts's Whisper commitLine path calls this separately, after the fact, with the SAME window's
  // audio the worker just transcribed — fire-and-forget, best-effort, never blocking the live decode.
  ipcMain.handle(IPC.speakerEmbed, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return {}
    const p = payload as { samples?: unknown; speaker?: unknown }
    if (!(p?.samples instanceof Float32Array)) return {}
    // Same defensive cap as parakeetFeed — see its own comment for why.
    if (p.samples.length > 16_000 * 30) return {}
    if (p.speaker === 'them') {
      const label = labelThemAudio(p.samples)
      // Echo bleed: the Whisper worker already committed the line — return echo:true so the renderer
      // can drop it (listen.ts). Without that flag the operator's own words stayed labeled as THEM.
      if (label?.echo) return { echo: true as const }
      if (label) return { name: label.name }
    } else if (p.speaker === 'you') {
      observeOperatorAudio(p.samples)
    }
    return {}
  })

  // --- Métis Local (on-device LLM): model readiness metadata ---
  // Paths stay in main; the renderer only learns whether the weights are usable, and — since they are
  // fetched on first run rather than shipped — whether that fetch is running, failed, or never started
  // (MQA-187). Folded into this one channel deliberately: no second push channel to keep in sync, and
  // nothing new crosses the boundary beyond a status word and a fraction.
  ipcMain.handle(IPC.localModelsList, (e) => {
    assertMainWindow(e)
    return listLocalModels(localModelDownloadState())
  })

  // MQA-247: the high-accuracy transcription model. Same shape as the LLM weights above — paths stay in
  // main, the renderer learns only readiness, a status word and a fraction.
  //
  // Fetch is EXPLICIT. 1.61 GB is not a transfer to begin on someone's behalf, and the bundled floor
  // model already works, so nothing here runs on a timer or on first import. The user asks.
  ipcMain.handle(IPC.asrModelState, async (e) => {
    assertMainWindow(e)
    return { ...asrModelDownloadState(), ready: await isHighTierAsrModelReady(), bytes: asrModelBytes() }
  })
  ipcMain.handle(IPC.asrModelFetch, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false }
    auditLog('asr.model.fetch_requested', { bytes: asrModelBytes() })
    return { ok: await ensureHighTierAsrModel() }
  })
  ipcMain.handle(IPC.asrModelRemove, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false }
    removeHighTierAsrModel()
    auditLog('asr.model.removed', {})
    return { ok: true }
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
    // MQA-182: Private View means Métis does not look at OR SEND your screen — and an already-captured
    // frame is still your screen. The renderer keeps the last vision request verbatim so Retry / "Go
    // deeper" can replay it (state.ts lastReqRef), and that replay used to reach the provider minutes
    // after the user flipped the switch. getScreenshot() re-checks the switch after its own async
    // capture for exactly this reason (see its post-capture check); every path that can send a frame has
    // to re-check it at SEND time, and this handler is the trust boundary the renderer cannot bypass.
    // Keyed on the payload, not the mode: the schema permits an image on a non-vision mode too.
    if (req.image && privateViewOn()) {
      auditLog('capture.blocked', { reason: 'private_view', at: 'ask' })
      win?.webContents.send(IPC.streamError, { id: req.id, message: PRIVATE_VIEW_BLOCKED_MESSAGE })
      return
    }
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
    // Overlap local sidecar start with the sync brain stamp below — when local will serve (or hedge),
    // kicking ensure NOW hides cold-load behind Receipt Mode work instead of serializing after it.
    if (localPrewarmEligible(s, getAllowedProviders(), publicSettings().providerReady)) {
      void ensureLocalRuntimeStarted(s.localLlm.modelId, req.mode === 'vision').catch((err) =>
        mainLog.warn('[local] early ensure failed', err instanceof Error ? err.message : String(err))
      )
    }
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
    // MQA-180: the injection above is best-effort, and on a REPLAY it usually finds nothing — Retry / "Go
    // deeper" re-send the renderer's intent flag verbatim (state.ts lastReqRef) long after the cached
    // description expired, the user changed windows, or Private View went on. The renderer set its
    // "Viewed screen" badge from that intent flag alone, so an ask that reached the provider with zero
    // screen data still rendered as grounded. Main is the only side that knows what actually went out:
    // report the verdict on stream:meta. `undefined` for every other ask — main has no verdict there and
    // the renderer keeps what run() set (a vision ask carries its own image).
    const screenGrounded =
      req.mode === 'answer' && req.wantsScreenContext ? !!req.screenContext : undefined
    const allowed = getAllowedProviders() // org allowlist (null = unrestricted)

    // Screen-vision capability. Static per provider, EXCEPT Dust: its ability to read a screenshot depends
    // on the selected agent's underlying model (it uploads the shot as a content fragment), so consult the
    // per-agent capability instead of the static flag. Everything else uses PROVIDERS[p].vision.
    const providerVisionOk = (p: ProviderId): boolean =>
      p === 'dust' ? dustSelectedAgentVision(s.providerModels['dust']) : PROVIDERS[p].vision

    // MQA-228: the "can't read screenshots" advice must name a provider the user is actually ALLOWED to
    // switch to. The static "Switch to Claude or GPT" wording sent org-policy users at providers the
    // allowlist blocks — following the advice dead-ended on the approved-provider-list error. Prefer a
    // target that is already keyed/CLI-connected (immediately actionable), else any allowed vision-capable
    // provider; when the policy leaves none at all, say THAT instead of advising an impossible switch.
    // 'local' is excluded as a switch target: when it was eligible, the fallback path already answered
    // before this message could surface, so naming it here would always be advice that just failed.
    const visionSwitchAdvice = (blocked: ProviderId): string => {
      const candidates = (Object.keys(PROVIDERS) as ProviderId[]).filter(
        (p) => p !== blocked && p !== 'local' && providerVisionOk(p) && (!allowed || allowed.includes(p))
      )
      const ready = candidates.find((p) =>
        PROVIDERS[p].kind === 'cli' ? !!s.cliConnected[p] : getApiKey(p).length > 0
      )
      const target = ready ?? candidates[0]
      if (target)
        return `Switch to ${PROVIDERS[target].label} in Settings, or ask without a screen capture.`
      return allowed
        ? "Your organization's approved providers can't read screenshots — ask without a screen capture."
        : 'Ask without a screen capture.'
    }

    // Pick the next eligible keyed provider not yet tried — the waterfall target when the primary (e.g.
    // Dust) can't answer. Pure (no side effect) so the retry gate can cheaply ask "is there anywhere to
    // fall over to?" before deciding how long to keep retrying a dead primary.
    const pickFailover = (tried: ProviderId[], preferFree = false): ProviderId | null => {
      // A request pinned to a specific Dust agent (Spotlight Ref) has NO valid failover target — no other
      // provider hosts that managed agent, so falling over would silently answer from the active generic
      // provider (e.g. Kimi) with a reply that never touched the agent. Returning null here suppresses
      // failover at BOTH seams that consult pickFailover (the retry-budget sizing and the pre-token
      // failover line), letting the flow fall through to the reconnect-Dust message instead.
      if (!allowCrossProviderFailover(req)) return null
      const tier = routeTier(req, s.thinkingMode)
      // MQA-269: a user-authored chain IS the priority. When present it replaces both sort keys —
      // providerPriority's CLI bucket-swap and preferFree's free-tier float — because both exist to GUESS
      // an order the user has now stated outright. Silently re-sorting a chain the user typed is the
      // failure mode this field exists to end; preferFree in particular would reorder it at exactly the
      // moment the order matters most (the primary just ran out). Providers not in the chain are appended
      // after it, still in declaration order — a chain is a preference, not an allowlist, so a key added
      // later remains a reachable backup without re-editing the chain.
      // Ids are filtered through PROVIDERS so a stale profile naming a retired provider cannot crash, and
      // deduped so a hand-edited settings file cannot make one provider eat two attempts.
      const userOrder = s.providerFallbackOrder.filter(
        (p, i, a) => p in PROVIDERS && a.indexOf(p) === i
      ) as ProviderId[]
      const all = Object.keys(PROVIDERS) as ProviderId[]
      // Candidate order (no chain) honors the CLI-vs-API priority: when 'cli', CLI-kind providers sort
      // first so a failover reaches for another local CLI before a metered API. V8's Array.sort is
      // stable, so equal-rank providers keep their PROVIDERS declaration order; 'api' (default) leaves
      // the order unchanged. `preferFree` (set when the primary just ran OUT of credit/tokens, gated on
      // resilience.preferFreeOnExhaustion) adds a secondary key that floats free-tier providers ahead of
      // paid ones — "prefer a free backup when the paid one is spent" — without touching the normal order.
      const order = userOrder.length
        ? [...userOrder, ...all.filter((p) => !userOrder.includes(p))]
        : all.slice().sort((a, b) => {
            const cliRank =
              s.providerPriority === 'cli'
                ? (PROVIDERS[a].kind === 'cli' ? 0 : 1) - (PROVIDERS[b].kind === 'cli' ? 0 : 1)
                : 0
            if (cliRank !== 0) return cliRank
            if (preferFree) return (PROVIDERS[a].freeTier ? 0 : 1) - (PROVIDERS[b].freeTier ? 0 : 1)
            return 0
          })
      const eligible = (p: ProviderId): boolean => {
        if (tried.includes(p)) return false
        // Métis Local: routingMode-aware primary eligibility (localPrimaryEligibleFor) so Routing mode
        // → Local can fail over / serve without per-mode useFor toggles. 'api' mode keeps local out of
        // the healthy mid-walk (fallback/floor still catch last-resort below). Out-of-scope modes
        // (answer/recap) stay ineligible here — same PLAN.md §4.3 both-gates contract.
        if (p === 'local') {
          if (resolveRoutingMode(s) === 'api') return false
          return localPrimaryEligibleFor(req, s, tier, allowed)
        }
        return (
          (!allowed || allowed.includes(p)) &&
          (PROVIDERS[p].kind === 'cli' ? !!s.cliConnected[p] : getApiKey(p).length > 0) &&
          // A provider whose endpoint the USER supplies (Custom, Cloudflare's operator Worker) is only a
          // candidate once it actually has one. Cloudflare ships a default model, so without this check a
          // key alone would make it eligible and the walk would hand the request to streamOpenAI with no
          // baseURL — where the SDK's own default is api.openai.com. Failing the candidate here keeps the
          // walk moving to a provider that CAN answer instead of burning the attempt on a guard error.
          (!requiresUserBaseUrl(p) || !!providerBaseUrl(p, s)) &&
          (req.mode !== 'vision' || providerVisionOk(p)) &&
          // CLI providers (e.g. codex-cli) may have no configured model at all — attempt() below
          // already exempts kind==='cli' from the "no model" ineligibility check (the CLI just uses
          // its own default), so a failover candidate must be exempted the same way or a fully
          // default-configured CLI provider can never be selected.
          (PROVIDERS[p].kind === 'cli' ||
            !!resolveModelTier(p, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep))
        )
      }
      // Budget pre-emption (resilience.budgetPreempt): skip a provider whose live rate-limit headers say it
      // is about to 429 (usage-headroom.ts). Fail-open — unknown headroom never demotes — and folded into
      // the `healthy` filter ONLY, so a budget-blocked provider is still reachable as the last resort below.
      const budgetBlocked = (p: ProviderId): boolean => s.resilience.budgetPreempt && isBudgetExhausted(p)
      // MQA-003: prefer a provider whose credentials have NOT just been rejected and that has budget left.
      const healthy = order.find((p) => eligible(p) && !isCoolingDown(p) && !budgetBlocked(p))
      if (healthy) return healthy
      // MQA-113: the on-device fallback is preferred over a provider that is currently cooling down. The
      // first unhealthy provider is skipped above, but a SECOND (or Nth) simultaneously-cooling cloud
      // provider used to be returned by the old "?? order.find(eligible)" last resort — so every ask
      // re-walked a known-dead provider (deepseek down AND nvidia down → nvidia retried forever) instead
      // of going straight to local. Local is the honest next hop when all cloud is cooling.
      if (!tried.includes('local') && localFallbackEligibleFor(req, s, tier, allowed)) return 'local'
      // Near-last resort: a cooling cloud/CLI provider is still better than dead-ending with an error when
      // local cannot serve this request in-scope. A cooling provider is demoted, never removed — one
      // revoked key must not lock a user out of their only provider, and a rate-limit may recover mid-walk.
      const coolingResort = order.find(eligible)
      if (coolingResort) return coolingResort
      // The ABSOLUTE floor (the "worst case, no API needed" guarantee): on-device answers even an
      // out-of-scope mode (answer/recap) when literally nothing else can — every cloud/CLI route exhausted
      // or unconfigured, and the request is outside local's normal suggest/summary/vision scope. Dead last,
      // AFTER even a cooling cloud provider that might recover, so it never preempts a real answer.
      if (!tried.includes('local') && localAnswerFloorEligibleFor(req, s, allowed)) return 'local'
      return null
    }
    // F3 hedge: which race (if any) this call is part of, and which of the two legs it is. See hedge.ts's
    // HedgeRace doc comment for the full contract.
    type AttemptRace = { gate: HedgeRace; leg: HedgeLeg }
    // MQA-161: every provider the PRIMARY leg has actually reached, in order. A leg that fails over keeps
    // its leg identity, so picking the backup against the id the primary STARTED on would let the hedge
    // race the provider the primary just moved to — pickFailover is pure, so with identical inputs it
    // returns exactly that provider: one ask, two byte-identical billed requests (prompt, transcript and,
    // on a vision ask, the whole screenshot), both sharing a single failure mode. The hedge exists to buy
    // provider diversity, so it must exclude the whole chain, not one id.
    const primaryChain: ProviderId[] = []

    // Find the next eligible keyed provider not yet tried and start it — for failover when the primary
    // can't answer (Dust down → your configured Claude/GPT key takes over). `preferFree` floats free-tier
    // backups ahead when the just-failed provider ran out of credit/tokens (resilience.preferFreeOnExhaustion).
    // `race`, when present, is forwarded unchanged — a hedged leg's own failover cascade stays part of the
    // SAME leg (see AttemptRace's doc comment on attempt() below).
    const failover = (tried: ProviderId[], preferFree = false, race?: AttemptRace): boolean => {
      const next = pickFailover(tried, preferFree)
      if (!next) return false
      // Wave 2 — record the hop for the one-shot UI chip (docs/PROVIDER-ROUTING-POLICY.md). Only fire
      // when we actually start a different provider; a no-op return above leaves the notice untouched.
      const from = tried.length ? tried[tried.length - 1]! : 'unknown'
      if (from !== next) {
        lastFailoverNotice = {
          from,
          to: next,
          at: Date.now(),
          reason: preferFree ? 'exhausted' : 'failover'
        }
        auditLog('provider.failover', { from, to: next, reason: lastFailoverNotice.reason })
      }
      attempt(next, tried, 0, race)
      return true
    }

    // Validate a provider, start the stream, and on a PRE-token (TTFT) failure retry the same provider
    // (transient errors) then fall over to the next one. `retryCount` tracks same-provider transient
    // retries; failover resets it (each provider gets its own retry budget).
    const MAX_TRANSIENT_RETRIES = 3
    // The longest a rate-limit Retry-After we will WAIT OUT in place during a live ask. Beyond this we fail
    // straight over to the backup rather than freezing the answer — the whole point of "always a backup".
    const MAX_ASK_RETRY_WAIT_MS = 12_000
    // F3 hedge (main/llm/hedge.ts): `race` is set ONLY when this whole request is being hedge-raced (see
    // the primary dispatch at the bottom of this handler). It rides through every recursive attempt() call
    // this closure makes — the same-provider retry timer AND every failover() call — so a hedged leg's
    // entire retry/failover cascade stays gated behind the SAME race the whole way down: once the other
    // leg wins, every handler below (onDelta/onDone/onError) checks race.gate.isLoser(race.leg) first and
    // silently returns, so a losing leg's own cascading retries can never reach the renderer.
    const attempt = (provider: ProviderId, attempted: ProviderId[], retryCount = 0, race?: AttemptRace): void => {
      // Recorded on ENTRY, before any eligibility work: a provider the primary merely bounced off is still
      // one the hedge must not duplicate.
      if (race?.leg === 'primary' && !primaryChain.includes(provider)) primaryChain.push(provider)
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
          // F3 hedge: this leg is out — only actually surface an error once EVERY leg of the race
          // (including a backup that hasn't started yet) is confirmed dead. See HedgeRace.markDead.
          if (!race || race.gate.markDead(race.leg) === 'surface') {
            win?.webContents.send(IPC.streamError, {
              id: req.id,
              message: approvedLabel
                ? `${def.label} is not on your organization's approved provider list. Switch to ${approvedLabel} in Settings.`
                : `${def.label} is not on your organization's approved provider list.`
            })
          }
        } else if (!failover(attempted.concat(provider), undefined, race)) {
          if (!race || race.gate.markDead(race.leg) === 'surface') {
            win?.webContents.send(IPC.streamError, { id: req.id, message: 'No approved provider could answer.' })
          }
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
      // Where this attempt will actually send the request: the user's endpoint for the providers that
      // require one (Custom, Cloudflare's operator Worker), the user's Dust region, else the registry's
      // built-in. Resolved BEFORE the eligibility chain because a missing user endpoint is an eligibility
      // failure, not a stream failure.
      const baseURL = providerBaseUrl(provider, s)
      // Métis Local: accept localPrimaryEligibleFor (routingMode-aware) plus the unchanged fallback/floor
      // nets. Opted-in vision stays local at every tier so prompt complexity cannot silently turn a
      // screenshot into a cloud upload.
      const ineligible =
        provider === 'local'
          ? localPrimaryEligibleFor(req, s, tier, allowed) ||
            localFallbackEligibleFor(req, s, tier, allowed) ||
            // The answer-mode floor: pickFailover routes here when every cloud/CLI route is exhausted for an
            // out-of-scope mode (answer/recap). attempt() must accept it too, or the floor pickFailover
            // offered would be bounced right back with the "uses your cloud provider" message.
            localAnswerFloorEligibleFor(req, s, allowed)
            ? ''
            : localVisionRequired
              ? 'Métis Local could not process this screenshot on this device. Nothing was sent to a cloud provider. Open Settings → AI → Local AI to see whether the on-device model is ready.'
              : 'Métis Local handles live suggestions, summaries and screenshots — this request type uses your cloud provider.'
          : def.kind === 'cli' && !s.cliConnected[provider]
            ? `${def.label} is not connected. Open Settings → CLI Integration to set it up.`
            : def.kind !== 'cli' && !key
              ? `No API key for ${def.label}. Open Settings (gear) and add it.`
              : def.kind !== 'cli' && !model
                ? provider === 'dust'
                  ? `No ${tier === 'think' ? 'thinking' : 'base'} Dust agent set. Open Settings → Connect Dust and pick your agents.`
                  : `No model set for ${def.label}. Pick a model in Settings.`
                : // Endpoint-is-yours providers (Custom, Cloudflare's operator-deployed Worker) cannot be
                  // reached without a URL. Say so HERE, where the message is actionable and the flow can
                  // still fail over, rather than letting streamOpenAI's own guard surface it mid-stream.
                  def.kind !== 'cli' && requiresUserBaseUrl(provider) && !baseURL
                  ? `No endpoint URL set for ${def.label}. Open Settings → Advanced and add it.`
                  : req.mode === 'vision' && !providerVisionOk(provider)
                    ? `${def.label} can't read screenshots. ${visionSwitchAdvice(provider)}`
                    : provider === 'dust' && !s.dustWorkspaceId
                      ? 'Add your Dust workspace ID in Settings → AI → Dust setup.'
                      : ''
      if (ineligible) {
        // Vision turn, but the active provider can't read images (e.g. Dust agents). Transparently fail
        // over to a configured vision-capable provider (Claude/GPT) so a user who captured their screen
        // still gets an answer — `failover` only picks a provider that has both a key and a model. Surface
        // the error only when NO vision-capable provider is set up.
        const visionGap = req.mode === 'vision' && !providerVisionOk(provider)
        if (visionGap && failover(attempted.concat(provider), undefined, race)) return
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
            attempt('local', attempted.concat(provider), 0, race)
            return
          }
          // Out-of-scope modes (answer, recap) used to stop right here and surface "No API key for X.
          // Open Settings (gear) and add it." — even with a provisioned on-device model and the safety
          // net on. That is the single most common thing anyone asks Métis (type a question), so a user
          // who had deliberately turned the local model ON and added no key was told the app could not
          // answer, while the model that could sat idle on their disk. The absolute floor
          // (localAnswerFloorEligibleFor) exists precisely for this case and attempt()'s own eligibility
          // chain above already accepts it — only this seam never offered it.
          //
          // Routed through failover() rather than jumping straight to 'local' so the floor keeps its
          // rank: pickFailover places it DEAD LAST, after every keyed provider and even a cooling one,
          // so a user whose ACTIVE provider is merely misconfigured still gets their other key (or the
          // actionable setup error), not a silently weaker on-device answer. Gated on the floor being
          // genuinely available so an install without local behaves exactly as it did before.
          if (
            provider !== 'local' &&
            allowCrossProviderFailover(req) &&
            localAnswerFloorEligibleFor(req, s, allowed) &&
            failover(attempted.concat(provider), undefined, race)
          ) {
            return
          }
          if (!race || race.gate.markDead(race.leg) === 'surface') {
            win?.webContents.send(IPC.streamError, { id: req.id, message: ineligible })
          }
        } else if (!failover(attempted.concat(provider), undefined, race)) {
          if (!race || race.gate.markDead(race.leg) === 'surface') {
            win?.webContents.send(IPC.streamError, { id: req.id, message: ineligible })
          }
        }
        return
      }
      auditLog('provider.request', { provider, model, mode: req.mode, tier, retry: attempted.length > 0 })
      // Tell the waiting UI WHO is answering ("Asking your Dust agent…") — re-sent on retry/failover so
      // the display follows the live attempt. Metadata only (provider id + tier), never the model/agent id.
      // A leg that has already lost the race says nothing: its announcement would overwrite the winner's.
      if (!race || !race.gate.isLoser(race.leg)) {
        win?.webContents.send(IPC.streamMeta, { id: req.id, provider, tier, usedScreen: screenGrounded })
      }
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
      let paintedLen = 0
      let ttftMs: number | undefined
      // Strips a reasoning model's inline <think>…</think> out of the answer stream (llm/think-strip.ts).
      // One per attempt: each leg/retry is its own stream, and the stripper carries position state.
      // Sitting here rather than in a provider strategy is the point — every provider funnels through
      // this one onDelta, so the guarantee holds for cloud, CLI, Dust, a custom endpoint and on-device
      // alike, instead of being re-implemented per strategy and drifting.
      const think = new ThinkStripper()
      // Every visible token goes through here. `gotToken` deliberately tracks VISIBLE output, not raw
      // deltas: a model part-way through a think block has not answered yet, so it must not win the
      // hedge race, stop the MQA-020 empty-answer failover, or report a TTFT it hasn't earned. The
      // provider's own stall watchdog still sees the raw deltas, so a long think can't trip a timeout.
      const paint = (text: string): void => {
        if (!text) return
        if (!gotToken) {
          ttftMs = Date.now() - startedAt
          // Tokens are flowing, so these credentials demonstrably work — clear any prior auth
          // verdict (MQA-003/MQA-004) rather than leaving a stale "broken" mark on a live provider.
          recordSuccess(provider)
          // F3 hedge: this leg's first token is its bid to win — aborts whatever the other leg is doing.
          if (race) {
            race.gate.declareWinner(race.leg)
            // Re-assert WHO actually answered. Both legs announce themselves when they start, so if
            // the backup started second and the primary then won, the UI's last streamMeta named the
            // loser — the answer would be attributed to a provider that produced none of it.
            win?.webContents.send(IPC.streamMeta, { id: req.id, provider, tier, usedScreen: screenGrounded })
          }
        }
        gotToken = true
        paintedLen += text.length
        win?.webContents.send(IPC.streamDelta, { id: req.id, text })
      }
      const handle = createStream({
        providerId: provider,
        kind: def.kind,
        apiKey: key,
        baseURL,
        workspaceId: s.dustWorkspaceId,
        // Dust OAuth tokens (imported from the local CLI) expire after ~1h. On a pre-token 401 the
        // stream asks for fresh creds: re-mint via the CLI, persist them, and replay once — so an
        // expired token self-heals invisibly instead of surfacing an error.
        refreshDustAuth: provider === 'dust' ? makeRefreshDustAuth(s) : undefined,
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
            // F3 hedge: a leg that already lost the race is aborted, but a chunk already in flight when
            // abort() fires can still reach here once — swallow it rather than let two legs both paint.
            if (race && race.gate.isLoser(race.leg)) return
            paint(think.push(text))
          },
          onDone: (u) => {
            if (race && race.gate.isLoser(race.leg)) return
            // Release whatever the stripper is still holding: a tail that could have been a partial tag,
            // or — only when the answer would otherwise be blank — an unterminated think block. Must run
            // BEFORE the !gotToken check below, or a response that was entirely one unclosed think block
            // would be judged content-less and fail over despite having something to show.
            paint(think.flush())
            if (!race) streams.delete(req.id)
            // MQA-020 (belt-and-braces half): a provider that completes with ZERO content deltas has not
            // answered — the user gets a blank bubble and the waterfall stops, because "done" reads as
            // success. The known instance was claude-cli settling an `is_error: true` terminal line as
            // success (fixed at source in llm/cli.ts), but ANY strategy that reaches onDone pre-token has
            // the same effect, so treat it as a pre-token failure here and let the normal failover run.
            // Only for cloud/CLI: a local no-output must surface rather than silently upload the request.
            if (!gotToken && provider !== 'local' && failover(attempted.concat(provider), undefined, race)) return
            // …and when that failover finds NOTHING left to try, this leg is finished without ever having
            // answered. Falling through to the success path below would be wrong twice over: under a race
            // it deletes the COMBINED abort registration (see the hedge dispatch) while the other leg is
            // still streaming — orphaning it past a user cancel, since askCancel then finds no entry — and
            // it ends the ask with a blank streamDone, the very MQA-020 empty bubble the branch above
            // exists to prevent. Die quietly if the other leg can still answer; otherwise surface a real
            // error, exactly as the local branch below does.
            if (!gotToken && provider !== 'local') {
              if (race && race.gate.markDead(race.leg) !== 'surface') return
              if (race) streams.delete(req.id)
              win?.webContents.send(IPC.streamError, {
                id: req.id,
                message: 'That provider returned an empty answer, and there was no other provider to try. Check your providers in Settings.'
              })
              return
            }
            // MQA-102: the cloud/CLI branch above is deliberately gated `provider !== 'local'`, so a LOCAL
            // completion with zero content deltas used to fall straight through to streamDone — the exact
            // blank-bubble MQA-020 fixed for cloud/CLI, still live for the on-device last resort (the
            // "my key died" end state, where local is what answers). Surface it as an actionable error
            // instead. No failover: a local failure must never silently upload the request to cloud.
            if (!gotToken && provider === 'local') {
              if (!race || race.gate.markDead(race.leg) === 'surface') {
                if (race) streams.delete(req.id) // terminal for the race — same release as the error path
                win?.webContents.send(IPC.streamError, {
                  id: req.id,
                  message: 'Métis Local produced no answer — try again, or add a cloud provider in Settings for longer questions.'
                })
              }
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
            // The winning leg's success is the whole race's terminal outcome — drop the combined abort
            // registration set up before either leg started (see the hedge dispatch below).
            if (race) streams.delete(req.id)
            win?.webContents.send(IPC.streamDone, { id: req.id, ...u })
            // Act 5 trial hook (MQA-281): the ONE seam that fires on a real, successfully-delivered
            // result (gotToken is guaranteed true above) — never on install/launch. Cheap no-op unless
            // this is the very first qualifying (suggest/summary/recap) result this install has ever
            // produced; the demo-tagged check is belt-and-suspenders (see noteQualifyingUse's header).
            noteQualifyingUse(req.mode, req.prompt, req.transcript)
          },
          onError: (message) => {
            if (race && race.gate.isLoser(race.leg)) return
            if (!race) streams.delete(req.id)
            auditLog('provider.failed', { provider, gotToken, retry: retryCount })
            // "You ran out" — a rate limit (429), spent credit, or a Claude Pro / Codex subscription
            // usage-cap — is NOT a dead key, and each needs its own cooldown + message. Classify it FIRST
            // (exhaustion.ts), so a rate-limited Claude backs off for its Retry-After window, an out-of-
            // credit key demotes for ~1h instead of being re-tried as primary every ask, and a spent
            // subscription window demotes until its reset. This is the OmniRoute integration: the circuit
            // breaker now remembers token/credit exhaustion, not only credential rejections.
            const exhaustion: ExhaustionSignal | null =
              !gotToken && provider !== 'local' ? classifyExhaustion(message) : null
            if (exhaustion) {
              if (exhaustion.kind === 'rate-limit') recordRateLimited(provider, exhaustion.retryAfterMs)
              else
                recordExhausted(provider, exhaustion.kind, {
                  retryAfterMs: exhaustion.retryAfterMs,
                  resetAt: exhaustion.resetAt,
                  message: String(message)
                })
            }
            // MQA-003/MQA-004: remember a CREDENTIAL rejection (not a transport blip) so routing can stop
            // re-paying this provider's round trip on every subsequent ask, and so Settings can finally
            // tell the user their key stopped working instead of reporting it ready forever.
            // MQA-101: Dust's own auth-rejection wording drifts across API versions and the current
            // "does not have a valid authenticated credential" phrasing carries no 401 digits, so the
            // generic isAuthFailure misses it — the circuit breaker never trips for a genuinely dead Dust
            // session. dust.ts already maintains the broadened matcher for exactly this; use it for Dust.
            // Gated on !exhaustion so a "403 insufficient_quota" is not double-counted as a dead key, AND on
            // provider !== 'local' — the on-device model has no credentials to reject, and a local runtime
            // error whose text happens to match isAuthFailure (e.g. an EACCES "permission denied" from a
            // file lock re-hashing the model) must NOT cool 'local' down. If it did, the skip-cooling-primary
            // fast path would swap a privacy-pinned local vision request onto a cloud provider — uploading a
            // screenshot the user pinned to on-device-only. Local failures are handled by local-runtime.ts's
            // own restart budget, never by this credential breaker.
            const isCredentialRejection =
              !exhaustion &&
              provider !== 'local' &&
              (provider === 'dust' ? isDustAuthError({ message }) : isAuthFailure(message))
            if (!gotToken && isCredentialRejection) recordAuthFailure(provider, String(message))
            // Do NOT retire a CLI for a usage-cap: a spent Claude Pro / Codex window is a TEMPORARY lockout
            // that refills at a known time, not a dead login — retiring it would force a needless re-login.
            // Only a genuine auth failure retires the CLI.
            if (!gotToken && !exhaustion) retireCli(provider, message)
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
            // A rate-limit is retryable IN PLACE only if the server's window is short enough to wait inside
            // a live ask — a 5-minute Retry-After means "go to the backup now", not "freeze the UI". A hard
            // exhaustion (credit/usage-cap) is NEVER retried in place: money and subscription windows do not
            // return on a sub-second backoff, so we fail straight over.
            const rateLimitWaitMs =
              exhaustion?.kind === 'rate-limit' && exhaustion.retryAfterMs != null
                ? exhaustion.retryAfterMs
                : null
            const rateLimitTooLongToWait = rateLimitWaitMs != null && rateLimitWaitMs > MAX_ASK_RETRY_WAIT_MS
            const hardExhaustion = exhaustion != null && exhaustion.kind !== 'rate-limit'
            if (
              !gotToken &&
              retryCount < retryBudget &&
              isTransient(message) &&
              !hardExhaustion &&
              !rateLimitTooLongToWait
            ) {
              const delayMs = nextBackoff(retryCount, { retryAfterMs: rateLimitWaitMs ?? undefined })
              auditLog('provider.retry', { provider, attempt: retryCount + 1, delayMs })
              const timer = setTimeout(() => attempt(provider, attempted, retryCount + 1, race), delayMs)
              // Under a race the combined abort registration set up before either leg started already
              // covers cancellation (see the hedge dispatch below) — track this timer there instead of
              // overwriting it, so cancelling mid-backoff still clears the pending retry.
              if (race) race.gate.addCleanup(() => clearTimeout(timer))
              else streams.set(req.id, { abort: () => clearTimeout(timer) })
              return
            }
            // Retries exhausted or non-transient: fall over to another provider (pre-token only). When the
            // just-failed provider ran OUT (credit/tokens/usage-cap), prefer a free-tier backup or local.
            const preferFree = exhaustion != null && s.resilience.preferFreeOnExhaustion
            if (!gotToken && provider !== 'local' && failover(attempted.concat(provider), preferFree, race)) return
            // Replace raw client transport strings ("Unexpected network error from DustAPI: fetch failed")
            // with a clean message; keep the Dust-auth one-click reconnect path; else pass the message.
            // Reaching here means failover found NO backup — so an exhaustion message names the limit and
            // the fix (add a provider / add credit / wait for the reset) instead of a misleading
            // "Connection issue" (the old bug: a 429 was reported as a network fault) or a raw provider
            // string like "Claude AI usage limit reached|1754160000".
            const friendly = exhaustion
              ? exhaustion.kind === 'rate-limit'
                ? `${def.label} is rate-limited right now and no backup is configured. Add another provider in Settings → AI, or wait a moment and try again.`
                : exhaustion.kind === 'usage-cap'
                  ? `${def.label} hit its usage limit${
                      exhaustion.resetAt
                        ? ` (${formatResetPhrase(exhaustion.resetAt)})`
                        : ''
                    }. Add another provider in Settings → AI to keep going.`
                  : `${def.label} is out of credit. Add credit or switch providers in Settings → AI.`
              : // A gateway between Métis and the model can fail for a reason only its OPERATOR can
                // clear — a dead account token, a half-deployed Worker. Those arrive as a 502/503, which
                // matches isTransient below, so without this branch the user is told to check their
                // network while the real cause is a secret on the proxy. The proxy marks exactly those
                // (and deliberately NOT its transient upstream blips, which SHOULD retry), so the marker
                // is the signal that this sentence is already the actionable one — pass it through
                // rather than replacing it. Ahead of isTransient because 502 matches both.
                isProxyOperatorFault(message)
                ? stripProxyFaultMarker(message)
                : isTransient(message)
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
                      ? `${def.label} rejected your API key (it may have been revoked, expired, or disabled). Open Settings → AI to re-enter it.`
                      : message
            if (!race || race.gate.markDead(race.leg) === 'surface') {
              // Terminal for the whole race, so release the COMBINED abort registration too. The non-race
              // path already deleted its entry at the top of onError; without this the map kept the
              // HedgeRace and both handles alive for every hedged ask that ended in an error.
              if (race) streams.delete(req.id)
              // Trailing stream error AFTER substantial visible output (claude-cli idle linger, etc.) —
              // same keep-threshold as import-recap. Without this, Review blanked notes / autosave wrote
              // an empty recap even though the summary had already streamed onto the screen.
              if (gotToken && paintedLen >= 200) {
                mainLog.warn(
                  `[ask] keeping ${paintedLen}-char answer despite trailing stream error: ${friendly}`
                )
                win?.webContents.send(IPC.streamDone, { id: req.id })
                noteQualifyingUse(req.mode, req.prompt, req.transcript)
                return
              }
              win?.webContents.send(IPC.streamError, { id: req.id, message: friendly })
            }
          }
        }
      })
      if (race) race.gate.setHandle(race.leg, handle)
      else streams.set(req.id, handle)
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
    // localPrimaryEligibleFor (not the bare localEligibleFor) layers Wave 2's routingMode on top: 'api'
    // forces this false so local can never win the first-attempt pick, 'local' relaxes the per-mode
    // useFor toggle, 'auto' is byte-identical to the old localEligibleFor call.
    const localPrimaryEligible = localPrimaryEligibleFor(req, s, routeTier(req, s.thinkingMode), allowed)
    const localVisionRequired = localVisionPrivacyRequired(req, s)
    const primary = pickPrimaryProvider(
      req.providerOverride,
      localPrimaryEligible,
      cliPrimary,
      s.provider,
      localVisionRequired
    )
    // MQA-003: when the primary's credentials were just rejected — OR its live budget is nearly spent
    // (resilience.budgetPreempt) — start at the next eligible provider instead of re-paying its round trip
    // on every ask (measured 6.5–9.3s wasted against a 15s live-suggest budget). It stays in `attempted` so
    // the walk never circles back to it. pickFailover returns null for a pinned Dust-agent request, so a
    // pinned ask is never silently substituted.
    const primaryUnavailable =
      isCoolingDown(primary) || (s.resilience.budgetPreempt && isBudgetExhausted(primary))
    const skipDeadPrimary = primaryUnavailable ? pickFailover([primary]) : null

    // F3 hedge: a fresh, base-tier interactive ask (answer/vision/suggest) races a backup provider
    // against the primary if the primary hasn't produced a token within HEDGE_DELAY_MS — see
    // main/llm/hedge.ts's HedgeRace for the full contract. Scoped to a genuinely fresh first attempt
    // (never a preempted-primary substitution) and to requests that could actually fail over at all
    // (a pinned Dust-agent ask has nothing valid to race against).
    const hedgeEligible =
      s.resilience.hedge &&
      !skipDeadPrimary &&
      // MQA-147: never race a LOCAL primary. The hedge leg is a fresh dispatch, not a failover out of the
      // local leg, so neither `provider !== 'local'` failover guard ever sees it — a screenshot the user
      // pinned to on-device (localVisionPrivacyRequired) was POSTed to a keyed cloud provider 3s in, and a
      // local no-output silently uploaded the request instead of surfacing. This one conjunct subsumes the
      // vision pin (pickPrimaryProvider returns 'local' whenever it is set) and closes the same hole for an
      // in-scope local suggest. Without a race, the local leg's own terminals run un-suppressed, so the
      // "Nothing was sent to a cloud provider" message is actually delivered rather than markDead-swallowed.
      primary !== 'local' &&
      routeTier(req, s.thinkingMode) === 'base' &&
      (req.mode === 'answer' || req.mode === 'vision' || req.mode === 'suggest') &&
      allowCrossProviderFailover(req)
    if (hedgeEligible) {
      const race = new HedgeRace()
      // TRUE RACE (Tony's call): ANY cloud/CLI provider — Cloudflare or otherwise — and the on-device
      // model start TOGETHER and
      // the fastest answer wins. HEDGE_DELAY_MS exists to stop a merely-slow PAID primary being billed
      // twice for one ask, but an on-device backup has no per-request cost and no quota, so that head
      // start would be pure latency whenever the cloud turns out to be the slower of the two. Quality is
      // preserved because HedgeRace declares the winner on FIRST TOKEN, not on start order — a healthy
      // cloud provider that answers faster still wins and still serves its answer; local only takes the
      // ask when it genuinely gets there first, which is the cloud-is-slow / cloud-is-down case.
      // This early pick decides the DELAY only: startHedgeLeg re-picks the provider at fire time against
      // the live primaryChain, so a primary that fails over in the meantime is still excluded correctly.
      const hedgeDelayMs =
        pickFailover([primary]) === 'local'
          ? 0
          : req.mode === 'suggest'
            ? HEDGE_DELAY_SUGGEST_MS
            : HEDGE_DELAY_MS
      let hedgeTimer: NodeJS.Timeout | null = setTimeout(() => {
        hedgeTimer = null
        startHedgeLeg()
      }, hedgeDelayMs)
      // ONE launcher behind both triggers: the HEDGE_DELAY_MS timer (a primary that is merely slow) and
      // HedgeRace's own early pull-forward (a primary already dead — nothing left to give it time for).
      // race.markHedgeStarted() makes whichever fires second a no-op.
      function startHedgeLeg(): void {
        if (race.isDecided()) return
        // Snapshot, not the live array: primaryChain keeps growing under the primary leg while the hedge
        // runs, and `attempted` rides into every recursive attempt() this leg makes. Passing it on means the
        // hedge's OWN failover cascade also refuses to walk back onto a provider the primary already holds.
        const tried = primaryChain.slice()
        const backup = pickFailover(tried)
        if (!backup) {
          race.markHedgeUnavailable()
          return
        }
        race.markHedgeStarted()
        if (hedgeTimer) {
          clearTimeout(hedgeTimer)
          hedgeTimer = null
        }
        attempt(backup, tried, 0, { gate: race, leg: 'hedge' })
      }
      race.setHedgeStarter(startHedgeLeg)
      streams.set(req.id, {
        abort: () => {
          if (hedgeTimer) clearTimeout(hedgeTimer)
          race.abortAll()
        }
      })
      attempt(primary, [], 0, { gate: race, leg: 'primary' })
    } else {
      attempt(skipDeadPrimary ?? primary, skipDeadPrimary ? [primary] : [])
    }
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
    // ASR quality (1B.2b) — a live-only interim placeholder must never reach disk (see
    // TranscriptLineSchema.provisional's own doc comment). Belt-and-suspenders: listen.ts already
    // replaces a provisional line with the real one before it could ever be included here.
    m.lines = stripProvisionalLines(m.lines)
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
    // Wave 3 (settings.brainConsolidation): when batching is on, this meeting is marked pending but NOT
    // queued for immediate extraction — it waits for the next consolidation pass (or a manual rebuild/
    // "Index meetings" click, which scans for pending work independent of this flag) instead of paying a
    // network round trip after every single save.
    await enqueueIngest(r.path, { deferred: getSettings().brainConsolidation.enabled })
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
    // Hand the overlay's live bounds over so the dashboard opens clear of it. The bar is always-on-top,
    // so anywhere the two intersect the dashboard is the one that gets covered (measured: the bar hid its
    // top 23px across the full width). Undefined when the overlay is gone — placement then just centres.
    // Height is capped deliberately, NOT taken live. The renderer collapses the panel only
    // after this IPC resolves (RecallView/BrainView call onDashboardOpen in the .then), so sampling the
    // live bounds here measured the still-EXPANDED bar — up to ~992px tall — and placed the dashboard
    // below that, i.e. off the bottom of the screen. Placing against the idle rectangle the bar is about
    // to return to is deterministic and does not depend on a React render landing first.
    const avoid =
      win && !win.isDestroyed() && win.isVisible()
        ? (() => {
            const b = win.getBounds()
            return { ...b, height: Math.min(b.height, BAR_COLLAPSED_MAX_HEIGHT) }
          })()
        : undefined
    const result = openIntelligenceWindow(avoid)
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
      // Pending (deferred for consolidation) is NOT a failure — same discriminator ingestFailureCounts
      // already uses. Listing pending here painted every just-saved meeting as a red "failed" History dot.
      failedFiles: Object.entries(idx.ingested)
        .filter(([, v]) => !v.ok && !isPendingIngestRecord(v))
        .map(([file]) => file),
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
      corruptionBlocked: isJournalCorruptionBlocked(s),
      // MQA-230: entity files can still hold items attributed to an already-deleted meeting until the
      // deferred source refresh runs (it needs a usable provider). Surfaced so the UI can say the
      // cleanup is pending instead of silently claiming the delete was complete.
      cleanupPending: idx.sourceRefreshRequested === true
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
    // Same provisional-line guard as the real saveTranscript handler above — this periodic crash-
    // recovery snapshot must never resurrect a UI-only "…" placeholder into a recovered draft.
    await saveDraftTranscript(getSettings(), { ...parsed.data, lines: stripProvisionalLines(parsed.data.lines) })
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
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: DEVTOOLS_ENABLED, webSecurity: true }
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
    if (!requireAuth()) return publicSettings() // adds a folder to the brain's ingestion set — gate it like every other settings write
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
    if (!requireAuth()) return publicSettings()
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
    if (typeof payload?.width === 'number' && Number.isFinite(payload.width) && !onboardingExclusiveLive()) {
      // +10 (not the height report's +2) gives the pill's own box-shadow/glow room to render without
      // being hard-clipped at the window edge — see the .aw-pill / .aw-mark-glow comments in styles.css.
      const nextWidth = Math.max(120, Math.min(Math.ceil(payload.width) + 10, BAR_WIDTH))
      const layout = liveOverlayLayout()
      const rest = overlayRestSize(layout)
      // Hide pad must stay wide (~560). Do not accept a hug-width shrink to ~120.
      if (islandResting && layout === 'hide' && nextWidth < rest.width - 24) {
        /* keep parked hide width */
      } else if (!islandResting || nextWidth <= rest.width + 24) {
        currentWidth = nextWidth
      }
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
  ipcMain.handle(IPC.windowAnchorTop, (e) => {
    assertMainWindow(e)
    anchorTopCenter()
  })
  ipcMain.handle(IPC.windowRevealWidth, (e) => {
    assertMainWindow(e)
    restoreBarWidth()
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
  // Settings "Update now" → kick the in-app download. Progress + ready then stream to the renderer via the
  // listeners initAutoUpdate registered (IPC.updateProgress / IPC.updateDownloaded). Returns a reason when
  // this build cannot self-install so the UI shows the download-page link instead of a stuck button.
  ipcMain.handle(IPC.updateDownload, (e) => {
    assertMainWindow(e)
    return startUpdateDownload()
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
    // Relaunching the shortcut is the user's "bring it back" gesture, so it must self-heal a null `win`
    // (a boot-time createWindow() throw leaves the app alive in the tray with no window) instead of
    // no-opping forever. ensureWindow() also filters a destroyed-but-non-null window.
    const w = ensureWindow()
    if (!w) return
    // Non-activating, same island contract as every other reveal (see showForAsk's doc comment) — a
    // second launch attempt surfaces the overlay without stealing focus from the foreground app.
    if (!w.isVisible()) w.showInactive()
  })
  app.whenReady().then(async () => {
  initLogging() // route main-process logs to a rotated file before anything else can fail
  await installProxyAwareFetch() // route provider fetch through the env/OS proxy so Dust etc. work behind a corporate proxy
  // Warm the CLI binary cache at boot when a CLI provider is connected, so the session's FIRST CLI ask
  // doesn't stall on the login-shell PATH lookup (it only ran on sign-in before — i.e. once ever).
  try {
    const s0 = getSettings()
    if (s0.cliConnected['claude-cli'] || s0.cliConnected['codex-cli']) {
      prewarmCli()
      // MQA-062: and check the session those flags claim, once per launch. A `claude logout` between
      // runs otherwise leaves the app asserting a provider it cannot use until the first ask fails.
      void verifyCliSessions()
    }
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
  // Every build (not just Cahê): seed an optional installer-embedded Cloudflare proxy key, once per
  // profile, so a fresh install of the default provider can answer with zero paste-a-key setup when the
  // operator chose to embed one. See embedded-cloudflare-key.ts — a no-op when no bundle was packaged.
  importEmbeddedCloudflareKey()
  // Métis Local weights are no longer bundled in the installer (~728 MB; a universal mac package
  // carrying them would blow past GitHub's 2 GB release-asset limit), so fetch them once here whenever
  // the app opens. Deliberately NOT awaited: this is a multi-GB download and startup must not wait on
  // it, nor fail when the machine is offline or behind a restrictive proxy — the next launch retries.
  // ensureLocalModel() verifies the pinned sha256 and never throws.
  //
  // GATED on RAM only (MQA-186): a machine under the model's floor must not pay for weights
  // assertRamOk would refuse to load. Local AI `enabled` does NOT gate the download — routing stays
  // off by default (Cloudflare / API keys stay primary); the bytes land in the background so turning
  // Local on later is instant. OFF→ON in setSettings still re-arms as a second chance after a failed
  // first-run fetch.
  //
  // local-routing.ts re-reads isDownloaded() per request, so no ROUTING decision needs notifying. The
  // background screen reader does: its eligibility is evaluated when the engine is refreshed, and the boot
  // refresh below runs while this download is still in flight — without this re-arm, a first-run user who
  // opted in gets an inert fast path until some unrelated setting changes (MQA-178).
  // Pick by hardware, not by list position: bestModelForMachine() returns the strongest entry whose RAM
  // floor this machine clears. A profile still holding the SMALL floor model is upgraded here rather than
  // left behind — when that id was persisted it was the only model that existed, so it was never a user
  // choice to respect. An explicit pick of any other id is left alone. The upgrade only rewrites the
  // setting; ensureLocalModel then fetches whatever is missing, and a machine below the bigger model's
  // floor simply resolves back to the small one.
  {
    const best = bestModelForMachine()
    const current = getSettings().localLlm.modelId
    if (current !== best.id && current === 'qwen3.5-0.8b') {
      try {
        setSettings({ localLlm: { ...getSettings().localLlm, modelId: best.id } })
        mainLog.info(`[boot] upgraded the on-device model to ${best.id}`)
      } catch (e) {
        mainLog.warn('[boot] on-device model upgrade failed:', e)
      }
    }
    // Warm the sidecar so the first ask is never the cold one — measured 42s cold against ~2.3s warm.
    // Gated on the weights actually being PRESENT: on a fresh install they are still downloading (~3.4 GB,
    // in the background, right through onboarding), and warming then would fight that transfer for I/O to
    // load a model that is not there yet. So there are two triggers and one guard: warm shortly after boot
    // when the model is already on disk, and warm off the back of the fetch when it has just landed.
    // Fire-and-forget either way — startup never waits on it, and localPrewarmEligible re-checks
    // enabled/allowlist/hedge. spawnProfileFor already sizes the sidecar for this machine's RAM, so on a
    // small machine this warms the CPU-only ~2.1 GB configuration rather than the offloaded one.
    const warmLocalIfReady = (): void => {
      try {
        const cur = getSettings()
        if (!localModelDownloaded(cur.localLlm.modelId)) return
        if (!localPrewarmEligible(cur, getAllowedProviders(), publicSettings().providerReady)) return
        void prewarmLocal(cur.localLlm.modelId, buildPrewarmMessages('warm', cur)).catch((e) =>
          mainLog.warn('[boot] local prewarm failed:', e instanceof Error ? e.message : String(e))
        )
      } catch (e) {
        mainLog.warn('[boot] local prewarm skipped:', e instanceof Error ? e.message : String(e))
      }
    }
    if (shouldFetchWeights(best.id)) {
      void ensureLocalModel(best.id)
        .then(() => {
          refreshScreenPreprocess()
          // The weights just landed (first run, mid-onboarding). Warm now rather than leaving the very
          // first ask to pay the full cold load.
          warmLocalIfReady()
        })
        .catch((e) => mainLog.warn('[boot] local model provisioning failed:', e))
    }
    setTimeout(warmLocalIfReady, 4000).unref?.()
  }
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
  // MQA-175: the JS-level handlers below cannot see every death. A native C++ exception — Chromium's
  // OSCrypt raising std::out_of_range on a sync-mangled encrypted file, the shape that killed six
  // consecutive launches of the shipped 1.5.4 Windows build — unwinds past V8 entirely, so nothing in
  // this process ever runs again: no crash-*.log, no audit line, no window, no dialog. Only the NEXT
  // launch can report it, and only if this one left a mark before doing the dangerous work.
  const earlyDeath = beginBootWatch(app.getPath('userData'), app.getVersion())
  if (earlyDeath) persistCrash('boot-early-death', describeEarlyDeath(earlyDeath), 'previous launch died before boot completed')
  // Never let an unhandled error crash the overlay silently — log to file, audit, write a crash dump, and
  // (for a fatal exception) offer a one-time relaunch while defaulting to keep-alive.
  process.on('uncaughtException', (err) => onFatal('uncaughtException', err))
  process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason))
  // The self-test suite runs destructively against the LIVE profile (it overwrites, then deletes,
  // settings.json and managed-config.json), so devEnv() keeps it out of packaged builds — otherwise a
  // persistent `setx ASKTOTO_SELFTEST out.json` re-wipes the profile and quits on every launch.
  const selfTestOut = devEnv('ASKTOTO_SELFTEST')
  if (selfTestOut) {
    try {
      await runSelfTest(selfTestOut)
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
        // Deliberately not awaited (the sweep must not hold the interval), but the rejection is observed:
        // `void` attaches no handler, so a transient index.json write failure would escape as an
        // unhandledRejection and write a crash-*.log + an app.crash audit line for something that never
        // crashed — same shape as MQA-075. The refresh flag is re-requested by the 60s reconcile tick.
        void requestSourceRefresh(getSettings()).catch((e) =>
          mainLog.warn('[brain] source refresh after retention sweep failed:', e instanceof Error ? e.message : String(e))
        )
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
    const current = getSettings()
    if (Date.now() - current.dustTokenMintedAt <= DUST_TOKEN_FRESH_MS) return
    // Branches on dustSessionOrigin — see makeRefreshDustAuth's doc comment for why the two refresh paths
    // must never be mixed for one session.
    if (current.dustSessionOrigin === 'oauth') {
      void refreshDustOAuthSession()
        .then((fresh) => {
          if (fresh.ok) auditLog('dust.token.refreshed', { at })
        })
        .catch(() => {
          /* best-effort — the lazy on-401 refresh in dust.ts still covers this */
        })
      return
    }
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
  // screen-preprocess documents refresh() as "Call on startup and after settings change" — only the second
  // half was ever wired, so an opted-in user got a dead fast path (and a silent cloud image upload on every
  // screen ask) for the whole session after each relaunch (MQA-178). Deliberately AFTER createWindow: the
  // eligibility read drags in the local-model trust probe, which must not sit on the first-paint path; and
  // ahead of registerIpc so the renderer's first getSettings() already sees the reconciled readiness flag.
  // Silent on macOS by construction: eligibility now requires the Screen Recording grant to ALREADY exist
  // (screenCaptureGranted above), so this reconcile can never be what raises the TCC prompt (MQA-209).
  runStep('refreshScreenPreprocess', refreshScreenPreprocess)
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
  // Notch/menu-bar metrics for the island top clamp (MQA-275) — invalidate-on-topology-change, same
  // event set registerScreenListeners just subscribed to, plus powerMonitor resume (a notch MacBook can
  // wake docked to a different external display than it slept on). macOS-only signal; a no-op elsewhere.
  runStep('registerDisplayMetricsInvalidation', registerDisplayMetricsInvalidation)
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
    // MQA-175: this timer is the boot step an unreadable `.brain` kills — it is the first thing after
    // launch that decrypts index.json. When the previous run died before boot completed, this launch
    // deliberately does not walk back into it: the brain resume and its reconcile interval are skipped
    // for this session only, so the user reaches a working app instead of a sixth silent vanish. The
    // watch is cleared at the end of this callback either way, so the very next launch is normal again.
    if (earlyDeath) {
      mainLog.warn(`[boot] safe start — skipping the brain backfill/reconcile resume: ${describeEarlyDeath(earlyDeath)}`)
      auditLog('app.crash', { kind: 'safe_start', consecutive: earlyDeath.consecutive })
    } else {
      resumeBackfillIfPending()
      reconcileMeetingsInBackground()
      // Registered here rather than alongside the timer so safe start skips the recurring brain work too,
      // not just the single resume — the reconcile tick reads the same index.json.
      trackTimer(setInterval(reconcileMeetingsInBackground, BRAIN_RECONCILE_MS))
      // Wave 3: batch brain LLM extraction into settings.brainConsolidation's daily pass budget instead
      // of a round trip after every meeting. Hourly check, same "cheap enough to poll often, the budget
      // does the real gating" shape as the reconcile tick above; runConsolidationIfDue itself no-ops
      // instantly once today's passes are spent or the feature is off.
      void runConsolidationIfDue().catch((e) => mainLog.warn('[brain] initial consolidation check failed:', e))
      scheduleConsolidation(60 * 60 * 1000, trackTimer)
    }
    endBootWatch(app.getPath('userData'))
  }, 15_000)

  app.on('activate', () => {
    if (!win) createWindow()
    // Non-activating (island contract) — a dock-icon click surfaces the overlay without stealing focus.
    else win.showInactive()
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
  // MQA-175: quitting before the boot watch closed on its own is a normal exit, not an early death —
  // clear it here so the next launch is not pushed into safe start by a user who simply quit fast.
  // Own try, like every other step below: a failure here must never skip the sidecar kill.
  try {
    endBootWatch(app.getPath('userData'))
  } catch (e) {
    mainLog.warn('[will-quit] endBootWatch failed', e)
  }
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
