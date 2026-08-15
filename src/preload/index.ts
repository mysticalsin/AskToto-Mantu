import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AskStart,
  type PublicSettings,
  type Settings,
  type HotkeyAction,
  type CaptureResult,
  type ScreenContextResult,
  type SaveMeeting,
  type SaveNote,
  type RecapExport,
  type MeetingSummary,
  type RecallHit,
  type AnswerFeedback,
  type EvalMetrics,
  type StreamDelta,
  type StreamDone,
  type StreamError,
  type StreamMeta,
  type TestKeyResponse,
  type DustAgentsResponse,
  type DustCliImport,
  type DustDeviceLoginStart,
  type DustDevicePollResult,
  type DustSessionProbe,
  type CliActionResult,
  type CliInstallResult,
  type GraphStatus,
  type GraphRelated,
  type AuthStatus,
  type SignInResult,
  type CalendarTodayResult,
  type RecallReadResult,
  type RecallExportPlainResult,
  type UpdateCheckResult,
  type UpdateDownloadStart,
  type RecallBackfillSpeakersResult,
  type PlatformPermissions,
  type ShortcutFailure,
  type McpTestConnectionPayload,
  type McpSaveConnectionPayload,
  type McpDisconnectPayload,
  type McpPushPayload,
  type McpConnectResult,
  type McpPushResult,
  type LicenseActivatePayload,
  type LicenseActivateResult,
  type LicenseStatusResult,
  type LicenseGateVerdict,
  type ImportAudioPickResult,
  type ImportAudioProgress,
  type ImportJobView,
  type LocalModelSummary,
  type ProfileRecoveryResult
} from '@shared/ipc'
import type { ProviderId } from '@shared/providers'

