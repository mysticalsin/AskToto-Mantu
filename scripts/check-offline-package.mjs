#!/usr/bin/env node
/** Prevent post-install model/runtime bootstrap code from returning to the packaged application. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['src/main', 'src/preload', 'src/renderer/src', 'src/shared']
const sourceExt = /\.(?:ts|tsx|js|mjs)$/
const testFile = /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/
const forbidden = [
  { pattern: /huggingface\.co\/unsloth\/Qwen/i, reason: 'runtime Qwen download URL' },
  { pattern: /sherpa-onnx\/releases\/download\/asr-models/i, reason: 'runtime Parakeet download URL' },
  { pattern: /bundled ASR load failed, retrying remote/i, reason: 'packaged ASR remote fallback' },
  { pattern: /localModels:(?:download|cancel|delete)/, reason: 'runtime local-model mutation IPC' },
  { pattern: /node-llama-cpp/, reason: 'superseded native binding backend' },
  { pattern: /runFirstRunBootstrap|installerStepsForPlatform/, reason: 'post-install dependency bootstrap' },
  { pattern: /['"]tool['"]\s*,\s*['"]run['"]/, reason: 'on-demand uv tool provisioning' }
]

function filesUnder(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else if (sourceExt.test(entry.name) && !testFile.test(entry.name)) out.push(path)
  }
  return out
}

const failures = []
for (const file of roots.flatMap(filesUnder)) {
  const text = readFileSync(file, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) failures.push(`${file}: ${rule.reason}`)
  }
}

if (failures.length) {
  console.error('[check:offline-package] FAIL')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('[check:offline-package] OK — no packaged model downloader, superseded binding, or dependency installer')
