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
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { get as httpsGet } from 'node:https'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { provisionManagedNodeArchive } from './lib/managed-node-provision.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'src/shared/managed-node-manifest.json'), 'utf8'))
const NODE_VERSION = manifest.version
const BASE = `https://nodejs.org/dist/v${NODE_VERSION}/`
const ASSETS = manifest.assets
const DOWNLOAD_ATTEMPTS = 3
const RETRYABLE_DOWNLOAD_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED'
])

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const VC_DEST = join(REPO_ROOT, 'resources', 'vcredist', 'vc_redist.x64.exe')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isRetryableDownloadError(error) {
  if (RETRYABLE_DOWNLOAD_CODES.has(error?.code)) return true
  const statusCode = error?.statusCode
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600)
}

function downloadOnce(url, dest, get = httpsGet) {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 60_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadOnce(res.headers.location, dest, get).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        const error = new Error(`${url}: HTTP ${res.statusCode}`)
        error.statusCode = res.statusCode
        reject(error)
        return
      }
      pipeline(res, createWriteStream(dest)).then(resolve, reject)
    })
    req.on('error', reject)
  })
}

export async function download(url, dest, { get = httpsGet, attempts = DOWNLOAD_ATTEMPTS, retryDelayMs = 1_000 } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const tmp = `${dest}.download-${process.pid}-${Date.now()}-${attempt}`
    try {
      await downloadOnce(url, tmp, get)
      renameSync(tmp, dest)
      return
    } catch (error) {
      lastError = error
      rmSync(tmp, { force: true })
      if (attempt >= attempts || !isRetryableDownloadError(error)) break
      process.stdout.write(`Download failed (${error?.code ?? error?.statusCode ?? 'UNKNOWN'}), retrying ${attempt + 1}/${attempts}…\n`)
      await sleep(retryDelayMs * attempt)
    }
  }
  throw lastError
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
  await Promise.all(jobs)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
