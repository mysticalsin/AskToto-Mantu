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
  type MeetingSummary,
  type RecallHit,
  type StreamDelta,
  type StreamDone,
  type StreamError,
  type TestKeyResponse,
  type DustAgentsResponse,
  type DustCliImport,
  type DustCliSetup,
  type GraphStatus,
  type GraphRelated,
  type AuthStatus,
  type SignInResult,
  type PlatformPermissions
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
  graphifyStatus: (): Promise<GraphStatus> => ipcRenderer.invoke(IPC.graphifyStatus),
  graphifyRebuild: (): Promise<GraphStatus> => ipcRenderer.invoke(IPC.graphifyRebuild),
  graphifyRelated: (file: string): Promise<GraphRelated> =>
    ipcRenderer.invoke(IPC.graphifyRelated, file),
  graphifyOpenGraph: (): Promise<string> => ipcRenderer.invoke(IPC.graphifyOpenGraph),
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.authStatus),
  signIn: (): Promise<SignInResult> => ipcRenderer.invoke(IPC.authSignIn),
  signOut: (): Promise<void> => ipcRenderer.invoke(IPC.authSignOut),

  ask: (req: AskStart): Promise<void> => ipcRenderer.invoke(IPC.askStart, req),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.askCancel, id),
  capture: (): Promise<CaptureResult> => ipcRenderer.invoke(IPC.captureScreen),
  armAudio: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.armAudio, on),
  saveTranscript: (m: SaveMeeting): Promise<{ path: string }> =>
    ipcRenderer.invoke(IPC.saveTranscript, m),
  saveNote: (n: SaveNote): Promise<{ path: string }> => ipcRenderer.invoke(IPC.saveNote, n),
  pickFolder: (): Promise<PublicSettings> => ipcRenderer.invoke(IPC.pickFolder),
  openMeetingsFolder: (): Promise<void> => ipcRenderer.invoke(IPC.openPath),
  recallList: (): Promise<MeetingSummary[]> => ipcRenderer.invoke(IPC.recallList),
  recallSearch: (q: string): Promise<RecallHit[]> => ipcRenderer.invoke(IPC.recallSearch, q),
  recallOpen: (file: string): Promise<string> => ipcRenderer.invoke(IPC.recallOpen, file),
  setListeningState: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.listeningState, on),

  resize: (height: number): Promise<void> => ipcRenderer.invoke(IPC.windowResize, { height }),
  windowMode: (mode: 'bar' | 'settings'): Promise<void> =>
    ipcRenderer.invoke(IPC.windowMode, mode),
  windowMoveBy: (dx: number, dy: number): Promise<void> =>
    ipcRenderer.invoke(IPC.windowMoveBy, { dx, dy }),
  hide: (): Promise<void> => ipcRenderer.invoke(IPC.windowHide),
  toggle: (): Promise<void> => ipcRenderer.invoke(IPC.windowToggle),
  quit: (): Promise<void> => ipcRenderer.invoke(IPC.windowQuit),

  onDelta: (cb: (d: StreamDelta) => void): Unsub => sub(IPC.streamDelta, cb),
  onDone: (cb: (d: StreamDone) => void): Unsub => sub(IPC.streamDone, cb),
  onError: (cb: (d: StreamError) => void): Unsub => sub(IPC.streamError, cb),
  onHotkey: (cb: (a: HotkeyAction) => void): Unsub => sub(IPC.hotkey, cb),
  onMeetingDetected: (cb: (d: { app?: string; active?: boolean }) => void): Unsub =>
    sub(IPC.meetingDetected, cb)
}

contextBridge.exposeInMainWorld('toto', api)

export type TotoApi = typeof api
