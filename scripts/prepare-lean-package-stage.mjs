import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventoryCoreFiles, packageInventoryIdentity, validatePackageInventory } from './lib/package-inventory.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env.METIS_PACKAGE_PROFILE ?? 'full'
const args = process.argv.slice(2)
const [platform, arch] = args
const PLATFORM_ARCHES = { darwin: ['arm64', 'x64'], win32: ['x64'] }

function fail(message) {
  throw new Error(`[prepare-lean-package-stage] ${message}`)
}

if (PROFILE !== 'lean') fail('this staging command only accepts METIS_PACKAGE_PROFILE=lean')
if (!platform || !Object.hasOwn(PLATFORM_ARCHES, platform)) fail('usage: METIS_PACKAGE_PROFILE=lean node scripts/prepare-lean-package-stage.mjs <darwin|win32> <arm64|x64>')
if (!PLATFORM_ARCHES[platform].includes(arch)) fail(`unsupported architecture ${arch} for ${platform}`)

const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'))
const electronVersion = lock.packages?.['node_modules/electron']?.version
if (!electronVersion || electronVersion !== packageJson.devDependencies?.electron) {
  fail('locked Electron version is missing or differs from the package manifest')
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail('git did not return a full source commit')
const sourceChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: ROOT, encoding: 'utf8' }).trim()
if (sourceChanges) fail('candidate inventory requires a clean source checkout so sourceCommit identifies the built source')

const stageRoot = join(ROOT, 'build', 'lean-stage')
const resourcesRoot = join(stageRoot, 'resources')
await rm(stageRoot, { recursive: true, force: true })
await mkdir(resourcesRoot, { recursive: true })

async function copyTree(sourceRelative, destinationRelative = sourceRelative) {
  const source = join(ROOT, sourceRelative)
  const destination = join(resourcesRoot, destinationRelative)
  let stat
  try {
    stat = await lstat(source)
  } catch (error) {
    fail(`required core resource is missing: ${sourceRelative} (${error.code ?? error.message})`)
  }
  if (stat.isSymbolicLink()) fail(`symbolic links are not accepted in staged core resources: ${sourceRelative}`)
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const name of await readdir(source)) {
      await copyTree(join(sourceRelative, name), join(destinationRelative, name))
    }
    return
  }
  if (!stat.isFile()) fail(`core resource is not a regular file: ${sourceRelative}`)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { errorOnExist: true, force: false, preserveTimestamps: true })
}

const targetFolder = `${platform}-${arch}`
const managedNodeFolder = platform === 'win32' ? 'win-x64' : targetFolder
await copyTree('intelligence/dist', 'intelligence')
await copyTree('build/managed-config.example.json', 'managed-config.example.json')
await copyTree('build/managed-config.enterprise.example.json', 'managed-config.enterprise.example.json')
await copyTree('build/icon.png', 'icon.png')
await copyTree('build/tray', 'tray')
await copyTree('resources/graphify_runner.py', 'graphify_runner.py')
await copyTree('resources/speech-pack-fixtures/en.wav', 'speech-pack-fixtures/en.wav')
await copyTree('THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md')
await copyTree('skills', 'skills')
await copyTree('build/cloudflare-embed', 'cloudflare-embed')
await copyTree('resources/operator', 'operator')
await copyTree('resources/license-lease', 'license-lease')
await copyTree(`resources/ffmpeg/${targetFolder}`, `ffmpeg/${targetFolder}`)
await copyTree('resources/ffmpeg/manifest.json', 'ffmpeg/manifest.json')
await copyTree('resources/ffmpeg/LICENSE.LGPL-2.1.txt', 'ffmpeg/LICENSE.LGPL-2.1.txt')
await copyTree(`resources/managed-node/${managedNodeFolder}`, `managed-node/${managedNodeFolder}`)
if (platform === 'darwin') {
  await copyTree('resources/mac-helper', 'mac-helper')
} else {
  await copyTree('resources/vcredist', 'vcredist')
}

const packageProfilePath = join(resourcesRoot, 'speech-pack-profile.json')
await writeFile(packageProfilePath, '{"schema":1,"profile":"lean"}\n', { flag: 'wx', mode: 0o644 })

// Installer signing rewrites executable files. Their presence and platform shape are checked against
// the existing signed-sidecar gates; the immutable core inventory records stable staged resources.
const signedPayloads = new Set([
  `ffmpeg/${targetFolder}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`,
  `managed-node/${managedNodeFolder}/${platform === 'win32' ? 'node.exe' : 'bin/node'}`,
  ...(platform === 'darwin' ? ['mac-helper/metis-mac-helper'] : ['vcredist/vc_redist.x64.exe'])
])
const allCoreFiles = await inventoryCoreFiles(resourcesRoot)
const coreFiles = allCoreFiles.filter((file) => !signedPayloads.has(file.path))
const inventory = {
  schema: 1,
  profile: 'lean',
  platform,
  arch,
  appVersion: packageJson.version,
  electronVersion,
  sourceCommit,
  coreFiles
}
inventory.identity = packageInventoryIdentity(inventory)
validatePackageInventory(inventory)
await writeFile(join(resourcesRoot, 'package-inventory.json'), `${JSON.stringify(inventory)}\n`, { flag: 'wx', mode: 0o644 })

// Build-time self-check: every inventory path is inside the dedicated stage and matches its claimed bytes.
for (const file of coreFiles) {
  const path = join(resourcesRoot, ...file.path.split('/'))
  const bytes = await readFile(path)
  if (bytes.byteLength !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    fail(`staged core resource changed while inventory was being written: ${file.path}`)
  }
}

const relStageRoot = relative(ROOT, stageRoot).split(sep).join('/')
console.log(`[prepare-lean-package-stage] profile=lean platform=${platform} arch=${arch} coreFiles=${coreFiles.length} inventory=${inventory.identity}`)
console.log(`[prepare-lean-package-stage] staged resources at ${relStageRoot}/resources`)
