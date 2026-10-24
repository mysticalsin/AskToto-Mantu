import type { SpeechPackProgress } from '@shared/speech-pack'
import type { SpeechPackState } from './engine'
import {
  PARAKEET_TDT_V3_INT8,
  WHISPER_BASE_Q8,
  isImmutableUrl,
  type SpeechPackComponent,
  type SpeechPackComponentId
} from './manifest'

/** Pure helpers of the speech-pack service, kept apart so service.ts stays under the file-size cap. */
export function selectedId(engine: 'whisper' | 'parakeet' | 'apple'): SpeechPackComponentId | null {
  return engine === 'whisper' ? WHISPER_BASE_Q8.id : engine === 'parakeet' ? PARAKEET_TDT_V3_INT8.id : null
}

export function finiteState(state: SpeechPackState): SpeechPackProgress['state'] {
  return state.status === 'not-installed' ? 'paused' : state.status === 'error' ? 'error' : state.status
}

export function sourceHost(component: SpeechPackComponent): string | null {
  const url = component.source.kind === 'files' ? component.source.baseUrl : component.source.archive?.url
  if (!url || !isImmutableUrl(url)) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.hostname : null
  } catch {
    return null
  }
}