type Unsub = () => void
function sub<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke(IPC.settingsGet),
  getPermissions: (): Promise<PlatformPermissions> => ipcRenderer.invoke(IPC.permissionsGet),
  getShortcutFailures: (): Promise<ShortcutFailure[]> => ipcRenderer.invoke(IPC.shortcutFailures),
  openPermissionSettings: (kind: 'microphone' | 'screenRecording'): Promise<void> =>
    ipcRenderer.invoke(IPC.permissionsOpenSettings, kind),
  requestPermissionsUpfront: (): Promise<PlatformPermissions> =>
    ipcRenderer.invoke(IPC.permissionsRequestUpfront),
  setSettings: (patch: Partial<Settings> | import('@shared/ipc').SettingsPatch): Promise<PublicSettings> =>
    ipcRenderer.invoke(IPC.settingsSet, patch),
  recoverEncryptedProfile: (): Promise<ProfileRecoveryResult> => ipcRenderer.invoke(IPC.settingsRecoverProfile),
  setApiKey: (provider: ProviderId, key: string): Promise<{ hasKeys: Record<string, boolean> }> =>
    ipcRenderer.invoke(IPC.setApiKey, { provider, key }),
  clearApiKey: (provider: ProviderId): Promise<{ hasKeys: Record<string, boolean> }> =>
    ipcRenderer.invoke(IPC.clearApiKey, { provider }),
  testApiKey: (provider: ProviderId, key: string): Promise<TestKeyResponse> =>
    ipcRenderer.invoke(IPC.testApiKey, { provider, key }),
  dustListAgents: (): Promise<DustAgentsResponse> => ipcRenderer.invoke(IPC.dustListAgents),
  dustImportCli: (): Promise<DustCliImport> => ipcRenderer.invoke(IPC.dustImportCli),
  dustProbeSession: (): Promise<DustSessionProbe> => ipcRenderer.invoke(IPC.dustProbeSession),
  // Native OAuth sign-in (no CLI, no system Node.js) — begin opens the browser + returns the user code to
  // show; poll is called repeatedly at the returned interval until it resolves 'ok' with a workspace list;
  // pickWorkspace finishes the login with the chosen workspace. Tokens never cross to the renderer.
  dustLoginBegin: (): Promise<DustDeviceLoginStart> => ipcRenderer.invoke(IPC.dustLoginBegin),
  dustLoginPoll: (deviceCode: string): Promise<DustDevicePollResult> =>
    ipcRenderer.invoke(IPC.dustLoginPoll, deviceCode),
  dustLoginPickWorkspace: (workspaceId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.dustLoginPickWorkspace, workspaceId),
  cliDetect: (provider: ProviderId): Promise<CliActionResult> =>
    ipcRenderer.invoke(IPC.cliDetect, provider),
  cliSetup: (provider: ProviderId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.cliSetup, provider),
  cliTest: (provider: ProviderId): Promise<CliActionResult> =>
    ipcRenderer.invoke(IPC.cliTest, provider),
  cliInstall: (provider: ProviderId, onProgress: (line: string) => void): Promise<CliInstallResult> => {
    const listener = (_e: unknown, d: { provider: string; line: string }): void => {
      if (d.provider === provider) onProgress(d.line)
    }
    ipcRenderer.on(IPC.cliInstallProgress, listener)
    return ipcRenderer.invoke(IPC.cliInstall, provider).finally(() => {
      ipcRenderer.removeListener(IPC.cliInstallProgress, listener)
    })
  },
  cliLogin: (provider: ProviderId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.cliLogin, provider),
  graphifyStatus: (): Promise<GraphStatus> => ipcRenderer.invoke(IPC.graphifyStatus),
  graphifyRebuild: (): Promise<GraphStatus> => ipcRenderer.invoke(IPC.graphifyRebuild),
  graphifyRelated: (file: string): Promise<GraphRelated> =>
    ipcRenderer.invoke(IPC.graphifyRelated, file),
  graphifyOpenGraph: (): Promise<string> => ipcRenderer.invoke(IPC.graphifyOpenGraph),
  brainStatus: (): Promise<import('@shared/brain').BrainStatus | null> =>
    ipcRenderer.invoke(IPC.brainStatus),
  brainBackfill: (): Promise<{ queued: number; deferred?: 'no-provider'; preparing?: boolean }> => ipcRenderer.invoke(IPC.brainBackfill),
  brainOpenDashboard: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.brainOpenDashboard),
  // MI-2.5 Fix F: `error` is set (queued: 0) when a purge failure aborts the rebuild before it starts.
  brainRebuildAll: (): Promise<{ queued: number; error?: string }> => ipcRenderer.invoke(IPC.brainRebuildAll),
  // MI-2.5 review round 3: user-invoked recovery from a durable correction-journal corruption lock —
  // clears the sentinel so corrections resume (the quarantined copy is left for inspection). `cleared`
  // is false when there was no lock to clear.
  brainClearJournalCorruption: (): Promise<{ ok: boolean; cleared?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.brainClearJournalCorruption),
  brainRead: (): Promise<import('@shared/brain').BrainRead> => ipcRenderer.invoke(IPC.brainRead),
  // Canonical people/account names only — feeds the ASR entity-casing bias (lib/entity-casing.ts).
  brainEntityNames: (): Promise<import('@shared/ipc').BrainEntityNamesResult> =>
    ipcRenderer.invoke(IPC.brainEntityNames),
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.authStatus),
  signIn: (): Promise<SignInResult> => ipcRenderer.invoke(IPC.authSignIn),
  signOut: (): Promise<void> => ipcRenderer.invoke(IPC.authSignOut),
  calendarToday: (tz: string): Promise<CalendarTodayResult> => ipcRenderer.invoke(IPC.calendarToday, tz),
  parakeetStatus: (): Promise<{ ready: boolean; addonError: string | null }> =>
    ipcRenderer.invoke(IPC.parakeetStatus),
  parakeetEnsure: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.parakeetEnsure),
  // Returns {text, name?} — name is the Speaker Intelligence label for THEM windows when enabled
  // (older shape was a bare string; the renderer normalizes both while the contract settles).
  parakeetFeed: (samples: Float32Array, speaker: string): Promise<string | { text: string; name?: string }> =>
    ipcRenderer.invoke(IPC.parakeetFeed, { samples, speaker }),
  onParakeetProgress: (cb: (pct: number) => void): (() => void) => {
    const h = (_e: unknown, d: { pct: number }): void => cb(d.pct)
    ipcRenderer.on(IPC.parakeetProgress, h)
    return () => ipcRenderer.removeListener(IPC.parakeetProgress, h)
  },
  // Apple Speech (on-device, macOS only) — same {text, name?} shape and speaker ride-along as parakeetFeed.
  appleSpeechFeed: (samples: Float32Array, speaker: string): Promise<string | { text: string; name?: string }> =>
    ipcRenderer.invoke(IPC.appleSpeechFeed, { samples, speaker }),

  ask: (req: AskStart): Promise<void> => ipcRenderer.invoke(IPC.askStart, req),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.askCancel, id),
  // "New chat": resets main-owned conversation state (server-side Dust conversation + follow-up-memory
  // idle clock). Callers clear the renderer-side history refs themselves.
  resetAskContext: (): Promise<void> => ipcRenderer.invoke(IPC.askResetContext),
  capture: (): Promise<CaptureResult> => ipcRenderer.invoke(IPC.captureScreen),
  prewarmCapture: (): Promise<void> => ipcRenderer.invoke(IPC.prewarmCapture),
  // Fast-path for a screen-ask: ask main whether it already has a fresh, on-device description of the
  // current screen. Non-null → skip the capture and let main inject that context into a mode:'answer' ask.
  screenContext: (): Promise<ScreenContextResult> => ipcRenderer.invoke(IPC.screenContext),
  armAudio: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.armAudio, on),
  saveTranscript: (m: SaveMeeting): Promise<{ path: string }> =>
    ipcRenderer.invoke(IPC.saveTranscript, m),
  // Periodic crash-recovery snapshot of an in-progress meeting — fire-and-forget, best-effort.
  saveDraftTranscript: (m: SaveMeeting): Promise<void> => ipcRenderer.invoke(IPC.saveDraftTranscript, m),
  saveNote: (n: SaveNote): Promise<{ path: string }> => ipcRenderer.invoke(IPC.saveNote, n),
  // Import audio file: pick → hand off to the main-owned background job. The overlay never receives raw audio bytes.
  importAudioPick: (): Promise<ImportAudioPickResult> => ipcRenderer.invoke(IPC.importAudioPick),
  importAudioStart: (token: string): Promise<ImportJobView> => ipcRenderer.invoke(IPC.importAudioStart, { token }),
  importJobsList: (): Promise<ImportJobView[]> => ipcRenderer.invoke(IPC.importJobsList),
  importJobCancel: (jobId: string): Promise<void> => ipcRenderer.invoke(IPC.importJobCancel, { jobId }),
  importJobResume: (jobId: string): Promise<ImportJobView> => ipcRenderer.invoke(IPC.importJobResume, { jobId }),
  importJobRemove: (jobId: string): Promise<void> => ipcRenderer.invoke(IPC.importJobRemove, { jobId }),
  onImportAudioProgress: (cb: (d: ImportAudioProgress) => void): Unsub => sub(IPC.importAudioProgress, cb),
  answerFeedback: (f: AnswerFeedback): Promise<void> => ipcRenderer.invoke(IPC.answerFeedback, f),
  readMetrics: (): Promise<EvalMetrics> => ipcRenderer.invoke(IPC.metricsRead),
  exportRecapJson: (markdown: string): Promise<RecapExport> =>
    ipcRenderer.invoke(IPC.exportRecapJson, markdown),
  pickFolder: (): Promise<PublicSettings> => ipcRenderer.invoke(IPC.pickFolder),
  addTeamTranscriptFolder: (): Promise<PublicSettings> => ipcRenderer.invoke(IPC.addTeamTranscriptFolder),
  removeTeamTranscriptFolder: (folder: string): Promise<PublicSettings> =>
    ipcRenderer.invoke(IPC.removeTeamTranscriptFolder, folder),
  // shell.openPath resolves to '' on success or a non-empty OS error string on failure — callers need the
  // string to surface a failure (e.g. a deleted/unmounted meetings folder), not just fire-and-forget it.
  openMeetingsFolder: (): Promise<string> => ipcRenderer.invoke(IPC.openPath),
  openBrainForClaude: (): Promise<{ ok: boolean; path: string }> => ipcRenderer.invoke(IPC.openBrainForClaude),
  recallList: (): Promise<MeetingSummary[]> => ipcRenderer.invoke(IPC.recallList),
  recallSearch: (q: string): Promise<RecallHit[]> => ipcRenderer.invoke(IPC.recallSearch, q),
  recallOpen: (file: string): Promise<string> => ipcRenderer.invoke(IPC.recallOpen, file),
  recallRead: (file: string): Promise<RecallReadResult> => ipcRenderer.invoke(IPC.recallRead, file),
  // User-initiated decrypted markdown copy of ONE saved meeting (native save dialog in main). Exists so
  // external tools (e.g. Claude local ingesting into the second brain) can read a meeting even when
  // at-rest encryption is on.
  recallExportPlain: (file: string): Promise<RecallExportPlainResult> =>
    ipcRenderer.invoke(IPC.recallExportPlain, file),
  // title is shown in the native confirm dialog the main process pops up before deleting; optional.
  recallDelete: (file: string, title?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.recallDelete, file, title),
  // Fix an auto-generated title after the fact. Never renames the file on disk — only the in-file
  // frontmatter `title:` + H1 heading (and the index.md row, in plaintext mode).
  recallRename: (file: string, title: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.recallRename, { file, title }),
  // Edit a saved meeting's recap ("## Notes & follow-ups") after the fact. Rewrites only that section in
  // place (frontmatter + full transcript untouched); never renames the file. Preserves the file's own
  // encrypted/plaintext state.
  recallUpdateRecap: (file: string, recap: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.recallUpdateRecap, { file, recap }),
  // Task MI-5: flag/unflag a saved meeting as confidential — excludes it from every published wiki
  // surface (main/brain/publish.ts). Rewrites only the frontmatter block; never renames the file.
  recallSetConfidential: (file: string, confidential: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.recallSetConfidential, { file, confidential }),
  // Speaker Intelligence: manually (re)trigger the Teams-transcript speaker-name backfill for a past
  // meeting (see main/graph-transcript.ts). `named` is how many lines got a resolved name; 0 is a normal
  // non-error outcome (no Teams transcript existed/matched yet).
  recallBackfillSpeakers: (file: string): Promise<RecallBackfillSpeakersResult> =>
    ipcRenderer.invoke(IPC.recallBackfillSpeakers, { file }),
  // Delete every saved meeting + the knowledge graph. Main pops its own (extra-emphatic) confirm dialog.
  recallDeleteAll: (): Promise<{ ok: boolean; deleted: number; failed?: string[]; error?: string }> =>
    ipcRenderer.invoke(IPC.recallDeleteAll),
  // 90-Second Debrief: append the off-record gut-read to a saved meeting (basename only).
  debriefSave: (file: string, text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.debriefSave, { file, text }),
  // Commitment settlement: mark a ledger promise kept/broken (or reopen). Deal = display name.
  brainCommitmentSettle: (deal: string, text: string, status: 'open' | 'kept' | 'broken'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.brainCommitmentSettle, { deal, text, status }),
  // Deal outcome: mark a deal open/won/lost (or reopen). dealSlug = display name, slugified in main.
  brainSetDealOutcome: (dealSlug: string, outcome: 'open' | 'won' | 'lost'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.brainSetDealOutcome, { dealSlug, outcome }),
  // Correction engine (Task MI-2): rename/merge/unmerge/field-pin/commitment-reject. All five take
  // entity SLUGS (the immutable join key), never display names — the caller already has them from a
  // brain:read/brainEntityNames response.
  // asrSkipped/reason: the rename itself succeeded, but the alsoFixAsr pair couldn't be represented as
  // a live-transcript ASR correction (e.g. a name over the 80-char cap) — surfaced so MI-3's UI can say so.
  brainEntityRename: (
    kind: import('@shared/brain').EntityKind,
    id: string,
    newName: string,
    alsoFixAsr?: boolean
  ): Promise<{ ok: boolean; error?: string; asrSkipped?: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.brainEntityRename, { kind, id, newName, alsoFixAsr }),
  // seq (Task MI-3): the appended entity_merge journal entry's own sequence number, handed straight to
  // brainEntityUnmerge for the record page's post-merge "Undo" affordance.
  brainEntityMerge: (
    kind: import('@shared/brain').EntityKind,
    fromId: string,
    intoId: string
  ): Promise<{ ok: boolean; error?: string; seq?: number }> =>
    ipcRenderer.invoke(IPC.brainEntityMerge, { kind, fromId, intoId }),
  brainEntityUnmerge: (targetSeq: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.brainEntityUnmerge, { targetSeq }),
  brainEntityUpdateField: (
    kind: import('@shared/brain').EntityKind,
    id: string,
    field: string,
    value: unknown
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.brainEntityUpdateField, { kind, id, field, value }),
  brainCommitmentReject: (personSlug: string, text: string, dealSlug?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.brainCommitmentReject, { personSlug, dealSlug, text }),
  // Task MI-3: read-only. `file` is a saved meeting's basename — returns the stored MeetingExtraction, or
  // null when the brain hasn't ingested/extracted that meeting yet (also null while signed out).
  brainMeetingExtraction: (file: string): Promise<import('@shared/brain').MeetingExtraction | null> =>
    ipcRenderer.invoke(IPC.brainMeetingExtraction, { file }),
  // Task MI-3: aggregated needs-attention queue (lint contradictions, AMBIGUOUS fields, contradicted pins).
  brainAttention: (): Promise<import('@shared/ipc').BrainAttentionResult> =>
    ipcRenderer.invoke(IPC.brainAttention),
  setListeningState: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.listeningState, on),
  asrBundled: (): Promise<boolean> => ipcRenderer.invoke(IPC.asrBundled),

  // Métis Local (on-device LLM): read-only readiness for the model included in the installer.
  localModelsList: (): Promise<LocalModelSummary[]> => ipcRenderer.invoke(IPC.localModelsList),
  // Fire-and-forget: keep the local sidecar's per-slot KV cache hot while a meeting is live (PLAN.md
  // §4.4's pre-warm path). The renderer never learns the sidecar's port/key — this only ever sends
  // transcript text; main resolves the runtime/model/session key on its own.
  localPrewarm: (text: string): Promise<void> => ipcRenderer.invoke(IPC.localPrewarm, { text }),

  resize: (height: number, width?: number): Promise<void> =>
    ipcRenderer.invoke(IPC.windowResize, { height, width }),
  windowMode: (mode: 'bar' | 'settings'): Promise<void> =>
    ipcRenderer.invoke(IPC.windowMode, mode),
  windowMoveBy: (dx: number, dy: number): Promise<void> =>
    ipcRenderer.invoke(IPC.windowMoveBy, { dx, dy }),
  minimize: (narrow: boolean): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize, narrow),
  // A caught render-throw (ErrorBoundary) — fire-and-forget, best-effort. Main persists it to disk (same
  // sink as a main-process crash) so a field report survives without ASKTOTO_DEBUG_RENDERER devtools.
  reportCrash: (message: string, stack?: string, componentStack?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.rendererCrash, { message, stack, componentStack }),
  hide: (): Promise<void> => ipcRenderer.invoke(IPC.windowHide),
  toggle: (): Promise<void> => ipcRenderer.invoke(IPC.windowToggle),
  quit: (): Promise<void> => ipcRenderer.invoke(IPC.windowQuit),
  relaunch: (): Promise<void> => ipcRenderer.invoke(IPC.windowRelaunch),

  onDelta: (cb: (d: StreamDelta) => void): Unsub => sub(IPC.streamDelta, cb),
  onDone: (cb: (d: StreamDone) => void): Unsub => sub(IPC.streamDone, cb),
  onError: (cb: (d: StreamError) => void): Unsub => sub(IPC.streamError, cb),
  onMeta: (cb: (d: StreamMeta) => void): Unsub => sub(IPC.streamMeta, cb),
  onHotkey: (cb: (a: HotkeyAction) => void): Unsub => sub(IPC.hotkey, cb),

  onUpdateReady: (cb: (d: { version?: string; notes?: string }) => void): Unsub => sub(IPC.updateDownloaded, cb),
  onUpdateProgress: (cb: (d: { percent?: number }) => void): Unsub => sub(IPC.updateProgress, cb),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),
  // Settings "Update now" → start the in-app download; progress/ready arrive via onUpdateProgress/onUpdateReady.
  downloadUpdate: (): Promise<UpdateDownloadStart> => ipcRenderer.invoke(IPC.updateDownload),
  // Manual releases-feed check for Settings → About → Updates (works on every build, incl. unsigned mac).
  checkForUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC.updateCheck),

  openMailDraft: (input: { subject: string; body: string }): Promise<{ truncated: boolean }> =>
    ipcRenderer.invoke(IPC.openMailDraft, input),
  recapPdf: (input: { markdown: string; title?: string }): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke(IPC.recapPdf, input),

  mcpTestConnection: (payload: McpTestConnectionPayload): Promise<McpConnectResult> =>
    ipcRenderer.invoke(IPC.mcpTestConnection, payload),
  mcpSaveConnection: (payload: McpSaveConnectionPayload): Promise<McpConnectResult> =>
    ipcRenderer.invoke(IPC.mcpSaveConnection, payload),
  mcpDisconnect: (payload: McpDisconnectPayload): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.mcpDisconnect, payload),
  mcpPush: (payload: McpPushPayload): Promise<McpPushResult> =>
    ipcRenderer.invoke(IPC.mcpPush, payload),

  licenseActivate: (payload: LicenseActivatePayload): Promise<LicenseActivateResult> =>
    ipcRenderer.invoke(IPC.licenseActivate, payload),
  licenseStatus: (): Promise<LicenseStatusResult> => ipcRenderer.invoke(IPC.licenseStatus),
  // Boot-gate verdict — see the license:gate handler in main/index.ts for why this is a separate,
  // non-auth-gated channel from licenseStatus.
  licenseGate: (): Promise<LicenseGateVerdict> => ipcRenderer.invoke(IPC.licenseGate)
}

contextBridge.exposeInMainWorld('toto', api)

export type TotoApi = typeof api
