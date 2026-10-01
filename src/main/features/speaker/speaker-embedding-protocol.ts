export const SPEAKER_SAMPLE_RATE = 16_000
export const SPEAKER_MAX_SAMPLES = SPEAKER_SAMPLE_RATE * 30
export const SPEAKER_EMBEDDING_DIMENSIONS = 512

export type SpeakerEmbeddingOwner = 'live' | 'import'

export type SpeakerEmbeddingHostRequest =
  | { type: 'warmup'; id: string; model: string }
  | { type: 'embed'; id: string; model: string; pcm: ArrayBuffer }

export interface SpeakerEmbeddingHostResponse {
  type?: 'result' | 'error'
  id?: string
  embedding?: ArrayBuffer
  message?: string
}
