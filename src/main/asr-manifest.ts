import { statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The COMPLETE set of bundled files the offline whisper pipeline can request through the asr-model://
 * protocol (transformers.js whisper-base WASM path + the ORT runtime). The bundled/offline mode used to
 * be gated on just TWO of these (one wasm + config.json); any other file missing then hard-failed the
 * whole Listen feature at runtime with a raw transformers.js error ("file was not found locally at
 * asr-model://models/Xenova/whisper-base/tokenizer.json"), because the worker locks
 * env.allowRemoteModels=false in bundled mode. Bundled mode must only engage when EVERY file is present.
 */
export const ASR_REQUIRED_FILES: readonly string[][] = [
  ['ort', 'ort-wasm-simd-threaded.jsep.wasm'],
  ['ort', 'ort-wasm-simd-threaded.jsep.mjs'],
  ['models', 'Xenova', 'whisper-base', 'config.json'],
  ['models', 'Xenova', 'whisper-base', 'generation_config.json'],
  ['models', 'Xenova', 'whisper-base', 'preprocessor_config.json'],
  ['models', 'Xenova', 'whisper-base', 'tokenizer.json'],
  ['models', 'Xenova', 'whisper-base', 'tokenizer_config.json'],
  ['models', 'Xenova', 'whisper-base', 'special_tokens_map.json'],
  ['models', 'Xenova', 'whisper-base', 'normalizer.json'],
  ['models', 'Xenova', 'whisper-base', 'vocab.json'],
  ['models', 'Xenova', 'whisper-base', 'merges.txt'],
  ['models', 'Xenova', 'whisper-base', 'onnx', 'encoder_model_quantized.onnx'],
  ['models', 'Xenova', 'whisper-base', 'onnx', 'decoder_model_merged_quantized.onnx']
]

/**
 * True only when every bundled ASR file exists AND is non-empty under `base` (resourcesPath in packaged
 * builds, <repo>/resources in dev). A missing or zero-byte file (interrupted fetch-models run, incomplete
 * installer, cloud-placeholder weirdness) → false, so the worker uses the proven remote path instead of
 * bricking transcription mid-meeting.
 */
export function asrManifestComplete(base: string): boolean {
  for (const parts of ASR_REQUIRED_FILES) {
    try {
      if (statSync(join(base, ...parts)).size <= 0) return false
    } catch {
      return false
    }
  }
  return true
}
