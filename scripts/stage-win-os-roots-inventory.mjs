import { copyFile, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

if (process.platform !== 'win32') throw new Error('The Windows OS-root inventory must be staged on Windows.')
const helperManifest = join('resources', 'win-os-roots', 'osroots.manifest.json')
const appMain = join('out', 'main')
const destination = join(appMain, 'win-os-roots.manifest.json')
const helperStat = await lstat(join('resources', 'win-os-roots', 'osroots.exe'))
if (!helperStat.isFile() || helperStat.isSymbolicLink())
  throw new Error('The generated Windows helper is not a regular file.')
const manifest = JSON.parse(await readFile(helperManifest, 'utf8'))
const keys = Object.keys(manifest).sort().join(',')
if (
  keys !== 'bytes,helperVersion,path,schemaVersion,sha256' ||
  manifest.schemaVersion !== 1 ||
  manifest.helperVersion !== 1 ||
  manifest.path !== 'win-os-roots/osroots.exe' ||
  !Number.isSafeInteger(manifest.bytes) ||
  manifest.bytes !== helperStat.size ||
  typeof manifest.sha256 !== 'string' ||
  !/^[0-9a-f]{64}$/.test(manifest.sha256)
) {
  throw new Error('The generated Windows helper inventory is invalid.')
}
const mainStat = await lstat(appMain)
if (!mainStat.isDirectory() || mainStat.isSymbolicLink())
  throw new Error('The compiled app main directory is not a real directory.')
await copyFile(helperManifest, destination)
console.log('Staged the helper byte inventory inside app.asar at out/main/win-os-roots.manifest.json.')
