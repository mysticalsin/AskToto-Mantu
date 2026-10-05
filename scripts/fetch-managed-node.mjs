#!/usr/bin/env node
/**
 * Fetch the shared manifest's pinned official Node — and on Windows the VC++ redist — into
 * resources/managed-node and resources/vcredist so the next electron-builder pack
 * ships them. The user never installs Node, Git, or VC++ themselves.
 *
 *   node scripts/fetch-managed-node.mjs win|mac|all
 *
 * Checksums come from the manifest's official nodejs.org SHASUMS256.txt source.
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { get as httpsGet } from 'node:https'
import { fileURLToPath } from 'node:url'
import { provisionManagedNodeArchive } from './lib/managed-node-provision.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'src/shared/managed-node-manifest.json'), 'utf8'))
const NODE_VERSION = manifest.version
const BASE = `https://nodejs.org/dist/v${NODE_VERSION}/`
const ASSETS = manifest.assets
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RESPONSE_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_BASE_MS = 1_000

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const VC_DEST = join(REPO_ROOT, 'resources', 'vcredist', 'vc_redist.x64.exe')

export function fetchStream(url, { requestGet = httpsGet, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let timeout
    const req = requestGet(url, (res) => {
      clearTimeout(timeout)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
  const part = `${dest}.part`
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      try { unlinkSync(part) } catch { /* .part may not exist */ }
      const res = await fetchStream(url, { requestGet, requestTimeoutMs })
      const total = Number(res.headers['content-length'] || 0)
      res.setTimeout(responseIdleTimeoutMs, () => {
        res.destroy(new Error(`response idle timeout after ${responseIdleTimeoutMs}ms for ${url}`))
      })
      await pipeline(res, createWriteStream(part))
      if (res.socket) res.setTimeout(0)
      const size = statSync(part).size
      if (total && size !== total) throw new Error(`incomplete download: got ${size} of ${total} bytes`)
      renameSync(part, dest)
      return
    } catch (error) {
      lastErr = error
      try { unlinkSync(part) } catch { /* .part may not exist */ }
      const clientErr = /HTTP 4\d\d/.test(error?.message || '')
      if (attempt < maxAttempts && !clientErr) {
        const backoffMs = backoffBaseMs * 2 ** (attempt - 1)
        process.stdout.write(`  [retry ${attempt}/${maxAttempts - 1}] ${error?.message ?? String(error)}; waiting ${backoffMs}ms\n`)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      } else {
        break
      }
    }
  }
  throw lastErr
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function fetchAsset(id) {
  const spec = ASSETS[id]
  const dest = join(REPO_ROOT, 'resources', 'managed-node', id.replace('win32-', 'win-'))
  const cache = join(REPO_ROOT, 'resources', 'managed-node', '.cache')
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, spec.file)
  if (!existsSync(archive) || sha256File(archive) !== spec.sha256) {
    process.stdout.write(`Downloading ${spec.file}…\n`)
    await download(BASE + spec.file, archive)
  }
  provisionManagedNodeArchive(archive, dest, spec, NODE_VERSION)
  process.stdout.write(`Ready ${dest}\n`)
}

export async function fetchVcRedist() {
  mkdirSync(dirname(VC_DEST), { recursive: true })
  if (!existsSync(VC_DEST)) {
    process.stdout.write('Downloading vc_redist.x64.exe…\n')
    await download(VC_REDIST_URL, VC_DEST)
  }
  process.stdout.write(`Ready ${VC_DEST}\n`)
}

export async function main(argv = process.argv.slice(2)) {
  const target = argv[0] || 'all'
  const jobs = []
  if (target === 'win' || target === 'all') jobs.push(fetchAsset('win32-x64'), fetchVcRedist())
  if (target === 'mac' || target === 'all') jobs.push(fetchAsset('darwin-arm64'), fetchAsset('darwin-x64'))
  if (jobs.length === 0) throw new Error(`Unsupported managed Node target: ${target}`)
  await Promise.all(jobs)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
