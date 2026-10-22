#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectLeanInstallers } from './lib/lean-installer-selection.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [target, arch, outputArgument] = process.argv.slice(2)
if (!['mac', 'win'].includes(target) || !['arm64', 'x64'].includes(arch) || !outputArgument) {
  throw new Error('Usage: node scripts/measure-lean-candidate.mjs <mac|win> <arm64|x64> <release-directory>')
}
if (target === 'win' && arch !== 'x64') throw new Error('Windows lean candidates are x64 only')
const outputRoot = join(ROOT, outputArgument)

async function walk(directory, results = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, results)
    else if (entry.isFile() || entry.isSymbolicLink()) results.push(path)
    else throw new Error(`Unsupported packaged entry: ${path}`)
  }
  return results
}

async function bytesIn(directory) {
  let total = 0
  for (const path of await walk(directory)) total += (await lstat(path)).size
  return total
}

let appDirectory = join(outputRoot, 'win-unpacked')
if (target === 'mac') {
  const appRoots = (await readdir(outputRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(outputRoot, entry.name, 'Metis.app'))
  const existingApps = []
  for (const candidate of appRoots) {
    try {
      if ((await lstat(candidate)).isDirectory()) existingApps.push(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (existingApps.length !== 1)
    throw new Error(`Expected exactly one unpacked macOS app, found ${existingApps.length}`)
  appDirectory = existingApps[0]
}
const resourcesDirectory =
  target === 'mac' ? join(appDirectory, 'Contents', 'Resources') : join(appDirectory, 'resources')
const inventory = JSON.parse(await readFile(join(resourcesDirectory, 'package-inventory.json'), 'utf8'))
if (
  inventory.profile !== 'lean' ||
  inventory.arch !== arch ||
  inventory.platform !== (target === 'mac' ? 'darwin' : 'win32')
) {
  throw new Error('Packaged inventory does not match the requested candidate measurement target')
}

const installers = selectLeanInstallers(await walk(outputRoot), target).sort()
if (installers.length !== 1) throw new Error(`Expected exactly one lean installer, found ${installers.length}`)
const installer = installers[0]
const installerBytes = await readFile(installer)
const categories = {}
for (const [name, relativePath] of Object.entries({
  asar: 'app.asar',
  asarUnpacked: 'app.asar.unpacked',
  ffmpeg: 'ffmpeg',
  managedNode: 'managed-node',
  macHelper: 'mac-helper',
  intelligence: 'intelligence',
  skills: 'skills',
  resourcesTotal: '.'
})) {
  const path = join(resourcesDirectory, relativePath)
  try {
    if ((await lstat(path)).isDirectory()) categories[name] = await bytesIn(path)
    else categories[name] = (await lstat(path)).size
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    categories[name] = 0
  }
}
const appBytes = await bytesIn(appDirectory)
const output = {
  schema: 1,
  profile: 'lean',
  target,
  arch,
  sourceCommit: inventory.sourceCommit,
  packageInventoryIdentity: inventory.identity,
  appVersion: inventory.appVersion,
  electronVersion: inventory.electronVersion,
  appTreeBytes: appBytes,
  categories,
  installer: {
    name: relative(outputRoot, installer).split(sep).join('/'),
    bytes: installerBytes.byteLength,
    sha256: createHash('sha256').update(installerBytes).digest('hex'),
    under150MB: installerBytes.byteLength < 150_000_000
  }
}
const evidenceDir = join(ROOT, 'build', 'lean-measurements')
await mkdir(evidenceDir, { recursive: true })
const evidencePath = join(evidenceDir, `${target}-${arch}.json`)
await writeFile(evidencePath, `${JSON.stringify(output, null, 2)}\n`)
console.log(`[lean-measurement] ${JSON.stringify(output)}`)
console.log(`[lean-measurement] evidence=${relative(ROOT, evidencePath)}`)
