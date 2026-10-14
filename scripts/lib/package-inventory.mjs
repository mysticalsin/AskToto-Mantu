import { createHash } from 'node:crypto'
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const HEX_SHA256 = /^[a-f0-9]{64}$/

export function packageInventoryPayload(inventory) {
  return {
    schema: 1,
    profile: inventory.profile,
    platform: inventory.platform,
    arch: inventory.arch,
    appVersion: inventory.appVersion,
    electronVersion: inventory.electronVersion,
    sourceCommit: inventory.sourceCommit,
    coreFiles: inventory.coreFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  }
}

export function packageInventoryIdentity(inventory) {
  return createHash('sha256')
    .update(JSON.stringify(packageInventoryPayload(inventory)), 'utf8')
    .digest('hex')
}

export async function inventoryCoreFiles(resourcesRoot, { exclude = new Set(['package-inventory.json']) } = {}) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const rel = relative(resourcesRoot, path).split(sep).join('/')
      if (entry.isSymbolicLink()) throw new Error(`Package inventory refuses a symbolic link: ${rel}`)
      if (exclude.has(rel)) {
        if (!entry.isFile()) throw new Error(`Package inventory refuses a non-regular staged resource: ${rel}`)
        continue
      }
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile()) {
        const stat = await lstat(path)
        const bytes = await readFile(path)
        files.push({ path: rel, bytes: stat.size, sha256: createHash('sha256').update(bytes).digest('hex') })
      } else {
        throw new Error(`Package inventory refuses a non-regular staged resource: ${rel}`)
      }
    }
  }
  await walk(resourcesRoot)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

export function validatePackageInventory(inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    throw new Error('Package inventory must be an object')
  }
  const keys = Object.keys(inventory)
  const expectedKeys = [
    'schema',
    'profile',
    'platform',
    'arch',
    'appVersion',
    'electronVersion',
    'sourceCommit',
    'coreFiles',
    'identity'
  ]
  if (keys.join(',') !== expectedKeys.join(','))
    throw new Error('Package inventory has unexpected fields or field order')
  if (inventory.schema !== 1 || !['full', 'lean'].includes(inventory.profile))
    throw new Error('Package inventory schema/profile is invalid')
  if (!['darwin', 'win32'].includes(inventory.platform)) throw new Error('Package inventory platform is invalid')
  if (!['arm64', 'x64', 'universal'].includes(inventory.arch))
    throw new Error('Package inventory architecture is invalid')
  if (inventory.platform === 'win32' && inventory.arch !== 'x64') throw new Error('Windows inventory must target x64')
  if (inventory.platform === 'win32' && inventory.profile === 'lean' && inventory.arch !== 'x64') {
    throw new Error('Lean Windows inventory must target x64')
  }
  if (inventory.platform === 'darwin' && inventory.profile === 'lean' && inventory.arch === 'universal') {
    throw new Error('Lean macOS inventory must target one architecture')
  }
  if (
    typeof inventory.appVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(inventory.appVersion)
  ) {
    throw new Error('Package inventory application version is invalid')
  }
  if (
    typeof inventory.electronVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(inventory.electronVersion)
  ) {
    throw new Error('Package inventory Electron version is invalid')
  }
  if (typeof inventory.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(inventory.sourceCommit)) {
    throw new Error('Package inventory source commit is invalid')
  }
  if (!Array.isArray(inventory.coreFiles)) throw new Error('Package inventory coreFiles must be an array')
  let previous = ''
  for (const file of inventory.coreFiles) {
    if (
      !file ||
      typeof file !== 'object' ||
      Array.isArray(file) ||
      Object.keys(file).join(',') !== 'path,bytes,sha256'
    ) {
      throw new Error('Package inventory core file has unexpected fields or field order')
    }
    if (
      typeof file.path !== 'string' ||
      !file.path ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      file.path === 'package-inventory.json'
    ) {
      throw new Error(`Package inventory path is invalid: ${String(file.path)}`)
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HEX_SHA256.test(file.sha256)) {
      throw new Error(`Package inventory file metadata is invalid: ${file.path}`)
    }
    if (previous && file.path <= previous)
      throw new Error('Package inventory coreFiles must be unique and sorted by path')
    previous = file.path
  }
  if (!HEX_SHA256.test(inventory.identity) || packageInventoryIdentity(inventory) !== inventory.identity) {
    throw new Error('Package inventory identity does not match its canonical contents')
  }
  return inventory
}
