import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AskStart,
  type PublicSettings,
  type Settings,
  type HotkeyAction,
  type CaptureResult,
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
  type TestKeyResponse,
  type DustAgentsResponse,
  type DustCliImport,
  type DustCliSetup,
  type CliActionResult,
  type CliInstallResult,
  type GraphStatus,
  type GraphRelated,
  type AuthStatus,
  type SignInResult,
  type CalendarTodayResult,
  type RecallReadResult,
  type PlatformPermissions,
  type McpCrmTestConnectionPayload,
  type McpCrmSaveConnectionPayload,
  type McpCrmPushPayload,
  type McpCrmConnectResult,
  type McpCrmPushResult
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
  setSettings: (patch: Partial<Settings> | import('@shared/ipc').SettingsPatch): Promise<PublicSettings> =>
    ipcRenderer.invoke(IPC.settingsSet, patch),
  setApiKey: (provider: ProviderId, key: string): Promise<{ hasKeys: Record<string, boolean> }> =>
    ipcRenderer.invoke(IPC.setApiKey, { provider, key }),
  clearApiKey: (provider: ProviderId): Promise<{ hasKeys: Record<string, boolean> }> =>
    ipcRenderer.invoke(IPC.clearApiKey, { provider }),
  testApiKey: (provider: ProviderId, key: string): Promise<TestKeyResponse> =>
    ipcRenderer.invoke(IPC.testApiKey, { provider, key }),
  dustListAgents: (): Promise<DustAgentsResponse> => ipcRenderer.invoke(IPC.dustListAgents),
  dustImportCli: (): Promise<DustCliImport> => ipcRenderer.invoke(IPC.dustImportCli),
  dustSetupCli: (): Promise<DustCliSetup> => ipcRenderer.invoke(IPC.dustSetupCli),
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
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.authStatus),
  signIn: (): Promise<SignInResult> => ipcRenderer.invoke(IPC.authSignIn),
  signOut: (): Promise<void> => ipcRenderer.invoke(IPC.authSignOut),
  calendarToday: (tz: string): Promise<CalendarTodayResult> => ipcRenderer.invoke(IPC.calendarToday, tz),
  parakeetStatus: (): Promise<{ ready: boolean }> => ipcRenderer.invoke(IPC.parakeetStatus),
  parakeetEnsure: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.parakeetEnsure),
  parakeetFeed: (samples: Float32Array, speaker: string): Promise<string> =>
    ipcRenderer.invoke(IPC.parakeetFeed, { samples, speaker }),
  onParakeetProgress: (cb: (pct: number) => void): (() => void) => {
    const h = (_e: unknown, d: { pct: number }): void => cb(d.pct)
    ipcRenderer.on(IPC.parakeetProgress, h)
    return () => ipcRenderer.removeListener(IPC.parakeetProgress, h)
  },

  ask: (req: AskStart): Promise<void> => ipcRenderer.invoke(IPC.askStart, req),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.askCancel, id),
  capture: (): Promise<CaptureResult> => ipcRenderer.invoke(IPC.captureScreen),
  prewarmCapture: (): Promise<void> => ipcRenderer.invoke(IPC.prewarmCapture),
  armAudio: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.armAudio, on),
  saveTranscript: (m: SaveMeeting): Promise<{ path: string }> =>
    ipcRenderer.invoke(IPC.saveTranscript, m),
  saveNote: (n: SaveNote): Promise<{ path: string }> => ipcRenderer.invoke(IPC.saveNote, n),
  answerFeedback: (f: AnswerFeedback): Promise<void> => ipcRenderer.invoke(IPC.answerFeedback, f),
  readMetrics: (): Promise<EvalMetrics> => ipcRenderer.invoke(IPC.metricsRead),
  exportRecapJson: (markdown: string): Promise<RecapExport> =>
    ipcRenderer.invoke(IPC.exportRecapJson, markdown),
  pickFolder: (): Promise<PublicSettings> => ipcRenderer.invoke(IPC.pickFolder),
  openMeetingsFolder: (): Promise<void> => ipcRenderer.invoke(IPC.openPath),
  recallList: (): Promise<MeetingSummary[]> => ipcRenderer.invoke(IPC.recallList),
  recallSearch: (q: string): Promise<RecallHit[]> => ipcRenderer.invoke(IPC.recallSearch, q),
  recallOpen: (file: string): Promise<string> => ipcRenderer.invoke(IPC.recallOpen, file),
  recallRead: (file: string): Promise<RecallReadResult> => ipcRenderer.invoke(IPC.recallRead, file),
  // title is shown in the native confirm dialog the main process pops up before deleting; optional.
  recallDelete: (file: string, title?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.recallDelete, file, title),
  setListeningState: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.listeningState, on),
  asrBundled: (): Promise<boolean> => ipcRenderer.invoke(IPC.asrBundled),

  resize: (height: number): Promise<void> => ipcRenderer.invoke(IPC.windowResize, { height }),
  windowMode: (mode: 'bar' | 'settings'): Promise<void> =>
    ipcRenderer.invoke(IPC.windowMode, mode),
  windowMoveBy: (dx: number, dy: number): Promise<void> =>
    ipcRenderer.invoke(IPC.windowMoveBy, { dx, dy }),
  minimize: (narrow: boolean): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize, narrow),
  hide: (): Promise<void> => ipcRenderer.invoke(IPC.windowHide),
  toggle: (): Promise<void> => ipcRenderer.invoke(IPC.windowToggle),
  quit: (): Promise<void> => ipcRenderer.invoke(IPC.windowQuit),

  onDelta: (cb: (d: StreamDelta) => void): Unsub => sub(IPC.streamDelta, cb),
  onDone: (cb: (d: StreamDone) => void): Unsub => sub(IPC.streamDone, cb),
  onError: (cb: (d: StreamError) => void): Unsub => sub(IPC.streamError, cb),
  onHotkey: (cb: (a: HotkeyAction) => void): Unsub => sub(IPC.hotkey, cb),
  onMeetingDetected: (cb: (d: { app?: string; active?: boolean }) => void): Unsub =>
    sub(IPC.meetingDetected, cb),

  onUpdateReady: (cb: (d: { version?: string }) => void): Unsub => sub(IPC.updateDownloaded, cb),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),

  openMailDraft: (input: { subject: string; body: string }): Promise<{ truncated: boolean }> =>
    ipcRenderer.invoke(IPC.openMailDraft, input),
  recapPdf: (input: { markdown: string; title?: string }): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke(IPC.recapPdf, input),

  mcpCrmTestConnection: (payload: McpCrmTestConnectionPayload): Promise<McpCrmConnectResult> =>
    ipcRenderer.invoke(IPC.mcpCrmTestConnection, payload),
  mcpCrmSaveConnection: (payload: McpCrmSaveConnectionPayload): Promise<McpCrmConnectResult> =>
    ipcRenderer.invoke(IPC.mcpCrmSaveConnection, payload),
  mcpCrmDisconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.mcpCrmDisconnect),
  mcpCrmPush: (payload: McpCrmPushPayload): Promise<McpCrmPushResult> =>
    ipcRenderer.invoke(IPC.mcpCrmPush, payload)
}

contextBridge.exposeInMainWorld('toto', api)

export type TotoApi = typeof api
