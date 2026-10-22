import type { OptionalComponentId, SpeechRuntimeComponentId } from '../../../../shared/speech-pack'
import { componentBytes, componentDownloadBytes, PARAKEET_TDT_V3_INT8, WHISPER_BASE_Q8 } from './manifest'
import type { SpeechPackComponentId } from './manifest'

/**
 * The closed list of optional on-device components (G11, D-12). A lean installer ships none of them; each is a
 * model plus the runtime that runs it, offered only with the person's consent. This table is pure data so the
 * runtime registry, the service snapshot and the offer surfaces all read one description of what each costs,
 * who supplies it and where it runs. Presence and availability are resolved from it in optional-components.ts.
 *
 * - Parakeet is offered at the first hold (D-12): the first time command speech is needed and no cloud route
 *   serves it. Whisper and the local LLM are offered from Settings.
 * - Sizes for the speech models come from the pinned manifests. The local LLM size is the reviewed compact model
 *   plus projector (src/main/llm/local-models.ts, qwen3.5-0.8b); a test fails if the two drift.
 */
export interface OptionalComponentDescriptor {
  readonly id: OptionalComponentId
  readonly label: string
  readonly provider: string
  readonly sourceHost: string
  readonly privacy: 'on-device'
  readonly privacyNote: string
  readonly downloadBytes: number
  readonly installedBytes: number
  /** Speech-pack manifest row, when the component's weights are managed by the speech-pack service. */
  readonly modelComponentId: SpeechPackComponentId | null
  /** Local model registry id, when the weights belong to the local LLM registry. */
  readonly localModelId: string | null
  /** Runtimes that must be ready, in order, before the model can run. */
  readonly runtimeIds: readonly SpeechRuntimeComponentId[]
  readonly offer: { readonly surface: 'first-hold' | 'settings'; readonly consent: 'required' }
}

const LOCAL_LLM_MODEL_ID = 'qwen3.5-0.8b'
// qwen3.5-0.8b model.gguf (558,772,480) + mmproj.gguf (204,987,232).
const LOCAL_LLM_BYTES = 558_772_480 + 204_987_232

export const OPTIONAL_COMPONENT_DESCRIPTORS: readonly OptionalComponentDescriptor[] = [
  {
    id: 'local-llm',
    label: 'Métis Local',
    provider: 'Qwen3.5 0.8B from Alibaba Qwen, GGUF files by Unsloth',
    sourceHost: 'huggingface.co',
    privacy: 'on-device',
    privacyNote: 'Suggestions and summaries run on this computer. Nothing you say leaves it for this model.',
    downloadBytes: LOCAL_LLM_BYTES,
    installedBytes: LOCAL_LLM_BYTES,
    modelComponentId: null,
    localModelId: LOCAL_LLM_MODEL_ID,
    runtimeIds: ['runtime.llama-server'],
    offer: { surface: 'settings', consent: 'required' }
  },
  {
    id: 'whisper',
    label: 'Whisper (offline speech)',
    provider: 'Whisper base from OpenAI, quantized by Xenova',
    sourceHost: 'huggingface.co',
    privacy: 'on-device',
    privacyNote: 'Meeting audio is transcribed on this computer and is not sent to a speech service.',
    downloadBytes: componentDownloadBytes(WHISPER_BASE_Q8),
    installedBytes: componentBytes(WHISPER_BASE_Q8),
    modelComponentId: WHISPER_BASE_Q8.id,
    localModelId: null,
    runtimeIds: ['runtime.asr-whisper-worker'],
    offer: { surface: 'settings', consent: 'required' }
  },
  {
    id: 'parakeet',
    label: 'Parakeet (fast offline speech)',
    provider: 'Parakeet TDT 0.6B v3 from NVIDIA, int8 files by sherpa-onnx',
    sourceHost: 'huggingface.co',
    privacy: 'on-device',
    privacyNote: 'Commands and meeting audio are transcribed on this computer and are not sent to a speech service.',
    downloadBytes: componentDownloadBytes(PARAKEET_TDT_V3_INT8),
    installedBytes: componentBytes(PARAKEET_TDT_V3_INT8),
    modelComponentId: PARAKEET_TDT_V3_INT8.id,
    localModelId: null,
    runtimeIds: ['runtime.asr-sherpa-onnx'],
    offer: { surface: 'first-hold', consent: 'required' }
  }
]

export function descriptorFor(id: OptionalComponentId): OptionalComponentDescriptor {
  const descriptor = OPTIONAL_COMPONENT_DESCRIPTORS.find((item) => item.id === id)
  if (!descriptor) throw new Error(`Unknown optional component: ${id}`)
  return descriptor
}
