#!/usr/bin/env node
/**
 * fetch-llama-server.mjs — provision the PINNED llama.cpp `llama-server` sidecar runtime that powers
 * Métis Local (on-device suggest/summary/vision). Mirrors fetch-models.mjs: idempotent, retry-with-
 * backoff download, verify-before-use.
 *
 * Run once before packaging: `node scripts/fetch-llama-server.mjs mac|win|all`
 * Wired as predist / predist:win / dist:local / dist:win:appx / release / release:win / release:mas /
 * release:win:store (see package.json) so it runs automatically before electron-builder.
 *
 * What it does, per target:
 *   mac       llama-b9957-bin-macos-arm64.tar.gz  -> resources/llama/mac/        (llama-server + *.dylib)
 *   win (cpu) llama-b9957-bin-win-cpu-x64.zip     -> resources/llama/win/cpu/    (llama-server.exe + *.dll)
 *   win (gpu) llama-b9957-bin-win-vulkan-x64.zip  -> resources/llama/win/vulkan/ (llama-server.exe + *.dll)
 * `win` fetches BOTH win assets: local-runtime.ts prefers the Vulkan (GPU) build at spawn time and falls
 * back to the CPU build once if Vulkan fails to start, so both must be present in a Windows package.
 *
 * The archive is retained under ignored resources/llama/.cache, and its hardcoded sha256 is verified
 * BEFORE extraction on every run. Every packaging run re-extracts from that verified archive; a mutable
 * marker or stale warm extraction is never trusted. A `.sha256` provenance marker is still included in
 * each destination, but it is evidence only and never an input to the trust decision.
 */

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  chmodSync,
  copyFileSync,
  writeFileSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { get as httpsGet } from 'node:https'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractZip } from './zip-extract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const LLAMA_DIR = join(REPO_ROOT, 'resources', 'llama')
const ARCHIVE_CACHE_DIR = join(LLAMA_DIR, '.cache')
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RESPONSE_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_BASE_MS = 1_000

// Invoke Windows system tools by ABSOLUTE %SystemRoot%\System32 path, never bare name — same invariant
// src/main/win-security.ts holds for powershell/icacls. Node resolves a bare name through PATH only
// (libuv does not fall back to System32), so `tar` means System32's bsdtar on a plain terminal but GNU
// tar 1.35 under any Git-for-Windows PATH — and GNU tar reads the leading `D:` of an absolute archive
// path as a remote host ("tar: Cannot connect to D: resolve failed"). Whether packaging worked was
// decided by the operator's PATH order.
const WINDOWS_SYSTEM_TAR = join(
  process.env.SystemRoot || process.env.windir || 'C:\\Windows',
  'System32',
  'tar.exe'
)

