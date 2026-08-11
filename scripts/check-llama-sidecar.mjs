#!/usr/bin/env node
/** Verify the pinned llama.cpp `llama-server` sidecar binaries for the packaging TARGET exist before
 *  electron-builder runs — without this, a build ships with Métis Local permanently unavailable and no
 *  build-time signal (mirrors check-ffmpeg-sidecar.mjs). Both targets require TWO binaries, for
 *  different reasons: Windows ships the Vulkan (GPU, preferred) and CPU (fallback) builds because
 *  local-runtime.ts falls back to CPU once if Vulkan fails to spawn, and macOS ships arm64 and x64
 *  because the package is universal and picks by process.arch. Either target missing one of its pair
 *  silently breaks that contract at runtime. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const target = process.argv[2] || (process.platform === 'win32' ? 'win' : 'mac')
if (target !== 'mac' && target !== 'win') {
  console.error('Usage: node scripts/check-llama-sidecar.mjs <mac|win>')
  process.exit(2)
}

const required =
  target === 'mac'
    ? // The mac package is universal, so ONE .app serves Intel and Apple Silicon and has to carry both
      // sidecars — local-runtime.ts resolves resources/llama/mac/<process.arch>/llama-server at spawn
      // time. Shipping one arch leaves Métis Local permanently dead on the other half of the install
      // base with no build-time signal, which is precisely what this gate exists to prevent.
      [
        join('resources', 'llama', 'mac', 'arm64', 'llama-server'),
        join('resources', 'llama', 'mac', 'x64', 'llama-server')
      ]
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
