import type { IpcRenderer } from 'electron'
import { createCloudSpeechPreloadApi } from './cloud-speech'
import { createCommandConfirmPreloadApi } from './command-confirm'
import { createTranscriptRevisionPreloadApi } from './transcript-revision'
import { createMetricsPreloadApi } from './metrics'
import { createDictationMemoryPreloadApi } from './dictation-memory'
import { createVoiceActionsPreloadApi } from './voice-actions'
import { createSessionContextPreloadApi } from './session-context'
import { createTaskCardsPreloadApi } from './task-cards'
import { createContextGrantsPreloadApi } from './context-grants'
import { createScreenMarksPreloadApi } from './screen-marks'
import { createTaskBrowserPreloadApi } from './task-browser'
import { createExportPreloadApi } from './export-reveal'
import { createWalkthroughPreloadApi } from './walkthrough'
import { createSpokenRepliesPreloadApi } from './spoken-replies'
import { createArtifactsPreloadApi } from './artifacts'
import { createLinksPreloadApi } from './links'
import { createAssistantsPreloadApi } from './assistants'
import { createUserMemoryPreloadApi } from './user-memory'
import { createConnectorAccountsPreloadApi } from './connector-accounts'
import { createAccountChoicePreloadApi } from './connector-account-choice'
import { createQuietPreloadApi } from './quiet'
import { createDictationStatusPreloadApi } from './dictation-status'

/** The preload bridges that are one self-contained feature each, composed here so index.ts stays under its size cap. */
export function createFeaturePreloadApis(ipc: IpcRenderer) {
  return {
    ...createCloudSpeechPreloadApi(ipc),
    ...createTranscriptRevisionPreloadApi(ipc),
    ...createMetricsPreloadApi(ipc),
    ...createVoiceActionsPreloadApi(ipc),
    ...createDictationMemoryPreloadApi(ipc),
    ...createSessionContextPreloadApi(ipc),
    ...createCommandConfirmPreloadApi(ipc),
    ...createTaskCardsPreloadApi(ipc),
    ...createContextGrantsPreloadApi(ipc),
    ...createScreenMarksPreloadApi(ipc),
    ...createTaskBrowserPreloadApi(ipc),
    ...createExportPreloadApi(ipc),
    ...createWalkthroughPreloadApi(ipc),
    ...createSpokenRepliesPreloadApi(ipc),
    ...createArtifactsPreloadApi(ipc),
    ...createLinksPreloadApi(ipc),
    ...createAssistantsPreloadApi(ipc),
    ...createUserMemoryPreloadApi(ipc),
    ...createConnectorAccountsPreloadApi(ipc),
    ...createAccountChoicePreloadApi(ipc),
    ...createQuietPreloadApi(ipc),
    ...createDictationStatusPreloadApi(ipc),
    ...createAttachmentsPreloadApi(ipc)
  }
}
