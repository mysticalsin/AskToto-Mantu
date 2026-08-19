import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { net } from 'electron'
import { auditLog } from '../logger'
import { assertRamOk, getModel, modelPaths, type LocalModelDownloadState, type LocalModelFile } from './local-models'

/**
 * First-run downloader for the Métis Local weights.
 *
 * The weights used to ship inside the installer. They no longer do: at ~728 MB they dominated the
 * download, and a universal (Intel + Apple Silicon) package carrying them would exceed GitHub's 2 GB
 * per-asset release limit. So the app fetches them once, into the writable per-user model directory.
 *
 * This is the ONLY place installed application code reaches the network for model weights, and the
 * integrity rules here are what replace the build-time supply-chain gate that bundling gave us:
 *
 *   - the URL is an immutable upstream revision (commit hash in the path), never a branch;
 *   - Content-Length must equal the pinned byte count BEFORE a single byte is written;
 *   - the finished file must match the pinned SHA-256, or it is deleted rather than kept;
 *   - bytes land in a `.partial` file and are renamed into place only after that check passes, so a
 *     half-written or tampered file can never be mistaken for a usable model by a later run.
 *
 * Transport is Electron's `net.fetch`, NOT `node:https` (MQA-185). node:https consults neither the OS/PAC
 * proxy nor HTTP(S)_PROXY, and `setGlobalDispatcher` in net/install-proxy.ts only rebinds undici's
 * `fetch` — so a node:https request was the single outbound call in the whole main process that could
 * not traverse a corporate proxy. Since this fetch is the ONLY way an installed app can obtain the
 * weights, that made Métis Local permanently unprovisionable on exactly the managed networks
 * install-proxy.ts exists for. net.fetch resolves the proxy per request host, which also covers a PAC
 * that routes huggingface.co differently from the provider host install-proxy.ts probes with.
 *
 * Failure is non-fatal by design. Métis Local is one route among several — a machine that is offline,
 * behind a blocked proxy, or short on disk simply keeps using the cloud/CLI routes, and the next launch
 * retries. Nothing here is allowed to block or crash app startup. It is no longer SILENT, though: the
 * state below is what Settings reads, so an in-flight or failed fetch reads as itself instead of as a
 * damaged install (MQA-186/187).
 */

const REQUEST_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 120_000
const MAX_ATTEMPTS = 3

const IDLE: LocalModelDownloadState = { modelId: null, status: 'idle', progress: 0 }

let inFlight: Promise<boolean> | null = null
let state: LocalModelDownloadState = IDLE

/**
 * What the fetch is doing right now. Read by the localModels:list IPC handler and folded into the summary
 * Settings already polls, so there is no second channel to keep in sync — and nothing new can cross the
 * main→renderer boundary beyond a status word and a fraction.
 */
export function localModelDownloadState(): LocalModelDownloadState {
  return state
}

/**
 * Whether this machine should fetch the ~763 MB of weights at all.
 *
 * Two reasons not to, both of which boot used to ignore — it fetched unconditionally (MQA-186):
 *   - Local AI is switched off. The transfer is then pure waste of the user's bandwidth, and the toggle
 *     is the only "not now" the product offers. Callers MUST re-arm on the OFF→ON edge: this module has
 *     no other trigger, so gating without re-arming would strand the user with no path to the weights.
 *   - The machine is under the model's RAM floor. assertRamOk refuses every load below it, so the bytes
 *     could never be used; listModels() already reported such a machine `insufficient-ram`.
 */
