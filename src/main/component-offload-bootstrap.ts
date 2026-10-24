import { OPTIONAL_COMPONENT_DESCRIPTORS } from './features/components/speech-pack/optional-component-descriptors'
import { availableBytesAtPath, nearestExistingPath } from './features/components/speech-pack/download'
import {
  createComponentOffloadService,
  createLocalModelTarget,
  createOffloadReceiptStore,
  createSpeechPackTarget,
  type LocalModelFacts,
  type SpeechPackService
} from './features/components'
import { registerComponentOffloadIpc } from './ipc/component-offload-ipc'
import { isDownloaded, listModels, modelSource, modelsRoot } from './llm/local-models'
import { localModelDownloadState } from './llm/local-model-download'
import { getState as localRuntimeState, stop as stopLocalRuntime } from './llm/local-runtime'

const LOCAL_LLM_MODEL_ID = OPTIONAL_COMPONENT_DESCRIPTORS.find((item) => item.id === 'local-llm')?.localModelId ?? null

/** Registry and runtime facts for the local LLM row of the optional-component status (G87). */
export function localModelFactsFromMain(): LocalModelFacts | undefined {
  if (LOCAL_LLM_MODEL_ID === null) return undefined
  const summary = listModels(localModelDownloadState()).find((item) => item.id === LOCAL_LLM_MODEL_ID)
  return {
    downloaded: isDownloaded(LOCAL_LLM_MODEL_ID),
    source: modelSource(LOCAL_LLM_MODEL_ID),
    reason: summary?.unavailableReason ?? null,
    runtimeState: localRuntimeState()
  }
}

/**
 * Compose the offload service for the desktop (G87): the speech-pack engine removes speech packs, the local-model
 * target removes the downloaded LLM weights, and both run behind the same capture and busy fences as installs.
 * Receipts are stored beside userData, never inside the speech-pack root.
 */
export function startComponentOffload(options: {
  service: Pick<SpeechPackService, 'snapshot' | 'evictSpeechComponent'>
  rootDir: string
  receiptsPath: string
  captureActive: () => boolean
  ipcMain: Parameters<typeof registerComponentOffloadIpc>[0]['ipcMain']
  assertMainWindow: Parameters<typeof registerComponentOffloadIpc>[0]['assertMainWindow']
}): { stop(): void } {
  const speechTarget = (id: 'whisper' | 'parakeet') => {
    const modelComponentId = OPTIONAL_COMPONENT_DESCRIPTORS.find((item) => item.id === id)?.modelComponentId
    return modelComponentId
      ? createSpeechPackTarget({ service: options.service, rootDir: options.rootDir, componentId: modelComponentId })
      : null
  }
  const targets = {
    whisper: speechTarget('whisper'),
    parakeet: speechTarget('parakeet'),
    'local-llm': LOCAL_LLM_MODEL_ID
      ? createLocalModelTarget({
          modelsRoot,
          modelId: LOCAL_LLM_MODEL_ID,
          downloading: () => localModelDownloadState().status === 'downloading',
          stopRuntime: stopLocalRuntime
        })
      : null
  } as const
  const service = createComponentOffloadService({
    statuses: async () => (await options.service.snapshot()).optionalComponents ?? [],
    target: (id) => targets[id],
    captureActive: options.captureActive,
    freeBytes: async () => availableBytesAtPath(await nearestExistingPath(options.rootDir)),
    receipts: createOffloadReceiptStore(options.receiptsPath)
  })
  void service.initialise()
  const unregister = registerComponentOffloadIpc({
    ipcMain: options.ipcMain,
    assertMainWindow: options.assertMainWindow,
    service
  })
  return { stop: unregister }
}
