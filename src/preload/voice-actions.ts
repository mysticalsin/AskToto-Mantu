import type { IpcRenderer } from 'electron'
import {
  VOICE_ACTIONS_IPC,
  VoiceBeginSchema,
  VoiceEndSchema,
  VoiceStateSnapshotSchema,
  type VoiceBegin,
  type VoiceEnd,
  type VoiceReport,
  type VoiceStateSnapshot
} from '../shared/voice/voice-turn'

type Unsub = () => void

/**
 * Voice actions bridge. Every push from main is validated here and a malformed payload is dropped, so the
 * renderer only ever sees the contract shapes. `report` is the one renderer-to-main call: main validates it again
 * and it can only move the current turn toward failure. There is no call that starts a turn, mints an activation
 * or opens a microphone: those are main's, from the held chord.
 */
export function createVoiceActionsPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'invoke'>): {
  voiceActions: {
    getState(): Promise<VoiceStateSnapshot | null>
    onState(cb: (state: VoiceStateSnapshot) => void): Unsub
    onBegin(cb: (turn: VoiceBegin) => void): Unsub
    onEnd(cb: (turn: VoiceEnd) => void): Unsub
    report(report: VoiceReport): Promise<unknown>
  }
} {
  const subscribe = <T>(channel: string, parse: (raw: unknown) => T | null, cb: (value: T) => void): Unsub => {
    const listener = (_event: unknown, payload: unknown): void => {
      const value = parse(payload)
      if (value === null) return
      try {
        cb(value)
      } catch {
        /* a throwing subscriber must not break the bridge */
      }
    }
    ipc.on(channel, listener)
    return () => ipc.removeListener(channel, listener)
  }
  const parser =
    <T>(schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } }) =>
    (raw: unknown): T | null => {
      const parsed = schema.safeParse(raw)
      return parsed.success ? parsed.data : null
    }
  return {
    voiceActions: {
      async getState() {
        const parsed = VoiceStateSnapshotSchema.safeParse(await ipc.invoke(VOICE_ACTIONS_IPC.getState))
        return parsed.success ? parsed.data : null
      },
      onState: (cb) => subscribe(VOICE_ACTIONS_IPC.state, parser(VoiceStateSnapshotSchema), cb),
      onBegin: (cb) => subscribe(VOICE_ACTIONS_IPC.begin, parser(VoiceBeginSchema), cb),
      onEnd: (cb) => subscribe(VOICE_ACTIONS_IPC.end, parser(VoiceEndSchema), cb),
      report: (report) => ipc.invoke(VOICE_ACTIONS_IPC.report, report)
    }
  }
}
