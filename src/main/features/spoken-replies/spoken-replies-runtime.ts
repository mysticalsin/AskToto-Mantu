/**
 * spoken-replies-runtime.ts — builds the spoken replies service for the main process (G27).
 *
 * index.ts calls `createSpokenRepliesRuntime` once and hands the result to three places: the ask turn registry
 * (`observeAsk`), the voice actions runtime (`bargeIn`) and the renderer IPC (`snapshot`, `listVoices`, `preview`,
 * `stop`). Everything platform specific (the engine, the helper path, the process host) is bound here, so index.ts
 * grows by a few lines and the service itself stays free of Electron.
 */
import { SPOKEN_REPLIES_IPC } from '@shared/spoken-replies'
import type { SpokenRepliesSettings } from '@shared/spoken-replies-settings'
import { auditLog } from '../../logger'
import { macSpeakSpawnSpec, macSpeakVoicesSpawnSpec } from '../../mac-helper'
import { ttsProcessHost } from '../../infra/process/tts-process-host'
import { createSpokenReplies, type SpokenReplies } from './spoken-replies-service'
import { createTtsAdapter, type TtsAdapter } from './tts-adapter'

interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

export interface SpokenRepliesRuntimeDeps {
  getSettings(): { spokenReplies?: SpokenRepliesSettings }
  /** A meeting is being recorded (the speaker would be captured): spoken replies are muted. */
  meetingLive(): boolean
  window(): WindowLike | null | undefined
  /** Defaults to this process's platform. */
  platform?: NodeJS.Platform
  /** Tests may supply an engine; production binds the platform's own. */
  adapter?: TtsAdapter | null
}

export function createSpokenRepliesRuntime(deps: SpokenRepliesRuntimeDeps): SpokenReplies {
  const platform = deps.platform ?? process.platform
  const adapter =
    deps.adapter !== undefined
      ? deps.adapter
      : createTtsAdapter(platform, {
          port: ttsProcessHost,
          macHelper: { speakSpec: macSpeakSpawnSpec, voicesSpec: macSpeakVoicesSpawnSpec }
        })
  return createSpokenReplies({
    adapter,
    platform,
    getSettings: deps.getSettings,
    meetingLive: deps.meetingLive,
    onState(state) {
      const win = deps.window()
      if (!win || win.isDestroyed()) return
      try {
        win.webContents.send(SPOKEN_REPLIES_IPC.state, state)
      } catch {
        // The renderer may be gone; getState recovers the snapshot.
      }
    },
    audit: ({ phase, ...detail }) => auditLog('tts.playback', { phase, ...detail })
  })
}
