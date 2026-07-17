#!/usr/bin/env node
// Provision the Speaker Intelligence embedding model (SPEAKER-INTELLIGENCE-PLAN §4):
// 3D-Speaker CAM++ en_voxceleb 16k ONNX (~28MB, Apache-2.0), redistributed by sherpa-onnx's model
// releases. Checksum-pinned like every other provisioned asset (fetch-llama-server.mjs pattern);
// resources/models/** already ships via extraResources on BOTH platforms, so no yml change is needed.
// Skips when the pinned file is already present; hard-fails on checksum mismatch.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_ =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx'
const SHA256 = '357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'resources', 'models', 'speaker')
const outFile = join(outDir, 'embedding.onnx')

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

if (existsSync(outFile) && sha256(readFileSync(outFile)) === SHA256) {
  console.log('[fetch-speaker-model] embedding.onnx present and checksum-verified — skipped')
  process.exit(0)
}

console.log('[fetch-speaker-model] downloading CAM++ en speaker embedding model (~28MB)…')
const res = await fetch(URL_, { redirect: 'follow' })
if (!res.ok) {
  console.error(`[fetch-speaker-model] download failed: HTTP ${res.status}`)
  process.exit(1)
}
const buf = Buffer.from(await res.arrayBuffer())
const digest = sha256(buf)
if (digest !== SHA256) {
  console.error(`[fetch-speaker-model] checksum mismatch: expected ${SHA256}, got ${digest} — refusing to install`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })
const tmp = `${outFile}.tmp`
writeFileSync(tmp, buf)
renameSync(tmp, outFile)
console.log(`[fetch-speaker-model] installed ${outFile} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
