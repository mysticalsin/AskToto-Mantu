/**
 * fetch-models.mjs — populate resources/ with bundled ASR model weights.
 *
 * Run once before packaging: `npm run fetch-models`
 * Wired as predist / prepack so it runs automatically before electron-builder.
 * Script is idempotent: files already present are skipped (size > 0 check).
 *
 * What it downloads / copies:
 *   1. Xenova/whisper-base         → resources/models/Xenova/whisper-base/
 *   2. onnx-community/whisper-large-v3-turbo → resources/models/onnx-community/whisper-large-v3-turbo/
 *   3. Parakeet TDT 0.6b v3 int8  → resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/
 *   4. ONNX-runtime WASM blobs    → resources/ort/   (copied from node_modules, no network needed)
 *
 * Total download: ~1.3 GB (one-time; subsequent runs skip existing files).
 */

import { createWriteStream, existsSync, mkdirSync, statSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { get as httpsGet } from 'node:https'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const RES = join(REPO_ROOT, 'resources')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

/** True if file exists and has non-zero size. */
function filePresent(p) {
  return existsSync(p) && statSync(p).size > 0
}

/** HTTPS GET with redirect following. Returns a Node IncomingMessage stream. */
function fetchStream(url) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        fetchStream(res.headers.location).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      resolve(res)
    })
    req.on('error', reject)
  })
}

/** Download url → dest, skipping if already present. Shows progress.
 *  When optional=true, any download error is logged and swallowed so the
 *  build continues. Required files (default) still fail loudly. */
async function download(url, dest, { optional = false } = {}) {
  if (filePresent(dest)) {
    console.log(`  [skip] ${dest.replace(REPO_ROOT, '.')}`)
    return
  }
  ensureDir(dirname(dest))
  console.log(`  [fetch] ${url}`)
  let res
  try {
    res = await fetchStream(url)
  } catch (err) {
    if (optional) {
      console.log(`  [skip-optional] ${dest.replace(REPO_ROOT, '.')} (not in repo: ${err.message})`)
      return
    }
    throw err
  }
  const total = Number(res.headers['content-length'] || 0)
  let got = 0
  let lastPct = -1
  try {
    await new Promise((resolve, reject) => {
      const out = createWriteStream(dest)
      res.on('data', (chunk) => {
        got += chunk.length
        if (total) {
          const pct = Math.round((got / total) * 100)
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct
            process.stdout.write(`\r    ${pct}%  (${(got / 1024 / 1024).toFixed(1)} MB)`)
          }
        }
      })
      res.pipe(out)
      out.on('finish', () => { process.stdout.write('\n'); out.close(resolve) })
      out.on('error', reject)
      res.on('error', reject)
    })
  } catch (err) {
    if (optional) {
      console.log(`  [skip-optional] ${dest.replace(REPO_ROOT, '.')} (download error: ${err.message})`)
      return
    }
    throw err
  }
}

/** Build a HuggingFace resolve URL for a given repo + file (main revision). */
function hfUrl(repo, file) {
  return `https://huggingface.co/${repo}/resolve/main/${file}`
}

/** Download a set of HF files into a local directory.
 *  requiredFiles: fail the build if any of these are missing (404 or network error).
 *  optionalFiles: log and skip on any error — these files may not exist in every repo. */
async function downloadHfFiles(repo, requiredFiles, optionalFiles, destDir) {
  ensureDir(destDir)
  for (const file of requiredFiles) {
    await download(hfUrl(repo, file), join(destDir, file), { optional: false })
  }
  for (const file of optionalFiles) {
    await download(hfUrl(repo, file), join(destDir, file), { optional: true })
  }
}

// ─── 1. Xenova/whisper-base (WASM fallback, q8 quantized) ────────────────────
async function fetchWhisperBase() {
  console.log('\n[1/4] Xenova/whisper-base (WASM fallback, q8)')
  const repo = 'Xenova/whisper-base'
  const dest = join(RES, 'models', 'Xenova', 'whisper-base')
  // Required: ONNX model files + core config/tokenizer/preprocessor
  const requiredFiles = [
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
    'config.json',
    'generation_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'preprocessor_config.json'
  ]
  // Optional: may be folded into tokenizer.json in some repo variants
  const optionalFiles = [
    'vocab.json',
    'merges.txt',
    'normalizer.json',
    'special_tokens_map.json'
  ]
  await downloadHfFiles(repo, requiredFiles, optionalFiles, dest)
}

