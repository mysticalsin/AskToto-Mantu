#!/usr/bin/env node
// Pinned installer for Microsoft's "ArtifactSigning" PowerShell module (Lane C / L2-wrapper-hook —
// integration-design.md §2.3 option B, §F7). scripts/azure-sign-hook.cjs calls the module's
// Invoke-ArtifactSigning cmdlet but never installs it and never talks to PSGallery itself — this
// script is the only thing that downloads it, and only for one exact, hash-pinned version.
//
// `node scripts/artifact-signing-module.mjs install`:
//   1. Downloads the nupkg for PINNED.version from PSGallery's v2 package endpoint (which redirects
//      to its CDN — verified 2026-09-24, see notes below).
//   2. Verifies its SHA-256 against PINNED.sha256 before extracting anything.
//   3. Extracts (a nupkg is a plain ZIP; no third-party zip dependency is added — see extractZip
//      below) into $RUNNER_TEMP/artifact-signing/<version>, confined to that directory (zip-slip guard).
//   4. Parses the extracted ArtifactSigning.psd1 and verifies ModuleVersion equals PINNED.version
//      exactly, and that it declares no RequiredModules (this version doesn't; if a future pinned
//      version ever added one, that would be an unpinned second PSGallery dependency and this fails
//      closed rather than silently trusting it).
//   5. Writes ARTIFACT_SIGNING_MODULE_PATH=<psd1 path> to $GITHUB_ENV when present, and prints it.
//
// Verified 2026-09-24: https://www.powershellgallery.com/api/v2/package/ArtifactSigning (latest) and
// .../ArtifactSigning/0.1.20 (exact) both redirect to
// https://cdn.powershellgallery.com/packages/artifactsigning.0.1.20.nupkg and give the same bytes,
// sha256 ff7f77717752a640103b12dc176099761f472b96b4da2b9b2362e0a46a172810. The manifest
// (ArtifactSigning.psd1) declares RootModule=ArtifactSigning.psm1, FunctionsToExport=
// @("Invoke-ArtifactSigning"), and no RequiredModules key. Its nuspec has no <dependencies> either.
// Its NestedModules (ClickOnce, DotnetCheck, FileFormat, Metadata, NugetInstall, SignTool, SignCli)
// ship inside this same package and are not a separate gallery dependency; at run time
// Invoke-ArtifactSigning itself downloads pinned-by-the-module NuGet packages
// (Microsoft.Windows.SDK.BuildTools, Microsoft.ArtifactSigning.Client, sign) — that is the module's
// own supply chain, out of scope for this installer to re-pin.

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PINNED = {
  name: 'ArtifactSigning',
  version: '0.1.20',
  sha256: 'ff7f77717752a640103b12dc176099761f472b96b4da2b9b2362e0a46a172810'
}

export function downloadUrl(pinned = PINNED) {
  return `https://www.powershellgallery.com/api/v2/package/${pinned.name}/${pinned.version}`
}

