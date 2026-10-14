#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXPERIMENTS = Object.freeze({
  'mac-arm64-udbz': Object.freeze({
    target: 'mac',
    arch: 'arm64',
    builderArgs: Object.freeze(['-c.compression=maximum', '-c.dmg.format=UDBZ'])
  }),
  'mac-arm64-ulfo': Object.freeze({
    target: 'mac',
    arch: 'arm64',
    builderArgs: Object.freeze(['-c.compression=maximum', '-c.dmg.format=ULFO'])
  }),
  'mac-x64-udbz': Object.freeze({
    target: 'mac',
    arch: 'x64',
    builderArgs: Object.freeze(['-c.compression=maximum', '-c.dmg.format=UDBZ'])
  }),
  'mac-x64-ulfo': Object.freeze({
    target: 'mac',
    arch: 'x64',
    builderArgs: Object.freeze(['-c.compression=maximum', '-c.dmg.format=ULFO'])
  }),
  'win-x64-solid': Object.freeze({
    target: 'win',
    arch: 'x64',
    builderArgs: Object.freeze(['-c.compression=maximum', '-c.nsis.differentialPackage=false'])
  })
})

const [target, arch, outputArgument, experimentId] = process.argv.slice(2)
if (!['mac', 'win'].includes(target) || !['arm64', 'x64'].includes(arch) || !outputArgument || !experimentId) {
  throw new Error(
    'Usage: node scripts/measure-lean-candidate.mjs <mac|win> <arm64|x64> <release-directory> <experiment-id>'
  )
}
if (target === 'win' && arch !== 'x64') throw new Error('Windows lean candidates are x64 only')
const experiment = Object.hasOwn(EXPERIMENTS, experimentId) ? EXPERIMENTS[experimentId] : null
if (!experiment || experiment.target !== target || experiment.arch !== arch) {
  throw new Error('Measurement target and experiment must match one of the closed lean compression variants')
}
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

const extension = target === 'mac' ? '.dmg' : '.exe'
const installers = (await walk(outputRoot))
  .filter((path) => path.toLowerCase().endsWith(extension) && !path.includes(`${sep}win-unpacked${sep}`))
  .sort()
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
const under150MB = installerBytes.byteLength < 150_000_000
const output = {
  schema: 1,
  profile: 'lean',
  target,
  arch,
  experiment: { id: experimentId, builderArgs: experiment.builderArgs },
  workflowSha: process.env.GITHUB_SHA ?? null,
  workflowRef: process.env.GITHUB_REF ?? null,
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
    under150MB
  }
}
const evidenceDir = join(ROOT, 'build', 'lean-measurements')
await mkdir(evidenceDir, { recursive: true })
const evidencePath = join(evidenceDir, `${target}-${arch}.json`)
await writeFile(evidencePath, `${JSON.stringify(output, null, 2)}\n`)
console.log(`[lean-measurement] ${JSON.stringify(output)}`)
console.log(`[lean-measurement] evidence=${relative(ROOT, evidencePath)}`)
if (!under150MB) {
  console.error(`[lean-measurement] nonpromotable installer bytes=${installerBytes.byteLength} requiredBelow=150000000`)
  process.exitCode = 1
}
