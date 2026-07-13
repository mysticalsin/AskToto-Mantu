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
 * The archive's sha256 is verified BEFORE extraction — a mismatch deletes the download and throws. A
 * `.sha256` sentinel is written into each destination on success so a re-run skips already-provisioned,
 * still-matching-the-current-pin targets without re-downloading (mirrors fetch-models.mjs's `filePresent`
 * idempotency, but keyed on the verified archive hash rather than file presence alone — that also makes
 * a pin bump in this script self-invalidate any stale extraction from a prior tag).
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
import { get as httpsGet } from 'node:https'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const LLAMA_DIR = join(REPO_ROOT, 'resources', 'llama')

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

/** HTTPS GET with redirect following (GitHub release assets 302 to objects.githubusercontent.com). */
function fetchStream(url) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        fetchStream(next).then(resolve, reject)
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

/** Download url -> dest with retry+backoff on transient failures (mirrors fetch-models.mjs). A 4xx
 *  (bad pin/URL) never changes on retry, so it breaks out immediately instead of burning the budget.
 *  Skips outright when a non-empty archive already sits at `dest` (fetch-models.mjs's `filePresent`
 *  idiom) — the sha256 check right after this call in provision() is what actually gates trust, so a
 *  leftover archive from an interrupted prior run (e.g. one that failed during extraction, after the
 *  download itself succeeded) is reused instead of re-fetched. */
async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`  [skip-fetch] ${dest.replace(REPO_ROOT, '.')} already on disk`)
    return
  }
  console.log(`  [fetch] ${url}`)
  const part = dest + '.part'
  const MAX_ATTEMPTS = 3
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchStream(url)
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      let lastPct = -1
      await new Promise((resolve, reject) => {
        const out = createWriteStream(part)
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
      const size = statSync(part).size
      if (total && size !== total) throw new Error(`incomplete download: got ${size} of ${total} bytes`)
      renameSync(part, dest)
      return
    } catch (err) {
      lastErr = err
      try { unlinkSync(part) } catch { /* .part may not exist */ }
      const clientErr = /HTTP 4\d\d/.test(err.message || '')
      if (attempt < MAX_ATTEMPTS && !clientErr) {
        const backoffMs = 1000 * 2 ** (attempt - 1)
        console.log(`  [retry ${attempt}/${MAX_ATTEMPTS - 1}] ${err.message}; waiting ${backoffMs}ms`)
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

/** Extract archivePath (tar.gz OR zip — bsdtar, the `tar` shipped on macOS and on Windows 10+/Server
 *  2019+ runners, auto-detects both container formats from an -xf invocation) and copy only the runtime
 *  binary plus its shared libraries into destDir. Everything else in the release (llama-cli, llama-bench,
 *  the other example binaries) is intentionally discarded — Métis only ever spawns llama-server. */
function extractRuntime(archivePath, destDir, binaryName, keepExt) {
  const tmpDir = `${destDir}.extract-tmp`
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  execFileSync('tar', ['-xf', archivePath, '-C', tmpDir], { stdio: 'inherit' })
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

function isProvisioned(asset) {
  const marker = join(asset.dest, '.sha256')
  const binaryPath = join(asset.dest, asset.binary)
  if (!existsSync(binaryPath) || !existsSync(marker)) return false
  return readFileSync(marker, 'utf8').trim() === asset.sha256
}

async function provision(key, asset) {
  console.log(`\n[${key}] ${asset.file} -> ${asset.dest.replace(REPO_ROOT, '.')}`)
  if (isProvisioned(asset)) {
    console.log(`  [skip] already present + verified (${asset.sha256.slice(0, 12)}…)`)
    return
  }
  const archivePath = join(LLAMA_DIR, asset.file)
  await download(BASE_URL + asset.file, archivePath)

  // Verify BEFORE extraction — never unpack an archive we haven't confirmed the integrity of.
  const actual = sha256Of(archivePath)
  if (actual !== asset.sha256) {
    unlinkSync(archivePath)
    throw new Error(`${asset.file} sha256 mismatch: expected ${asset.sha256}, got ${actual}. Deleted; re-run to retry.`)
  }

  extractRuntime(archivePath, asset.dest, asset.binary, asset.keepExt)
  unlinkSync(archivePath)

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

main().catch((err) => {
  console.error('\nfetch-llama-server FAILED:', err.message)
  process.exit(1)
})
