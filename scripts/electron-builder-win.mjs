#!/usr/bin/env node
// Windows release build wrapper (Lane C / L2-wrapper-hook — integration-design.md §2.2, §2.4).
//
// `release:build:win` calls this instead of invoking electron-builder directly. It:
//   1. Resolves the fail-closed signing mode from the environment (scripts/lib/windows-signing-mode.mjs,
//      owned by lane 1). No identity literal ever lives in this repo — everything comes from env.
//   2. Writes a short-lived electron-builder config overlay (extends electron-builder.win.yml) built
//      from that resolved mode, so the CLI's repeated `-c.` form (which collapses an array to its last
//      value — see integration-design.md §2.2) is never used for the publisher pin list.
//   3. Runs electron-builder against the overlay, then deletes it in a `finally`, on success or failure.
//
// `dist:win`, `dist:win:appx` and `release:win:store` are unaffected and keep calling electron-builder
// directly; only `release:build:win` (the public release chain) goes through this wrapper.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  resolveWindowsSigningMode,
  describeSigningModeFailure,
  buildWindowsSigningOverlay
} from './lib/windows-signing-mode.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// electron-builder's own CLI entry (node_modules/electron-builder/cli.js -> out/cli/cli.js). Invoking
// it directly with `node <path>` — rather than through `npx`/`electron-builder` — means this never
// goes through a Windows .cmd shim, so it can run with `shell: false` (no argv-injection surface) on
// every platform, unlike the npm/npx shell workaround build-cahe-windows.mjs needs for CVE-2024-27980.
const ELECTRON_BUILDER_CLI = resolve(REPO_ROOT, 'node_modules', 'electron-builder', 'cli.js')

function overlayDirectory() {
  const base = process.env.RUNNER_TEMP || tmpdir()
  mkdirSync(base, { recursive: true })
  return base
}

function runElectronBuilder(overlayPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [ELECTRON_BUILDER_CLI, '--config', overlayPath, '--win', '--x64', '--publish', 'never'],
      { stdio: 'inherit', shell: false, cwd: REPO_ROOT }
    )
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`electron-builder exited via signal ${signal}`))
      resolvePromise(code ?? 1)
    })
  })
}

async function main() {
  const resolved = resolveWindowsSigningMode(process.env)
  if (!resolved.ok) {
    console.error(`[electron-builder-win] FAIL - ${describeSigningModeFailure(resolved)}`)
    return 1
  }

  const baseConfigPath = resolve(REPO_ROOT, 'electron-builder.win.yml')
  const signHookPath = resolve(__dirname, 'azure-sign-hook.cjs')
  const overlay = buildWindowsSigningOverlay(resolved, { baseConfigPath, signHookPath })

  const overlayPath = join(overlayDirectory(), `metis-win-signing-${process.pid}.json`)
  writeFileSync(overlayPath, JSON.stringify(overlay), { mode: 0o600 })
  try {
    return await runElectronBuilder(overlayPath)
  } finally {
    rmSync(overlayPath, { force: true })
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main()
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      console.error(`[electron-builder-win] FAIL - ${error.message}`)
      process.exitCode = 1
    })
}
