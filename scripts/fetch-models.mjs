/**
 * fetch-models.mjs — populate resources/ with bundled ASR model weights.
 *
 * Run once before packaging: `npm run fetch-models`
 * Wired as predist / prepack so it runs automatically before electron-builder.
 * Script is idempotent: files already present are skipped (size > 0 check).
 *
 * What it downloads / copies:
 *   1. Xenova/whisper-base         → resources/models/Xenova/whisper-base/
 *   2. onnx-community/whisper-large-v3-turbo → optional WebGPU benchmark asset (only when
 *      ASKTOTO_INCLUDE_WEBGPU_ASR=1; excluded from standard installers to keep them releasable)
 *   3. Parakeet TDT 0.6b v3 int8  → resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/
 *   4. ONNX-runtime WASM blobs    → resources/ort/   (copied from node_modules, no network needed)
 *
 * Standard download: ~700 MB (one-time; subsequent runs skip existing files).
 */

import { createWriteStream, existsSync, mkdirSync, statSync, copyFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { get as httpsGet } from 'node:https'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { extractTarBz2Windows } from './tar-bz2-extract.mjs'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const RES = join(REPO_ROOT, 'resources')
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RESPONSE_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_BASE_MS = 1_000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

/** True if file exists and has non-zero size. */
function filePresent(p) {
  return existsSync(p) && statSync(p).size > 0
}

/** HTTPS GET with redirect following. Returns a Node IncomingMessage stream.
 *  The deadline includes DNS, TCP/TLS setup, and response headers. */
export function fetchStream(
  url,
  { requestGet = httpsGet, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}
) {
  return new Promise((resolve, reject) => {
    let timeout
    const req = requestGet(url, (res) => {
      clearTimeout(timeout)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        // HuggingFace returns RELATIVE Location headers for small config/tokenizer files (LFS weights
        // redirect to absolute CDN URLs). Resolve against the request URL so https.get gets an absolute
        // URL instead of throwing "Invalid URL" on a bare path.
        const next = new URL(res.headers.location, url).toString()
        fetchStream(next, { requestGet, requestTimeoutMs }).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      resolve(res)
    })
    timeout = setTimeout(() => {
      req.destroy(new Error(`request timeout after ${requestTimeoutMs}ms for ${url}`))
    }, requestTimeoutMs)
    req.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

/** Download url → dest, skipping if already present. Shows progress.
 *  When optional=true, any download error is logged and swallowed so the
 *  build continues. Required files (default) still fail loudly. */
export async function download(
  url,
  dest,
  {
    optional = false,
    requestGet = httpsGet,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    responseIdleTimeoutMs = DEFAULT_RESPONSE_IDLE_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS
  } = {}
) {
  if (filePresent(dest)) {
    console.log(`  [skip] ${dest.replace(REPO_ROOT, '.')}`)
    return
  }
  ensureDir(dirname(dest))
  console.log(`  [fetch] ${url}`)
  const part = dest + '.part'
  let lastErr
  // Retry with backoff: a single transient blip (DNS, HF rate-limit, connection reset) across ~15 files /
  // ~1.3 GB otherwise fails the whole predist / CI step and forces a full manual rerun. A client error
  // (404: the file just isn't in this repo) never changes on retry, so it breaks out immediately, which
  // matters for the optional-file probes.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchStream(url, { requestGet, requestTimeoutMs })
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      let lastPct = -1
      const out = createWriteStream(part)
      res.setTimeout(responseIdleTimeoutMs, () => {
        res.destroy(new Error(`response idle timeout after ${responseIdleTimeoutMs}ms for ${url}`))
      })
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
      await pipeline(res, out)
      // res.socket can already be null here (Node releases/detaches the socket once the
      // response has fully ended), and IncomingMessage#setTimeout dereferences it unguarded.
      if (res.socket) res.setTimeout(0)
      process.stdout.write('\n')
      // Integrity: a truncated download (connection dropped mid-stream) would otherwise rename a partial
      // file into place and read back later as a corrupt model. Verify the byte count against Content-Length.
      const size = statSync(part).size
      if (total && size !== total) throw new Error(`incomplete download: got ${size} of ${total} bytes`)
      renameSync(part, dest)
      return
    } catch (err) {
      lastErr = err
      try { unlinkSync(part) } catch { /* .part may not exist */ }
      const clientErr = /HTTP 4\d\d/.test(err.message || '')
      if (attempt < maxAttempts && !clientErr) {
        const backoffMs = backoffBaseMs * 2 ** (attempt - 1)
        console.log(`  [retry ${attempt}/${maxAttempts - 1}] ${err.message}; waiting ${backoffMs}ms`)
        await new Promise((r) => setTimeout(r, backoffMs))
      } else break
    }
  }
  if (optional) {
    console.log(`  [skip-optional] ${dest.replace(REPO_ROOT, '.')} (${lastErr && lastErr.message})`)
    return
  }
  throw lastErr
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

/** Extract a .tar.bz2 archive into destDir, cross-platform.
 *
 *  macOS/Linux: shell out to the system `tar`, unchanged.
 *
 *  Windows: NEVER shells out to tar at all. Spawning an external `tar xjf` is unreliable there in two
 *  distinct, machine-dependent ways — GNU tar (only reachable from a Git-Bash-flavored PATH) misparses
 *  an absolute `C:\...` path as `[user@]host:path` remote-tape syntax, while bsdtar (System32's tar.exe,
 *  the ONLY `tar` reachable from a plain terminal — i.e. what a fresh machine resolves by default) has
 *  no bzip2 codec linked in and shells out to an external bzip2.exe filter subprocess that can deadlock
 *  under Node's child_process on Windows pipe/handle inheritance. Both failure modes were reproduced by
 *  hand during development (see scripts/tar-bz2-extract.mjs's module docstring for the full writeup);
 *  the second one hangs forever with zero bytes written on anything past a trivially small archive,
 *  which is exactly what blocked this script on Windows. extractTarBz2Windows decompresses bzip2 and
 *  unpacks the ustar container entirely in-process instead, using only Node builtins. */
async function extractTarBz2(archive, destDir) {
  if (process.platform === 'win32') {
    extractTarBz2Windows(archive, destDir)
    return
  }
  await execFileAsync('tar', ['xjf', archive, '-C', destDir])
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
  const archive = join(destDir, `${MODEL_NAME}.tar.bz2`)
  if (requiredFiles.every(filePresent)) {
    // Sweep a stranded archive on the skip path too, not just after a fresh extract below. The download
    // and the unlink are separate steps, so any run that extracted but did not reach the unlink — a crash,
    // a Ctrl-C, or the hand-extraction workaround docs/WINDOWS.md used to prescribe — leaves 464 MB behind
    // that every later run skips straight past. It is not inert: resources/asr ships in the package, so the
    // leftover both bloats the installer and hard-fails check-packaged-runtime.mjs's exact-inventory gate
    // with "asr runtime inventory mismatch / Unexpected: <archive>".
    if (filePresent(archive)) {
      try {
        unlinkSync(archive)
        console.log('  [clean] removed a stale parakeet archive left by an earlier run')
      } catch { /* best effort — a locked file must not fail provisioning */ }
    }
    console.log('  [skip] all parakeet model files present')
    return
  }
  ensureDir(destDir)
  await download(MODEL_URL, archive)
  console.log(`  [extract] ${process.platform === 'win32' ? 'in-process bzip2+tar (win32)' : 'tar xjf'} ...`)
  await extractTarBz2(archive, destDir)
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
  if (process.env.ASKTOTO_INCLUDE_WEBGPU_ASR === '1') await fetchWhisperLargeV3Turbo()
  else console.log('\n[2/4] WebGPU Whisper large-v3-turbo — skipped (set ASKTOTO_INCLUDE_WEBGPU_ASR=1 to fetch)')
  await fetchParakeet()
  await copyOrtWasm()

  // Required no-network integrity gate. Content-Length/non-empty checks above catch interrupted fetches;
  // this reviewed manifest also catches upstream drift or a same-size substitution before packaging.
  await import('./check-runtime-assets.mjs')

  console.log('\n=== fetch-models complete ===')
  console.log('Run `npm run dist` (or `npm run dist:win`) to package with bundled models.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nfetch-models FAILED:', err.message)
    process.exit(1)
  })
}
