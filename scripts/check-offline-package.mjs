#!/usr/bin/env node
/** Prevent post-install model/runtime bootstrap code from returning to the packaged application. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['src/main', 'src/preload', 'src/renderer/src', 'src/shared']
const sourceExt = /\.(?:ts|tsx|js|mjs)$/
const testFile = /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/
// The Qwen weights are no longer bundled (they made a universal mac package exceed GitHub's 2 GB
// release-asset limit), so a runtime download URL is now expected — but ONLY in the two files that were
// reviewed for it: the pinned manifest and the single downloader that verifies size + sha256 before
// use. Anywhere else it means a second, unaudited fetch path has appeared, which is exactly what this
// gate exists to stop. Every other rule below is unchanged.
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
console.log('[check:offline-package] OK — no packaged model downloader, superseded binding, or dependency installer')
