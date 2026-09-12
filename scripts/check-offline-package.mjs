#!/usr/bin/env node
/** Reject unreviewed runtime download/bootstrap paths; this is not a fresh-install inference test. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['src/main', 'src/preload', 'src/renderer/src', 'src/shared']
const sourceExt = /\.(?:ts|tsx|js|mjs)$/
const testFile = /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/
// Compact Qwen ships in the installer. The optional larger selection and development/unbundled path
// still use the reviewed manifest/downloader, with immutable size + SHA-256 checks. A Qwen URL anywhere
// else is an unreviewed fetch path. Packaged inventory and fresh-profile offline inference have their
// own gates; this source scan must not claim that the application contains no download code.
const QWEN_DOWNLOAD_ALLOWED = ['src/main/llm/local-models.ts', 'src/main/llm/local-model-download.ts']
// Import ASR: bundled resources first; userData fetch is the reviewed fallback when the installer
// or a dev checkout is missing weights. Only this file may hold the sherpa-onnx archive URL.
const PARAKEET_DOWNLOAD_ALLOWED = ['src/main/asr-bundled-ensure.ts']

const forbidden = [
  {
    pattern: /huggingface\.co\/unsloth\/Qwen/i,
    reason: 'runtime Qwen download URL outside the reviewed downloader',
    allow: QWEN_DOWNLOAD_ALLOWED
  },
  {
    pattern: /sherpa-onnx\/releases\/download\/asr-models/i,
    reason: 'runtime Parakeet download URL',
    allow: PARAKEET_DOWNLOAD_ALLOWED
  },
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
  // Compare on posix-style paths so the allowlist behaves identically on Windows checkouts.
  const normalized = file.split('\\').join('/')
  for (const rule of forbidden) {
    if (rule.allow?.some((allowed) => normalized === allowed || normalized.endsWith(`/${allowed}`))) continue
    if (rule.pattern.test(text)) failures.push(`${file}: ${rule.reason}`)
  }
}

if (failures.length) {
  console.error('[check:offline-package] FAIL')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('[check:offline-package] OK — reviewed optional download paths only; no superseded binding or dependency bootstrap')
