#!/usr/bin/env node
// One-command installer builder for Métis.
//
// Defaults to the current platform and prints the installable artifacts at the end. This is intentionally
// a thin wrapper over the existing electron-builder config so release signing, resources, and update
// metadata keep one source of truth.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { platform, tmpdir } from 'node:os'

const VALID = new Set(['current', 'mac', 'win', 'all'])
const target = process.argv[2] || 'current'
if (!VALID.has(target)) {
  console.error('Usage: node scripts/build-installers.mjs [current|mac|win|all]')
  process.exit(2)
}

function isCloudSyncedWorkspace(path) {
  return /(?:^|[\\/])Library[\\/]CloudStorage(?:[\\/]|$)|(?:^|[\\/])OneDrive(?:[\\/]|$)/i.test(path)
}

// Finder/OneDrive metadata can be reapplied between afterPack's xattr cleanup
// and codesign verification. Package in a local filesystem for cloud-synced
// checkouts; CI and ordinary local repos retain the canonical release/ output.
const outDir = process.env.ASKTOTO_INSTALLER_OUTPUT_DIR || (
  isCloudSyncedWorkspace(process.cwd()) ? join(tmpdir(), 'metis-installers') : 'release'
)

function run(cmd, args, opts = {}) {
  console.log(`\n> ${[cmd, ...args].join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) process.exit(r.status || 1)
}

function targetsFor(requested) {
  if (requested === 'all') return ['mac', 'win']
  if (requested === 'current') {
    if (platform() === 'darwin') return ['mac']
    if (platform() === 'win32') return ['win']
    console.error('Current-platform installer builds are supported on macOS and Windows.')
    process.exit(2)
  }
  return [requested]
}

function artifactFiles() {
  if (!existsSync(outDir)) return []
  return readdirSync(outDir)
    .filter((name) => /\.(dmg|zip|exe|appx|msix|pkg|blockmap|ya?ml)$/i.test(name))
    .sort()
}

function withOutputDir(args) {
  return outDir === 'release' ? args : [...args, `-c.directories.output=${outDir}`]
}

function printInstallHelp(files) {
  const installers = files.filter((name) => /\.(dmg|exe|appx|msix|pkg)$/i.test(name))
  console.log('\nInstallers created:')
  if (!installers.length) {
    console.log(`  No installable artifacts found in ${outDir}. Check the electron-builder output above.`)
    return
  }
  for (const name of installers) console.log(`  ${join(outDir, name)}`)

  const hasMac = installers.some((name) => /\.dmg$/i.test(name))
  const hasWin = installers.some((name) => /\.exe$/i.test(name))
  const hasStore = installers.some((name) => /\.(appx|msix|pkg)$/i.test(name))
  console.log('\nHow to install:')
  if (hasMac) console.log('  macOS: open the .dmg, drag Métis to Applications, then open Métis.')
  if (hasWin) console.log('  Windows: run Metis-Setup-*.exe. Use Metis-Portable-*.exe for no-install testing.')
  if (hasStore) console.log('  Store package: upload the .pkg/.appx/.msix through the relevant store dashboard.')
  if (hasMac && process.env.ASKTOTO_SIGN_INSTALLER !== '1') {
    console.log('\nNote: local macOS installers use a complete ad-hoc signature, not Developer ID/notarization.')
    console.log('Set ASKTOTO_SIGN_INSTALLER=1 with signing inputs, or use the tagged release workflow for customer builds.')
  }
}

const requestedTargets = targetsFor(target)
const verifyWindowsSignature = process.env.ASKTOTO_SIGN_INSTALLER === '1' || Boolean(
  process.env.WIN_CSC_LINK || process.env.CSC_LINK
)

if (target === 'all' && platform() !== 'darwin' && platform() !== 'win32') {
  console.error('Cross-platform installer builds should run on macOS or Windows, or use GitHub Actions.')
  process.exit(2)
}

// Do this before clearing output or downloading models. Main-process bytecode and native launch
// checks require the target host; the GitHub release workflow builds both platforms on their hosts.
for (const t of requestedTargets) run('node', ['scripts/check-build-host.mjs', t])
if (requestedTargets.includes('win') && verifyWindowsSignature && !process.env.WIN_CSC_EXPECTED_SUBJECT?.trim()) {
  console.error('Signed Windows installers require WIN_CSC_EXPECTED_SUBJECT to verify the publisher identity.')
  process.exit(2)
}

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })

run('node', ['scripts/check-no-dynamic-import.mjs'])
run('node', ['scripts/embed-cloudflare-key.mjs'])
run('node', ['scripts/check-cloudflare-key-valid.mjs'])
if (requestedTargets.includes('mac')) run('node', ['scripts/check-xcode-tools.mjs'])
for (const target of requestedTargets) {
  for (const arch of target === 'mac' ? ['arm64', 'x64'] : ['x64']) {
    run('node', ['scripts/check-ffmpeg-sidecar.mjs', target, arch])
  }
}
if (requestedTargets.includes('mac')) run('node', ['scripts/provision-mac-natives.mjs'])
for (const target of requestedTargets) {
  for (const arch of target === 'mac' ? ['arm64', 'x64'] : ['x64']) {
    run('node', ['scripts/check-sherpa-platform.mjs', target, arch])
  }
}
if (requestedTargets.includes('mac')) run('node', ['scripts/provision-electron-dist.mjs'])
for (const target of requestedTargets) run('node', ['scripts/fetch-llama-server.mjs', target])
for (const target of requestedTargets) run('node', ['scripts/check-llama-sidecar.mjs', target])
for (const target of requestedTargets) run('node', ['scripts/fetch-managed-node.mjs', target])
// metis-mac-helper Swift sidecar — must exist before a mac package or electron-builder only WARNS about
// the missing extraResources dir and ships a silently degraded app (no Vision OCR, no frontmost watcher).
if (requestedTargets.includes('mac')) {
  run('node', ['scripts/build-mac-helper.mjs'])
  run('node', ['scripts/check-mac-helper.mjs', 'mac'])
}
run('node', ['scripts/fetch-local-model.mjs'])
run('node', ['scripts/check-local-model.mjs'])
run('node', ['scripts/fetch-speaker-model.mjs'])
run('node', ['scripts/fetch-models.mjs'])
run('npm', ['run', 'build:intelligence'])
run('npm', ['run', 'build'], requestedTargets.includes('mac') ? {
  env: { ...process.env, ASKTOTO_MAC_UNIVERSAL: '1' }
} : {})

for (const t of requestedTargets) {
  if (t === 'mac') {
    const args = withOutputDir([
      'electron-builder', '--mac', '--universal', '-c.npmRebuild=false',
      '-c.electronDist=resources/electron-dist', '--publish', 'never'
    ])
    const options = { env: { ...process.env, ASKTOTO_MAC_ARCHES: 'arm64,x64' } }
    if (process.env.ASKTOTO_SIGN_INSTALLER !== '1') {
      args.push('-c.mac.identity=null')
      options.env.ASKTOTO_ADHOC_SIGN = '1'
    }
    run('npx', args, options)
    const appDir = join(outDir, 'mac-universal', 'Metis.app')
    run('node', ['scripts/check-packaged-runtime.mjs', 'mac', join(appDir, 'Contents', 'Resources'), '--arches=arm64,x64', '--macho-arches=arm64,x64', '--post-sign'])
    run('node', ['scripts/check-update-metadata.mjs', join(outDir, 'latest-mac.yml')])
    run('node', ['scripts/verify-signing.mjs', outDir, ...(process.env.ASKTOTO_SIGN_INSTALLER === '1' ? ['--require-notarized'] : [])])
    run('node', ['scripts/check-packaged-launch.mjs', appDir], {
      env: { ...process.env, ASKTOTO_MAC_LAUNCH_GATE: '1' }
    })
  }
  if (t === 'win') {
    run('npx', withOutputDir([
      'electron-builder',
      '--config',
      'electron-builder.win.yml',
      '--win',
      '--x64',
      '--publish',
      'never'
    ]))
    run('node', ['scripts/check-packaged-runtime.mjs', 'win', join(outDir, 'win-unpacked', 'resources'), '--post-sign'])
    run('node', ['scripts/check-update-metadata.mjs', join(outDir, 'latest.yml')])
    if (verifyWindowsSignature) run('node', ['scripts/verify-signing.mjs', outDir])
    const executable = join(outDir, 'win-unpacked', 'Metis.exe')
    run('node', ['scripts/check-packaged-launch.mjs', executable])
    run('node', ['scripts/check-packaged-asr.mjs', executable])
  }
}

run('node', ['scripts/check-embedded-cloudflare-key.mjs', outDir])
run('node', ['scripts/check-release.mjs'], { env: { ...process.env, ASKTOTO_ARTIFACTS_DIR: outDir } })
printInstallHelp(artifactFiles())
