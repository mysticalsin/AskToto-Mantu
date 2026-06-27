/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers'

// Fetch models from the HF hub (no local model files bundled).
env.allowLocalModels = false

/* eslint-disable @typescript-eslint/no-explicit-any */
let asr: any = null
let loading = false
const post = (m: unknown): void => (self as unknown as Worker).postMessage(m)

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as { type: string; model?: string; audio?: Float32Array; seq?: number }

  if (msg.type === 'init') {
    if (asr || loading) return
    loading = true
    try {
      asr = await pipeline('automatic-speech-recognition', msg.model || 'Xenova/whisper-tiny', {
        dtype: 'q8'
      })
      post({ type: 'ready' })
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      loading = false
    }
    return
  }

  if (msg.type === 'audio') {
    const speaker = (msg as { speaker?: string }).speaker
    // Always emit exactly one terminal reply so the renderer queue never wedges.
    if (!asr || !msg.audio) {
      post({ type: 'text', text: '', speaker })
      return
    }
    try {
      const out: any = await asr(msg.audio, { chunk_length_s: 30, stride_length_s: 5 })
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out?.text || '').trim()
      post({ type: 'text', text, speaker })
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err), speaker })
    }
  }
}
