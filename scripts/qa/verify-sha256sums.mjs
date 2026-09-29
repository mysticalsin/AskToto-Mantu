#!/usr/bin/env node
// Verifies downloaded release artifacts against the release's published SHA256SUMS before anything is installed.
// Invariant: every file in the artifact directory must be listed in the sums file with a matching digest; a
// missing entry, a mismatch or an empty directory is a failure, never a skip.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseSha256Sums(text) {
  const entries = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line)
    if (!match) throw new Error(`Unparseable SHA256SUMS line: ${line}`)
    entries.set(basename(match[2].trim()), match[1].toLowerCase())
  }
  return entries
}

export function verifyArtifacts(sumsText, artifacts) {
  const expected = parseSha256Sums(sumsText)
  if (artifacts.length === 0) throw new Error('No artifacts to verify.')
  const failures = []
  for (const { name, sha256 } of artifacts) {
    const published = expected.get(name)
    if (!published) failures.push(`${name}: not listed in SHA256SUMS`)
    else if (published !== sha256.toLowerCase()) failures.push(`${name}: digest mismatch (published ${published}, got ${sha256})`)
  }
  if (failures.length > 0) throw new Error(`SHA256SUMS verification failed:\n${failures.join('\n')}`)
  return artifacts.map((a) => a.name)
}

export function hashDirectory(dir) {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, sha256: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') }))
}

function main(argv) {
  const [dir, sumsFile] = argv
  if (!dir || !sumsFile) throw new Error('usage: verify-sha256sums.mjs <artifact-dir> <SHA256SUMS-file>')
  const verified = verifyArtifacts(readFileSync(sumsFile, 'utf8'), hashDirectory(dir))
  console.log(`SHA256SUMS verified: ${verified.join(', ')}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
