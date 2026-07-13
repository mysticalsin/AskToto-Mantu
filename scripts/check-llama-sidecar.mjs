#!/usr/bin/env node
/** Verify the pinned llama.cpp `llama-server` sidecar binaries for the packaging TARGET exist before
 *  electron-builder runs — without this, a build ships with Métis Local permanently unavailable and no
 *  build-time signal (mirrors check-ffmpeg-sidecar.mjs). Windows ships BOTH the Vulkan (GPU, preferred)
 *  and CPU (fallback) builds — local-runtime.ts falls back to the CPU binary once if Vulkan fails to
 *  spawn, so a Windows package missing either one silently breaks that contract at runtime. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const target = process.argv[2] || (process.platform === 'win32' ? 'win' : 'mac')
if (target !== 'mac' && target !== 'win') {
  console.error('Usage: node scripts/check-llama-sidecar.mjs <mac|win>')
  process.exit(2)
}

const required =
  target === 'mac'
    ? [join('resources', 'llama', 'mac', 'llama-server')]
    : [
        join('resources', 'llama', 'win', 'vulkan', 'llama-server.exe'),
        join('resources', 'llama', 'win', 'cpu', 'llama-server.exe')
      ]

const missing = required.filter((f) => !existsSync(f))
if (missing.length) {
  throw new Error(
    `Missing local-LLM sidecar binar${missing.length > 1 ? 'ies' : 'y'} for target "${target}": ${missing.join(', ')}\n` +
      `A ${target} build from here would silently ship with no on-device model runtime — Métis Local ` +
      `would be permanently unavailable with no build-time signal.\n` +
      `Provision it with network access, then retry:\n\n` +
      `  node scripts/fetch-llama-server.mjs ${target}\n`
  )
}
for (const f of required) console.log(`[check:llama] OK — ${f}`)
