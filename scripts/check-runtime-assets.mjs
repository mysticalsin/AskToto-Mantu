#!/usr/bin/env node
/** No-network size/hash gate for every ASR/ORT file copied into a standard installer. */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

const manifestPath = join('resources', 'runtime-assets-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.schemaVersion !== 1 || !manifest.assets || typeof manifest.assets !== 'object') {
  throw new Error(`Invalid runtime asset manifest: ${manifestPath}`)
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

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.name !== '.gitkeep') out.push(path)
  }
  return out
}

for (const [path, expected] of Object.entries(manifest.assets)) {
  if (!existsSync(path)) throw new Error(`Missing runtime asset: ${path}`)
  const size = statSync(path).size
  if (size !== expected.bytes) throw new Error(`${path}: expected ${expected.bytes} bytes, got ${size}`)
  const digest = await hashFile(path)
  if (digest !== expected.sha256) {
    throw new Error(`${path}: SHA-256 mismatch (expected ${expected.sha256}, got ${digest})`)
  }
}

const packagedRoots = [
  join('resources', 'models', 'Xenova', 'whisper-base'),
  join('resources', 'asr', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'),
  join('resources', 'ort')
]
const listed = new Set(Object.keys(manifest.assets))
const unexpected = packagedRoots
  .flatMap(walk)
  .map((path) => relative('.', path).split('\\').join('/'))
  .filter((path) => !listed.has(path))
if (unexpected.length) throw new Error(`Unreviewed runtime assets would be packaged: ${unexpected.join(', ')}`)

console.log(`[check:runtime-assets] OK ${listed.size} ASR/ORT files match reviewed size and SHA-256 pins`)
