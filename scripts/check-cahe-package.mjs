#!/usr/bin/env node
import { extractFile, listPackage } from '@electron/asar'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const outputDirectory = process.argv[2]
if (!outputDirectory) {
  throw new Error('Usage: node scripts/check-cahe-package.mjs <output-directory>')
}

const outputRoot = resolve(outputDirectory)
const installerPattern = /^Metis-Windows-Cahe-Setup-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\.exe$/
const installers = readdirSync(outputRoot).filter((name) => installerPattern.test(name))
if (installers.length !== 1) {
  throw new Error(`Expected exactly one Cahê installer, found: ${installers.join(', ') || 'none'}`)
}

const installer = join(outputRoot, installers[0])
if (!statSync(installer).isFile() || statSync(installer).size === 0) {
  throw new Error(`Cahê installer is missing or empty: ${installer}`)
}

const executable = join(outputRoot, 'win-unpacked', 'Metis-Windows-Cahe.exe')
if (!existsSync(executable) || statSync(executable).size === 0) {
  throw new Error(`Cahê executable is missing or empty: ${executable}`)
}

const appAsar = join(outputRoot, 'win-unpacked', 'resources', 'app.asar')
const sourceMainLoader = readFileSync(join(repositoryRoot, 'out/main/index.js'))
const sourceMainBytecode = readFileSync(join(repositoryRoot, 'out/main/index.jsc'))
// @electron/asar keys entries with the packing host's separator (backslash on Windows). Resolve each
// reviewed POSIX path back to the archive's native key so extraction works regardless of build OS.
const extractPackaged = (posixPath) => {
  const wanted = `/${posixPath.replace(/^\/+/, '')}`
  const rawKey = listPackage(appAsar).find(
    (entry) => `/${entry.split('\\').join('/').replace(/^\/+/, '')}` === wanted
  )
  if (!rawKey) throw new Error(`Cahê package is missing ${posixPath}`)
  return extractFile(appAsar, rawKey.replace(/^[\\/]+/, ''))
}
const packagedMainLoader = extractPackaged('out/main/index.js')
const packagedMainBytecode = extractPackaged('out/main/index.jsc')

if (!packagedMainLoader.toString('utf8').includes('require("./index.jsc")')) {
  throw new Error('Cahê package does not contain the bytecode main-process loader')
}
if (!packagedMainLoader.equals(sourceMainLoader)) {
  throw new Error('Cahê package main-process loader differs from the just-built source loader')
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
if (sha256(packagedMainBytecode) !== sha256(sourceMainBytecode)) {
  throw new Error('Cahê package main-process bytecode differs from the just-built source bytecode')
}

const kimiKeyPattern = /sk-kimi-[A-Za-z0-9_-]{16,}/

// EXPLICIT, DOCUMENTED EXCEPTION — not a loophole: the Cahê pilot intentionally embeds a Kimi API key
// (src/main/cahe-embedded-key.ts + electron-builder.cahe.win.yml's extraResources) so the pilot works
// with zero setup. This gate stays a hard refusal by default; METIS_CAHE_EMBED_KEY=1 is the one,
// deliberate way to acknowledge the trade-off for a build that is meant to ship the key. Leaving the
// flag unset keeps the original "never allow an embedded Kimi key" behavior byte-for-byte.
const ALLOW_EMBEDDED_KIMI_KEY = process.env.METIS_CAHE_EMBED_KEY === '1'
let embeddedKeyFound = false

function warnEmbeddedKimiKey(path) {
  embeddedKeyFound = true
  console.log(`
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
⚠️  Cahê build intentionally embeds a Kimi API key — it is EXTRACTABLE from the installer;
⚠️  scope/rotate that key. This is expected ONLY because METIS_CAHE_EMBED_KEY=1 was set.
⚠️  Found in: ${basename(path)}
⚠️  Do not reuse a key that guards anything beyond this pilot's minimum plan/quota, and be
⚠️  ready to rotate or revoke it — packaging it does not keep it secret once it ships.
⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️ ⚠️
`)
}

async function assertNoEmbeddedKimiKey(path) {
  await new Promise((resolvePromise, rejectPromise) => {
    let carry = ''
    const stream = createReadStream(path)
    stream.on('data', (chunk) => {
      const text = carry + chunk.toString('latin1')
      if (kimiKeyPattern.test(text)) {
        if (ALLOW_EMBEDDED_KIMI_KEY) {
          warnEmbeddedKimiKey(path)
          resolvePromise()
          stream.destroy()
          return
        }
        stream.destroy(new Error(`Refusing Cahê package with an embedded Kimi API key: ${basename(path)}`))
        return
      }
      carry = text.slice(-64)
    })
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
}

// The key is in neither of these: electron-builder.cahe.win.yml copies it to resources/cahe/ as an
// extraResource (outside app.asar), and NSIS ships win-unpacked inside an LZMA-compressed app-64.7z,
// so a raw byte scan of the .exe cannot see it. Scanning the packaged extraResources directory is what
// makes this gate's refusal real; the two below stay as a net for a key that lands somewhere it was
// never meant to be.
await assertNoEmbeddedKimiKey(appAsar)
await assertNoEmbeddedKimiKey(installer)
const packagedCaheResources = join(outputRoot, 'win-unpacked', 'resources', 'cahe')
// Absent on a deliberately keyless build (METIS_CAHE_ALLOW_KEYLESS=1) — nothing to scan, not a failure.
if (existsSync(packagedCaheResources)) {
  for (const entry of readdirSync(packagedCaheResources, { recursive: true })) {
    const file = join(packagedCaheResources, entry)
    if (statSync(file).isFile()) await assertNoEmbeddedKimiKey(file)
  }
}
console.log(
  embeddedKeyFound
    ? `[check:cahe-package] OK ${installers[0]} — current bytecode, distinct identity, embedded Kimi key explicitly allowed (METIS_CAHE_EMBED_KEY=1)`
    : `[check:cahe-package] OK ${installers[0]} — current bytecode, distinct identity, no embedded Kimi key`
)
