#!/usr/bin/env node
/**
 * Verify the native sherpa-onnx addon for the packaging TARGET exists before electron-builder runs.
 * npm's os/cpu-gated optionalDependencies only install the sherpa-onnx-<platform>-<arch> package
 * matching the HOST running `npm install` — cross-building (e.g. `--win` from this macOS dev machine)
 * silently leaves the target's package missing. electron-builder's asarUnpack glob then copies whatever
 * happens to be in node_modules regardless of target, so the build exits 0 with no native ASR addon for
 * that platform (src/main/parakeet.ts falls back to Whisper with no build-time signal). This hard-fails
 * instead, after first attempting a safe, version-pinned auto-provision.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const target = process.argv[2] || process.platform
// sherpa-onnx-node resolves its addon package as sherpa-onnx-<platform>-<arch>, where platform is
// 'win' (not 'win32') / 'darwin' / 'linux' — see node_modules/sherpa-onnx-node/addon.js.
const sherpaPlatform =
  target === 'win' || target === 'win32' ? 'win' : target === 'mac' ? 'darwin' : target
const sherpaArch = process.argv[3] || (sherpaPlatform === 'win' ? 'x64' : process.arch)
const pkgName = `sherpa-onnx-${sherpaPlatform}-${sherpaArch}`
const addonPath = join('node_modules', pkgName, 'sherpa-onnx.node')

if (existsSync(addonPath)) {
  console.log(`[check:sherpa] OK — ${pkgName}`)
  process.exit(0)
}

// Pin to sherpa-onnx-node's own installed version rather than a separate hardcoded constant, so this
// never drifts out of sync when sherpa-onnx-node is bumped.
const sherpaNodeVersion = JSON.parse(
  readFileSync(join('node_modules', 'sherpa-onnx-node', 'package.json'), 'utf8')
).version
const provisionArgs = ['install', '--no-save', '--force', `${pkgName}@${sherpaNodeVersion}`]
const provisionCmd = `npm ${provisionArgs.join(' ')}`

console.warn(`[check:sherpa] ${pkgName} missing — attempting auto-provision: ${provisionCmd}`)
const result = spawnSync('npm', provisionArgs, { stdio: 'inherit', timeout: 120_000 })

if (result.status === 0 && existsSync(addonPath)) {
  console.log(`[check:sherpa] OK — ${pkgName} (auto-provisioned)`)
  process.exit(0)
}

throw new Error(
  `${pkgName} is missing from node_modules — a ${target} build from this host would silently ship ` +
    `without the native Parakeet ASR addon. Provision it with network access, then retry:\n\n` +
    `  ${provisionCmd}\n\n` +
    `Or build ${target} targets on a matching native host/CI runner instead.`
)