export function shouldFetchWeights(modelId: string, localAiEnabled: boolean): boolean {
  if (!localAiEnabled) return false
  try {
    assertRamOk(modelId)
  } catch {
    return false
  }
  return true
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** True when `path` already exists with the pinned size AND hash. */
async function alreadyValid(path: string, spec: LocalModelFile): Promise<boolean> {
  try {
    if (statSync(path).size !== spec.bytes) return false
  } catch {
    return false
  }
  return (await sha256Of(path)) === spec.sha256
}

async function downloadOne(
  file: 'gguf' | 'mmproj',
  spec: LocalModelFile,
  dest: string,
  onChunk: (bytes: number) => void
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  rmSync(partial, { force: true })

  // One controller carries both deadlines. net.fetch hands back a Response, not a socket, so the idle
  // guard node:https got from res.setTimeout has to be rebuilt here: a proxy that accepts the connection
  // and then stops sending bytes would otherwise hold the transfer open indefinitely.
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number, why: string): void => {
    clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(new Error(why)), ms)
  }
  arm(REQUEST_TIMEOUT_MS, `${file}: request timeout for ${spec.url}`)

  try {
    const res = await net.fetch(spec.url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status} for ${spec.url}`)

    // Reject on the declared length before writing anything: a redirect to a login/error page or a
    // swapped asset is caught here rather than after streaming half a gigabyte to disk.
    const header = res.headers.get('content-length')
    const declared = header === null ? Number.NaN : Number(header)
    if (Number.isFinite(declared) && declared !== spec.bytes) {
      throw new Error(`${file}: server declared ${declared} bytes, expected ${spec.bytes}`)
    }
    if (!res.body) throw new Error(`${file}: response carried no body`)

    // `getReader()` rather than async iteration: it is the one traversal API every ReadableStream
    // implementation exposes, and it is what cli-installer.ts's download already uses.
    const reader = res.body.getReader()
    arm(IDLE_TIMEOUT_MS, `${file}: stalled mid-download`)
    await pipeline(
      (async function* () {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          if (!value) continue
          arm(IDLE_TIMEOUT_MS, `${file}: stalled mid-download`)
          onChunk(value.byteLength)
          yield value
        }
      })(),
      createWriteStream(partial)
    )

    const size = statSync(partial).size
    if (size !== spec.bytes) throw new Error(`${file}: got ${size} bytes, expected ${spec.bytes}`)
    const digest = await sha256Of(partial)
    if (digest !== spec.sha256) {
      throw new Error(`${file}: sha256 ${digest.slice(0, 12)}… does not match the pinned ${spec.sha256.slice(0, 12)}…`)
    }
    // Only now is the file allowed to exist under its real name.
    renameSync(partial, dest)
  } catch (err) {
    ctrl.abort()
    rmSync(partial, { force: true })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ensure both weight files are present and valid, downloading them if not.
 * Resolves true when the model is ready. Never throws — callers treat false as "Local unavailable".
 * Concurrent callers share one download rather than racing for the same files.
 */
export function ensureLocalModel(modelId: string): Promise<boolean> {
  if (inFlight) return inFlight
  inFlight = run(modelId).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(modelId: string): Promise<boolean> {
  let entry
  try {
    entry = getModel(modelId)
  } catch {
    return false
  }
  const paths = modelPaths(modelId)
  const files = [
    { key: 'gguf' as const, spec: entry.gguf, dest: paths.gguf },
    { key: 'mmproj' as const, spec: entry.mmproj, dest: paths.mmproj }
  ]

  const totalBytes = files.reduce((sum, f) => sum + f.spec.bytes, 0)
  let received = 0
  const publish = (status: LocalModelDownloadState['status']): void => {
    state = { modelId, status, progress: totalBytes ? Math.min(1, received / totalBytes) : 0 }
  }

  const missing = []
  for (const f of files) {
    if (await alreadyValid(f.dest, f.spec)) received += f.spec.bytes
    else missing.push(f)
  }
  if (!missing.length) {
    state = IDLE
    return true
  }

  publish('downloading')
  auditLog('local.model.download_start', { modelId, files: missing.map((f) => f.key) })

  for (const f of missing) {
    // A stale file that failed verification must go before we refetch, so a crash between the two
    // never leaves a bad file sitting where a later run would trust its presence.
    rmSync(f.dest, { force: true })
    const base = received
    let lastErr: unknown
    let ok = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
      try {
        received = base
        await downloadOne(f.key, f.spec, f.dest, (n) => {
          received += n
          publish('downloading')
        })
        ok = true
      } catch (err) {
        lastErr = err
        received = base
        publish('downloading')
      }
    }
    if (!ok) {
      auditLog('local.model.download_fail', {
        modelId,
        file: f.key,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr)
      })
      // Held at 'failed' rather than reset, because this is what Settings now reads: the card says the
      // fetch could not complete and names what has to be reachable, instead of the old "the bundled
      // model files are missing or incomplete — reinstall Métis", which no installer can satisfy
      // (MQA-187/191).
      publish('failed')
      return false
    }
  }

  auditLog('local.model.download_ok', { modelId })
  state = IDLE
  return true
}
