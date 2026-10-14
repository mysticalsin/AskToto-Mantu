import { lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Electron Builder drops these exact tracked zero-byte directory placeholders from extraResources. */
const LEAN_PACKAGE_DIRECTORY_PLACEHOLDERS = Object.freeze([
  'cloudflare-embed',
  'operator',
  'license-lease',
  'managed-node/darwin-arm64',
  'managed-node/darwin-x64',
  'managed-node/win-x64',
  'vcredist'
])

// ExtraResources copies files, so empty provisioned-key directories need an explicit directory step.
// Their nonempty contents remain subject to the complete package inventory and byte checks.
export async function ensureLeanPackageCoreDirectories(resourcesRoot) {
  const root = await lstat(resourcesRoot)
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Lean package resource root is invalid')
  for (const name of ['operator', 'license-lease', 'cloudflare-embed']) {
    const directory = join(resourcesRoot, name)
    try {
      await mkdir(directory, { mode: 0o755 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stat = await lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Lean package ${name} directory is invalid`)
    }
  }
}

export async function removeKnownLeanPackagePlaceholders(resourcesRoot) {
  let removed = false
  for (const directory of LEAN_PACKAGE_DIRECTORY_PLACEHOLDERS) {
    const placeholder = join(resourcesRoot, directory, '.gitkeep')
    let stat
    try {
      stat = await lstat(placeholder)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile() || stat.size !== 0) {
      throw new Error(`Lean package ${directory} placeholder must be a zero-byte regular file`)
    }
    await rm(placeholder)
    removed = true
  }
  return removed
}
