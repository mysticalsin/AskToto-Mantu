import type { IpcRenderer } from 'electron'
import { createCloudSpeechPreloadApi } from './cloud-speech'
import { createTranscriptRevisionPreloadApi } from './transcript-revision'
import { createMetricsPreloadApi } from './metrics'
import { createVoiceActionsPreloadApi } from './voice-actions'

/** The preload bridges that are one self-contained feature each, composed here so index.ts stays under its size cap. */
export function createFeaturePreloadApis(ipc: IpcRenderer) {
  return {
    ...createCloudSpeechPreloadApi(ipc),
    ...createTranscriptRevisionPreloadApi(ipc),
    ...createMetricsPreloadApi(ipc),
    ...createVoiceActionsPreloadApi(ipc)
  }
}
