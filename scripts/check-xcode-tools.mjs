#!/usr/bin/env node
// macOS installer/release preflight. AskToto is packaged by electron-builder, but macOS packaging
// still depends on Apple's developer toolchain for signing, notarization, product packages, and DMG
// validation. Fail early with actionable output if Xcode is not installed/selected.

import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'

if (platform() !== 'darwin') {
  console.log('[check:xcode] skipped - Xcode tools are only required on macOS')
  process.exit(0)
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    const detail = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
    throw new Error(`${cmd} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
}

function findTool(name) {
  const path = run('xcrun', ['--find', name])
  if (!path) throw new Error(`xcrun could not find ${name}`)
  return path
}

try {
  const selected = run('xcode-select', ['-p'])
  const version = run('xcodebuild', ['-version']).replace(/\n/g, ' / ')
  const sdkPath = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'])
  const sdkVersion = run('xcrun', ['--sdk', 'macosx', '--show-sdk-version'])
  const tools = ['codesign', 'productbuild', 'notarytool', 'stapler'].map((name) => `${name}=${findTool(name)}`)

  console.log(`[check:xcode] ${version}`)
  console.log(`[check:xcode] selected=${selected}`)
  console.log(`[check:xcode] macosx-sdk=${sdkVersion} (${sdkPath})`)
  for (const tool of tools) console.log(`[check:xcode] ${tool}`)
} catch (e) {
  console.error(`[check:xcode] FAIL - ${e instanceof Error ? e.message : String(e)}`)
  console.error('[check:xcode] Install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer')
  process.exit(1)
}
