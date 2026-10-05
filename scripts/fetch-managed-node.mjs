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
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
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
const DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_BACKOFF_MS = 1_000

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const VC_DEST = join(REPO_ROOT, 'resources', 'vcredist', 'vc_redist.x64.exe')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function downloadOnce(url, dest) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { timeout: 60_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadOnce(new URL(res.headers.location, url).toString(), dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${url}: HTTP ${res.statusCode}`))
        return
      }
      pipeline(res, createWriteStream(dest)).then(resolve, reject)
    })
    req.on('error', reject)
  })
}

async function download(url, dest) {
  let lastError
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      await downloadOnce(url, dest)
      return
    } catch (error) {
      lastError = error
      try {
        unlinkSync(dest)
      } catch {
        /* A failed request can happen before the file is opened. */
      }
      const clientError = /HTTP 4\d\d/.test(error?.message ?? '')
      if (attempt >= DOWNLOAD_ATTEMPTS || clientError) break
      const delay = DOWNLOAD_BACKOFF_MS * 2 ** (attempt - 1)
      const reason = error?.code ?? error?.message ?? error
      process.stdout.write(`Retrying ${basenameForLog(url)} after ${reason} (${attempt}/${DOWNLOAD_ATTEMPTS - 1})…\n`)
      await sleep(delay)
    }
  }
  throw lastError
}

function basenameForLog(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? url
  } catch {
    return url
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function fetchAsset(id) {
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

async function fetchVcRedist() {
  mkdirSync(dirname(VC_DEST), { recursive: true })
  if (!existsSync(VC_DEST)) {
    process.stdout.write('Downloading vc_redist.x64.exe…\n')
    await download(VC_REDIST_URL, VC_DEST)
  }
  process.stdout.write(`Ready ${VC_DEST}\n`)
}

const target = process.argv[2] || 'all'
const jobs = []
if (target === 'win' || target === 'all') jobs.push(fetchAsset('win32-x64'), fetchVcRedist())
if (target === 'mac' || target === 'all') jobs.push(fetchAsset('darwin-arm64'), fetchAsset('darwin-x64'))
await Promise.all(jobs)
