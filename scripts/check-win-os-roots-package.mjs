import { createHash } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { extractFile } from '@electron/asar'

const resourcesRoot = resolve(process.argv[2] || '')
const prepackage = process.argv[3] === '--prepackage'
if (!process.argv[2] || (process.argv[3] && !prepackage)) {
  throw new Error('Usage: node scripts/check-win-os-roots-package.mjs <packaged-resources-directory> [--prepackage]')
}
if (process.platform !== 'win32') throw new Error('The Windows OS-root package check must run on Windows.')

const helperPath = join(resourcesRoot, 'win-os-roots', 'osroots.exe')
const helperStat = await lstat(helperPath)
if (!helperStat.isFile() || helperStat.isSymbolicLink())
  throw new Error('The packaged Windows OS-root helper must be a regular file.')
const helper = await readFile(helperPath)
let manifestBytes
if (prepackage) {
  const manifestPath = join(resourcesRoot, 'win-os-roots', 'osroots.manifest.json')
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error('The build inventory must be a regular file.')
  manifestBytes = await readFile(manifestPath)
} else {
  const archivePath = join(resourcesRoot, 'app.asar')
  const archiveStat = await lstat(archivePath)
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink())
    throw new Error('The packaged app archive must be a regular file.')
  manifestBytes = extractFile(archivePath, 'out/main/win-os-roots.manifest.json')
}
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const manifestKeys = Object.keys(manifest).sort().join(',')
if (
  manifestKeys !== 'bytes,helperVersion,path,schemaVersion,sha256' ||
  manifest.schemaVersion !== 1 ||
  manifest.helperVersion !== 1 ||
  manifest.path !== 'win-os-roots/osroots.exe' ||
  manifest.bytes !== helper.byteLength ||
  typeof manifest.sha256 !== 'string' ||
  !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
  createHash('sha256').update(helper).digest('hex') !== manifest.sha256
) {
  throw new Error('Packaged Windows OS-root helper differs from its exact app inventory.')
}
if (helper.length < 64 || helper.toString('ascii', 0, 2) !== 'MZ') {
  throw new Error('Packaged Windows OS-root helper is not a PE executable.')
}
const peOffset = helper.readUInt32LE(0x3c)
if (
  peOffset < 64 ||
  peOffset + 6 > helper.length ||
  helper.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' ||
  helper.readUInt16LE(peOffset + 4) !== 0x8664
) {
  throw new Error('Packaged Windows OS-root helper is not x64 PE.')
}

const poisoned = 'Z:\\metis-caller-controlled'
for (const env of [
  { SystemRoot: poisoned, SYSTEMROOT: poisoned, windir: poisoned, WINDIR: poisoned, PATH: '' },
  { PATH: '' }
]) {
  const output = spawnSync(helperPath, ['--json'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    env
  })
  if (output.error || output.status !== 0 || output.stderr !== '' || output.stdout.length > 2048) {
    throw new Error('Packaged Windows OS-root helper did not return a bounded success response.')
  }
  const lines = output.stdout.split('\n')
  if (lines.length !== 2 || lines[1] !== '') throw new Error('Packaged helper did not emit exactly one JSON line.')
  const result = JSON.parse(lines[0])
  if (
    Object.keys(result).sort().join(',') !== 'systemRoot,version,windowsRoot' ||
    result.version !== 1 ||
    typeof result.windowsRoot !== 'string' ||
    typeof result.systemRoot !== 'string' ||
    result.windowsRoot.toLowerCase() === poisoned.toLowerCase() ||
    result.systemRoot.toLowerCase() === poisoned.toLowerCase() ||
    result.systemRoot.toLowerCase() !== join(result.windowsRoot, 'System32').toLowerCase()
  ) {
    throw new Error('Packaged helper returned invalid or caller-controlled Windows system directories.')
  }
  for (const path of [result.windowsRoot, result.systemRoot]) {
    const stat = await lstat(path)
    if (!stat.isDirectory()) throw new Error('Packaged helper returned a path that is not an OS directory.')
  }
}

const invalid = spawnSync(helperPath, ['unexpected-argument'], {
  encoding: 'utf8',
  timeout: 3000,
  windowsHide: true,
  env: { SystemRoot: poisoned, windir: poisoned, PATH: '' }
})
if (
  invalid.error ||
  invalid.status !== 2 ||
  invalid.stderr !== '' ||
  invalid.stdout !== '{"version":1,"error":"ARGUMENTS_INVALID"}\n'
) {
  throw new Error('Packaged helper did not return its fixed closed failure object for invalid arguments.')
}
console.log('Packaged Windows OS-root helper: inventory, x64 PE, poisoned-env positive, and fixed-error checks passed.')