// ─── 2. onnx-community/whisper-large-v3-turbo (WebGPU, fp16+q4) ──────────────
async function fetchWhisperLargeV3Turbo() {
  console.log('\n[2/4] onnx-community/whisper-large-v3-turbo (WebGPU, fp16+q4)')
  const repo = 'onnx-community/whisper-large-v3-turbo'
  const dest = join(RES, 'models', 'onnx-community', 'whisper-large-v3-turbo')
  // Required: ONNX model files + core config/tokenizer/preprocessor
  const requiredFiles = [
    'onnx/encoder_model_fp16.onnx',
    'onnx/decoder_model_merged_q4.onnx',
    'config.json',
    'generation_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'preprocessor_config.json'
  ]
  // Optional: this repo folds these into tokenizer.json — 404s are non-fatal
  const optionalFiles = [
    'vocab.json',
    'merges.txt',
    'normalizer.json',
    'special_tokens_map.json'
  ]
  await downloadHfFiles(repo, requiredFiles, optionalFiles, dest)
}

// ─── 3. Parakeet TDT 0.6b v3 int8 ───────────────────────────────────────────
async function fetchParakeet() {
  console.log('\n[3/4] sherpa-onnx Parakeet TDT 0.6b v3 int8')
  const MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
  const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`
  const destDir = join(RES, 'asr')
  const modelDir = join(destDir, MODEL_NAME)
  const requiredFiles = [
    join(modelDir, 'encoder.int8.onnx'),
    join(modelDir, 'decoder.int8.onnx'),
    join(modelDir, 'joiner.int8.onnx'),
    join(modelDir, 'tokens.txt')
  ]
  if (requiredFiles.every(filePresent)) {
    console.log('  [skip] all parakeet model files present')
    return
  }
  ensureDir(destDir)
  const archive = join(destDir, `${MODEL_NAME}.tar.bz2`)
  await download(MODEL_URL, archive)
  console.log('  [extract] tar xjf ...')
  await execFileAsync('tar', ['xjf', archive, '-C', destDir])
  // Clean up archive
  try { unlinkSync(archive) } catch { /* ignore */ }
  if (!requiredFiles.every(filePresent)) {
    throw new Error('Parakeet model files missing after extraction — check the archive.')
  }
  console.log('  [ok] parakeet model extracted')
}

// ─── 4. ONNX-runtime WASM blobs (copy from node_modules — no network) ────────
// transformers.js uses env.backends.onnx.wasm.wasmPaths to locate these files.
// The path is set to 'asr-model://ort/' which maps to resources/ort/.
// transformers.js@3.8.1 + onnxruntime-web 1.22 request ONLY the JSEP build at
// runtime. The JSEP build covers both CPU-WASM and WebGPU kernels — there is no
// separate plain ort-wasm-simd-threaded.wasm request. Shipping the plain variants
// produces misleading "fall back to CDN" warnings without any benefit.
//   - ort-wasm-simd-threaded.jsep.wasm    (JSEP build — CPU-WASM + WebGPU)
//   - ort-wasm-simd-threaded.jsep.mjs     (ES module loader for above)
async function copyOrtWasm() {
  console.log('\n[4/4] ONNX-runtime WASM blobs (from node_modules)')
  const destDir = join(RES, 'ort')
  ensureDir(destDir)

  // Prefer @huggingface/transformers/dist (version-matched to the exact ORT build
  // transformers.js ships with), then onnxruntime-web/dist as fallback.
  const sources = [
    // Transformers-bundled (version-pinned to the exact ORT build transformers.js ships with)
    join(REPO_ROOT, 'node_modules', '@huggingface', 'transformers', 'dist'),
    // onnxruntime-web dist (has both plain + jsep variants)
    join(REPO_ROOT, 'node_modules', 'onnxruntime-web', 'dist')
  ]

  // Only the JSEP files — the only ones transformers.js@3.8.1 requests at runtime
  const files = [
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jsep.mjs'
  ]

  for (const file of files) {
    const dest = join(destDir, file)
    if (filePresent(dest)) {
      console.log(`  [skip] ${file}`)
      continue
    }
    let copied = false
    for (const srcDir of sources) {
      const src = join(srcDir, file)
      if (existsSync(src)) {
        copyFileSync(src, dest)
        console.log(`  [copy] ${file}  (from ${srcDir.replace(REPO_ROOT, '.')})`)
        copied = true
        break
      }
    }
    if (!copied) {
      console.warn(`  [warn] ${file} not found in node_modules — ORT may fall back to CDN for this file`)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== fetch-models: populating resources/ for bundled ASR ===')
  console.log(`Target: ${RES}`)

  await fetchWhisperBase()
  await fetchWhisperLargeV3Turbo()
  await fetchParakeet()
  await copyOrtWasm()

  console.log('\n=== fetch-models complete ===')
  console.log('Run `npm run dist` (or `npm run dist:win`) to package with bundled models.')
}

main().catch((err) => {
  console.error('\nfetch-models FAILED:', err.message)
  process.exit(1)
})