export function installRoot(env = process.env, pinned = PINNED) {
  return join(env.RUNNER_TEMP || tmpdir(), 'artifact-signing', pinned.version)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function downloadModule({ fetchFn = fetch, pinned = PINNED } = {}) {
  const url = downloadUrl(pinned)
  const response = await fetchFn(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`ARTIFACT_SIGNING_DOWNLOAD_FAILED:${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const digest = sha256(buffer)
  if (digest !== pinned.sha256) throw new Error('ARTIFACT_SIGNING_SHA256_MISMATCH')
  return buffer
}

// --- Minimal dependency-free ZIP reader (a .nupkg is a plain ZIP/OOXML container). No third-party
// zip package is added: node_modules is a symlinked, shared tree here and this repo's own convention
// (fetch-managed-node.mjs, fetch-speaker-model.mjs) is checksum-then-use with stdlib only. Only the
// two record types and the one compression method (deflate; PSGallery packages are small enough that
// "stored" is also handled) this package actually uses are supported; anything else fails closed.

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const MAX_COMMENT_LENGTH = 65_535

function findEndOfCentralDirectory(buffer) {
  const searchStart = Math.max(0, buffer.length - 22 - MAX_COMMENT_LENGTH)
  for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('ARTIFACT_SIGNING_ZIP_EOCD_NOT_FOUND')
}

export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralDirectorySize = buffer.readUInt32LE(eocd + 12)
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16)
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new Error('ARTIFACT_SIGNING_ZIP_CENTRAL_DIRECTORY_INVALID')
  }
  const entries = []
  let pointer = centralDirectoryOffset
  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(pointer) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('ARTIFACT_SIGNING_ZIP_CENTRAL_ENTRY_INVALID')
    }
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const uncompressedSize = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localHeaderOffset = buffer.readUInt32LE(pointer + 42)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('ARTIFACT_SIGNING_ZIP64_UNSUPPORTED')
    }
    const nameStart = pointer + 46
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength)
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset })
    pointer = nameStart + nameLength + extraLength + commentLength
  }
  return entries
}

export function extractZipEntry(buffer, entry) {
  const offset = entry.localHeaderOffset
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('ARTIFACT_SIGNING_ZIP_LOCAL_ENTRY_INVALID')
  }
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`ARTIFACT_SIGNING_ZIP_METHOD_UNSUPPORTED:${entry.method}`)
}

// Confines every extracted path under `root` (rejects `..`, an absolute entry name, or any resolved
// path that escapes it — the classic zip-slip). Directory entries (trailing "/") are skipped; there is
// nothing in this package that needs an explicitly-created empty directory.
export function extractZip(buffer, root) {
  const resolvedRoot = resolve(root)
  for (const entry of readZipEntries(buffer)) {
    if (entry.name.endsWith('/')) continue
    if (isAbsolute(entry.name) || entry.name.split(/[\\/]/).includes('..')) {
      throw new Error(`ARTIFACT_SIGNING_ZIP_PATH_UNSAFE:${entry.name}`)
    }
    const destination = normalize(join(resolvedRoot, entry.name))
    if (destination !== resolvedRoot && !destination.startsWith(resolvedRoot + sep)) {
      throw new Error(`ARTIFACT_SIGNING_ZIP_PATH_UNSAFE:${entry.name}`)
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, extractZipEntry(buffer, entry))
  }
}

// --- Manifest verification (no PowerShell dependency: this only needs to read two hashtable keys) ---

export function parseManifestVersion(psd1Source) {
  const match = psd1Source.match(/ModuleVersion\s*=\s*['"]([^'"]+)['"]/)
  if (!match) throw new Error('ARTIFACT_SIGNING_MANIFEST_VERSION_MISSING')
  return match[1]
}

export function parseManifestRequiredModules(psd1Source) {
  const match = psd1Source.match(/RequiredModules\s*=\s*@\(([^)]*)\)/s)
  if (!match) return []
  return match[1].split(',').map((entry) => entry.trim()).filter(Boolean)
}

export function verifyManifest(psd1Source, pinned = PINNED) {
  const version = parseManifestVersion(psd1Source)
  if (version !== pinned.version) throw new Error(`ARTIFACT_SIGNING_MANIFEST_VERSION_MISMATCH:${version}`)
  const requiredModules = parseManifestRequiredModules(psd1Source)
  if (requiredModules.length > 0) throw new Error('ARTIFACT_SIGNING_REQUIRED_MODULES_UNSUPPORTED')
  return version
}

export async function installArtifactSigningModule({ env = process.env, fetchFn = fetch, pinned = PINNED } = {}) {
  const buffer = await downloadModule({ fetchFn, pinned })
  const root = installRoot(env, pinned)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  extractZip(buffer, root)

  const psd1Path = join(root, `${pinned.name}.psd1`)
  verifyManifest(readFileSync(psd1Path, 'utf8'), pinned)

  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `ARTIFACT_SIGNING_MODULE_PATH=${psd1Path}\n`)
  return psd1Path
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  const command = process.argv[2]
  if (command !== 'install') {
    console.error('Usage: node scripts/artifact-signing-module.mjs install')
    process.exit(2)
  }
  installArtifactSigningModule()
    .then((psd1Path) => {
      console.log(`[artifact-signing-module] OK - ${PINNED.name} ${PINNED.version} -> ${psd1Path}`)
    })
    .catch((error) => {
      console.error(`[artifact-signing-module] FAIL - ${error.message}`)
      process.exitCode = 1
    })
}
