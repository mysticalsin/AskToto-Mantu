#!/usr/bin/env node
/** Prove the production ASR worker is fail-closed after Vite tree-shaking/minification. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const assetsDir = join('out', 'renderer', 'assets')
const workers = readdirSync(assetsDir).filter(
  (name) => name.startsWith('whisper.worker-') && name.endsWith('.js')
)

if (workers.length !== 1) {
  throw new Error(`Expected exactly one built Whisper worker, found ${workers.length}: ${workers.join(', ')}`)
}

const workerPath = join(assetsDir, workers[0])
const source = readFileSync(workerPath, 'utf8')

const required = [
  ['bundled Whisper model', 'Xenova/whisper-base'],
  ['bundled model protocol', 'asr-model://models'],
  ['bundled ONNX Runtime protocol', 'asr-model://ort/']
]
for (const [label, marker] of required) {
  if (!source.includes(marker)) throw new Error(`Built ASR worker is missing ${label}: ${marker}`)
}

if (!/\.allowRemoteModels\s*=\s*!1/.test(source)) {
  throw new Error('Built ASR worker does not force allowRemoteModels=false')
}

const forbidden = [
  'whisper-large-v3-turbo',
  'bundled ASR load failed, retrying remote',
  'Check your internet connection and try Listen again'
]
for (const marker of forbidden) {
  if (source.includes(marker)) throw new Error(`Built ASR worker contains a remote-fallback path: ${marker}`)
}

console.log(`[check:built-offline] OK — ${workers[0]} is bundled-only and fail-closed`)
