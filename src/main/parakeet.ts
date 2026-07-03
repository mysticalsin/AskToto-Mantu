/**
 * Parakeet v3 ASR engine (NVIDIA NeMo TDT, 25 European languages, auto-detect) running on-device in the
 * MAIN process via the sherpa-onnx-node native addon (N-API — loads in Electron without a rebuild). It is
 * the opt-in "fastest, European" alternative to the default Whisper engine; if anything here is missing or
 * fails, the renderer silently falls back to Whisper, so this can never break live transcription.
 *
 * The model (~487 MB int8) ships BUNDLED in the app's resources (resources/asr, populated by
 * `npm run fetch-models` before packaging) and loads straight from disk with zero network use — see
 * modelDir() below, which always prefers the bundled copy. Only if that copy is absent (e.g. a dev build
 * that skipped fetch-models) does it fall back to a one-time download to userData, after which it is
 * fully offline. A correctly packaged build never downloads at use-time.
 */
import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { get as httpsGet } from 'node:https'
import { execFile } from 'node:child_process'
import { mainLog } from './logger'

const MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`
const SAMPLE_RATE = 16000

function asrDir(): string {
  return join(app.getPath('userData'), 'asr')
}

/**
 * Return the model directory, preferring the bundled copy shipped inside the app's resources.
 * In packaged builds, resources/asr/<MODEL_NAME> is extracted by electron-builder extraResources.
 * In dev, resources/asr/<MODEL_NAME> lives at the repo root (populated by `npm run fetch-models`).
 * If none of the four required files are found in the bundled location, fall back to the userData
 * download directory so the existing download path stays intact as a last resort.
 */
function modelDir(): string {
  const REPO_ROOT = join(__dirname, '..', '..')
  const bundledBase = app.isPackaged ? process.resourcesPath : join(REPO_ROOT, 'resources')
  const bundledDir = join(bundledBase, 'asr', MODEL_NAME)
  const bundledFiles = [
    join(bundledDir, 'encoder.int8.onnx'),
    join(bundledDir, 'decoder.int8.onnx'),
    join(bundledDir, 'joiner.int8.onnx'),
    join(bundledDir, 'tokens.txt')
  ]
  if (bundledFiles.every(existsSync)) {
    return bundledDir
  }
  // Bundled copy absent — fall back to the userData download location.
  return join(asrDir(), MODEL_NAME)
}
function modelFiles(): { encoder: string; decoder: string; joiner: string; tokens: string } {
  const d = modelDir()
  return {
    encoder: join(d, 'encoder.int8.onnx'),
    decoder: join(d, 'decoder.int8.onnx'),
    joiner: join(d, 'joiner.int8.onnx'),
    tokens: join(d, 'tokens.txt')
  }
}

/** True when all model files are present on disk (engine can be constructed without a download). */
export function parakeetModelReady(): boolean {
  const f = modelFiles()
  return existsSync(f.encoder) && existsSync(f.decoder) && existsSync(f.joiner) && existsSync(f.tokens)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let recognizer: any = null
let downloading = false

/** Lazily load sherpa-onnx-node; returns null (→ Whisper fallback) if the native addon can't load. */
function loadSherpa(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('sherpa-onnx-node')
  } catch (e) {
    mainLog.error('[parakeet] sherpa-onnx-node failed to load:', (e as Error)?.message)
    return null
  }
}

/** Download + extract the Parakeet model once. Reports 0-100 progress. Throws on failure (caller falls back). */
export async function ensureParakeetModel(onProgress?: (pct: number) => void): Promise<void> {
  if (parakeetModelReady()) return
  if (downloading) throw new Error('model download already in progress')
  downloading = true
  const dir = asrDir()
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, `${MODEL_NAME}.tar.bz2`)
  try {
    await download(MODEL_URL, archive, onProgress)
    await extractTarBz2(archive, dir)
    try {
      rmSync(archive, { force: true })
    } catch {
      /* keep the archive if cleanup fails */
    }
    if (!parakeetModelReady()) throw new Error('model files missing after extraction')
  } finally {
    downloading = false
  }
}

function download(url: string, dest: string, onProgress?: (pct: number) => void, depth = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (depth > 5) {
      reject(new Error('too many redirects'))
      return
    }
    const req = httpsGet(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        download(res.headers.location, dest, onProgress, depth + 1).then(resolve, reject) // follow GitHub redirect
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`download failed: HTTP ${res.statusCode}`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      let lastPct = -1
      const out = createWriteStream(dest)
      res.on('data', (c) => {
        got += c.length
        if (total && onProgress) {
          const pct = Math.round((got / total) * 100)
          if (pct !== lastPct) {
            lastPct = pct
            onProgress(pct)
          }
        }
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve()))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.setTimeout(30000, () => req.destroy(new Error('model download timed out')))
    req.on('error', reject)
  })
}

function extractTarBz2(archive: string, dir: string): Promise<void> {
  // `tar` ships on macOS, Linux, and Windows 10+ and handles .tar.bz2 with -xjf.
  // bsdtar (macOS) does not support --no-absolute-paths; both bsdtar and GNU tar already
  // strip leading '/' from archive member names by default, so omitting it is safe.
  return new Promise((resolve, reject) => {
    execFile('tar', ['xjf', archive, '-C', dir], (err) => (err ? reject(err) : resolve()))
  })
}

/** Construct (once) the offline recognizer for the Parakeet transducer model. */
function getRecognizer(): any | null {
  if (recognizer) return recognizer
  if (!parakeetModelReady()) return null
  const sherpa = loadSherpa()
  if (!sherpa) return null
  const f = modelFiles()
  try {
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
        tokens: f.tokens,
        numThreads: 2,
        provider: 'cpu',
        modelType: 'nemo_transducer',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    })
    return recognizer
  } catch (e) {
    mainLog.error('[parakeet] recognizer construction failed:', (e as Error)?.message)
    return null
  }
}

/**
 * Transcribe one mono 16kHz Float32 PCM window → text.
 * THROWS if the engine is unavailable or decoding fails, so the renderer can tell a real failure apart from
 * silence and fall back to Whisper (an empty string here means genuine no-speech, NOT a failure).
 */
export async function parakeetTranscribe(samples: Float32Array): Promise<string> {
  const rec = getRecognizer()
  if (!rec) throw new Error('parakeet recognizer unavailable')
  try {
    const stream = rec.createStream()
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
    await rec.decodeAsync(stream)
    const r = rec.getResult(stream)
    return (r?.text || '').trim() // '' = genuine silence/no speech
  } catch (e) {
    mainLog.error('[parakeet] transcribe failed:', (e as Error)?.message)
    throw e instanceof Error ? e : new Error(String(e)) // surface to renderer → Whisper fallback
  }
}

/** Free the recognizer (between meetings / on idle) to release memory. */
export function parakeetRelease(): void {
  try {
    recognizer?.free?.()
  } catch {
    /* best-effort */
  }
  recognizer = null
}
