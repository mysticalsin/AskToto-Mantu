#!/usr/bin/env node
/**
 * Fast gate for `npm run dev`: skip fetch-models when Parakeet + Whisper floor are already on disk.
 * Otherwise run fetch-models.mjs so a fresh checkout becomes a runnable Métis.
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'

export const REQUIRED_ASR_ASSETS = [
  join(ROOT, 'resources', 'asr', MODEL, 'encoder.int8.onnx'),
  join(ROOT, 'resources', 'asr', MODEL, 'decoder.int8.onnx'),
  join(ROOT, 'resources', 'asr', MODEL, 'joiner.int8.onnx'),
  join(ROOT, 'resources', 'asr', MODEL, 'tokens.txt'),
  join(ROOT, 'resources', 'models', 'Xenova', 'whisper-base', 'onnx', 'encoder_model_quantized.onnx'),
  join(ROOT, 'resources', 'models', 'Xenova', 'whisper-base', 'onnx', 'decoder_model_merged_quantized.onnx')
]

export function asrAssetsPresent(paths = REQUIRED_ASR_ASSETS) {
  return paths.every((p) => {
    try {
      return existsSync(p) && statSync(p).size > 0
    } catch {
      return false
    }
  })
}

export function missingAsrAssets(paths = REQUIRED_ASR_ASSETS) {
  return paths.filter((p) => {
    try {
      return !(existsSync(p) && statSync(p).size > 0)
    } catch {
      return true
    }
  })
}

async function main() {
  if (asrAssetsPresent()) {
    console.log('[ensure-asr] Parakeet and Whisper floor are present')
    return
  }
  const missing = missingAsrAssets()
  console.log(`[ensure-asr] ${missing.length} required ASR file(s) missing — running fetch-models`)
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'fetch-models.mjs')], {
      cwd: ROOT,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`fetch-models exited ${code}`))
    })
  })
  if (!asrAssetsPresent()) {
    const still = missingAsrAssets()
    throw new Error(
      `Required ASR assets missing after fetch:\n${still.map((p) => `  ${p}`).join('\n')}`
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nensure-asr FAILED:', err.message)
    process.exit(1)
  })
}
