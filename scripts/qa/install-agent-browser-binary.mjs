#!/usr/bin/env node

/** Install the pinned Agent Browser native executable only after its GitHub release SHA-256 matches. */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const VERSION = '0.39.0'
const RELEASE_ASSETS = {
  'darwin-arm64': {
    name: 'agent-browser-darwin-arm64',
    bytes: 15_803_424,
    sha256: '636fc9aa269e3819b539998aa5b87e1c3953556c19eeb9685053743283464faa'
  },
  'darwin-x64': {
    name: 'agent-browser-darwin-x64',
    bytes: 17_433_384,
    sha256: 'c080b1c2c4f03c2690778d72f30a0f8807cea1a5946b71e0ab6d71498f2d573e'
  },
  'win32-x64': {
    name: 'agent-browser-win32-x64.exe',
    bytes: 17_920_000,
    sha256: '772d3f2b47fceffde8289308d11979836f4ca3066199c3accfdbd694d5f7610a'
  }
}

function parsePackageDir(args) {
  const index = args.indexOf('--agent-browser-package')
  if (index < 0 || !args[index + 1]) throw new Error('agent-browser-package-required')
  return resolve(args[index + 1])
}

function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function assetForHost() {
  const key = `${process.platform}-${process.arch}`
  const asset = RELEASE_ASSETS[key]
  if (!asset) throw new Error('agent-browser-platform-not-pinned')
  return asset
}

function validateBinaryDirectory(packageRoot, binDir) {
  const directory = lstatSync(binDir)
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('agent-browser-binary-directory-invalid')
  }
  const canonical = realpathSync(binDir)
  if (resolve(canonical) !== resolve(binDir) || !isInside(packageRoot, canonical)) {
    throw new Error('agent-browser-binary-directory-invalid')
  }
  return canonical
}

function sizeBound(maxBytes) {
  let received = 0
  return new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length
      if (received > maxBytes) {
        callback(new Error('agent-browser-release-size-limit'))
        return
      }
      callback(null, chunk)
    }
  })
}

async function install(packagePath) {
  const packageRoot = realpathSync(packagePath)
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (metadata.name !== 'agent-browser' || metadata.version !== VERSION) {
    throw new Error('agent-browser-version-mismatch')
  }

  const asset = assetForHost()
  const binDir = join(packageRoot, 'bin')
  mkdirSync(binDir, { recursive: true })
  const canonicalBinDir = validateBinaryDirectory(packageRoot, binDir)
  const binaryPath = join(canonicalBinDir, asset.name)
  if (!isInside(packageRoot, binaryPath)) throw new Error('agent-browser-binary-path-invalid')

  const url = `https://github.com/vercel-labs/agent-browser/releases/download/v${VERSION}/${asset.name}`
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error('agent-browser-release-download-failed')
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > asset.bytes) {
    await response.body.cancel()
    throw new Error('agent-browser-release-size-limit')
  }

  const temporary = join(canonicalBinDir, `.${asset.name}.${process.pid}.${Date.now()}.part`)
  try {
    await pipeline(response.body, sizeBound(asset.bytes), createWriteStream(temporary, { flags: 'wx', mode: 0o700 }))
    const bytes = statSync(temporary).size
    const digest = createHash('sha256').update(readFileSync(temporary)).digest('hex')
    if (bytes !== asset.bytes || digest !== asset.sha256) throw new Error('agent-browser-release-integrity-mismatch')

    if (validateBinaryDirectory(packageRoot, binDir) !== canonicalBinDir) {
      throw new Error('agent-browser-binary-directory-invalid')
    }
    try {
      const target = lstatSync(binaryPath)
      if (!target.isFile() || target.isSymbolicLink()) throw new Error('agent-browser-binary-target-not-regular-file')
      rmSync(binaryPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (process.platform !== 'win32') chmodSync(temporary, 0o755)
    // The temporary file and package live on the runner's same volume in CI. A rename is the final
    // operation, so an unverified download is never visible at the executable path.
    renameSync(temporary, binaryPath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }

  return { name: basename(binaryPath), bytes: asset.bytes, digest: asset.sha256 }
}

async function main() {
  const result = await install(parsePackageDir(process.argv.slice(2)))
  console.log(`[agent-browser-install] verified ${result.name} (${result.bytes} bytes, sha256 ${result.digest})`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failure = error instanceof Error ? error.message.replace(/[^a-z0-9-]/gi, '').slice(0, 80) : 'unknown-failure'
    console.error(`[agent-browser-install] failed:${failure}`)
    process.exitCode = 1
  })
}
