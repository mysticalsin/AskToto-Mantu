#!/usr/bin/env node
// One-command installer builder for Métis.
//
// Defaults to the current platform and prints the installable artifacts at the end. This is intentionally
// a thin wrapper over the existing electron-builder config so release signing, resources, and update
// metadata keep one source of truth.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'

const VALID = new Set(['current', 'mac', 'win', 'all'])
const target = process.argv[2] || 'current'
if (!VALID.has(target)) {
  console.error('Usage: node scripts/build-installers.mjs [current|mac|win|all]')
  process.exit(2)
}

const outDir = 'release'

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

function printInstallHelp(files) {
  const installers = files.filter((name) => /\.(dmg|exe|appx|msix|pkg)$/i.test(name))
  console.log('\nInstallers created:')
  if (!installers.length) {
    console.log('  No installable artifacts found in release/. Check the electron-builder output above.')
    return
  }
  for (const name of installers) console.log(`  release/${name}`)

  const hasMac = installers.some((name) => /\.dmg$/i.test(name))
  const hasWin = installers.some((name) => /\.exe$/i.test(name))
  const hasStore = installers.some((name) => /\.(appx|msix|pkg)$/i.test(name))
  console.log('\nHow to install:')
  if (hasMac) console.log('  macOS: open the .dmg, drag Métis to Applications, then open Métis.')
  if (hasWin) console.log('  Windows: run Metis-Setup-*.exe. Use Metis-Portable-*.exe for no-install testing.')
  if (hasStore) console.log('  Store package: upload the .pkg/.appx/.msix through the relevant store dashboard.')
  if (hasMac && process.env.ASKTOTO_SIGN_INSTALLER !== '1') {
    console.log('\nNote: local macOS installers are unsigned by default to avoid keychain prompts.')
    console.log('Set ASKTOTO_SIGN_INSTALLER=1 or use npm run release for signed/notarized customer builds.')
  }
}

const requestedTargets = targetsFor(target)

if (target === 'all' && platform() !== 'darwin' && platform() !== 'win32') {
  console.error('Cross-platform installer builds should run on macOS or Windows, or use GitHub Actions.')
  process.exit(2)
}

if (target === 'all' && platform() === 'win32') {
  console.warn('Windows can build Windows installers locally. Build macOS installers on a macOS runner.')
}
if (target === 'all' && platform() === 'darwin') {
  console.warn('macOS can build macOS installers locally. Windows installer builds may require Wine; GitHub Actions is safer.')
}

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })

run('node', ['scripts/check-no-dynamic-import.mjs'])
if (requestedTargets.includes('mac')) run('node', ['scripts/check-xcode-tools.mjs'])
for (const target of requestedTargets) run('node', ['scripts/check-ffmpeg-sidecar.mjs', target])
for (const target of requestedTargets) run('node', ['scripts/check-sherpa-platform.mjs', target])
for (const target of requestedTargets) run('node', ['scripts/fetch-llama-server.mjs', target])
for (const target of requestedTargets) run('node', ['scripts/check-llama-sidecar.mjs', target])
run('node', ['scripts/fetch-models.mjs'])
run('npm', ['run', 'build:intelligence'])
run('npx', ['electron-vite', 'build'])

for (const t of requestedTargets) {
  if (t === 'mac') {
    const args = ['electron-builder', '--mac', '--publish', 'never']
    if (process.env.ASKTOTO_SIGN_INSTALLER !== '1') args.push('-c.mac.identity=null')
    run('npx', args)
  }
  if (t === 'win') run('npx', ['electron-builder', '--win', '--x64', '--publish', 'never'])
}

printInstallHelp(artifactFiles())
