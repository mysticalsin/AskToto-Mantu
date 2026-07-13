#!/usr/bin/env node
/**
 * Provision the single model payload that ships inside every Métis installer.
 *
 * Network access exists only in this build-time script. Installed application code has no model
 * downloader. Set METIS_LOCAL_MODEL_SOURCE_DIR to reuse already-reviewed local files without a network
 * request; CI omits it and downloads the same byte/hash-pinned assets into the build cache.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  copyFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'
import { LOCAL_MODEL_ASSETS, LOCAL_MODEL_DIR } from './local-model-assets.mjs'

const MAX_ATTEMPTS = 3

function safeUnlink(path) {
  try {
    unlinkSync(path)
  } catch {
    // Missing cleanup target.
  }
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function fileMatches(path, asset) {
  if (!existsSync(path) || statSync(path).size !== asset.bytes) return false
  return (await hashFile(path)) === asset.sha256
}

function openResponse(url, startByte = 0, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error(`Too many redirects for ${url}`))
  return new Promise((resolve, reject) => {
    const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {}
    const req = httpsGet(url, { headers }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        openResponse(new URL(res.headers.location, url).toString(), startByte, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200 && status !== 206) {
        res.resume()
        reject(new Error(`HTTP ${status} for ${url}`))
        return
      }
      resolve(res)
    })
    req.setTimeout(120_000, () => req.destroy(new Error(`Timed out fetching ${url}`)))
    req.on('error', reject)
  })
}

async function streamToFile(res, path, append) {
  await new Promise((resolve, reject) => {
    const out = createWriteStream(path, { flags: append ? 'a' : 'w' })
    res.pipe(out)
    out.on('finish', () => out.close(resolve))
    out.on('error', reject)
    res.on('error', reject)
  })
}

async function download(asset, dest) {
  const part = `${dest}.part`
  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let startByte = existsSync(part) ? statSync(part).size : 0
      if (startByte >= asset.bytes) {
        safeUnlink(part)
        startByte = 0
      }
      let res = await openResponse(asset.url, startByte)
      if (startByte > 0 && res.statusCode !== 206) {
        res.resume()
        safeUnlink(part)
        startByte = 0
        res = await openResponse(asset.url, 0)
      }
      console.log(`[fetch:local-model] ${asset.file}: ${startByte ? `resume at ${startByte}` : 'download'}`)
      await streamToFile(res, part, startByte > 0)
      const size = statSync(part).size
      if (size !== asset.bytes) throw new Error(`${asset.file}: expected ${asset.bytes} bytes, got ${size}`)
      const digest = await hashFile(part)
      if (digest !== asset.sha256) {
        safeUnlink(part)
        throw new Error(`${asset.file}: SHA-256 mismatch (expected ${asset.sha256}, got ${digest})`)
      }
      renameSync(part, dest)
      return
    } catch (error) {
      lastError = error
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = 1_000 * 2 ** (attempt - 1)
        console.warn(`[fetch:local-model] attempt ${attempt} failed: ${error.message}; retrying in ${waitMs}ms`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }
  }
  throw lastError
}

async function provision(asset) {
  const dest = join(LOCAL_MODEL_DIR, asset.file)
  if (await fileMatches(dest, asset)) {
    console.log(`[fetch:local-model] OK cached: ${asset.file}`)
    return
  }
  safeUnlink(dest)
  mkdirSync(LOCAL_MODEL_DIR, { recursive: true })

  const sourceDir = process.env.METIS_LOCAL_MODEL_SOURCE_DIR
  if (sourceDir) {
    const candidates = [join(sourceDir, asset.sourceFile), join(sourceDir, asset.file)]
    const source = candidates.find((path) => existsSync(path))
    if (!source) throw new Error(`${asset.file}: not found in METIS_LOCAL_MODEL_SOURCE_DIR=${sourceDir}`)
    const part = `${dest}.part`
    safeUnlink(part)
    copyFileSync(source, part)
    if (!(await fileMatches(part, asset))) {
      safeUnlink(part)
      throw new Error(`${asset.file}: local source failed byte/hash verification`)
    }
    renameSync(part, dest)
    console.log(`[fetch:local-model] OK local source: ${asset.file}`)
    return
  }

  await download(asset, dest)
  console.log(`[fetch:local-model] OK downloaded: ${asset.file}`)
}

for (const asset of LOCAL_MODEL_ASSETS) await provision(asset)