// ─── Pins (llama.cpp release b9957 — verified 2026-07-10, PLAN.md §3) ─────────────────────────────────
const TAG = 'b9957'
const BASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/`

const ASSETS = {
  mac: {
    file: 'llama-b9957-bin-macos-arm64.tar.gz',
    sha256: '7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f',
    dest: join(LLAMA_DIR, 'mac'),
    binary: 'llama-server',
    keepExt: '.dylib'
  },
  'win-cpu': {
    file: 'llama-b9957-bin-win-cpu-x64.zip',
    sha256: '422ad9b46f5ab60f7fd2e83783233eba2d9383e6f17d7ee916c80f19eb070e79',
    dest: join(LLAMA_DIR, 'win', 'cpu'),
    binary: 'llama-server.exe',
    keepExt: '.dll'
  },
  'win-vulkan': {
    file: 'llama-b9957-bin-win-vulkan-x64.zip',
    sha256: 'fcc0a8c0f0f3140122452ed2728cebb520c5fbc4fc921836ee3a45dd77e18c68',
    dest: join(LLAMA_DIR, 'win', 'vulkan'),
    binary: 'llama-server.exe',
    keepExt: '.dll'
  }
}

function assetKeysFor(target) {
  if (target === 'mac') return ['mac']
  if (target === 'win') return ['win-cpu', 'win-vulkan']
  return ['mac', 'win-cpu', 'win-vulkan']
}

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────────

/** HTTPS GET with redirect following (GitHub release assets 302 to objects.githubusercontent.com).
 * The timer covers DNS, TCP/TLS setup, and response headers so a dead route cannot hang packaging. */
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

/** Download url -> dest with retry+backoff on transient failures (mirrors fetch-models.mjs). A 4xx
 *  (bad pin/URL) never changes on retry, so it breaks out immediately instead of burning the budget.
 *  Skips outright when a non-empty archive already sits at `dest` (fetch-models.mjs's `filePresent`
 *  idiom) — the sha256 check right after this call in provision() is what actually gates trust, so a
 *  leftover archive from an interrupted prior run (e.g. one that failed during extraction, after the
 *  download itself succeeded) is reused instead of re-fetched. */
export async function download(
  url,
  dest,
  {
    requestGet = httpsGet,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    responseIdleTimeoutMs = DEFAULT_RESPONSE_IDLE_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS
  } = {}
) {
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`  [skip-fetch] ${dest.replace(REPO_ROOT, '.')} already on disk`)
    return
  }
  if (existsSync(dest)) unlinkSync(dest)
  console.log(`  [fetch] ${url}`)
  const part = dest + '.part'
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchStream(url, { requestGet, requestTimeoutMs })
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      let lastPct = -1
      const out = createWriteStream(part)
      res.setTimeout(responseIdleTimeoutMs, () => {
        res.destroy(
          new Error(`response idle timeout after ${responseIdleTimeoutMs}ms for ${url}`)
        )
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
      // IncomingMessage.setTimeout delegates to the underlying socket. After a normal response
      // finishes Node may detach that socket, so calling it here can throw while the archive is
      // already complete. The idle timer is only needed while the body is flowing; once pipeline
      // resolves the stream has ended and no timer needs clearing.
      process.stdout.write('\n')
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
  throw lastErr
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Locate the directory (searching down from root) that directly contains `filename` — the mac tarball
 *  nests everything one level deep (llama-b9957/), the win zips are flat, and hardcoding either layout
 *  would silently extract nothing the day upstream changes it. */
function findDirContaining(root, filename, depth = 3) {
  if (existsSync(join(root, filename))) return root
  if (depth <= 0) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findDirContaining(join(root, entry.name), filename, depth - 1)
      if (found) return found
    }
  }
  return null
}

/** Unpack archivePath (tar.gz OR zip) into destDir without ever resolving an extraction tool through
 *  PATH on Windows: the win assets are .zip and are inflated in-process (zip-extract.mjs — no subprocess
 *  at all), and the mac .tar.gz, only reachable from a Windows host via the `all` target, goes to the
 *  absolute System32 bsdtar, which has zlib linked in and needs no external filter process.
 *  macOS/Linux keep the system `tar`, which auto-detects both containers from an -xf invocation. */
export function extractArchive(archivePath, destDir) {
  if (process.platform !== 'win32') {
    execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' })
    return
  }
  if (archivePath.toLowerCase().endsWith('.zip')) {
    extractZip(archivePath, destDir)
    return
  }
  execFileSync(WINDOWS_SYSTEM_TAR, ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' })
}

/** Extract archivePath and copy only the runtime binary plus its shared libraries into destDir.
 *  Everything else in the release (llama-cli, llama-bench, the other example binaries) is intentionally
 *  discarded — Métis only ever spawns llama-server. */
function extractRuntime(archivePath, destDir, binaryName, keepExt) {
  const tmpDir = `${destDir}.extract-tmp`
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  extractArchive(archivePath, tmpDir)
  const sourceDir = findDirContaining(tmpDir, binaryName)
  if (!sourceDir) throw new Error(`${binaryName} not found anywhere under the extracted archive ${archivePath}.`)
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  for (const f of readdirSync(sourceDir)) {
    if (f === binaryName || f.endsWith(keepExt)) copyFileSync(join(sourceDir, f), join(destDir, f))
  }
  rmSync(tmpDir, { recursive: true, force: true })
  chmodSync(join(destDir, binaryName), 0o755)
}

async function provision(key, asset) {
  console.log(`\n[${key}] ${asset.file} -> ${asset.dest.replace(REPO_ROOT, '.')}`)
  const archivePath = join(ARCHIVE_CACHE_DIR, asset.file)
  await download(BASE_URL + asset.file, archivePath)

  // Verify the immutable pin on EVERY run, including a warm cache hit. Extracted files and marker text
  // are deliberately not trusted because either can be corrupted without changing the other.
  const actual = sha256Of(archivePath)
  if (actual !== asset.sha256) {
    unlinkSync(archivePath)
    throw new Error(`${asset.file} sha256 mismatch: expected ${asset.sha256}, got ${actual}. Deleted; re-run to retry.`)
  }

  extractRuntime(archivePath, asset.dest, asset.binary, asset.keepExt)

  if (!existsSync(join(asset.dest, asset.binary))) {
    throw new Error(`${asset.binary} missing from ${asset.dest} after extraction — check the archive contents.`)
  }
  writeFileSync(join(asset.dest, '.sha256'), asset.sha256 + '\n')
  console.log(`  [ok] provisioned (${asset.sha256.slice(0, 12)}…)`)
}

// ─── Main ───────────────────────────────────────────────────────────────────────────────────────────
const VALID = new Set(['mac', 'win', 'all'])
// No arg: auto-detect the current platform (mirrors check-ffmpeg-sidecar.mjs / check-sherpa-platform.mjs's
// `process.argv[2] || process.platform` fallback) so the bare `npm run fetch:llama` convenience script works.
const target = process.argv[2] || (process.platform === 'win32' ? 'win' : 'mac')
if (!VALID.has(target)) {
  console.error('Usage: node scripts/fetch-llama-server.mjs mac|win|all')
  process.exit(2)
}

async function main() {
  console.log(`=== fetch-llama-server: provisioning resources/llama/ for target "${target}" (tag ${TAG}) ===`)
  mkdirSync(LLAMA_DIR, { recursive: true })
  for (const key of assetKeysFor(target)) {
    await provision(key, ASSETS[key])
  }
  console.log('\n=== fetch-llama-server complete ===')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nfetch-llama-server FAILED:', err.message)
    process.exit(1)
  })
}
