#!/usr/bin/env node
/** No-network release gate for the model payload embedded in Métis. */
import './check-offline-package.mjs'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { LOCAL_MODEL_ASSETS, LOCAL_MODEL_DIR, LOCAL_MODEL_LICENSE } from './local-model-assets.mjs'

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

const allowed = new Set(LOCAL_MODEL_ASSETS.map((asset) => asset.file))
const actual = existsSync(LOCAL_MODEL_DIR) ? readdirSync(LOCAL_MODEL_DIR).filter((name) => !name.startsWith('.')) : []
const unexpected = actual.filter((name) => !allowed.has(name))
if (unexpected.length) throw new Error(`Unexpected bundled local-model files: ${unexpected.join(', ')}`)

for (const asset of LOCAL_MODEL_ASSETS) {
  const path = join(LOCAL_MODEL_DIR, asset.file)
  if (!existsSync(path)) throw new Error(`Missing bundled local-model asset: ${path}`)
  const size = statSync(path).size
  if (size !== asset.bytes) throw new Error(`${asset.file}: expected ${asset.bytes} bytes, got ${size}`)
  const digest = await hashFile(path)
  if (digest !== asset.sha256) throw new Error(`${asset.file}: SHA-256 mismatch (expected ${asset.sha256}, got ${digest})`)
  console.log(`[check:local-model] OK ${asset.file} (${size} bytes, ${digest})`)
}

if (!existsSync(LOCAL_MODEL_LICENSE.path)) throw new Error(`Missing bundled model license: ${LOCAL_MODEL_LICENSE.path}`)
const licenseSize = statSync(LOCAL_MODEL_LICENSE.path).size
if (licenseSize !== LOCAL_MODEL_LICENSE.bytes) {
  throw new Error(`Model license: expected ${LOCAL_MODEL_LICENSE.bytes} bytes, got ${licenseSize}`)
}
const licenseDigest = await hashFile(LOCAL_MODEL_LICENSE.path)
if (licenseDigest !== LOCAL_MODEL_LICENSE.sha256) {
  throw new Error(`Model license: SHA-256 mismatch (expected ${LOCAL_MODEL_LICENSE.sha256}, got ${licenseDigest})`)
}
console.log(`[check:local-model] OK model license (${licenseSize} bytes, ${licenseDigest})`)

console.log('[check:local-model] OK exactly one bundled model: qwen3.5-0.8b')
