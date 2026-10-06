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
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { download } from './fetch-llama-server.mjs'
import { provisionManagedNodeArchive } from './lib/managed-node-provision.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'src/shared/managed-node-manifest.json'), 'utf8'))
const NODE_VERSION = manifest.version
const BASE = `https://nodejs.org/dist/v${NODE_VERSION}/`
const ASSETS = manifest.assets

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const VC_DEST = join(REPO_ROOT, 'resources', 'vcredist', 'vc_redist.x64.exe')

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Reuse a cached archive only when its sha256 matches; otherwise discard it and fetch through the
 *  shared retrying download (fetch-llama-server.mjs), so one DNS or connection failure on a CI runner
 *  does not fail packaging. provisionManagedNodeArchive re-verifies the hash before extraction. */
export async function fetchVerifiedArchive(url, archive, sha256, downloadOptions = {}) {
  if (existsSync(archive)) {
    if (sha256File(archive) === sha256) return
    unlinkSync(archive)
  }
  await download(url, archive, downloadOptions)
}

async function fetchAsset(id) {
  const spec = ASSETS[id]
  const dest = join(REPO_ROOT, 'resources', 'managed-node', id.replace('win32-', 'win-'))
  const cache = join(REPO_ROOT, 'resources', 'managed-node', '.cache')
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, spec.file)
  await fetchVerifiedArchive(BASE + spec.file, archive, spec.sha256)
  provisionManagedNodeArchive(archive, dest, spec, NODE_VERSION)
  process.stdout.write(`Ready ${dest}\n`)
}

async function fetchVcRedist() {
  mkdirSync(dirname(VC_DEST), { recursive: true })
  if (!existsSync(VC_DEST)) {
    await download(VC_REDIST_URL, VC_DEST)
  }
  process.stdout.write(`Ready ${VC_DEST}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] || 'all'
  const jobs = []
  if (target === 'win' || target === 'all') jobs.push(fetchAsset('win32-x64'), fetchVcRedist())
  if (target === 'mac' || target === 'all') jobs.push(fetchAsset('darwin-arm64'), fetchAsset('darwin-x64'))
  await Promise.all(jobs)
}
