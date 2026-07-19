#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire
} from '@electron/fuses'
import { pathToFileURL } from 'node:url'

function fail(message) {
  throw new Error(`check-electron-fuses: ${message}`)
}

async function regularFile(path) {
  const stats = await fs.lstat(path)
  return stats.isFile() && !stats.isSymbolicLink()
}

async function resolveExecutable(app) {
  if (!isAbsolute(app)) fail('--app must be absolute')
  const target = resolve(app)
  const stats = await fs.lstat(target).catch(() => null)
  if (!stats || stats.isSymbolicLink()) fail('app path is missing or symlinked')
  if (stats.isFile()) return target
  if (!stats.isDirectory()) fail('app path must be a file or directory')

  const macDirectory = join(target, 'Contents', 'MacOS')
  const macExists = await fs.lstat(macDirectory).then((value) => value.isDirectory(), () => false)
  const directory = macExists ? macDirectory : target
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!macExists && !entry.name.toLowerCase().endsWith('.exe')) continue
    const candidate = join(directory, entry.name)
    if (await regularFile(candidate)) candidates.push(candidate)
  }
  if (candidates.length !== 1) fail('app must contain exactly one executable')
  return candidates[0]
}

function stateName(value) {
  if (value === FuseState.ENABLE) return 'enabled'
  if (value === FuseState.DISABLE) return 'disabled'
  if (value === FuseState.REMOVED) return 'removed'
  if (value === FuseState.INHERIT) return 'inherit'
  return 'unknown'
}

export async function checkElectronFuses({
  app,
  requireRunAsNode = false,
  readFuses = getCurrentFuseWire
}) {
  const executable = await resolveExecutable(app)
  const wire = await readFuses(executable)
  if (wire?.version !== FuseVersion.V1) fail('unsupported or unreadable fuse wire')
  const runAsNodeState = wire[FuseV1Options.RunAsNode]
  const runAsNode = stateName(runAsNodeState)
  if (requireRunAsNode && runAsNodeState !== FuseState.ENABLE) {
    fail(`RunAsNode must be enabled, received ${runAsNode}`)
  }
  const states = {}
  for (const [name, index] of Object.entries(FuseV1Options)) {
    if (typeof index === 'number') states[name] = stateName(wire[index])
  }
  return { executable, runAsNode, states }
}

function parseArgs(args) {
  const options = { requireRunAsNode: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help') return { help: true }
    if (arg === '--require-run-as-node') {
      options.requireRunAsNode = true
      continue
    }
    if (arg === '--app') {
      const value = args[++index]
      if (!value || value.startsWith('--') || options.app) fail('--app requires one value')
      options.app = value
      continue
    }
    fail(`unknown argument ${arg}`)
  }
  return options
}

async function runCli(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  if (options.help) {
    console.log('Usage: node scripts/check-electron-fuses.mjs --app <absolute-app-or-executable> [--require-run-as-node]')
    return
  }
  if (!options.app) fail('--app is required')
  const result = await checkElectronFuses(options)
  console.log(`[check-electron-fuses] RunAsNode=${result.runAsNode} ${result.executable}`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
