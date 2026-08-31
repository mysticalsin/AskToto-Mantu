#!/usr/bin/env node
/**
 * Fetch the pinned official Node (22.22.3) — and on Windows the VC++ redist — into
 * resources/managed-node and resources/vcredist so the next electron-builder pack
 * ships them. The user never installs Node, Git, or VC++ themselves.
 *
 *   node scripts/fetch-managed-node.mjs win|mac|all
 *
 * Checksums are the official nodejs.org SHASUMS256.txt values for v22.22.3.
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { get as httpsGet } from 'node:https'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const NODE_VERSION = '22.22.3'
const BASE = `https://nodejs.org/dist/v${NODE_VERSION}/`

const ASSETS = {
  'win-x64': {
    file: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33',
    dest: join(REPO_ROOT, 'resources', 'managed-node', 'win-x64'),
    nodeRel: 'node.exe'
  },
  'darwin-arm64': {
    file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: '0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207',
    dest: join(REPO_ROOT, 'resources', 'managed-node', 'darwin-arm64'),
    nodeRel: join('bin', 'node')
  },
  'darwin-x64': {
    file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: '45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec',
    dest: join(REPO_ROOT, 'resources', 'managed-node', 'darwin-x64'),
    nodeRel: join('bin', 'node')
  }
}

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const VC_DEST = join(REPO_ROOT, 'resources', 'vcredist', 'vc_redist.x64.exe')

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { timeout: 60_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        download(res.headers.location, dest).then(resolve, reject)
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

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function extractZip(archive, dest) {
  mkdirSync(dest, { recursive: true })
  if (process.platform === 'win32') {
    const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(tar, ['-xf', archive, '-C', dest], { stdio: 'inherit' })
    return
  }
  execFileSync('unzip', ['-qo', archive, '-d', dest], { stdio: 'inherit' })
}

function extractTarGz(archive, dest) {
  mkdirSync(dest, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { stdio: 'inherit' })
}

async function fetchAsset(id) {
  const spec = ASSETS[id]
  const cache = join(REPO_ROOT, 'resources', 'managed-node', '.cache')
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, spec.file)
  if (!existsSync(archive) || sha256File(archive) !== spec.sha256) {
    process.stdout.write(`Downloading ${spec.file}…\n`)
    await download(BASE + spec.file, archive)
  }
  const actual = sha256File(archive)
  if (actual !== spec.sha256) {
    throw new Error(`${spec.file} sha256 ${actual} !== ${spec.sha256}`)
  }
  mkdirSync(spec.dest, { recursive: true })
  if (spec.file.endsWith('.zip')) {
    const tmp = join(cache, `${id}-extract`)
    extractZip(archive, tmp)
    const inner = join(tmp, spec.file.replace(/\.zip$/, ''))
    const { cpSync, rmSync } = await import('node:fs')
    cpSync(existsSync(inner) ? inner : tmp, spec.dest, { recursive: true })
    rmSync(tmp, { recursive: true, force: true })
  } else {
    extractTarGz(archive, spec.dest)
  }
  writeFileSync(join(spec.dest, '.node-version'), NODE_VERSION + '\n')
  process.stdout.write(`Ready ${spec.dest}\n`)
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
if (target === 'win' || target === 'all') jobs.push(fetchAsset('win-x64'), fetchVcRedist())
if (target === 'mac' || target === 'all') jobs.push(fetchAsset('darwin-arm64'), fetchAsset('darwin-x64'))
await Promise.all(jobs)
