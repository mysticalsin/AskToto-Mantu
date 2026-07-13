#!/usr/bin/env node
/** Verify electron-updater metadata names, sizes, and SHA-512 values against the built artifacts. */
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function scalar(value) {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseMetadata(source) {
  const top = {}
  const files = []
  let current
  for (const line of source.split(/\r?\n/)) {
    const topLevel = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (topLevel) {
      top[topLevel[1]] = scalar(topLevel[2])
      current = undefined
      continue
    }
    const item = line.match(/^\s+-\s+url:\s*(.+)$/)
    if (item) {
      current = { url: scalar(item[1]) }
      files.push(current)
      continue
    }
    const property = current && line.match(/^\s+(sha512|size):\s*(.+)$/)
    if (property) current[property[1]] = scalar(property[2])
  }
  return { top, files }
}

function requirePlainArtifactName(name, label) {
  if (!name || name !== basename(name) || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error(`${label} must be a plain artifact filename, got: ${name || '<empty>'}`)
  }
}

function requireRegularFile(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Update artifact must be a regular self-contained file: ${path}`)
  }
  return stat
}

function sha512File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('base64')))
    stream.on('error', reject)
  })
}

async function verifyFile(directory, entry, label) {
  requirePlainArtifactName(entry.url, `${label} path`)
  if (!/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512 || '')) {
    throw new Error(`${label} has an invalid SHA-512 base64 value`)
  }
  const artifactPath = join(directory, entry.url)
  const stat = requireRegularFile(artifactPath)
  if (entry.size !== undefined) {
    const expectedSize = Number(entry.size)
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || stat.size !== expectedSize) {
      throw new Error(`${label} size mismatch for ${entry.url}: expected ${entry.size}, got ${stat.size}`)
    }
  }
  const actual = await sha512File(artifactPath)
  if (actual !== entry.sha512) {
    throw new Error(`${label} SHA-512 mismatch for ${entry.url}`)
  }
}

export async function verifyUpdateMetadata(metadataPath, expectedVersion) {
  const absoluteMetadata = resolve(metadataPath)
  const metadataStat = requireRegularFile(absoluteMetadata)
  if (metadataStat.size <= 0) throw new Error(`Update metadata is empty: ${absoluteMetadata}`)
  const { top, files } = parseMetadata(readFileSync(absoluteMetadata, 'utf8'))
  if (top.version !== expectedVersion) {
    throw new Error(`Update metadata version mismatch: expected ${expectedVersion}, got ${top.version || '<empty>'}`)
  }
  const metadataName = basename(absoluteMetadata)
  const expectedTopArtifact =
    metadataName === 'latest-mac.yml'
      ? `Metis-${expectedVersion}.zip`
      : metadataName === 'latest.yml'
        ? `Metis-Setup-${expectedVersion}.exe`
        : null
  if (!expectedTopArtifact) throw new Error(`Unsupported update metadata filename: ${metadataName}`)
  requirePlainArtifactName(top.path, `${metadataName} top-level path`)
  if (top.path !== expectedTopArtifact) {
    throw new Error(`Update metadata path mismatch: expected ${expectedTopArtifact}, got ${top.path || '<empty>'}`)
  }
  if (!files.length) throw new Error(`Update metadata has no files entries: ${absoluteMetadata}`)

  const directory = dirname(absoluteMetadata)
  for (const [index, entry] of files.entries()) {
    await verifyFile(directory, entry, `${metadataName} files[${index}]`)
  }
  const primary = files.find((entry) => entry.url === top.path)
  if (!primary || primary.sha512 !== top.sha512) {
    throw new Error(`${metadataName} top-level path/SHA-512 does not match its files entry`)
  }
  await verifyFile(directory, { url: top.path, sha512: top.sha512 }, `${metadataName} primary`)
  return { version: top.version, artifact: top.path, files: files.map((entry) => entry.url) }
}

async function main() {
  const metadataFiles = process.argv.slice(2)
  if (!metadataFiles.length) {
    throw new Error('Usage: node scripts/check-update-metadata.mjs <latest-mac.yml|latest.yml> [...]')
  }
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
  for (const metadata of metadataFiles) {
    const result = await verifyUpdateMetadata(metadata, version)
    console.log(
      `[check:update-metadata] OK ${basename(metadata)} — ${result.artifact} and ${result.files.length} file hash(es)`
    )
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[check:update-metadata] FAIL — ${error.message}`)
    process.exit(1)
  })
}
